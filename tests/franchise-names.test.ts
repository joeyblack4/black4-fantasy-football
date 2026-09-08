import { it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { FranchiseService, fingerprint } from "../src/franchise/service.js";
import {
  FranchiseNames,
  FOOTBALL_COMMUNITY,
  franchiseDisplayName,
} from "../src/franchise/names.js";
let f: Awaited<ReturnType<typeof testDb>>, names: FranchiseNames;
const leagueId = "synthetic-name-test",
  agentId = "agent0",
  pubkey = "a".repeat(64),
  ownerPubkey = "b".repeat(64);
const actor: Actor = { leagueId, role: "commissioner", id: "commissioner" },
  owner: Actor = { leagueId, role: "owner", id: "o0", teamId: "t0" };
let channelId: string, manifestId: string;
beforeEach(async () => {
  f = await testDb();
  names = new FranchiseNames(f.db);
  channelId = randomUUID();
  manifestId = randomUUID();
  await new LeagueService(f.db).execute(actor, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "setup",
    name: "Explicitly synthetic DB fixture; no Buzz or model calls",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: "t" + i,
      ownerId: "o" + i,
      name: "Setup " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await f.db.query(
    "INSERT INTO runtime_agents(id,model,budget_micros) VALUES($1,'test/model-v1',100)",
    [agentId],
  );
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
    [agentId, leagueId, "t0"],
  );
  await f.db.query(
    `INSERT INTO buzz_league_bindings VALUES($1,$2,'real','synthetic-fixture','synthetic-fixture','fixture',clock_timestamp())`,
    [leagueId, FOOTBALL_COMMUNITY],
  );
  await f.db.query(
    `INSERT INTO buzz_managed_identities(league_id,agent_id,team_id,owner_id,pubkey,community_url,credential_path,credential_fingerprint,owner_pubkey_hint,provenance) VALUES($1,$2,'t0','o0',$3,$4,'/unused/synthetic','fixture',$5,'synthetic test rows; no actual identity')`,
    [leagueId, agentId, pubkey, FOOTBALL_COMMUNITY, ownerPubkey],
  );
  await f.db.query(
    `INSERT INTO buzz_participants VALUES($1,$2,'o0','t0',$3,'agent',$4)`,
    [leagueId, pubkey, agentId, ownerPubkey],
  );
  await f.db.query(
    `INSERT INTO buzz_conversations(league_id,channel_id,kind,member_pubkeys,discovery_receipt_id) VALUES($1,$2,'private-channel',$3,'synthetic fixture')`,
    [leagueId, channelId, JSON.stringify([pubkey, ownerPubkey])],
  );
  await f.db.query(
    `INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status,activated_at) VALUES($1,$2,$3,1,$4,'fixture','active',clock_timestamp())`,
    [
      manifestId,
      leagueId,
      agentId,
      { leagueId, agentId, model: "test/model-v1" },
    ],
  );
});
afterEach(async () => {
  await f?.close();
});
async function brand(name = "Synthetic Racers", realReceipt = true) {
  const action = {
    type: "brand" as const,
    causalId: randomUUID(),
    name,
    description: "Synthetic fixture authored without inference",
    tagline: "Fixture",
    colors: ["#000000"],
  };
  const saved = await new FranchiseService(f.db).execute(owner, {
    agentId,
    idempotencyKey: action.causalId,
    action,
  });
  if (realReceipt) {
    const job = randomUUID();
    await f.db.query(
      `INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,status,completed_at) VALUES($1,$2,$3,'fixture','event','{}',clock_timestamp(),'completed',clock_timestamp())`,
      [job, agentId, action.causalId],
    );
    await f.db.query(
      `INSERT INTO provider_calls(id,manifest_id,agent_id,job_id,fence,staff_role,purpose,requested_model,requested_provider,generation_id,status) VALUES($1,$2,$3,$4,1,'owner','owner','test/model-v1','fixture','synthetic-generation','verified')`,
      [randomUUID(), manifestId, agentId, job],
    );
    await f.db.query(
      `INSERT INTO runtime_franchise_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,action,status,service_receipt) VALUES($1,$2,$3,$4,$5,1,$6,'t0','o0',$7,'delivered',$8)`,
      [
        randomUUID(),
        agentId,
        job,
        action.causalId,
        fingerprint(action),
        leagueId,
        action,
        saved,
      ],
    );
  }
  return saved;
}
const reconcile = () => names.reconcile(actor, { teamId: "t0", channelId });
it("requires actual receipt chain and rejects direct API brands, wrong actor, community and channel", async () => {
  await expect(reconcile()).rejects.toThrow("OWNER_BRAND_REQUIRED");
  await brand("Synthetic Racers", false);
  await expect(reconcile()).rejects.toThrow(
    "REAL_OWNER_BRAND_RECEIPT_REQUIRED",
  );
  await expect(
    names.reconcile(owner, { teamId: "t0", channelId }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    names.reconcile(
      { ...actor, leagueId: "other" },
      { teamId: "t0", channelId },
    ),
  ).rejects.toThrow("NAME_BINDING_FORBIDDEN");
  await expect(
    names.reconcile(actor, { teamId: "t0", channelId: randomUUID() }),
  ).rejects.toThrow("NAME_BINDING_FORBIDDEN");
  await f.db.query("UPDATE buzz_league_bindings SET mode='mock'");
  await expect(reconcile()).rejects.toThrow("NAME_BINDING_FORBIDDEN");
});
it("updates only display text atomically once, retaining owner identity and exact model slug", async () => {
  await brand();
  const results = await Promise.all([reconcile(), reconcile()]);
  expect(results.filter((r) => r.replayed)).toHaveLength(1);
  expect(results[0].receipt.desired_name).toBe(
    "Synthetic Racers - test/model-v1",
  );
  expect(results[0].buzzStatus).toBe("operator-readback-required");
  const t = (await f.db.query("SELECT * FROM league_teams WHERE id='t0'"))
    .rows[0];
  expect(t).toMatchObject({
    name: "Synthetic Racers - test/model-v1",
    id: "t0",
    owner_id: "o0",
  });
  expect(
    (await f.db.query("SELECT * FROM franchise_name_receipts")).rowCount,
  ).toBe(1);
});
it("prepares exact operator argv, rejects foreign profile and mismatched readback without network", async () => {
  await brand();
  const r = (await reconcile()).receipt;
  const command = {
    receiptId: r.id,
    observedPubkey: pubkey,
    currentManagedName: "Setup 0",
    profileReference: "synthetic profile receipt",
  };
  const h = await names.prepareBuzzHandoff(actor, command);
  expect(h.args).toEqual([
    "agents",
    "draft-update",
    "--channel",
    channelId,
    "--agent-name",
    "Setup 0",
    "--display-name",
    "Synthetic Racers - test/model-v1",
  ]);
  expect(h.externalWritePerformed).toBe(false);
  expect(h.requiresDesktopSave).toBe(true);
  await expect(
    names.prepareBuzzHandoff(actor, {
      ...command,
      observedPubkey: "c".repeat(64),
    }),
  ).rejects.toThrow("NAME_PUBKEY_MISMATCH");
  const evidence = {
    receiptId: r.id,
    pubkey,
    profileName: r.desired_name,
    managedName: r.desired_name,
    profileEventId: "d".repeat(64),
    managedReadbackReference: "synthetic UI receipt",
  };
  await expect(
    names.attestBuzzReadback(actor, { ...evidence, managedName: "Wrong" }),
  ).rejects.toThrow("NAME_READBACK_MISMATCH");
  expect(
    (await names.attestBuzzReadback(actor, evidence)).automatedVerification,
  ).toBe(false);
});
it("supersedes old handoffs after owner revises its brand or active model changes", async () => {
  await brand();
  const r = (await reconcile()).receipt;
  await brand("Synthetic New Name");
  await expect(
    names.prepareBuzzHandoff(actor, {
      receiptId: r.id,
      observedPubkey: pubkey,
      currentManagedName: "Setup 0",
      profileReference: "fixture",
    }),
  ).rejects.toThrow("NAME_RECEIPT_SUPERSEDED");
  const r2 = (await reconcile()).receipt;
  await f.db.query(
    "UPDATE provider_manifests SET status='retired' WHERE id=$1",
    [manifestId],
  );
  await expect(
    names.prepareBuzzHandoff(actor, {
      receiptId: r2.id,
      observedPubkey: pubkey,
      currentManagedName: "Setup 0",
      profileReference: "fixture",
    }),
  ).rejects.toThrow("NAME_RECEIPT_SUPERSEDED");
  await expect(reconcile()).rejects.toThrow("ACTIVE_MODEL_REQUIRED");
});
it("rejects control characters and oversize names without silently truncating or overwriting", async () => {
  expect(() => franchiseDisplayName("Bad\nName", "test/model")).toThrow();
  expect(() =>
    franchiseDisplayName("a".repeat(120), "m".repeat(100)),
  ).toThrow();
  await brand("Bad\u202EName");
  await expect(reconcile()).rejects.toThrow();
  expect(
    (await f.db.query("SELECT name FROM league_teams WHERE id='t0'")).rows[0]
      .name,
  ).toBe("Setup 0");
});
