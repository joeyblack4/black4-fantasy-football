import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DataDispatcher } from "../src/data/dispatcher.js";
import { StatsService } from "../src/data/index.js";
import { syntheticReceiver } from "../src/data/fixtures.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { testDb } from "./helpers.js";
describe("data changes to durable owner inbox", () => {
  let h: Awaited<ReturnType<typeof testDb>>,
    dispatcher: DataDispatcher,
    stats: StatsService;
  const owner: Actor = {
    id: "owner-0",
    role: "owner",
    leagueId: "dispatch-test",
    teamId: "team-0",
  };
  beforeAll(async () => {
    h = await testDb();
    dispatcher = new DataDispatcher(h.db);
    stats = new StatsService(h.db);
    const league = new LeagueService(h.db),
      admin: Actor = {
        id: "admin",
        role: "commissioner",
        leagueId: owner.leagueId,
      };
    await league.execute(admin, {
      type: "createLeague",
      leagueId: owner.leagueId,
      idempotencyKey: "create",
      name: "Synthetic dispatch test",
      rules: {
        rosterSize: 1,
        draftOrder: "snake",
        draftPickSeconds: 60,
        faabBudget: 100,
        lineupSlots: [{ id: "WR", positions: ["WR"] }],
      },
      teams: Array.from({ length: 12 }, (_, i) => ({
        id: "team-" + i,
        name: "Team " + i,
        ownerId: "owner-" + i,
        kind: i < 10 ? "ai" : "human",
      })),
    });
    await league.execute(admin, {
      type: "importPlayers",
      leagueId: owner.leagueId,
      idempotencyKey: "players",
      players: [
        {
          id: syntheticReceiver.playerId,
          name: "Synthetic Player",
          positions: ["WR"],
        },
        { id: "UNWATCHED", name: "Synthetic Unwatched", positions: ["WR"] },
      ],
    });
    await new RuntimeStore(h.db).createAgent({
      id: "agent-0",
      model: "SYNTHETIC/fixture",
      budgetMicros: 1000000,
    });
    await h.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent-0", owner.leagueId, owner.teamId],
    );
  });
  afterAll(async () => h?.close());
  it("binds subscription authority and limits delivery to watched players", async () => {
    await expect(
      dispatcher.subscribe(
        { ...owner, id: "impostor" },
        {
          agentId: "agent-0",
          feedId: syntheticReceiver.feedId,
          playerId: syntheticReceiver.playerId,
        },
      ),
    ).rejects.toThrow("does not own");
    await dispatcher.subscribe(owner, {
      agentId: "agent-0",
      feedId: syntheticReceiver.feedId,
      playerId: syntheticReceiver.playerId,
    });
    await stats.ingest(syntheticReceiver);
    await stats.ingest({ ...syntheticReceiver, playerId: "UNWATCHED" });
    const receipts = await Promise.all([
      dispatcher.dispatchOnce(),
      dispatcher.dispatchOnce(),
    ]);
    expect(receipts.reduce((n, r) => n + r.delivered, 0)).toBe(1);
    expect((await h.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(1);
    expect((await dispatcher.dispatchOnce()).delivered).toBe(0);
  });
  it("repairs a crash after inbox enqueue but before delivery receipt without a second wakeup", async () => {
    await h.db.query("DELETE FROM data_deliveries"); // simulate only missing acknowledgement in this isolated fixture
    expect((await new DataDispatcher(h.db).dispatchOnce()).delivered).toBe(1);
    expect((await h.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(1);
    await stats.ingest({
      ...syntheticReceiver,
      revision: 2,
      stats: { ...syntheticReceiver.stats, receivingYards: 75 },
    });
    expect((await dispatcher.dispatchOnce()).delivered).toBe(1);
    const jobs = await h.db.query(
      "SELECT * FROM runtime_jobs ORDER BY created_at",
    );
    expect(jobs.rowCount).toBe(2);
    expect(jobs.rows[1].payload.synthetic).toBe(true);
    expect(jobs.rows[1].payload.revision).toBe("2");
    expect(jobs.rows[1].source_occurred_at.toISOString()).toBe(
      syntheticReceiver.sourceAt,
    );
    await stats.ingest({
      ...syntheticReceiver,
      revision: 3,
      stats: { ...syntheticReceiver.stats, receivingYards: 75 },
    });
    expect((await dispatcher.dispatchOnce()).delivered).toBe(0); // unchanged polling observation does not buy another model turn
  });
  it("disables further monitoring without deleting the history", async () => {
    await dispatcher.subscribe(owner, {
      agentId: "agent-0",
      feedId: syntheticReceiver.feedId,
      playerId: syntheticReceiver.playerId,
      enabled: false,
    });
    await stats.ingest({
      ...syntheticReceiver,
      revision: 4,
      stats: { ...syntheticReceiver.stats, receivingYards: 70 },
    });
    expect((await dispatcher.dispatchOnce()).delivered).toBe(0);
    expect((await h.db.query("SELECT * FROM data_deliveries")).rowCount).toBe(
      2,
    );
  });
});
