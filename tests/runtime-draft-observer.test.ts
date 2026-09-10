import { RehearsalRuntime } from "../src/runtime/rehearsal.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { MflDraftObserver } from "../src/runtime/mfl-draft-observer.js";
import { MflAdapter, PgMflJournal } from "../src/mfl/index.js";
import { bindHost } from "../src/league/host.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { createMflOwnerReadTools } from "../src/runtime/mfl-tools.js";
let f: Awaited<ReturnType<typeof testDb>>,
  runtime: RuntimeStore,
  observer: MflDraftObserver,
  adapter: MflAdapter,
  calls: number;
let nativeDraftKind: string;
let mflLeagueId: string;
let state: {
  round: number;
  pick: number;
  franchise: string;
  paused: boolean;
  over: boolean;
  completed: {
    round: number;
    pick: number;
    franchise: string;
    player: string;
  }[];
};
let duringRead: (() => Promise<void>) | undefined;
const leagueId = "observer-fixture",
  commissioner = {
    id: "commissioner",
    role: "commissioner" as const,
    leagueId,
  };
beforeEach(async () => {
  f = await testDb();

  runtime = new RuntimeStore(f.db);
  calls = 0;
  nativeDraftKind = "live";
  mflLeagueId = "12345";
  duringRead = undefined;
  state = {
    round: 1,
    pick: 1,
    franchise: "0001",
    paused: false,
    over: false,
    completed: [],
  };
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'Synthetic observer','{}')",
    [leagueId],
  );
  for (let i = 0; i < 3; i++) {
    const kind = i === 2 ? "human" : "ai";
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,$4,$5,$5,100)",
      [leagueId, `team${i}`, `owner${i}`, kind, i],
    );
    await runtime.createAgent({
      id: `agent${i}`,
      kind,
      model: "synthetic/draft",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`agent${i}`, leagueId, `team${i}`],
    );
  }
  await bindHost(f.db, commissioner, {
    leagueId,
    host: "mfl",
    expectedVersion: 0,
    idempotencyKey: "host",
    reason: "Synthetic observer binding",
    config: { season: 2026, leagueId: "12345", configRef: "synthetic" },
  });
  adapter = new MflAdapter(
    {
      leagueId,
      season: 2026,
      host: "www47.myfantasyleague.com",
      mflLeagueId: "12345",
      mode: "synthetic",
      userAgent: "Black4-test",
      franchises: [0, 1, 2].map((i) => ({
        teamId: `team${i}`,
        ownerId: `owner${i}`,
        franchiseId: `000${i + 1}`,
      })),
    },
    {
      journal: new PgMflJournal(f.db),
      getSessionCookie: async () => "SYNTHETIC",
      fetchImpl: async (url, init) => {
        expect(init?.method ?? "GET").toBe("GET");
        if (new URL(String(url)).searchParams.get("TYPE") === "league")
          return Response.json({
            league: {
              id: mflLeagueId,
              draft_kind: nativeDraftKind,
              loadRosters:
                nativeDraftKind === "live" ? "live_draft" : "email_draft",
            },
          });
        expect(String(url)).toContain("_LEAGUE_draft_results.xml");
        calls++;
        await duringRead?.();
        const rows = state.completed
          .map(
            (p) =>
              `<draftPick round="${p.round}" pick="${p.pick}" franchise="${p.franchise}" player="${p.player}"/>`,
          )
          .join("");
        return new Response(
          `<draftResults round="${state.round}" pick="${state.pick}" franchise_id="${state.franchise}" paused="${state.paused ? "1" : "0"}" over="${state.over ? "1" : "0"}" timestamp="100">${rows}</draftResults>`,
          { status: 200 },
        );
      },
    },
  );
  observer = new MflDraftObserver(f.db, runtime, async () => adapter);
});
afterEach(async () => {
  await f?.close();
});
async function configure() {
  await observer.configure(commissioner, {
    epoch: "synthetic-epoch",
    expectedHostVersion: 1,
    synthetic: true,
  });
}
it("refuses to arm native email mode despite future static draft slots", async () => {
  nativeDraftKind = "email";
  await expect(configure()).rejects.toMatchObject({
    code: "MFL_NATIVE_LIVE_DRAFT_REQUIRED",
  });
  expect(calls).toBe(0);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_mfl_draft_observers")).rowCount,
  ).toBe(0);
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(0);
});
it("holds an armed observer if native mode changes to email before polling and never wakes a future slot", async () => {
  await configure();
  nativeDraftKind = "email";
  expect(await observer.poll(commissioner)).toMatchObject({
    status: "held",
    reason: "MFL_NATIVE_LIVE_DRAFT_REQUIRED",
  });
  expect(calls).toBe(0);
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(0);
});
it("polls with commissioner authority and creates exactly one urgent owner job with no inference or pick", async () => {
  await expect(
    observer.configure(
      { ...commissioner, role: "owner" },
      { epoch: "bad", expectedHostVersion: 1, synthetic: true },
    ),
  ).rejects.toThrow("DRAFT_OBSERVER_COMMISSIONER_REQUIRED");
  await configure();
  const results = await Promise.all([
    observer.poll(commissioner),
    observer.poll(commissioner),
  ]);
  expect(results.filter((r) => r.status === "woken")).toHaveLength(1);
  expect(calls).toBe(1);
  expect((await observer.poll(commissioner)).status).toBe("unchanged");
  const rows = (
    await f.db.query("SELECT agent_id,priority,payload FROM runtime_jobs")
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].agent_id).toBe("agent0");
  expect(rows[0].priority).toBe("urgent");
  expect(rows[0].payload.synthetic).toBe(true);
  expect((await f.db.query("SELECT 1 FROM provider_calls")).rowCount).toBe(0);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_football_outbox")).rowCount,
  ).toBe(0);
});
it("pauses quietly, wakes each changed turn, and leaves a human turn unclaimed", async () => {
  await configure();
  state.paused = true;
  expect((await observer.poll(commissioner)).status).toBe("observed");
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(0);
  state.paused = false;
  expect((await observer.poll(commissioner)).status).toBe("woken");
  state.completed.push({
    round: 1,
    pick: 1,
    franchise: "0001",
    player: "14319",
  });
  state.pick = 2;
  state.franchise = "0002";
  expect((await observer.poll(commissioner)).status).toBe("woken");
  state.completed.push({
    round: 1,
    pick: 2,
    franchise: "0002",
    player: "14320",
  });
  state.pick = 3;
  state.franchise = "0003";
  expect((await observer.poll(commissioner)).status).toBe("woken");
  expect(await runtime.claim("human", 30000, undefined, ["agent2"])).toBeNull();
  state.over = true;
  expect((await observer.poll(commissioner)).status).toBe("observed");
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(3);
});
it("holds a reset or corrected history until a new explicit epoch is configured", async () => {
  await configure();
  state.completed = [{ round: 1, pick: 1, franchise: "0001", player: "14319" }];
  state.pick = 2;
  state.franchise = "0002";
  await observer.poll(commissioner);
  state.completed = [];
  state.pick = 1;
  state.franchise = "0001";
  expect((await observer.poll(commissioner)).status).toBe("held");
  const before = calls;
  expect((await observer.poll(commissioner)).status).toBe("held");
  expect(calls).toBe(before);
  expect(
    (
      await observer.configure(commissioner, {
        epoch: "synthetic-epoch",
        expectedHostVersion: 1,
        synthetic: true,
      })
    ).status,
  ).toBe("held");
  await observer.configure(commissioner, {
    epoch: "reviewed-reset",
    expectedHostVersion: 1,
    synthetic: true,
  });
  expect((await observer.poll(commissioner)).status).toBe("woken");
});
it("does not release an old observation after the selected host version changes", async () => {
  await configure();
  duringRead = async () => {
    duringRead = undefined;
    await bindHost(f.db, commissioner, {
      leagueId,
      host: "mfl",
      expectedVersion: 1,
      idempotencyKey: "host2",
      reason: "Synthetic reviewed host revision",
      config: { season: 2026, leagueId: "12345", configRef: "synthetic-v2" },
    });
  };
  expect((await observer.poll(commissioner)).status).toBe("held");
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(0);
});
it("model-authored local queue dispatch verifies its receipt without any native request and reads privately", async () => {
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "queue-preparation",
    payload: { synthetic: true },
  });
  const driver = new TestDriver("synthetic/draft", () => ({
    actions: [
      {
        type: "football",
        causalId: "queue-v1",
        command: {
          type: "mflLocalDraftQueue",
          expectedVersion: 0,
          playerIds: ["14319", "14320"],
        },
      },
    ],
    costMicros: 0,
    summary: "Synthetic owner preference fixture",
  }));
  expect(
    (
      await runOne(runtime, driver, "queue-worker", {
        maxCostMicros: 10,
        allowedAgentIds: ["agent0"],
      })
    ).status,
  ).toBe("completed");
  const outbox = new FootballOutbox(f.db, runtime, undefined, async () => {
    throw Error("No native adapter should be loaded for a local preference");
  });
  const claim = (await outbox.claim("queue-outbox"))!;
  await expect(
    outbox.acknowledge(claim, {
      receiptId: "forged",
      result: {},
      replayed: false,
    }),
  ).rejects.toThrow();
  const receipt = await outbox.execute(claim);
  expect(receipt.result.nativeQueueUploaded).toBe(false);
  expect(receipt.result.automaticPickAuthorized).toBe(false);
  await outbox.acknowledge(claim, receipt);
  expect(calls).toBe(0);
  await runtime.ingestEvent({
    agentId: "agent1",
    causalId: "own-queue",
    payload: { synthetic: true },
  });
  const job0 = (await runtime.claim("queue-read0", 30000, undefined, [
      "agent0",
    ]))!,
    job1 = (await runtime.claim("queue-read1", 30000, undefined, ["agent1"]))!;
  const read = createMflOwnerReadTools(f.db, async () => {
    throw Error("Local queue read must not load a native session");
  })[0];
  expect(
    ((await read.execute(job0, { type: "localDraftQueue" })) as any).playerIds,
  ).toEqual(["14319", "14320"]);
  expect(
    ((await read.execute(job1, { type: "localDraftQueue" })) as any).playerIds,
  ).toEqual([]);
  expect(calls).toBe(0);
});
it("fences an expired polling lease before it can wake an owner", async () => {
  await configure();
  duringRead = async () => {
    duringRead = undefined;
    await f.db.query(
      "UPDATE runtime_mfl_draft_observers SET lease_until=clock_timestamp()-interval '1 second' WHERE league_id=$1",
      [leagueId],
    );
  };
  expect((await observer.poll(commissioner)).status).toBe("stale");
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(0);
  expect((await observer.poll(commissioner)).status).toBe("woken");
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(1);
});

async function armRehearsal() {
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  await bindHost(f.db, commissioner, {
    leagueId,
    host: "mfl",
    expectedVersion: 1,
    idempotencyKey: "production-before-rehearsal",
    reason: "Synthetic production identity before trial",
    config: {
      season: 2026,
      leagueId: "62282",
      configRef: "synthetic-production",
    },
  });
  await new RehearsalRuntime(f.db, runtime).arm(commissioner, {
    epoch: "trial-observer",
    expectedHostVersion: 2,
    trialConfigRef: "synthetic-trial",
    capMicros: 100,
    synthetic: true,
    operatorEvidenceRef: "SYNTHETIC paused test readiness",
    reason: "Synthetic observer rehearsal integration",
  });
  mflLeagueId = "46625";
  adapter.config.mflLeagueId = mflLeagueId;
  await observer.configure(commissioner, {
    epoch: "trial-observer",
    expectedHostVersion: 3,
    synthetic: true,
  });
  await f.db.query("UPDATE runtime_agents SET enabled=true");
}
it("atomically tags a fresh rehearsal AI draft wake once and permits only that epoch job to be claimed", async () => {
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "old-production",
    payload: { synthetic: true },
  });
  await armRehearsal();
  expect((await observer.poll(commissioner)).status).toBe("woken");
  expect((await observer.poll(commissioner)).status).toBe("unchanged");
  const tagged = (await f.db.query("SELECT * FROM runtime_rehearsal_jobs"))
    .rows;
  expect(tagged).toHaveLength(1);
  expect(tagged[0]).toMatchObject({
    agent_id: "agent0",
    epoch: "trial-observer",
    source: "draft-observer",
  });
  const job = await runtime.claim("trial-worker", 30000, undefined, ["agent0"]);
  expect(job?.id).toBe(tagged[0].job_id);
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_jobs WHERE causal_id='old-production'",
      )
    ).rows[0].status,
  ).toBe("pending");
});
it("leaves rehearsal human-seat notification untagged and never claims it as an AI owner", async () => {
  await armRehearsal();
  state.franchise = "0003";
  expect((await observer.poll(commissioner)).status).toBe("woken");
  expect(
    (await f.db.query("SELECT 1 FROM runtime_rehearsal_jobs")).rowCount,
  ).toBe(0);
  expect(
    await runtime.claim("human-not-a-worker", 30000, undefined, ["agent2"]),
  ).toBeNull();
});
it("rolls back an AI observer wake when the rehearsal is no longer armed", async () => {
  await armRehearsal();
  await f.db.query("UPDATE runtime_rehearsals SET status='stopped'");
  await expect(observer.poll(commissioner)).rejects.toThrow(
    "REHEARSAL_WAKE_HOST_MISMATCH",
  );
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(0);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_rehearsal_jobs")).rowCount,
  ).toBe(0);
});

async function configureNative() {
  await f.db.query(
    "INSERT INTO buzz_league_bindings(league_id,community_url,mode,binding_receipt_id,archive_consent_receipt_id,configuration_hash) VALUES($1,'wss://black4fantasysports.communities.buzz.xyz','mock','fixture','fixture','fixture')",
    [leagueId],
  );
  for (let i = 0; i < 3; i++)
    await f.db.query(
      "INSERT INTO buzz_participants(league_id,pubkey,owner_id,team_id,owner_pubkey,kind) VALUES($1,$2,$3,$4,$5,$6)",
      [
        leagueId,
        String(i + 1).repeat(64),
        `owner${i}`,
        `team${i}`,
        "f".repeat(64),
        i === 2 ? "human" : "agent",
      ],
    );
  await observer.configure(commissioner, {
    epoch: "native-test",
    expectedHostVersion: 1,
    synthetic: true,
    deliveryMode: "native-buzz",
  });
}
it("native observer queues one on-clock notice, never generic cognition, and confirms completed picks once", async () => {
  await configureNative();
  expect((await observer.poll(commissioner)).status).toBe("queued");
  await observer.poll(commissioner);
  expect(
    (await f.db.query("SELECT * FROM runtime_native_draft_notifications"))
      .rowCount,
  ).toBe(1);
  expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(0);
  state.completed = [{ round: 1, pick: 1, franchise: "0001", player: "12345" }];
  state.pick = 2;
  state.franchise = "0002";
  await observer.poll(commissioner);
  await observer.poll(commissioner);
  const notices = (
    await f.db.query("SELECT kind FROM runtime_native_draft_notifications")
  ).rows;
  expect(notices.filter((n) => n.kind === "pick-confirmed")).toHaveLength(1);
  expect(notices.filter((n) => n.kind === "on-clock")).toHaveLength(2);
});
it("native manual pause suppresses polls and resume requires fresh observation with one new wake", async () => {
  await configureNative();
  await observer.poll(commissioner);
  await observer.setPaused(commissioner, true, "Joey requested a pause");
  expect((await observer.poll(commissioner)).status).toBe("held");
  await observer.setPaused(commissioner, false, "Ready again");
  expect(
    (
      await f.db.query(
        "SELECT last_observed_at FROM runtime_mfl_draft_observers",
      )
    ).rows[0].last_observed_at,
  ).toBeNull();
  await observer.poll(commissioner);
  await observer.poll(commissioner);
  expect(
    (
      await f.db.query(
        "SELECT * FROM runtime_native_draft_notifications WHERE kind='on-clock'",
      )
    ).rowCount,
  ).toBe(2);
});
