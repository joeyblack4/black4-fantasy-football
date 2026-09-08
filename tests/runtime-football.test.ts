import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { ratifySynthetic } from "./league-governance-fixture.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { RuntimeStore, type DriverResult } from "../src/runtime/index.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { FootballActionSchema } from "../src/runtime/football-schema.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  league: LeagueService,
  outbox: FootballOutbox;
const leagueId = "outbox-league";
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  league = new LeagueService(f.db);
  outbox = new FootballOutbox(f.db, store, league);
  const cmd = (actor: Actor, input: Record<string, unknown>) =>
    league.execute(actor, { leagueId, idempotencyKey: randomUUID(), ...input });
  await cmd(commissioner, {
    type: "createLeague",
    name: "SYNTHETIC runtime football fixture",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
    teams: owners.map((o, i) => ({
      id: o.teamId,
      name: "Fixture " + i,
      ownerId: o.id,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await cmd(commissioner, {
    type: "importPlayers",
    players: owners.map((_, i) => ({
      id: "p" + i,
      name: "Synthetic player " + i,
      positions: ["RB"],
    })),
  });
  await cmd(commissioner, {
    type: "importSchedule",
    games: owners.map((_, i) => ({
      playerId: "p" + i,
      week: 1,
      kickoffAt: new Date(Date.now() + 3600000).toISOString(),
      status: "scheduled",
    })),
  });
  await ratifySynthetic(f.db, league, commissioner, owners);
  await cmd(commissioner, { type: "startDraft" });
  for (let i = 0; i < 12; i++)
    await cmd(owners[i], {
      type: "draftPick",
      expectedPick: i,
      playerId: "p" + i,
    });
  for (let i = 0; i < 2; i++) {
    await store.createAgent({
      id: "agent" + i,
      model: "synthetic/football",
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
async function queueLineup() {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "start",
    payload: { synthetic: true },
  });
  const driver = new TestDriver("synthetic/football", () => ({
    actions: [
      {
        type: "football",
        causalId: "lineup",
        command: { type: "setLineup", week: 1, slots: { RB: "p0" } },
      },
    ],
    costMicros: 0,
    summary: "Synthetic owner action, no model called",
  }));
  expect((await runOne(store, driver, "owner-worker")).status).toBe(
    "completed",
  );
}
it("synthetic owners propose and accept a trade through autonomous result wakeups", async () => {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "trade-idea",
    payload: { kind: "synthetic.trade-idea" },
  });
  const driver = new TestDriver("synthetic/football", (job) => {
    const actions: DriverResult["actions"] =
      job.payload.kind === "synthetic.trade-idea"
        ? [
            {
              type: "football",
              causalId: "propose",
              command: {
                type: "proposeTrade",
                tradeId: "synthetic-trade",
                toTeamId: "team1",
                givePlayers: ["p0"],
                receivePlayers: ["p1"],
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              },
            },
          ]
        : job.agentId === "agent1" && job.payload.commandType === "proposeTrade"
          ? [
              {
                type: "football",
                causalId: "accept",
                command: { type: "acceptTrade", tradeId: "synthetic-trade" },
              },
            ]
          : [];
    return {
      actions,
      costMicros: 0,
      summary:
        "SYNTHETIC scripted owner policy; software coordination proof only",
    };
  });
  expect((await runOne(store, driver, "owner-worker")).status).toBe(
    "completed",
  );
  expect((await f.db.query("SELECT * FROM league_trades")).rows).toHaveLength(
    0,
  );
  expect((await outbox.dispatchOne("football-worker")).status).toBe(
    "delivered",
  );
  // Origin owner's receipt wake may run before counterparty wake; no new user prompt is inserted.
  for (let i = 0; i < 2; i++) await runOne(store, driver, "owner-worker");
  expect((await outbox.dispatchOne("football-worker")).status).toBe(
    "delivered",
  );
  expect(
    (
      await f.db.query(
        "SELECT status FROM league_trades WHERE id='synthetic-trade'",
      )
    ).rows[0].status,
  ).toBe("accepted");
  const roster = (await league.snapshot(leagueId)).rosters;
  expect(roster.find((r: any) => r.player_id === "p0").team_id).toBe("team1");
  expect(roster.find((r: any) => r.player_id === "p1").team_id).toBe("team0");
  expect(
    (
      await f.db.query(
        "SELECT * FROM runtime_football_outbox WHERE status='delivered'",
      )
    ).rows,
  ).toHaveLength(2);
  const receipt = (await store.snapshot()).receipts.filter(
    (r) => r.type === "football.executed",
  );
  expect(receipt).toHaveLength(2);
});
it("replays one engine effect after simulated crash between engine commit and delivery record", async () => {
  await queueLineup();
  const original = (await outbox.claim("crashed-dispatcher", 50))!;
  const receipt = await outbox.execute(original);
  expect((await f.db.query("SELECT * FROM league_lineups")).rows).toHaveLength(
    1,
  );
  await pause(70);
  const recovered = (await outbox.claim("replacement", 5000))!;
  const replay = await outbox.execute(recovered);
  expect(replay.replayed).toBe(true);
  expect(replay.receiptId).toBe(receipt.receiptId);
  await expect(outbox.acknowledge(original, receipt)).rejects.toThrow(
    "STALE_OUTBOX_CLAIM",
  );
  await outbox.acknowledge(recovered, replay);
  expect(
    (await f.db.query("SELECT * FROM league_events WHERE type='setLineup'"))
      .rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "SELECT * FROM runtime_jobs WHERE causal_id LIKE 'football-result:%'",
      )
    ).rows,
  ).toHaveLength(1);
});
it("competing dispatchers claim a single command and forged receipts cannot mark it delivered", async () => {
  await queueLineup();
  const claims = (
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => outbox.claim("worker" + i)),
    )
  ).filter(Boolean);
  expect(claims).toHaveLength(1);
  await expect(
    outbox.acknowledge(claims[0]!, {
      receiptId: "fake",
      eventId: "fake",
      result: {},
      replayed: false,
    }),
  ).rejects.toThrow("UNVERIFIED_FOOTBALL_RECEIPT");
  const real = await outbox.execute(claims[0]!);
  await outbox.acknowledge(claims[0]!, real);
  expect((await outbox.dispatchOne("another")).status).toBe("idle");
});
it("rejects commissioner commands, actor injection and supplied league scope before enqueue", async () => {
  for (const command of [
    { type: "advanceWeek", week: 2 },
    { type: "setLineup", week: 1, slots: { RB: "p0" }, leagueId: "other" },
    { type: "setLineup", week: 1, slots: { RB: "p0" }, actor: commissioner },
    {
      type: "setLineup",
      week: 1,
      slots: { RB: "p0" },
      idempotencyKey: "chosen",
    },
  ])
    expect(
      FootballActionSchema.safeParse({
        type: "football",
        causalId: "bad",
        command,
      }).success,
    ).toBe(false);
  await store.createAgent({
    id: "unbound",
    model: "synthetic/football",
    budgetMicros: 1000,
  });
  await store.ingestEvent({
    agentId: "unbound",
    causalId: "start",
    payload: {},
  });
  const job = (await store.claim("w"))!;
  const reservationId = await store.reserve(job, 0);
  await expect(
    store.complete(job, {
      actions: [
        {
          type: "football",
          causalId: "lineup",
          command: { type: "setLineup", week: 1, slots: { RB: "p0" } },
        },
      ],
      costMicros: 0,
      summary: "synthetic",
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("FOOTBALL_BINDING_REQUIRED");
  expect(
    (await f.db.query("SELECT * FROM runtime_football_outbox")).rows,
  ).toHaveLength(0);
});
it("stale owner claim cannot queue football actions and rejects changed intent under same causal ID", async () => {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "start",
    payload: {},
  });
  const stale = (await store.claim("old", 30000))!;
  const reservationId = await store.reserve(stale, 0);
  await f.db.query(
    "UPDATE runtime_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [stale.id],
  );
  await expect(
    store.complete(stale, {
      actions: [
        {
          type: "football",
          causalId: "lineup",
          command: { type: "setLineup", week: 1, slots: { RB: "p0" } },
        },
      ],
      costMicros: 0,
      summary: "synthetic",
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("STALE_CLAIM");
  expect(
    (await f.db.query("SELECT * FROM runtime_football_outbox")).rows,
  ).toHaveLength(0);
  const fresh = (await store.claim("new"))!;
  const freshReservation = await store.reserve(fresh, 0);
  await expect(
    store.complete(fresh, {
      actions: [
        {
          type: "football",
          causalId: "same",
          command: { type: "setLineup", week: 1, slots: { RB: "p0" } },
        },
        {
          type: "football",
          causalId: "same",
          command: { type: "setLineup", week: 1, slots: {} },
        },
      ],
      costMicros: 0,
      summary: "synthetic",
      reservationId: freshReservation,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(
    (await f.db.query("SELECT * FROM runtime_football_outbox")).rows,
  ).toHaveLength(0);
});
it("engine rejection wakes owner with failure and never produces a success receipt", async () => {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "start",
    payload: {},
  });
  await runOne(
    store,
    new TestDriver("synthetic/football", () => ({
      actions: [
        {
          type: "football",
          causalId: "illegal-lineup",
          command: { type: "setLineup", week: 1, slots: { RB: "p1" } },
        },
      ],
      costMicros: 0,
      summary: "Synthetic invalid ownership fixture",
    })),
    "w",
  );
  expect((await outbox.dispatchOne("d")).status).toBe("failed");
  const snap = await store.snapshot();
  expect(snap.receipts.some((r) => r.type === "football.executed")).toBe(false);
  expect(snap.jobs.some((j) => j.payload.kind === "football.failed")).toBe(
    true,
  );
  expect((await f.db.query("SELECT * FROM league_lineups")).rows).toHaveLength(
    0,
  );
});

it("football dispatcher respects its franchise scope", async () => {
  await queueLineup();
  expect(await outbox.claim("wrong-scope", 30000, ["agent1"])).toBeNull();
  expect(
    (await outbox.dispatchOne("empty-scope", { allowedAgentIds: [] })).status,
  ).toBe("idle");
  expect(
    (await outbox.dispatchOne("right-scope", { allowedAgentIds: ["agent0"] }))
      .status,
  ).toBe("delivered");
});
