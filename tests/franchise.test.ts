import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { GovernanceService } from "../src/governance/index.js";
import { halfPprRules } from "../src/data/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { runOne, TestDriver, ActionSchema } from "../src/runtime/worker.js";
import {
  GovernanceActionSchema,
  FranchiseService,
  FranchiseOutbox,
  type LocalFranchiseAction,
} from "../src/franchise/index.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  service: FranchiseService,
  outbox: FranchiseOutbox,
  league: LeagueService;
const leagueId = "franchise-test";
const owners = Array.from({ length: 12 }, (_, i): Actor => ({
  id: "owner" + i,
  teamId: "team" + i,
  leagueId,
  role: "owner",
}));
const commissioner: Actor = {
  id: "commissioner",
  leagueId,
  role: "commissioner",
};
const rules = {
  rosterSize: 2,
  draftOrder: "snake",
  draftPickSeconds: 60,
  faabBudget: 100,
  lineupSlots: [{ id: "RB", positions: ["RB"] }],
};
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  service = new FranchiseService(f.db);
  outbox = new FranchiseOutbox(f.db, store, service);
  league = new LeagueService(f.db);
  await league.execute(commissioner, {
    leagueId,
    idempotencyKey: "create",
    type: "createLeague",
    name: "Synthetic franchise suite",
    rules,
    teams: owners.map((o, i) => ({
      id: o.teamId,
      ownerId: o.id,
      name: "Fixture " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  for (let i = 0; i < 12; i++) {
    await store.createAgent({
      id: "agent" + i,
      model: "test/franchise",
      kind: i < 10 ? "ai" : "human",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent" + i, leagueId, "team" + i],
    );
  }
});
afterEach(async () => {
  await f?.close();
});
const draft = (body = "Synthetic draft"): LocalFranchiseAction => ({
  type: "public_draft",
  causalId: randomUUID(),
  draftId: "weekly",
  title: "Week one",
  body,
  channel: "x",
});
const save = (
  action: LocalFranchiseAction,
  actor = owners[0],
  agentId = "agent0",
) => service.execute(actor, { agentId, idempotencyKey: randomUUID(), action });
it("stores owner-authored brand artifacts as inert versioned text with a trusted receipt", async () => {
  const action: LocalFranchiseAction = {
    type: "brand",
    causalId: "identity",
    name: "Synthetic Comets",
    tagline: "Test fixture",
    colors: ["#112233"],
    description: "Synthetic identity",
    audience: "Fantasy players",
    strategy: "Learn publicly",
    budgetPlan: "Evaluate useful sources",
    artifacts: [
      {
        name: "Uniform",
        kind: "svg",
        source: "<svg><script>never execute</script></svg>",
      },
      {
        name: "Team page",
        kind: "html",
        source: "<h1>Stored source only</h1>",
      },
    ],
  };
  const receipt = await save(action);
  expect(receipt.result).toMatchObject({
    kind: "brand.saved",
    published: false,
    artifactPolicy: "inert-source-only",
    version: 1,
  });
  const state = await service.snapshot(owners[0]);
  expect(state.brands[0].payload.artifacts[0].source).toBe(
    action.artifacts![0].source,
  );
  expect((await service.snapshot(owners[1])).brands).toHaveLength(0);
  await expect(save(action, owners[1], "agent0")).rejects.toThrow(
    "FRANCHISE_FORBIDDEN",
  );
});
it("model actions enqueue and dispatch brand/public drafts/services without publishing or charging", async () => {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "start",
    payload: {},
  });
  const driver = new TestDriver("test/franchise", () => ({
    actions: [
      {
        type: "brand",
        causalId: "brand",
        name: "Comets",
        tagline: "Synthetic",
        colors: ["#112233"],
        description: "Fixture",
      },
      draft(),
      {
        type: "service_request",
        causalId: "source",
        service: "Fantasy statistics provider",
        purpose: "Evaluate rankings",
        maxCostMicros: 5000000,
      },
    ],
    costMicros: 0,
    summary: "SYNTHETIC model fixture",
  }));
  expect(
    (await runOne(store, driver, "w", { allowedAgentIds: ["agent0"] })).status,
  ).toBe("completed");
  expect((await service.snapshot(owners[0])).drafts).toHaveLength(0);
  for (let i = 0; i < 3; i++)
    expect(
      (await outbox.dispatchOne("d", { allowedAgentIds: ["agent0"] })).status,
    ).toBe("delivered");
  const snapshot = await service.snapshot(owners[0]);
  expect(snapshot.brands).toHaveLength(1);
  expect(snapshot.drafts).toHaveLength(1);
  expect(snapshot.serviceRequests[0].status).toBe("requested");
  expect(Number((await store.agentSnapshot("agent0")).agent.spent_micros)).toBe(
    0,
  );
  expect(
    (await store.agentSnapshot("agent0")).jobs.filter(
      (j) => j.payload.kind === "franchise.result",
    ),
  ).toHaveLength(3);
  expect(
    (await f.db.query("SELECT * FROM franchise_publication_approvals")).rows,
  ).toHaveLength(0);
});
it("publication approval binds an immutable exact batch and draft edits revoke it", async () => {
  await save(draft());
  const row = (await service.snapshot(owners[0])).drafts[0];
  const batch = await service.prepareBatch(commissioner, {
    items: [
      {
        teamId: "team0",
        draftId: "weekly",
        version: row.version,
        contentHash: row.content_hash,
      },
    ],
  });
  await expect(
    service.approveBatch(owners[0], {
      batchId: batch.id,
      contentHash: batch.content_hash,
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    service.approveBatch(commissioner, {
      batchId: batch.id,
      contentHash: "a".repeat(64),
    }),
  ).rejects.toThrow("BATCH_CHANGED_OR_REVOKED");
  const approval = await service.approveBatch(commissioner, {
    batchId: batch.id,
    contentHash: batch.content_hash,
  });
  expect(
    (await service.approvedBatch(commissioner, batch.id)).items[0].body,
  ).toBe("Synthetic draft");
  expect(
    (
      await service.approveBatch(commissioner, {
        batchId: batch.id,
        contentHash: batch.content_hash,
      })
    ).id,
  ).toBe(approval.id);
  await save(draft("Edited after approval"));
  await expect(service.approvedBatch(commissioner, batch.id)).rejects.toThrow(
    "BATCH_NOT_APPROVED",
  );
  expect(
    (
      await f.db.query(
        "SELECT * FROM franchise_publication_approvals WHERE id=$1",
        [approval.id],
      )
    ).rows[0].content_hash,
  ).toBe(batch.content_hash);
  expect((await service.snapshot(owners[0])).drafts).toHaveLength(2);
});
it("tampering prepared batch content cannot reuse its old approval hash", async () => {
  await save(draft());
  const row = (await service.snapshot(owners[0])).drafts[0];
  const batch = await service.prepareBatch(commissioner, {
    items: [
      {
        teamId: "team0",
        draftId: "weekly",
        version: 1,
        contentHash: row.content_hash,
      },
    ],
  });
  await f.db.query(
    "UPDATE franchise_publication_batches SET items=jsonb_set(items,'{0,body}','\"unreviewed\"') WHERE id=$1",
    [batch.id],
  );
  await expect(
    service.approveBatch(commissioner, {
      batchId: batch.id,
      contentHash: batch.content_hash,
    }),
  ).rejects.toThrow("BATCH_CHANGED_OR_REVOKED");
});
it("commissioner review wakes requester but does not provision an account or spend money", async () => {
  const receipt = await save({
    type: "service_request",
    causalId: "s",
    service: "Rankings",
    purpose: "Compare projections",
    maxCostMicros: 1000000,
  });
  await expect(
    service.reviewService(owners[0], {
      requestId: receipt.result.requestId,
      decision: "approved",
      note: "Self approval",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await service.reviewService(commissioner, {
    requestId: receipt.result.requestId,
    decision: "approved",
    note: "Review approved; provisioning still pending",
  });
  const job = (await store.agentSnapshot("agent0")).jobs.find(
    (j) => j.payload.kind === "service.reviewed",
  );
  expect(job.payload).toMatchObject({ provisioned: false, chargedMicros: 0 });
  await expect(
    service.reviewService(
      { ...commissioner, leagueId: "other" },
      {
        requestId: receipt.result.requestId,
        decision: "approved",
        note: "Cross league",
      },
    ),
  ).rejects.toThrow("SERVICE_REQUEST_NOT_FOUND");
});
it("governance owner actions dispatch through verified receipts and wake league peers", async () => {
  const governance = new GovernanceService(f.db);
  await governance.execute(commissioner, {
    leagueId,
    idempotencyKey: "meeting",
    type: "openMeeting",
    meetingId: "constitution",
    proposalDeadline: new Date(Date.now() + 60000).toISOString(),
    voteDeadline: new Date(Date.now() + 120000).toISOString(),
  });
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "propose",
    payload: {},
  });
  const driver = new TestDriver("test/franchise", () => ({
    actions: [
      GovernanceActionSchema.parse({
        type: "governance",
        causalId: "proposal",
        command: {
          type: "submitProposal",
          meetingId: "constitution",
          proposalId: "proposal",
          version: "v1",
          title: "Synthetic rules",
          rationale: "Fixture rationale",
          rules: {
            ...rules,
            draftOrder: "snake",
            lineupSlots: [{ id: "RB", positions: ["RB"] }],
          },
          scoringRules: halfPprRules,
          teamOrder: owners.map((o) => o.teamId!),
        },
      }),
    ],
    costMicros: 0,
    summary: "Synthetic proposal author",
  }));
  expect(
    (await runOne(store, driver, "w", { allowedAgentIds: ["agent0"] })).status,
  ).toBe("completed");
  expect((await outbox.dispatchOne("d")).status).toBe("delivered");
  expect(
    (await f.db.query("SELECT * FROM governance_proposals")).rows,
  ).toHaveLength(1);
  expect(
    (await store.agentSnapshot("agent1")).jobs[0].payload.commandType,
  ).toBe("submitProposal");
  expect(
    ActionSchema.safeParse({
      type: "governance",
      causalId: "ratify",
      command: { type: "prepareRatification", proposalId: "proposal" },
    }).success,
  ).toBe(false);
  expect(ActionSchema.safeParse({ ...draft(), approve: true }).success).toBe(
    false,
  );
});
it("franchise outbox crash recovery replays one saved draft and fences stale acknowledgments", async () => {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "start",
    payload: {},
  });
  await runOne(
    store,
    new TestDriver("test/franchise", () => ({
      actions: [draft()],
      costMicros: 0,
      summary: "Synthetic",
    })),
    "w",
  );
  const old = (await outbox.claim("old", 50, ["agent0"]))!;
  const receipt = await outbox.execute(old);
  await new Promise((r) => setTimeout(r, 70));
  const current = (await outbox.claim("new", 5000, ["agent0"]))!;
  const replay = await outbox.execute(current);
  expect(replay.replayed).toBe(true);
  expect(replay.receiptId).toBe(receipt.receiptId);
  await expect(outbox.acknowledge(old, receipt)).rejects.toThrow(
    "STALE_FRANCHISE_CLAIM",
  );
  await outbox.acknowledge(current, replay);
  expect((await service.snapshot(owners[0])).drafts).toHaveLength(1);
});
it("franchise dispatch scopes and persisted receipts prevent foreign or forged delivery", async () => {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "start",
    payload: {},
  });
  await runOne(
    store,
    new TestDriver("test/franchise", () => ({
      actions: [draft()],
      costMicros: 0,
      summary: "Synthetic",
    })),
    "w",
  );
  expect(
    (await outbox.dispatchOne("foreign", { allowedAgentIds: ["agent1"] }))
      .status,
  ).toBe("idle");
  const claim = (await outbox.claim("scoped", 30000, ["agent0"]))!;
  await expect(
    outbox.acknowledge(claim, {
      receiptId: randomUUID(),
      result: { published: true },
      replayed: false,
    }),
  ).rejects.toThrow("UNVERIFIED_FRANCHISE_RECEIPT");
});
