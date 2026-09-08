import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  OwnerStageRuntime,
  assertOwnerStageResearchBudget,
} from "../src/runtime/owner-stage.js";
import {
  TestDriver,
  runOne,
  KnownZeroCostError,
} from "../src/runtime/worker.js";
import { FranchiseOutbox } from "../src/franchise/outbox.js";
import { FranchiseService } from "../src/franchise/service.js";
import { migrate, transaction } from "../src/db.js";
import { randomUUID } from "node:crypto";
import {
  BuzzArchiveService,
  nostrEventId,
  type BuzzEvent,
} from "../src/buzz/archive.js";
import { BuzzRuntimeOutbound } from "../src/buzz/runtime-outbound.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  stage: OwnerStageRuntime,
  outbox: FranchiseOutbox,
  archive: BuzzArchiveService,
  eventToAccept: BuzzEvent | undefined;
const leagueId = "owner-stage-fixture",
  room = "12345678-1234-4234-9234-123456789abc",
  pubkeys = ["a".repeat(64), "b".repeat(64)],
  stageId = "onboarding-v1";
const commissioner = {
  id: "commissioner",
  role: "commissioner" as const,
  leagueId,
};
const listener = {
  leagueId,
  pubkey: pubkeys[0]!,
  communityUrl: "wss://synthetic-onboarding.example.test",
  mode: "mock" as const,
};
const brand = {
  type: "brand" as const,
  causalId: "own-brand",
  name: "Synthetic Original",
  tagline: "A fixture only",
  description: "Synthetic owner identity",
  colors: ["#123456"],
};
const config = () => ({
  stageId,
  policyReceiptId: "SYNTHETIC approved commissioner policy",
  introChannelId: room,
  synthetic: true,
  initiativeDeadline: new Date(Date.now() + 3600000).toISOString(),
  followupDeadline: new Date(Date.now() + 7200000).toISOString(),
  allowedActions: ["brand", "remember", "schedule", "cancel", "buzz_channel"],
  readTools: [
    "research_sources",
    "research_search",
    "research_retrieve",
    "buzz_read",
  ],
  limits: { maxTurns: 8, maxSpendMicros: 100, maxReservationMicros: 20 },
});
function evt(content: string, who = 0, replyTo?: string): BuzzEvent {
  const e = {
    pubkey: pubkeys[who]!,
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [
      ["h", room],
      ["p", pubkeys[1 - who]!],
      ...(replyTo ? [["e", replyTo, "", "reply"]] : []),
    ],
  };
  return { ...e, id: nostrEventId(e) };
}
async function ingest(e: BuzzEvent) {
  return archive.ingestBatch(listener, {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [e],
    complete: true,
  });
}
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  stage = new OwnerStageRuntime(f.db, store);
  archive = new BuzzArchiveService(f.db);
  eventToAccept = undefined;
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC onboarding','{}')",
    [leagueId],
  );
  for (let i = 0; i < 2; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,'ai',$4,$4,100)",
      [leagueId, `team${i}`, `owner${i}`, i],
    );
    await store.createAgent({
      id: `agent${i}`,
      model: "synthetic/onboarding",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`agent${i}`, leagueId, `team${i}`],
    );
  }
  await archive.configure(commissioner, {
    leagueId,
    communityUrl: listener.communityUrl,
    mode: "mock",
    bindingReceiptId: "SYNTHETIC binding",
    archiveConsentReceiptId: "SYNTHETIC consent",
    participants: pubkeys.map((pubkey, i) => ({
      pubkey,
      teamId: `team${i}`,
      ownerId: `owner${i}`,
      agentId: `agent${i}`,
      kind: "agent",
      ownerPubkey: "c".repeat(64),
    })),
  });
  await archive.registerChannel(commissioner, {
    leagueId,
    channelId: room,
    memberPubkeys: pubkeys,
    receiptId: "SYNTHETIC membership",
  });
  for (let i = 0; i < 2; i++)
    await new BuzzRuntimeOutbound(f.db).cutoverToPolling(commissioner, {
      leagueId,
      agentId: `agent${i}`,
      receiptId: "SYNTHETIC cutover",
    });
  const channel = new BuzzChannelService(f.db, async () => ({
    read: async () => pubkeys.map((pubkey) => ({ pubkey, role: "member" })),
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ accepted: true, event_id: eventToAccept!.id }),
    }),
  }));
  outbox = new FranchiseOutbox(f.db, store, undefined, undefined, channel);
});
afterEach(async () => {
  await f?.close();
});
async function begin() {
  await stage.configure(commissioner, config());
  await stage.wakeOwner(commissioner, "agent0");
}
async function turn(actions: any[], agentId = "agent0") {
  return runOne(
    store,
    new TestDriver("synthetic/onboarding", () => ({
      actions,
      costMicros: 0,
      summary: "Synthetic owner-stage fixture",
    })),
    "owner-stage",
    { allowedAgentIds: [agentId], maxCostMicros: 10 },
  );
}
async function drain() {
  for (let i = 0; i < 10; i++) {
    const r = await outbox.dispatchOne("stage-outbox", {
      allowedAgentIds: ["agent0"],
    });
    if (r.status === "idle") return;
    expect(r.status).toBe("delivered");
  }
  throw Error("Unbounded drain");
}
it("persists trusted charter and preserves an existing brand and old pending intents for review", async () => {
  await new FranchiseService(f.db).execute(
    { id: "owner0", role: "owner", leagueId, teamId: "team0" },
    { agentId: "agent0", idempotencyKey: "old-brand", action: brand },
  );
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "old-phase",
    payload: {},
  });
  expect(
    (
      await turn([
        { ...brand, causalId: "old-pending", name: "Unreviewed old intent" },
      ])
    ).status,
  ).toBe("completed");
  await begin();
  const context = await stage.context("agent0");
  expect(context.stage).toBe("onboarding");
  if (context.stage !== "onboarding") throw Error("missing");
  expect(context.charter).toContain("Black4");
  expect(context.assignment).not.toContain("Operator-only qualification plan");
  expect(context.activePermissions).not.toContain("governance");
  expect(context.assignedPeerAgentId).toBe("agent1");
  expect(
    (await f.db.query("SELECT status FROM runtime_franchise_outbox")).rows[0]
      .status,
  ).toBe("held");
  expect(
    (await f.db.query("SELECT payload FROM franchise_brand_versions")).rows[0]
      .payload.name,
  ).toBe(brand.name);
  expect(await stage.mayInfer("agent0", 10)).toBe(true);
});
it("repairs legacy outbox constraints before holding pending franchise and football intents", async () => {
  // Reproduce the previously deployed constraint shape in this isolated schema.
  for (const table of ["runtime_franchise_outbox", "runtime_football_outbox"]) {
    await f.db.query(
      `ALTER TABLE ${table} DROP CONSTRAINT ${table}_status_check`,
    );
    await f.db.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_status_check CHECK(status IN ('pending','running','delivered','dead'))`,
    );
  }
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "legacy-intents",
    payload: {},
  });
  expect(
    (
      await turn([
        { ...brand, causalId: "legacy-brand" },
        {
          type: "football",
          causalId: "legacy-football",
          command: { type: "setDraftQueue", playerIds: [] },
        },
      ])
    ).status,
  ).toBe("completed");
  const before = await f.db.query(
    "SELECT id,action FROM runtime_franchise_outbox",
  );
  const footballBefore = await f.db.query(
    "SELECT id,command FROM runtime_football_outbox",
  );
  const assignment = config();
  await expect(stage.configure(commissioner, assignment)).rejects.toMatchObject(
    { code: "23514" },
  );
  expect(
    (await f.db.query("SELECT 1 FROM runtime_owner_stages")).rowCount,
  ).toBe(0);
  await f.db.query(
    "DELETE FROM schema_migrations WHERE name='032_runtime_outbox_held.sql'",
  );
  await migrate(f.db);
  await stage.configure(commissioner, assignment);
  expect(
    (
      await f.db.query(
        "SELECT id,action,status,error FROM runtime_franchise_outbox",
      )
    ).rows,
  ).toEqual([
    {
      ...before.rows[0],
      status: "held",
      error: "OWNER_STAGE_PREVIOUS_INTENT_HELD",
    },
  ]);
  expect(
    (
      await f.db.query(
        "SELECT id,command,status,error FROM runtime_football_outbox",
      )
    ).rows,
  ).toEqual([
    {
      ...footballBefore.rows[0],
      status: "held",
      error: "OWNER_STAGE_PREVIOUS_INTENT_HELD",
    },
  ]);
  for (const table of ["runtime_franchise_outbox", "runtime_football_outbox"]) {
    await expect(
      f.db.query(`UPDATE ${table} SET status='invalid'`),
    ).rejects.toMatchObject({ code: "23514" });
  }
});
it("permits reviewed new work without releasing uncertain money or marking onboarding ready", async () => {
  await stage.configure(commissioner, {
    ...config(),
    limits: { maxTurns: 8, maxSpendMicros: 30, maxReservationMicros: 20 },
  });
  await stage.wakeOwner(commissioner, "agent0");
  expect(
    (
      await runOne(
        store,
        new TestDriver("synthetic/onboarding", () => {
          throw Error("SYNTHETIC uncertain provider bill");
        }),
        "held-cost",
        { allowedAgentIds: ["agent0"], maxCostMicros: 20 },
      )
    ).status,
  ).toBe("failed");
  const reservation = (await f.db.query("SELECT * FROM runtime_reservations"))
    .rows[0];
  expect(reservation.status).toBe("uncertain");
  expect(await stage.mayInfer("agent0", 10)).toBe(false);
  const input = {
    agentId: "agent0",
    reservationId: reservation.id,
    reason: "Synthetic provider incident investigated; tool disabled",
    evidenceRef: "synthetic://private/incident-1",
  };
  await expect(
    stage.reviewCostHold(
      { id: "owner0", role: "owner", leagueId, teamId: "team0" },
      input,
    ),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_COMMISSIONER_REQUIRED" });
  await expect(
    stage.reviewCostHold({ ...commissioner, leagueId: "foreign" }, input),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_SCOPE" });
  await expect(
    stage.reviewCostHold(commissioner, { ...input, agentId: "agent1" }),
  ).rejects.toMatchObject({
    code: "OWNER_STAGE_UNCERTAIN_RESERVATION_REQUIRED",
  });
  const jobsBefore = (
    await f.db.query("SELECT id,status FROM runtime_jobs ORDER BY id")
  ).rows;
  const review = await stage.reviewCostHold(commissioner, input);
  expect(review).toMatchObject({
    reconciled: false,
    automaticWake: false,
    heldMicros: 20,
    reservationStatus: "uncertain",
    replayed: false,
  });
  expect((await stage.reviewCostHold(commissioner, input)).replayed).toBe(true);
  expect(
    (await f.db.query("SELECT * FROM runtime_reservations")).rows[0],
  ).toEqual(reservation);
  expect(
    (await f.db.query("SELECT id,status FROM runtime_jobs ORDER BY id")).rows,
  ).toEqual(jobsBefore);
  expect(
    (
      await f.db.query(
        "SELECT reserved_micros,spent_micros FROM runtime_agents WHERE id='agent0'",
      )
    ).rows[0],
  ).toEqual({ reserved_micros: "20", spent_micros: "0" });
  expect(await stage.mayInfer("agent0", 10)).toBe(true);
  expect(await stage.mayInfer("agent0", 11)).toBe(false);
  expect((await stage.checkpoint(commissioner))[0]?.missing).not.toContain(
    "stage-cost-reconciliation",
  );
  expect(
    (await stage.checkpoint(commissioner))[0]?.evidence.costUnknown,
  ).toEqual([
    expect.objectContaining({
      reservation_id: reservation.id,
      status: "uncertain",
      amount_micros: "20",
      review: expect.objectContaining({ reconciled: false }),
    }),
  ]);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "operator-new-job",
    payload: { instruction: "Synthetic new work after investigated incident" },
  });
  expect((await turn([])).status).toBe("completed");
  const context = await stage.context("agent0");
  if (context.stage !== "onboarding") throw Error("missing stage");
  expect(context.usage).toMatchObject({
    turns: 2,
    committed_micros: "20",
    unresolved_costs: 1,
    unreviewed_costs: 0,
  });
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "over-limit-new-job",
    payload: {},
  });
  expect(
    (
      await runOne(
        store,
        new TestDriver("synthetic/onboarding", () => {
          throw Error("Driver must not run over stage cap");
        }),
        "over-cap",
        { allowedAgentIds: ["agent0"], maxCostMicros: 20 },
      )
    ).status,
  ).toBe("failed");
  expect(
    (await f.db.query("SELECT count(*)::int AS n FROM runtime_reservations"))
      .rows[0].n,
  ).toBe(2);
});
it("requires the exact dead job fence for uncertain cost review", async () => {
  await begin();
  await runOne(
    store,
    new TestDriver("synthetic/onboarding", () => {
      throw Error("SYNTHETIC uncertain bill");
    }),
    "held-cost",
    { allowedAgentIds: ["agent0"], maxCostMicros: 10 },
  );
  const reservation = (await f.db.query("SELECT * FROM runtime_reservations"))
    .rows[0];
  const input = {
    agentId: "agent0",
    reservationId: reservation.id,
    reason: "Synthetic incident reviewed",
    evidenceRef: "synthetic://incident",
  };
  await f.db.query("UPDATE runtime_jobs SET status='pending' WHERE id=$1", [
    reservation.job_id,
  ]);
  await expect(stage.reviewCostHold(commissioner, input)).rejects.toMatchObject(
    { code: "OWNER_STAGE_DEAD_FENCE_REQUIRED" },
  );
  await f.db.query(
    "UPDATE runtime_jobs SET status='dead',fence=fence+1 WHERE id=$1",
    [reservation.job_id],
  );
  await expect(stage.reviewCostHold(commissioner, input)).rejects.toMatchObject(
    { code: "OWNER_STAGE_DEAD_FENCE_REQUIRED" },
  );
});
it("counts paid research reservations and verified charges within the same stage cap", async () => {
  await stage.configure(commissioner, {
    ...config(),
    limits: { maxTurns: 8, maxSpendMicros: 30, maxReservationMicros: 20 },
  });
  await stage.wakeOwner(commissioner, "agent0");
  const job = await store.claim(
    "research-stage",
    30000,
    "synthetic/onboarding",
    ["agent0"],
  );
  if (!job) throw Error("missing job");
  await store.reserve(job, 10);
  const operationId = randomUUID();
  await f.db.query(
    "INSERT INTO research_paid_operations(id,league_id,agent_id,job_id,fence,operation_key,fingerprint,kind,status,reservation_micros,tariff,request_hash,request) VALUES($1,$2,$3,$4,$5,'SYNTHETIC-search','fixture','search','dispatched',6,'{}','fixture','{}')",
    [operationId, leagueId, job.agentId, job.id, job.fence],
  );
  const checkResearch = (amount: number, suppliedJob = job) =>
    transaction(f.db, async (tx) => {
      await tx.query("SELECT id FROM runtime_agents WHERE id=$1 FOR UPDATE", [
        suppliedJob.agentId,
      ]);
      return assertOwnerStageResearchBudget(
        tx,
        suppliedJob,
        amount,
        "research_search",
      );
    });
  await expect(checkResearch(14)).resolves.toBeUndefined();
  await expect(checkResearch(15)).rejects.toMatchObject({
    code: "OWNER_STAGE_SPEND_LIMIT",
  });
  await expect(
    checkResearch(1, { ...job, fence: job.fence + 1 }),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_PREVIOUS_INTENT_HELD" });
  let context = await stage.context("agent0");
  if (context.stage !== "onboarding") throw Error("missing stage");
  expect(context.usage).toMatchObject({
    committed_micros: "16",
    research_committed_micros: "6",
    research_unresolved_costs: 0,
  });
  await f.db.query(
    "UPDATE research_paid_operations SET status='completed',actual_micros=4,credits_used=2 WHERE id=$1",
    [operationId],
  );
  await expect(checkResearch(16)).resolves.toBeUndefined();
  await expect(checkResearch(17)).rejects.toMatchObject({
    code: "OWNER_STAGE_SPEND_LIMIT",
  });
  await f.db.query(
    "UPDATE research_paid_operations SET status='unknown',actual_micros=NULL WHERE id=$1",
    [operationId],
  );
  await expect(checkResearch(1)).rejects.toMatchObject({
    code: "OWNER_STAGE_COST_REQUIRES_REVIEW",
  });
  expect(await stage.mayInfer("agent0", 1)).toBe(false);
  context = await stage.context("agent0");
  if (context.stage !== "onboarding") throw Error("missing stage");
  expect(context.usage).toMatchObject({
    committed_micros: "16",
    unresolved_costs: 1,
    unreviewed_costs: 1,
    research_unresolved_costs: 1,
  });
  expect((await stage.checkpoint(commissioner))[0]?.missing).toContain(
    "stage-cost-reconciliation",
  );
});
it("extends deadlines through receipts without changing stage history, jobs or evidence", async () => {
  await begin();
  await turn([
    {
      type: "remember",
      key: "preserved-evidence",
      content: "SYNTHETIC owner evidence",
    },
  ]);
  const original = (await f.db.query("SELECT * FROM runtime_owner_stages"))
    .rows[0];
  const jobsBefore = (
    await f.db.query("SELECT * FROM runtime_jobs ORDER BY id")
  ).rows;
  const followupDeadline = new Date(
    new Date(original.configuration.followupDeadline).getTime() + 3600000,
  ).toISOString();
  const request = {
    stageId,
    idempotencyKey: "extend-after-provider-defect",
    followupDeadline,
    reason: "Synthetic provider outage consumed the original onboarding window",
  };
  await expect(
    stage.extendDeadlines(
      { id: "owner0", role: "owner", leagueId, teamId: "team0" },
      request,
    ),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_COMMISSIONER_REQUIRED" });
  await expect(
    stage.extendDeadlines({ ...commissioner, leagueId: "foreign" }, request),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_SCOPE" });
  const receipt = await stage.extendDeadlines(commissioner, request);
  expect(receipt).toMatchObject({
    automaticWake: false,
    oldDeadlines: { followup: original.configuration.followupDeadline },
    newDeadlines: { followup: followupDeadline },
  });
  expect((await stage.extendDeadlines(commissioner, request)).replayed).toBe(
    true,
  );
  await expect(
    stage.extendDeadlines(commissioner, {
      ...request,
      reason: "Different intent under the same key",
    }),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_DEADLINE_CONFLICT" });
  await expect(
    stage.extendDeadlines(commissioner, {
      ...request,
      idempotencyKey: "shorten",
      followupDeadline: original.configuration.followupDeadline,
    }),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_DEADLINE_SHORTENING" });
  expect(
    (await f.db.query("SELECT * FROM runtime_owner_stages")).rows[0],
  ).toEqual(original);
  expect(
    (await f.db.query("SELECT * FROM runtime_jobs ORDER BY id")).rows,
  ).toEqual(jobsBefore);
  expect(
    (
      await f.db.query(
        "SELECT content FROM runtime_memory WHERE key='preserved-evidence'",
      )
    ).rows[0].content,
  ).toContain("owner evidence");
  const context = await stage.context("agent0");
  if (context.stage !== "onboarding") throw Error("missing stage");
  expect(context.deadlines.followup).toBe(followupDeadline);
  expect(context.deadlineHistory.original.followup).toBe(
    original.configuration.followupDeadline,
  );
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "explicit-new-work",
    payload: {},
  });
  expect(
    (
      await turn([
        {
          type: "schedule",
          causalId: "extended-followup",
          dueAt: new Date(
            new Date(original.configuration.followupDeadline).getTime() + 60000,
          ).toISOString(),
          payload: {
            kind: "onboarding.followup",
            stageId,
            task: "Review the preserved owner operating evidence",
          },
        },
      ])
    ).status,
  ).toBe("completed");
  await f.db.query("UPDATE runtime_owner_stages SET status='paused'");
  const second = await stage.extendDeadlines(commissioner, {
    ...request,
    idempotencyKey: "later-extension",
    followupDeadline: new Date(
      new Date(followupDeadline).getTime() + 60000,
    ).toISOString(),
  });
  expect(second.previousReceiptId).toBe(receipt.receiptId);
  expect(
    (await f.db.query("SELECT status FROM runtime_owner_stages")).rows[0]
      .status,
  ).toBe("paused");
  expect(await stage.mayInfer("agent0", 1)).toBe(false);
});
it("requires verified scoped Firecrawl search and matching actual page content", async () => {
  await begin();
  await turn([]);
  const t = (
    await f.db.query(
      "SELECT * FROM runtime_owner_stage_turns WHERE agent_id='agent0'",
    )
  ).rows[0];
  const url = "https://example.org/synthetic-football-report",
    otherUrl = "https://example.org/unrelated";
  async function operation(kind: "search" | "scrape", pageUrl: string) {
    const id = randomUUID();
    const result = {
      status: "retrieved",
      provider: "firecrawl",
      synthetic: true,
      results: [
        {
          url: pageUrl,
          title: "SYNTHETIC source",
          excerpt: "Actual synthetic fixture page content",
          contentHash: "a".repeat(64),
        },
      ],
    };
    await f.db.query(
      "INSERT INTO research_paid_operations(id,league_id,agent_id,job_id,fence,operation_key,fingerprint,kind,status,reservation_micros,actual_micros,credits_used,tariff,request_hash,response_hash,result,completed_at) VALUES($1,$2,'agent0',$3,$4,$1::uuid::text,'fixture',$5,'completed',4,2,1,'{}',$6,$7,$8,clock_timestamp())",
      [
        id,
        leagueId,
        t.job_id,
        t.fence,
        kind,
        "b".repeat(64),
        "c".repeat(64),
        result,
      ],
    );
    await f.db.query(
      "INSERT INTO research_receipts(id,league_id,agent_id,job_id,tool,url,source_id,status,details,completed_at) VALUES($1,$2,'agent0',$3,$4,$5,'firecrawl','completed',$6,clock_timestamp())",
      [
        id,
        leagueId,
        t.job_id,
        kind === "search" ? "research_search" : "research_retrieve",
        kind === "scrape" ? pageUrl : null,
        {
          paidOperationId: id,
          requestHash: "b".repeat(64),
          responseHash: "c".repeat(64),
        },
      ],
    );
    return id;
  }
  const baseline = async () =>
    (await stage.checkpoint(commissioner)).find((r) => r.agentId === "agent0")!
      .researchBaseline;
  const search = await operation("search", url);
  expect((await baseline()).status).toBe("incomplete");
  await operation("scrape", otherUrl);
  expect((await baseline()).status).toBe("incomplete");
  const page = await operation("scrape", url);
  expect(await baseline()).toMatchObject({
    status: "verified",
    pageMatchesSearchCitation: true,
    search: { source: "firecrawl", receiptId: search },
    page: { id: page, url },
  });
  await f.db.query(
    "UPDATE research_paid_operations SET status='unknown',actual_micros=NULL WHERE id=$1",
    [search],
  );
  expect((await baseline()).status).toBe("incomplete");
  await f.db.query(
    "UPDATE research_paid_operations SET status='completed',actual_micros=2,fence=fence+1 WHERE id=$1",
    [search],
  );
  expect((await baseline()).status).toBe("incomplete");
  await f.db.query(
    "UPDATE research_paid_operations SET fence=fence-1,agent_id='agent1' WHERE id=$1",
    [search],
  );
  expect((await baseline()).status).toBe("incomplete");
  await f.db.query(
    "UPDATE research_paid_operations SET agent_id='agent0' WHERE id=$1",
    [search],
  );
  await f.db.query(
    'UPDATE research_receipts SET details=details||\'{"responseHash":"mismatch"}\'::jsonb WHERE id=$1',
    [page],
  );
  expect((await baseline()).status).toBe("incomplete");
  await f.db.query(
    "UPDATE research_receipts SET details=details||$2::jsonb WHERE id=$1",
    [page, { responseHash: "c".repeat(64) }],
  );
  await f.db.query(
    "UPDATE research_paid_operations SET result=jsonb_set(result,'{status}','\"unavailable\"') WHERE id=$1",
    [page],
  );
  expect((await baseline()).status).toBe("incomplete");
  await f.db.query(
    "UPDATE research_paid_operations SET result=jsonb_set(jsonb_set(result,'{status}','\"retrieved\"'),'{synthetic}','false') WHERE id=$1",
    [page],
  );
  expect((await baseline()).status).toBe("incomplete");
});
it("allows a new owner appointment after a failed one while preserving failure evidence", async () => {
  await begin();
  const action = {
    type: "schedule",
    causalId: "first-followup",
    dueAt: new Date(Date.now() + 60000).toISOString(),
    payload: {
      kind: "onboarding.followup",
      stageId,
      task: "Inspect actual peer evidence and operating memory",
    },
  };
  expect((await turn([action])).status).toBe("completed");
  for (let attempt = 0; attempt < 3; attempt++) {
    await f.db.query(
      "UPDATE runtime_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE causal_id='first-followup'",
    );
    expect(
      (
        await runOne(
          store,
          new TestDriver("synthetic/onboarding", () => {
            throw new KnownZeroCostError(
              "SYNTHETIC failed appointment before billing",
            );
          }),
          "failed-appointment",
          { allowedAgentIds: ["agent0"], maxCostMicros: 10 },
        )
      ).status,
    ).toBe("failed");
  }
  const failed = (
    await f.db.query(
      "SELECT * FROM runtime_jobs WHERE causal_id='first-followup'",
    )
  ).rows[0];
  expect(failed.status).toBe("dead");
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "owner-recovery",
    payload: {},
  });
  expect(
    (
      await turn([
        {
          ...action,
          causalId: "replacement-followup",
          dueAt: new Date(Date.now() + 120000).toISOString(),
        },
      ])
    ).status,
  ).toBe("completed");
  expect(
    (await f.db.query("SELECT * FROM runtime_jobs WHERE id=$1", [failed.id]))
      .rows[0],
  ).toEqual(failed);
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='owner_stage.schedule_authored' ORDER BY seq DESC LIMIT 1",
      )
    ).rows[0].details.replacesFailedAppointments,
  ).toEqual([{ appointmentId: failed.id, error: failed.error }]);
  const context = await stage.context("agent0");
  if (context.stage !== "onboarding") throw Error("missing stage");
  expect(context.existingWork.followup).toMatchObject({
    status: "pending",
    causal_id: "replacement-followup",
  });
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "no-third-appointment",
    payload: {},
  });
  expect((await turn([{ ...action, causalId: "third-followup" }])).status).toBe(
    "failed",
  );
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM runtime_jobs WHERE kind='appointment'",
      )
    ).rows[0].n,
  ).toBe(2);
});
it("keeps unrelated owner work when a legitimate followup time passes during generation", async () => {
  await begin();
  const result = await runOne(
    store,
    new TestDriver("synthetic/onboarding", async () => {
      const dueAt = new Date(Date.now() + 20).toISOString();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        actions: [
          {
            type: "remember",
            key: "useful-on-time-evidence",
            content: "SYNTHETIC retained owner decision",
          },
          brand,
          {
            type: "schedule",
            causalId: "generation-late-followup",
            dueAt,
            payload: {
              kind: "onboarding.followup",
              stageId,
              task: "Read actual retained evidence at the earliest available turn",
            },
          },
        ],
        costMicros: 0,
        summary: "Synthetic generation lateness fixture",
      };
    }),
    "slow-generation",
    { allowedAgentIds: ["agent0"], maxCostMicros: 10 },
  );
  expect(result.status).toBe("completed");
  expect(
    (
      await f.db.query(
        "SELECT content FROM runtime_memory WHERE key='useful-on-time-evidence'",
      )
    ).rows[0].content,
  ).toContain("retained");
  expect(
    (await f.db.query("SELECT status FROM runtime_franchise_outbox")).rows[0]
      .status,
  ).toBe("pending");
  const late = (
    await f.db.query(
      "SELECT details FROM runtime_receipts WHERE type='owner_stage.schedule_late'",
    )
  ).rows[0].details;
  expect(late.latenessMs).toBeGreaterThan(0);
  expect(late.disposition).toBe(
    "immediately-eligible-original-due-time-preserved",
  );
  expect(
    (
      await f.db.query(
        "SELECT due_at<=clock_timestamp() AS due FROM runtime_jobs WHERE causal_id='generation-late-followup'",
      )
    ).rows[0].due,
  ).toBe(true);
});
it("amends turn and readonly allowances while preserving the original budget and action ceiling", async () => {
  await stage.configure(commissioner, {
    ...config(),
    limits: { maxTurns: 2, maxSpendMicros: 20, maxReservationMicros: 10 },
  });
  await stage.wakeOwner(commissioner, "agent0");
  expect((await turn([])).status).toBe("completed");
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "second-turn",
    payload: {},
  });
  expect((await turn([])).status).toBe("completed");
  expect(await stage.mayInfer("agent0", 10)).toBe(false);
  const original = (await f.db.query("SELECT * FROM runtime_owner_stages"))
    .rows[0];
  const jobs = (await f.db.query("SELECT * FROM runtime_jobs ORDER BY id"))
    .rows;
  await expect(
    stage.configure(commissioner, {
      ...config(),
      stageId: "forbidden-initial-cap",
      limits: { maxTurns: 13, maxSpendMicros: 20, maxReservationMicros: 10 },
    }),
  ).rejects.toThrow();
  const request = {
    stageId,
    idempotencyKey: "extra-observed-recovery-turns",
    maxTurns: 16,
    addReadTools: ["mfl_read" as const],
    reason:
      "Synthetic onboarding defects require bounded recovery and readonly football qualification",
  };
  await expect(
    stage.amendOperationalAllowance(
      { id: "owner0", role: "owner", leagueId, teamId: "team0" },
      request,
    ),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_COMMISSIONER_REQUIRED" });
  await expect(
    stage.amendOperationalAllowance(
      { ...commissioner, leagueId: "foreign" },
      request,
    ),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_SCOPE" });
  await expect(
    stage.amendOperationalAllowance(commissioner, { ...request, maxTurns: 17 }),
  ).rejects.toThrow();
  await expect(
    stage.amendOperationalAllowance(commissioner, {
      ...request,
      addReadTools: ["football"],
    } as any),
  ).rejects.toThrow();
  await expect(
    stage.amendOperationalAllowance(commissioner, {
      ...request,
      allowedActions: ["football"],
    } as any),
  ).rejects.toThrow();
  await expect(
    stage.amendOperationalAllowance(commissioner, {
      ...request,
      maxSpendMicros: 1000,
    } as any),
  ).rejects.toThrow();
  const receipt = await stage.amendOperationalAllowance(commissioner, request);
  expect(receipt).toMatchObject({
    automaticWake: false,
    newAllowance: { maxTurns: 16, additionalReadTools: ["mfl_read"] },
    maxSpendMicros: 20,
    maxReservationMicros: 10,
  });
  expect(
    (await stage.amendOperationalAllowance(commissioner, request)).replayed,
  ).toBe(true);
  await expect(
    stage.amendOperationalAllowance(commissioner, {
      ...request,
      reason: "Different request under the same identity",
    }),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_ALLOWANCE_CONFLICT" });
  expect(
    (await f.db.query("SELECT * FROM runtime_owner_stages")).rows[0],
  ).toEqual(original);
  expect(
    (await f.db.query("SELECT * FROM runtime_jobs ORDER BY id")).rows,
  ).toEqual(jobs);
  const context = await stage.context("agent0");
  if (context.stage !== "onboarding") throw Error("missing stage");
  expect(context.limits).toEqual({
    maxTurns: 16,
    maxSpendMicros: 20,
    maxReservationMicros: 10,
  });
  expect(context.activePermissions).toContain("mfl_read");
  expect(context.allowedActions).toEqual(original.configuration.allowedActions);
  expect(context.activePermissions).not.toContain("football");
  expect(context.activePermissions).not.toContain("governance");
  expect(await stage.mayInfer("agent0", 10)).toBe(true);
  expect(await stage.mayInfer("agent0", 21)).toBe(false);
  for (let i = 2; i < 16; i++) {
    await store.ingestEvent({
      agentId: "agent0",
      causalId: "extra-turn-" + i,
      payload: {},
    });
    expect((await turn([])).status).toBe("completed");
  }
  expect(await stage.mayInfer("agent0", 1)).toBe(false);
  await expect(
    stage.amendOperationalAllowance(commissioner, {
      ...request,
      idempotencyKey: "reduce",
      maxTurns: 11,
    }),
  ).rejects.toMatchObject({ code: "OWNER_STAGE_ALLOWANCE_REDUCTION" });
});
it("rejects forbidden football actions before enqueue and limits all message turns before inference", async () => {
  await stage.configure(commissioner, {
    ...config(),
    limits: { maxTurns: 2, maxSpendMicros: 100, maxReservationMicros: 20 },
  });
  await stage.wakeOwner(commissioner, "agent0");
  expect(
    (
      await turn([
        {
          type: "football",
          causalId: "forbidden",
          command: { type: "setDraftQueue", playerIds: [] },
        },
      ])
    ).status,
  ).toBe("failed");
  expect(
    (await f.db.query("SELECT 1 FROM runtime_football_outbox")).rowCount,
  ).toBe(0);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "chatter",
    payload: {},
  });
  expect((await turn([])).status).toBe("completed");
  expect(await stage.mayInfer("agent0", 10)).toBe(false);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "more-chatter",
    payload: {},
  });
  let calls = 0;
  const result = await runOne(
    store,
    new TestDriver("synthetic/onboarding", () => {
      calls++;
      return { actions: [], costMicros: 0, summary: "must not run" };
    }),
    "blocked",
    { allowedAgentIds: ["agent0"], maxCostMicros: 10 },
  );
  expect(result.status).toBe("failed");
  expect(calls).toBe(0);
});
it("loads private memories in a fresh runtime, rejects foreign readback and requires a distinct source job", async () => {
  await begin();
  expect(
    (
      await turn([
        {
          type: "remember",
          key: "owner/memory-probe",
          content: "owner zero private phrase",
        },
        {
          type: "remember",
          key: "owner_operating_packet_v1",
          content: "Owner zero plan",
        },
      ])
    ).status,
  ).toBe("completed");
  await stage.wakeOwner(commissioner, "agent1");
  const restarted = new RuntimeStore(f.db);
  await runOne(
    restarted,
    new TestDriver("synthetic/onboarding", (job) => {
      expect(job.memory).not.toContainEqual(
        expect.objectContaining({ content: "owner zero private phrase" }),
      );
      return {
        actions: [
          {
            type: "remember",
            key: "owner/memory-readback",
            content: JSON.stringify({
              key: "owner/memory-probe",
              value: "owner zero private phrase",
              sourceVersion: 1,
            }),
          },
        ],
        costMicros: 0,
        summary: "Synthetic foreign readback rejected",
      };
    }),
    "foreign",
    { allowedAgentIds: ["agent1"], maxCostMicros: 10 },
  );
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_receipts WHERE type='owner_stage.memory_roundtrip'",
      )
    ).rowCount,
  ).toBe(0);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "fresh-read",
    payload: {},
  });
  expect(
    (
      await runOne(
        restarted,
        new TestDriver("synthetic/onboarding", (job) => {
          const memory = job.memory.find(
            (m) => m.key === "owner/memory-probe",
          )!;
          expect(memory.content).toBe("owner zero private phrase");
          return {
            actions: [
              {
                type: "remember",
                key: "owner/memory-readback",
                content: JSON.stringify({
                  key: memory.key,
                  value: memory.content,
                  sourceVersion: memory.version,
                  usedFor:
                    "Apply the restored budget plan to the next source check",
                }),
              },
            ],
            costMicros: 0,
            summary: "Synthetic private restored memory use",
          };
        }),
        "fresh",
        { allowedAgentIds: ["agent0"], maxCostMicros: 10 },
      )
    ).status,
  ).toBe("completed");
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_receipts WHERE type='owner_stage.memory_roundtrip' AND agent_id='agent0'",
      )
    ).rowCount,
  ).toBe(1);
});
it("drains action receipts before another owner turn and avoids automatic receipt wake storms", async () => {
  await begin();
  eventToAccept = evt(
    "Synthetic intro with one concrete source-sharing proposal",
  );
  expect(
    (
      await turn([
        brand,
        {
          type: "buzz_channel",
          causalId: `onboarding:${stageId}:intro`,
          channelId: room,
          content: eventToAccept.content,
          mentionAgentIds: ["agent1"],
        },
      ])
    ).status,
  ).toBe("completed");
  expect(await stage.mayInfer("agent0", 10)).toBe(false);
  await drain();
  expect(await stage.mayInfer("agent0", 10)).toBe(true);
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(1);
  const row = (await stage.checkpoint(commissioner))[0]!;
  expect(row.missing).toContain("canonical-buzz-introduction");
  await ingest(eventToAccept);
  expect((await stage.checkpoint(commissioner))[0]!.missing).not.toContain(
    "canonical-buzz-introduction",
  );
});
it("reviews only verified output, canonical peer exchange, useful later follow-up and restored memory", async () => {
  await begin();
  const intro = evt(
    "SYNTHETIC proposal: I will compare free sources; can you check freshness?",
  );
  eventToAccept = intro;
  expect(
    (
      await turn([
        brand,
        {
          type: "remember",
          key: "owner_operating_packet_v1",
          content:
            "Synthetic own plan: compare free sources against freshness.",
        },
        {
          type: "remember",
          key: "owner_capability_needs_v1",
          content: JSON.stringify({
            needs: [],
            reason: "Synthetic source baseline review fixture",
          }),
        },
        {
          type: "remember",
          key: "owner/memory-probe",
          content: "my own synthetic budget thesis",
        },
        {
          type: "schedule",
          causalId: "useful-followup",
          dueAt: new Date(Date.now() + 60000).toISOString(),
          payload: {
            kind: "onboarding.followup",
            stageId,
            task: "Review the observed source-sharing response and update the next step",
          },
        },
        {
          type: "buzz_channel",
          causalId: `onboarding:${stageId}:intro`,
          channelId: room,
          content: intro.content,
          mentionAgentIds: ["agent1"],
        },
      ])
    ).status,
  ).toBe("completed");
  await drain();
  await ingest(intro);
  await expect(
    stage.reviewOwner(commissioner, {
      agentId: "agent0",
      note: "Synthetic review must not pass yet",
    }),
  ).rejects.toThrow("OWNER_STAGE_EVIDENCE_INCOMPLETE");
  const peer = evt(
    "SYNTHETIC counterproposal: assess publication times before rankings.",
    1,
  );
  await ingest(peer);
  const response = evt(
    "SYNTHETIC accepted: I will rank sources by freshness before comparing players.",
    0,
    peer.id,
  );
  eventToAccept = response;
  expect(
    (
      await turn([
        {
          type: "remember",
          key: "owner/memory-readback",
          content: JSON.stringify({
            key: "owner/memory-probe",
            value: "my own synthetic budget thesis",
            sourceVersion: 1,
            usedFor:
              "Use the restored free-source strategy to accept the peer freshness counterproposal",
          }),
        },
        {
          type: "buzz_channel",
          causalId: "actual-peer-response",
          channelId: room,
          content: response.content,
          mentionAgentIds: ["agent1"],
          replyTo: peer.id,
        },
      ])
    ).status,
  ).toBe("completed");
  await drain();
  await ingest(response);
  await f.db.query(
    "UPDATE runtime_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE causal_id='useful-followup'",
  );
  expect(
    (
      await turn([
        {
          type: "remember",
          key: "owner/onboarding-followup",
          content:
            "SYNTHETIC completed: inspected the canonical peer response; use freshness as the first criterion.",
        },
      ])
    ).status,
  ).toBe("completed");
  const checkpoint = (await stage.checkpoint(commissioner))[0]!;
  expect(checkpoint.missing).toEqual([]);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "final-reviewed-incident",
    payload: {},
  });
  await runOne(
    store,
    new TestDriver("synthetic/onboarding", () => {
      throw Error("SYNTHETIC uncertain final incident");
    }),
    "final-incident",
    { allowedAgentIds: ["agent0"], maxCostMicros: 10 },
  );
  const incident = (
    await f.db.query(
      "SELECT * FROM runtime_reservations WHERE status='uncertain'",
    )
  ).rows[0];
  expect((await stage.checkpoint(commissioner))[0]!.missing).toEqual([
    "stage-cost-reconciliation",
  ]);
  await stage.reviewCostHold(commissioner, {
    agentId: "agent0",
    reservationId: incident.id,
    reason: "Synthetic reviewer confirmed safe continuation with full hold",
    evidenceRef: "synthetic://incident/evidence",
  });
  expect((await stage.checkpoint(commissioner))[0]!.missing).toEqual([]);
  expect(
    (await stage.checkpoint(commissioner))[0]!.advisories.join(" "),
  ).toContain("UNKNOWN");
  const restoredContext = await stage.context("agent0");
  if (restoredContext.stage !== "onboarding") throw Error("missing stage");
  expect(restoredContext.existingWork.followup).toMatchObject({
    status: "completed",
    causal_id: "useful-followup",
  });
  expect(restoredContext.existingWork.introduction).toMatchObject({
    status: "delivered",
    action: { causalId: "onboarding:" + stageId + ":intro" },
  });
  const peerContext = await stage.context("agent1");
  if (peerContext.stage !== "onboarding") throw Error("missing peer stage");
  expect(peerContext.existingWork).toMatchObject({
    followup: null,
    introduction: null,
  });
  const review = await stage.reviewOwner(commissioner, {
    agentId: "agent0",
    note: "Synthetic reviewer inspected authored content and receipts; no real agent evidence claimed.",
  });
  expect(review.receipt_id).toBeTruthy();
  expect(
    (await f.db.query("SELECT status FROM runtime_owner_stages")).rows[0]
      .status,
  ).toBe("active");
  expect((await f.db.query("SELECT 1 FROM governance_votes")).rowCount).toBe(0);
});
it("allows only an explicit staged canary for a disabled owner without resuming ordinary work", async () => {
  const manifestId = "12345678-1234-4234-9234-123456789abd";
  await f.db.query(
    "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status) VALUES($1,$2,'agent0',1,$3,'SYNTHETIC','staged')",
    [
      manifestId,
      leagueId,
      { agentId: "agent0", leagueId, model: "synthetic/onboarding" },
    ],
  );
  const { ManifestRegistry } = await import("../src/providers/manifests.js");
  const canary = await new ManifestRegistry(f.db).createCanaryJob(manifestId);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "ordinary",
    payload: {},
  });
  await f.db.query("UPDATE runtime_agents SET enabled=false WHERE id='agent0'");
  expect(
    await store.claim("ordinary", 30000, undefined, ["agent0"]),
  ).toBeNull();
  const driver = new TestDriver("synthetic/onboarding", () => ({
    actions: [],
    costMicros: 0,
    summary: "Synthetic staged canary only",
  }));
  expect(
    (
      await runOne(store, driver, "canary", {
        allowedAgentIds: ["agent0"],
        onlyCanaryJobId: canary,
        maxCostMicros: 0,
      })
    ).status,
  ).toBe("completed");
  expect(
    (await f.db.query("SELECT enabled FROM runtime_agents WHERE id='agent0'"))
      .rows[0].enabled,
  ).toBe(false);
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_jobs WHERE causal_id='ordinary'",
      )
    ).rows[0].status,
  ).toBe("pending");
  const retired = await new ManifestRegistry(f.db).createCanaryJob(manifestId);
  await f.db.query(
    "UPDATE provider_manifests SET status='retired' WHERE id=$1",
    [manifestId],
  );
  expect(
    await store.claim("retired", 30000, undefined, ["agent0"], retired),
  ).toBeNull();
});
it("preserves old appointments as cancelled history while leaving explicit canary jobs untouched", async () => {
  const old = await store.scheduleSelf("agent0", {
    causalId: "old-convention-vote",
    dueAt: new Date(),
    payload: { kind: "old-vote" },
  });
  const manifestId = "12345678-1234-4234-9234-123456789abe";
  await f.db.query(
    "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status) VALUES($1,$2,'agent0',1,$3,'SYNTHETIC','staged')",
    [
      manifestId,
      leagueId,
      { agentId: "agent0", leagueId, model: "synthetic/onboarding" },
    ],
  );
  const { ManifestRegistry } = await import("../src/providers/manifests.js");
  const canary = await new ManifestRegistry(f.db).createCanaryJob(manifestId);
  await begin();
  expect(
    (
      await f.db.query("SELECT status,payload FROM runtime_jobs WHERE id=$1", [
        old.id,
      ])
    ).rows[0],
  ).toEqual({ status: "cancelled", payload: { kind: "old-vote" } });
  expect(
    (await f.db.query("SELECT status FROM runtime_jobs WHERE id=$1", [canary]))
      .rows[0].status,
  ).toBe("pending");
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='owner_stage.previous_jobs_preserved'",
      )
    ).rows[0].details.jobs[0].id,
  ).toBe(old.id);
});
