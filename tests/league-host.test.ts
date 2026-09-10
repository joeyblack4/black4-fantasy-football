import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { LeagueClock } from "../src/league/clock.js";
import { hostBinding, getFootballHost, bindHost } from "../src/league/host.js";
let f: Awaited<ReturnType<typeof testDb>>, league: LeagueService;
const leagueId = "synthetic-host-tests",
  admin: Actor = { id: "commissioner", role: "commissioner", leagueId };
const mfl = {
  leagueId,
  expectedVersion: 0,
  idempotencyKey: "bind",
  host: "mfl",
  config: {
    season: 2026,
    leagueId: "46625",
    configRef: "SYNTHETIC_MFL_CONFIG",
  },
  reason: "Synthetic host selection test; no external calls",
};
beforeEach(async () => {
  f = await testDb();
  league = new LeagueService(f.db);
  await league.execute(admin, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "Synthetic host test",
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
      name: "Fixture " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
});
afterEach(async () => {
  await f?.close();
});
it("defaults unbound fixtures to custom/version0 but persists an explicit versioned MFL identity", async () => {
  expect(await hostBinding(f.db, leagueId)).toEqual({
    host: "custom",
    version: 0,
    config: {},
  });
  await f.db.query(
    "INSERT INTO public_league_releases(league_id,mode,approved_by,scope_hash,enabled) VALUES($1,'rehearsal','commissioner','synthetic-scope',true)",
    [leagueId],
  );
  const bound = await bindHost(f.db, admin, mfl);
  expect(
    (
      await f.db.query(
        "SELECT enabled FROM public_league_releases WHERE league_id=$1",
        [leagueId],
      )
    ).rows[0].enabled,
  ).toBe(false);
  expect(bound.binding).toEqual({
    host: "mfl",
    version: 1,
    config: mfl.config,
  });
  expect(await getFootballHost(f.db, leagueId)).toEqual({
    kind: "mfl",
    version: 1,
    identity: mfl.config,
  });
  expect((await bindHost(f.db, admin, mfl)).receiptId).toBe(bound.receiptId);
  await expect(
    bindHost(f.db, admin, {
      ...mfl,
      config: { ...mfl.config, leagueId: "999" },
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(
    (await f.db.query("SELECT * FROM league_host_receipts")).rows,
  ).toHaveLength(1);
});
it("blocks all custom mutations and even old success replay after MFL selection, without adding receipts", async () => {
  const before = (
    await f.db.query("SELECT count(*)::int n FROM league_command_receipts")
  ).rows[0].n;
  await bindHost(f.db, admin, mfl);
  const cases = [
    {
      type: "importPlayers",
      players: [{ id: "p", name: "Synthetic", positions: ["RB"] }],
    },
    { type: "startDraft" },
    { type: "setDraftQueue", playerIds: [] },
    {
      type: "ratifyConstitution",
      version: "v1",
      decisionReceipt: "not-an-MFL-rules-receipt",
    },
    { type: "advanceWeek", week: 2 },
  ];
  for (const command of cases)
    await expect(
      league.execute(admin, {
        ...command,
        leagueId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("custom football mutations");
  await expect(
    league.execute(admin, {
      type: "createLeague",
      leagueId,
      idempotencyKey: "create",
      name: "Synthetic host test",
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
        name: "Fixture " + i,
        kind: i < 10 ? "ai" : "human",
      })),
    }),
  ).rejects.toThrow("custom football mutations");
  expect(
    (await f.db.query("SELECT count(*)::int n FROM league_command_receipts"))
      .rows[0].n,
  ).toBe(before);
  expect(
    (
      await f.db.query("SELECT constitution_version FROM leagues WHERE id=$1", [
        leagueId,
      ])
    ).rows[0].constitution_version,
  ).toBeNull();
});
it("the custom clock refuses an MFL league even with no due work", async () => {
  await bindHost(f.db, admin, mfl);
  await expect(
    new LeagueClock(f.db).tick({ ...admin, role: "system" }, { leagueId }),
  ).rejects.toMatchObject({ code: "FOOTBALL_HOST_MISMATCH" });
});
it("rejects forged role, foreign scope, secrets in config and stale versions; concurrent switches have one winner", async () => {
  await expect(
    bindHost(f.db, { ...admin, role: "owner", teamId: "t0" }, mfl),
  ).rejects.toThrow("scoped commissioner");
  await expect(
    bindHost(f.db, { ...admin, leagueId: "other" }, mfl),
  ).rejects.toThrow("another league");
  await expect(
    bindHost(f.db, admin, {
      ...mfl,
      config: { ...mfl.config, apiKey: "must-not-be-stored" },
    }),
  ).rejects.toThrow();
  await expect(
    bindHost(f.db, admin, {
      ...mfl,
      config: { ...mfl.config, configRef: "https://api.example/secret" },
    }),
  ).rejects.toThrow();
  const results = await Promise.allSettled([
    bindHost(f.db, admin, { ...mfl, idempotencyKey: "a" }),
    bindHost(f.db, admin, {
      ...mfl,
      idempotencyKey: "b",
      config: { ...mfl.config, leagueId: "999" },
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await hostBinding(f.db, leagueId)).version).toBe(1);
});
it("quarantines queued intents on selection and refuses a host switch while a dispatch is in flight", async () => {
  await f.db.query(
    "INSERT INTO runtime_agents(id,model,budget_micros) VALUES('t0','synthetic/model',0)",
  );
  const jobId = randomUUID(),
    outboxId = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at) VALUES($1,'t0','synthetic','synthetic','event','{}',clock_timestamp())",
    [jobId],
  );
  await f.db.query(
    "INSERT INTO runtime_football_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,command,status) VALUES($1,'t0',$2,'synthetic','synthetic',1,$3,'t0','o0','{}','running')",
    [outboxId, jobId, leagueId],
  );
  await expect(bindHost(f.db, admin, mfl)).rejects.toMatchObject({
    code: "HOST_DISPATCH_IN_FLIGHT",
  });
  expect((await hostBinding(f.db, leagueId)).version).toBe(0);
  await f.db.query(
    "UPDATE runtime_football_outbox SET status='pending' WHERE id=$1",
    [outboxId],
  );
  await bindHost(f.db, admin, mfl);
  expect(
    (
      await f.db.query(
        "SELECT status,error,host_kind,host_version FROM runtime_football_outbox WHERE id=$1",
        [outboxId],
      )
    ).rows[0],
  ).toEqual({
    status: "held",
    error: "HOST_BINDING_CHANGED",
    host_kind: "custom",
    host_version: 0,
  });
});
it("does not mistake an explicit malformed host record or database failure for an unbound fixture", async () => {
  const bad = {
    query: async () => ({
      rows: [{ host: "mfl", version: 1, config: { leagueId: "46625" } }],
    }),
  } as unknown as typeof f.db;
  await expect(hostBinding(bad, leagueId)).rejects.toMatchObject({
    code: "HOST_BINDING_INVALID",
  });
  const unavailable = {
    query: async () => {
      throw Error("synthetic database failure");
    },
  } as unknown as typeof f.db;
  await expect(hostBinding(unavailable, leagueId)).rejects.toThrow(
    "synthetic database failure",
  );
});
it("refuses a host switch while a bound owner or staff model turn is running", async () => {
  await f.db.query(
    "INSERT INTO runtime_agents(id,model,budget_micros) VALUES('owner-turn','synthetic/model',0)",
  );
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES('owner-turn',$1,'t0')",
    [leagueId],
  );
  const jobId = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,status) VALUES($1,'owner-turn','synthetic','synthetic','event','{}',clock_timestamp(),'running')",
    [jobId],
  );
  await expect(bindHost(f.db, admin, mfl)).rejects.toMatchObject({
    code: "HOST_OWNER_TURN_IN_FLIGHT",
  });
  expect((await hostBinding(f.db, leagueId)).version).toBe(0);
  await f.db.query("UPDATE runtime_jobs SET status='completed' WHERE id=$1", [
    jobId,
  ]);
  expect((await bindHost(f.db, admin, mfl)).binding.version).toBe(1);
});
