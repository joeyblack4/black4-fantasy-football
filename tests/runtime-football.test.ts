import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { ratifySynthetic } from "./league-governance-fixture.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { RuntimeStore, type DriverResult } from "../src/runtime/index.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { FootballActionSchema } from "../src/runtime/football-schema.js";
import { bindHost } from "../src/league/host.js";
import { MflAdapter, PgMflJournal } from "../src/mfl/index.js";
import { createMflOwnerReadTools } from "../src/runtime/mfl-tools.js";
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

async function mflFixture() {
  await bindHost(f.db, commissioner, {
    leagueId,
    expectedVersion: 0,
    host: "mfl",
    config: {
      season: 2026,
      leagueId: "12345",
      configRef: "synthetic-mfl-test",
    },
    reason: "Synthetic adapter isolation test",
    idempotencyKey: "host-mfl",
  });
  const state = {
    posts: 0,
    readbacksBlocked: false,
    starters: [] as string[],
    seenFranchises: [] as string[],
  };
  const adapter = new MflAdapter(
    {
      leagueId,
      season: 2026,
      host: "www45.myfantasyleague.com",
      mflLeagueId: "12345",
      mode: "synthetic",
      userAgent: "Black4 Synthetic Runtime Test",
      franchises: owners.map((o, i) => ({
        teamId: o.teamId!,
        ownerId: o.id,
        franchiseId: String(i + 1).padStart(4, "0"),
      })),
    },
    {
      journal: new PgMflJournal(f.db),
      getSessionCookie: async () => "synthetic-session",
      writesEnabled: true,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const params =
          init?.method === "POST"
            ? new URLSearchParams(String(init.body))
            : url.searchParams;
        if (init?.method === "POST") {
          state.posts++;
          expect(params.get("FRANCHISE_ID")).toBe("0001");
          state.starters = (params.get("STARTERS") ?? "")
            .split(",")
            .filter(Boolean);
          return new Response(JSON.stringify({ status: "OK" }));
        }
        if (params.get("TYPE") === "rosters") {
          const franchise = params.get("FRANCHISE")!;
          state.seenFranchises.push(franchise);
          return new Response(
            JSON.stringify({
              rosters: {
                franchise: [
                  {
                    id: franchise,
                    player: [{ id: "12345", status: "ROSTER" }],
                  },
                ],
              },
            }),
          );
        }
        if (params.get("TYPE") === "weeklyResults") {
          if (state.readbacksBlocked && state.posts > 0)
            throw Error("Synthetic readback outage");
          return new Response(
            JSON.stringify({
              weeklyResults: {
                franchise: [{ id: "0001", starters: state.starters.join(",") }],
              },
            }),
          );
        }
        throw Error("Unexpected synthetic endpoint");
      },
    },
  );
  const loader = async () => adapter;
  outbox = new FootballOutbox(f.db, store, league, loader);
  return { state, adapter, loader };
}
async function queueMflLineup() {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "mfl-lineup-wake",
    payload: { synthetic: true },
  });
  expect(
    (
      await runOne(
        store,
        new TestDriver("synthetic/football", () => ({
          actions: [
            {
              type: "football",
              causalId: "mfl-lineup",
              command: {
                type: "mfl",
                action: { type: "lineup", week: 1, starters: ["12345"] },
              },
            },
          ],
          costMicros: 0,
          summary:
            "SYNTHETIC MFL adapter fixture; no model or external network called",
        })),
        "mfl-owner",
      )
    ).status,
  ).toBe("completed");
}

it("dispatches native MFL action with persisted owner identity and acknowledges only MFL journal", async () => {
  const { state } = await mflFixture();
  await queueMflLineup();
  expect((await outbox.dispatchOne("mfl-dispatcher")).status).toBe("delivered");
  expect(state.posts).toBe(1);
  expect(state.seenFranchises).toEqual(["0001"]);
  expect((await f.db.query("SELECT * FROM league_lineups")).rowCount).toBe(0);
  const row = (await f.db.query("SELECT * FROM runtime_football_outbox"))
    .rows[0];
  expect(row.host_kind).toBe("mfl");
  expect(row.host_version).toBe(1);
  expect(row.engine_receipt.mfl.state).toBe("verified");
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM league_command_receipts WHERE idempotency_key=$1",
        ["runtime-football:" + row.id],
      )
    ).rowCount,
  ).toBe(0);
});

it("holds uncertain MFL write and reconciles by reads without a second POST", async () => {
  const { state } = await mflFixture();
  state.readbacksBlocked = true;
  await queueMflLineup();
  const result = await outbox.dispatchOne("mfl-dispatcher");
  expect(result.status).toBe("held");
  expect(state.posts).toBe(1);
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_jobs WHERE agent_id='agent0' AND payload->>'kind'='football.held'",
      )
    ).rowCount,
  ).toBe(1);
  expect((await outbox.dispatchOne("must-not-retry")).status).toBe("idle");
  state.readbacksBlocked = false;
  expect(
    await outbox.reconcileHeld(result.outboxId!, "operator-reconcile"),
  ).toBe("delivered");
  expect(state.posts).toBe(1);
});

it("recovers journaled MFL success after a delivery-record crash without duplicate external effect", async () => {
  const { state } = await mflFixture();
  await queueMflLineup();
  const result = await outbox.dispatchOne("crash-gap", {
    afterExecute: async () => {
      throw Error("Synthetic process boundary");
    },
  });
  expect(result.status).toBe("held");
  expect(await outbox.reconcileHeld(result.outboxId!, "operator")).toBe(
    "delivered",
  );
  expect(state.posts).toBe(1);
});

it("MFL selection freezes queued custom intents and rejects new custom commands", async () => {
  await queueLineup();
  await mflFixture();
  expect((await outbox.dispatchOne("must-not-use-custom")).status).toBe("idle");
  expect(
    (await f.db.query("SELECT status FROM runtime_football_outbox")).rows[0]
      .status,
  ).toBe("held");
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "wrong-host",
    payload: {},
  });
  const job = (await store.claim("wrong-host"))!;
  const reservationId = await store.reserve(job, 0);
  await expect(
    store.complete(job, {
      actions: [
        {
          type: "football",
          causalId: "new-custom",
          command: { type: "setLineup", week: 1, slots: {} },
        },
      ],
      costMicros: 0,
      summary: "synthetic",
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("FOOTBALL_COMMAND_HOST_MISMATCH");
});

it("rejects forged MFL receipt and stale host revision before external dispatch", async () => {
  const { state } = await mflFixture();
  await queueMflLineup();
  const claim = (await outbox.claim("mfl-dispatcher"))!;
  await expect(
    outbox.acknowledge(claim, {
      receiptId: "forged",
      replayed: false,
      result: {},
    }),
  ).rejects.toThrow("UNVERIFIED_FOOTBALL_RECEIPT");
  await f.db.query(
    "UPDATE league_host_bindings SET version=version+1 WHERE league_id=$1",
    [leagueId],
  );
  await expect(outbox.execute(claim)).rejects.toThrow("FOOTBALL_HOST_CHANGED");
  expect(state.posts).toBe(0);
});

it("MFL read tools enforce live same-model job and stored franchise scope", async () => {
  const { state, loader } = await mflFixture();
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "mfl-read",
    payload: {},
  });
  const job = (await store.claim("reader"))!;
  const tool = createMflOwnerReadTools(f.db, loader)[0];
  await expect(
    tool.execute({ ...job, model: "different-model" }, { type: "roster" }),
  ).rejects.toThrow("MFL_JOB_AUTHORITY_EXPIRED");
  await expect(
    tool.execute(job, { type: "roster", teamId: "team1" }),
  ).rejects.toThrow();
  const receipt = (await tool.execute(job, { type: "roster" })) as {
    teamId: string;
  };
  expect(receipt.teamId).toBe("team0");
  expect(state.seenFranchises).toEqual(["0001"]);
  await f.db.query(
    "UPDATE runtime_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await expect(tool.execute(job, { type: "roster" })).rejects.toThrow(
    "MFL_JOB_AUTHORITY_EXPIRED",
  );
});

it("missing MFL configuration holds the intent without custom-engine fallback", async () => {
  await mflFixture();
  await queueMflLineup();
  outbox = new FootballOutbox(f.db, store, league, async () => {
    throw Error("Synthetic unavailable private configuration");
  });
  expect((await outbox.dispatchOne("missing-config")).status).toBe("held");
  expect((await f.db.query("SELECT 1 FROM league_lineups")).rowCount).toBe(0);
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_receipts WHERE type='mfl_operation'",
      )
    ).rowCount,
  ).toBe(0);
  expect((await outbox.dispatchOne("no-blind-retry")).status).toBe("idle");
});

it("MFL owner payload cannot inject authority or address another league's team", async () => {
  await mflFixture();
  expect(
    FootballActionSchema.safeParse({
      type: "football",
      causalId: "injected",
      command: {
        type: "mfl",
        action: {
          type: "lineup",
          week: 1,
          starters: ["12345"],
          actor: commissioner,
        },
      },
    }).success,
  ).toBe(false);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "cross-league",
    payload: {},
  });
  const job = (await store.claim("cross-league"))!;
  const reservationId = await store.reserve(job, 0);
  await expect(
    store.complete(job, {
      actions: [
        {
          type: "football",
          causalId: "cross-league-trade",
          command: {
            type: "mfl",
            action: {
              type: "proposeTrade",
              counterpartyTeamId: "unbound-other-league",
              givePlayerIds: ["12345"],
              receivePlayerIds: ["23456"],
            },
          },
        },
      ],
      costMicros: 0,
      summary: "synthetic",
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("FOOTBALL_PEER_SCOPE_FORBIDDEN");
  expect(
    (await f.db.query("SELECT 1 FROM runtime_football_outbox")).rowCount,
  ).toBe(0);
});
