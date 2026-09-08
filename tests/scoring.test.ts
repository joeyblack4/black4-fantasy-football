import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ScoreboardService,
  roundRobin,
  regularSeasonSchedule,
  type ScoreboardConfiguration,
} from "../src/scoring/index.js";
import { StatsService, halfPprRules } from "../src/data/index.js";
import { syntheticReceiver } from "../src/data/fixtures.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { ratifySynthetic } from "./league-governance-fixture.js";
import { testDb } from "./helpers.js";
describe("round robin", () => {
  it("covers all 66 pairs exactly once in eleven complete rounds", () => {
    const teams = Array.from({ length: 12 }, (_, i) => `team-${i}`),
      rounds = roundRobin(teams);
    expect(rounds).toHaveLength(11);
    const pairs = [];
    for (const round of rounds) {
      expect(
        new Set(round.flatMap((m) => [m.homeTeamId, m.awayTeamId])).size,
      ).toBe(12);
      for (const m of round)
        pairs.push([m.homeTeamId, m.awayTeamId].sort().join("/"));
    }
    expect(new Set(pairs).size).toBe(66);
    expect(() => roundRobin(["a", "a"])).toThrow();
  });
  it("extends a fourteen-week schedule deterministically with reversed rematches", () => {
    const teams = Array.from({ length: 12 }, (_, i) => "team-" + i),
      weeks = regularSeasonSchedule(teams, 14);
    expect(weeks).toHaveLength(14);
    for (const week of weeks)
      expect(
        new Set(week.matchups.flatMap((m) => [m.homeTeamId, m.awayTeamId]))
          .size,
      ).toBe(12);
    expect(weeks[11].matchups).toEqual(
      weeks[0].matchups.map((m) => ({
        homeTeamId: m.awayTeamId,
        awayTeamId: m.homeTeamId,
      })),
    );
    expect(() => regularSeasonSchedule(teams, 18)).toThrow();
  });
});
describe("league scoreboard with synthetic stats", () => {
  let harness: Awaited<ReturnType<typeof testDb>>,
    scoreboard: ScoreboardService,
    stats: StatsService,
    config: ScoreboardConfiguration;
  const actor: Actor = {
    id: "commissioner",
    role: "commissioner",
    leagueId: "score-test",
  };
  beforeAll(async () => {
    harness = await testDb();
    scoreboard = new ScoreboardService(harness.db);
    stats = new StatsService(harness.db);
    const league = new LeagueService(harness.db),
      teamIds = Array.from({ length: 12 }, (_, i) => `team-${i}`);
    await league.execute(actor, {
      type: "createLeague",
      leagueId: actor.leagueId,
      idempotencyKey: "create",
      name: "Synthetic Test",
      rules: {
        rosterSize: 2,
        draftOrder: "snake",
        draftPickSeconds: 60,
        faabBudget: 100,
        lineupSlots: [{ id: "WR", positions: ["WR"] }],
      },
      teams: teamIds.map((id, i) => ({
        id,
        name: id,
        ownerId: "owner-" + i,
        kind: i < 10 ? "ai" : "human",
      })),
    });
    await league.execute(actor, {
      type: "importPlayers",
      leagueId: actor.leagueId,
      idempotencyKey: "players",
      players: Array.from({ length: 24 }, (_, i) => ({
        id: "SYNTHETIC-WR-" + i,
        name: "Synthetic Player " + i,
        positions: ["WR"],
      })),
    });
    await ratifySynthetic(
      harness.db,
      league,
      actor,
      teamIds.map((teamId, i) => ({
        id: "owner-" + i,
        role: "owner" as const,
        leagueId: actor.leagueId,
        teamId,
      })),
      undefined,
      halfPprRules,
    );
    config = {
      leagueId: actor.leagueId,
      week: 1,
      feedId: syntheticReceiver.feedId,
      rules: halfPprRules,
      matchups: roundRobin(teamIds)[0]!,
      playerGames: Array.from({ length: 24 }, (_, i) => ({
        playerId: "SYNTHETIC-WR-" + i,
        gameId: syntheticReceiver.gameId,
      })),
    };
  });
  afterAll(async () => harness?.close());
  it("requires scoped commissioner and rejects incomplete or duplicate matchups", async () => {
    await expect(
      scoreboard.configure({ ...actor, role: "owner" }, config),
    ).rejects.toThrow("commissioner");
    await expect(
      scoreboard.configure({ ...actor, leagueId: "other" }, config),
    ).rejects.toThrow("commissioner");
    await expect(
      scoreboard.configure(actor, {
        ...config,
        matchups: config.matchups.slice(1),
      }),
    ).rejects.toThrow("exactly one");
    await expect(
      scoreboard.configure(actor, {
        ...config,
        matchups: config.matchups.map((m, i) =>
          i === 0 ? { ...m, awayTeamId: m.homeTeamId } : m,
        ),
      }),
    ).rejects.toThrow("exactly one");
  });
  it("freezes scoring and keeps empty lineup unknown rather than final zero", async () => {
    await expect(
      scoreboard.configure(actor, {
        ...config,
        rules: {
          ...halfPprRules,
          milliPointsPerUnit: {
            ...halfPprRules.milliPointsPerUnit,
            receptions: 1000,
          },
        },
      }),
    ).rejects.toThrow("owner-voted");
    expect((await scoreboard.configure(actor, config)).replayed).toBe(false);
    expect((await scoreboard.configure(actor, config)).replayed).toBe(true);
    await expect(
      scoreboard.configure(actor, { ...config, feedId: "different" }),
    ).rejects.toThrow("immutable");
    const snapshot = await scoreboard.snapshot(actor.leagueId, 1);
    expect(
      snapshot.teams.every(
        (t) => t.milliPoints === null && t.status === "incomplete",
      ),
    ).toBe(true);
    expect(
      snapshot.matchups.every(
        (m) => m.winnerTeamId === null && m.status === "provisional",
      ),
    ).toBe(true);
  });
  it("scores starters only, preserves provenance, and updates downward on corrections", async () => {
    // Direct fixture setup isolates scoring from the separately tested draft mechanics.
    for (let i = 0; i < 12; i++)
      await harness.db.query(
        "INSERT INTO league_lineups(league_id,team_id,week,slot_id,player_id) VALUES($1,$2,1,'WR',$3)",
        [actor.leagueId, "team-" + i, "SYNTHETIC-WR-" + i],
      );
    for (let i = 0; i < 24; i++)
      await stats.ingest({
        ...syntheticReceiver,
        playerId: "SYNTHETIC-WR-" + i,
        gameStatus: "final",
      });
    const first = await scoreboard.snapshot(actor.leagueId, 1);
    expect(first.teams[0]!.milliPoints).toBe(17500);
    expect(first.teams[0]!.synthetic).toBe("synthetic");
    expect(first.teams[0]!.starters).toHaveLength(1);
    expect(
      first.matchups.every((m) => m.status === "final" && m.tied === true),
    ).toBe(true);
    const firstReceipt = first.teams[0]!.starters[0]!.provenance!.snapshotId;
    await stats.ingest({
      ...syntheticReceiver,
      playerId: "SYNTHETIC-WR-0",
      gameStatus: "final",
      revision: 2,
      stats: { ...syntheticReceiver.stats, receivingYards: 75 },
    });
    const revised = await scoreboard.snapshot(actor.leagueId, 1);
    expect(revised.teams[0]!.milliPoints).toBe(16500);
    expect(revised.teams[0]!.starters[0]!.provenance!.snapshotId).not.toBe(
      firstReceipt,
    );
    expect(
      revised.matchups.find((m) => m.homeTeamId === "team-0")!.winnerTeamId,
    ).toBe("team-11");
  });
  it("exposes all ratified regular-season weeks and their configuration status", async () => {
    const schedule = await scoreboard.schedule(actor.leagueId);
    expect(schedule.algorithm).toBe("circle-repeat-v1");
    expect(schedule.weeks).toHaveLength(14);
    expect(schedule.weeks[0].configurationStatus).toBe("configured");
    expect(schedule.weeks[1].configurationStatus).toBe("missing");
    expect(schedule.postseason).toBe("not-implemented");
  });
  it("does not finalize a matchup with partial, stale, or unknown data", async () => {
    await stats.ingest({
      ...syntheticReceiver,
      playerId: "SYNTHETIC-WR-0",
      revision: 3,
      gameStatus: "live",
      stats: { receivingYards: 85 },
    });
    const snapshot = await scoreboard.snapshot(actor.leagueId, 1);
    expect(snapshot.teams[0]!.milliPoints).toBeNull();
    expect(snapshot.teams[0]!.starters[0]!.status).toBe("partial");
    expect(
      snapshot.matchups.find((m) => m.homeTeamId === "team-0")!.winnerTeamId,
    ).toBeNull();
    await stats.ingest({
      ...syntheticReceiver,
      playerId: "SYNTHETIC-WR-0",
      revision: 4,
      gameStatus: "live",
    });
    const stale = await scoreboard.snapshot(actor.leagueId, 1);
    expect(stale.teams[0]!.status).toBe("stale");
    expect(stale.matchups.find((m) => m.homeTeamId === "team-0")!.status).toBe(
      "provisional",
    );
    await stats.ingest({
      ...syntheticReceiver,
      playerId: "SYNTHETIC-WR-0",
      revision: 5,
      gameStatus: "final",
      sourceAt: null,
    });
    const unknownTime = await scoreboard.snapshot(actor.leagueId, 1);
    expect(unknownTime.teams[0]!.starters[0]!.status).toBe("unknown-freshness");
    expect(unknownTime.teams[0]!.status).toBe("provisional");
    await harness.db.query("UPDATE leagues SET status='drafting' WHERE id=$1", [
      actor.leagueId,
    ]);
    await expect(
      scoreboard.configure(actor, { ...config, week: 2 }),
    ).rejects.toThrow("upcoming week");
  });
  it("configures future weeks with frozen rules and records optimistic mapping changes", async () => {
    await harness.db.query("UPDATE leagues SET status='active' WHERE id=$1", [
      actor.leagueId,
    ]);
    const league = new LeagueService(harness.db),
      future = new Date(Date.now() + 7 * 86400000).toISOString();
    await league.execute(actor, {
      type: "importSchedule",
      leagueId: actor.leagueId,
      idempotencyKey: "week2-schedule",
      games: Array.from({ length: 24 }, (_, i) => ({
        playerId: "SYNTHETIC-WR-" + i,
        week: 2,
        kickoffAt: future,
        status: "scheduled",
      })),
    });
    const week2 = {
      ...config,
      week: 2,
      matchups: roundRobin(
        Array.from({ length: 12 }, (_, i) => `team-${i}`),
      )[1]!,
      playerGames: [
        { playerId: "SYNTHETIC-WR-23", gameId: "SYNTHETIC-WEEK-2" },
      ],
    };
    await expect(
      scoreboard.configure(actor, {
        ...week2,
        rules: { ...halfPprRules, version: "changed-rules" },
      }),
    ).rejects.toThrow("owner-voted");
    expect((await scoreboard.configure(actor, week2)).replayed).toBe(false);
    const command = {
      leagueId: actor.leagueId,
      week: 2,
      playerId: "SYNTHETIC-WR-0",
      gameId: "SYNTHETIC-WEEK-2",
      expectedVersion: 0,
      idempotencyKey: "map-add",
      reason: "Synthetic verified schedule fixture",
    };
    await expect(
      scoreboard.addPlayerGameMapping({ ...actor, role: "owner" }, command),
    ).rejects.toThrow("commissioner");
    const receipt = await scoreboard.addPlayerGameMapping(actor, command);
    expect(receipt.version).toBe(1);
    expect(
      (await scoreboard.addPlayerGameMapping(actor, command)).replayed,
    ).toBe(true);
    await expect(
      scoreboard.addPlayerGameMapping(actor, {
        ...command,
        gameId: "different",
      }),
    ).rejects.toThrow("idempotency");
    await expect(
      scoreboard.addPlayerGameMapping(actor, {
        ...command,
        idempotencyKey: "stale",
        gameId: "different",
      }),
    ).rejects.toThrow("Stale");
    const correction = {
      ...command,
      expectedVersion: 1,
      idempotencyKey: "map-correct",
      gameId: "SYNTHETIC-WEEK-2-CORRECTED",
    };
    expect(
      (await scoreboard.addPlayerGameMapping(actor, correction)).version,
    ).toBe(2);
    const state = await scoreboard.snapshot(actor.leagueId, 2);
    expect(state.mappingHistory).toHaveLength(2);
    await stats.ingest({
      ...syntheticReceiver,
      playerId: command.playerId,
      gameId: correction.gameId,
      sourceAt: new Date().toISOString(),
    });
    await expect(
      scoreboard.addPlayerGameMapping(actor, {
        ...correction,
        expectedVersion: 2,
        idempotencyKey: "after-stats",
        gameId: "invalid-third-game",
      }),
    ).rejects.toThrow("Observed or scored");
    await harness.db.query(
      "UPDATE league_player_games SET kickoff_at=clock_timestamp()-interval '1 second' WHERE league_id=$1 AND week=2 AND player_id='SYNTHETIC-WR-1'",
      [actor.leagueId],
    );
    await expect(
      scoreboard.addPlayerGameMapping(actor, {
        ...command,
        playerId: "SYNTHETIC-WR-1",
        idempotencyKey: "after-kickoff",
      }),
    ).rejects.toThrow("unstarted");
    await expect(
      scoreboard.configure(actor, { ...week2, week: 3 }),
    ).rejects.toThrow("verified unstarted");
  });

  it("refuses legacy configurations without a matching voted formula even on reads or exact replay", async () => {
    await harness.db.query(
      "UPDATE leagues SET ratified_scoring_rules=NULL WHERE id=$1",
      [actor.leagueId],
    );
    await expect(scoreboard.snapshot(actor.leagueId, 1)).rejects.toThrow(
      "owner-voted",
    );
    await expect(scoreboard.configure(actor, config)).rejects.toThrow(
      "owner-voted",
    );
    await harness.db.query(
      "UPDATE leagues SET ratified_scoring_rules=$2 WHERE id=$1",
      [actor.leagueId, halfPprRules],
    );
  });
});
