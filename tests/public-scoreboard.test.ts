import { it, expect } from "vitest";
import {
  ScoreboardConfigSchema,
  KvPublisher,
  buildSnapshot,
  intervalFor,
  serializeSnapshot,
  type ScoreboardInputs,
} from "../src/publication/scoreboard.js";

const config = ScoreboardConfigSchema.parse({
  version: 1,
  leagueId: "test",
  leagueName: "Test League",
  attribution: "Scoring by MyFantasyLeague.",
  slotOrder: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "PK", "Def"],
  kvKeys: { live: "live.json", weekPrefix: "weeks/" },
  teams: [
    {
      teamId: "b4-team-a",
      siteId: "alpha",
      name: "Alpha",
      owner: "A Co",
      kind: "ai",
    },
    {
      teamId: "b4-team-b",
      siteId: "black4",
      name: "Black 4",
      owner: "Joey",
      kind: "human",
    },
  ],
});
const now = new Date("2026-09-14T22:00:00Z");
const players = (prefix: string) => [
  {
    id: `${prefix}01`,
    name: "QB One",
    position: "QB",
    nflTeam: "AAA",
    status: "starter",
  },
  {
    id: `${prefix}02`,
    name: "RB One",
    position: "RB",
    nflTeam: "AAA",
    status: "starter",
  },
  {
    id: `${prefix}03`,
    name: "RB Two",
    position: "RB",
    nflTeam: "BBB",
    status: "starter",
  },
  {
    id: `${prefix}04`,
    name: "WR One",
    position: "WR",
    nflTeam: "BBB",
    status: "starter",
  },
  {
    id: `${prefix}05`,
    name: "WR Two",
    position: "WR",
    nflTeam: "CCC",
    status: "starter",
  },
  {
    id: `${prefix}06`,
    name: "TE One",
    position: "TE",
    nflTeam: "CCC",
    status: "starter",
  },
  {
    id: `${prefix}07`,
    name: "WR Three",
    position: "WR",
    nflTeam: "DDD",
    status: "starter",
  },
  {
    id: `${prefix}08`,
    name: "Kicker",
    position: "PK",
    nflTeam: "DDD",
    status: "starter",
  },
  {
    id: `${prefix}09`,
    name: "Defense",
    position: "Def",
    nflTeam: "AAA",
    status: "starter",
  },
  {
    id: `${prefix}10`,
    name: "Bench RB",
    position: "RB",
    nflTeam: "BBB",
    status: "nonstarter",
  },
  {
    id: `${prefix}11`,
    name: "Bench WR",
    position: "WR",
    nflTeam: "EEE",
    status: "nonstarter",
  },
];
function inputs(overrides: Partial<ScoreboardInputs> = {}): ScoreboardInputs {
  const starters = (p: string) =>
    players(p)
      .filter((x) => x.status === "starter")
      .map((x) => x.id);
  return {
    season: 2026,
    calendar: {
      week: 1,
      games: [
        {
          id: "nfl:1:AAA-BBB",
          kickoffAt: "2026-09-13T17:00:00.000Z",
          teams: ["AAA", "BBB"],
          gameSecondsRemaining: 0,
        },
        {
          id: "nfl:1:CCC-DDD",
          kickoffAt: "2026-09-15T00:15:00.000Z",
          teams: ["CCC", "DDD"],
          gameSecondsRemaining: 1200,
        },
      ],
      byeTeams: ["EEE"],
      matchups: [
        {
          week: 1,
          teams: [
            { franchiseId: "0001", teamId: "b4-team-a", isHome: false },
            { franchiseId: "0002", teamId: "b4-team-b", isHome: true },
          ],
        },
      ],
    },
    lineups: {
      week: 1,
      teams: [
        {
          teamId: "b4-team-a",
          franchiseId: "0001",
          starters: starters("1"),
          players: players("1"),
          score: null,
          result: "T",
        },
        {
          teamId: "b4-team-b",
          franchiseId: "0002",
          starters: starters("2"),
          players: players("2"),
          score: null,
          result: "T",
        },
      ],
    },
    standings: {
      teams: [
        {
          teamId: "b4-team-a",
          wins: "0",
          losses: "0",
          ties: "0",
          winningPercentage: ".000",
          pointsFor: "0",
          pointsAgainst: "0",
          allPlayPercentage: null,
        },
        {
          teamId: "b4-team-b",
          wins: "0",
          losses: "0",
          ties: "0",
          winningPercentage: ".000",
          pointsFor: "10.5",
          pointsAgainst: "0",
          allPlayPercentage: null,
        },
      ],
    },
    scores: {
      week: 1,
      teams: [
        {
          teamId: "b4-team-a",
          franchiseId: "0001",
          score: "101.25",
          gameSecondsRemaining: "2400",
          playersYetToPlay: 0,
          playersCurrentlyPlaying: 4,
          players: [
            {
              id: "101",
              score: "20.5",
              gameSecondsRemaining: 0,
              status: "starter",
            },
            {
              id: "102",
              score: "12",
              gameSecondsRemaining: 0,
              status: "starter",
            },
            {
              id: "103",
              score: "8.75",
              gameSecondsRemaining: 0,
              status: "starter",
            },
            {
              id: "104",
              score: "15",
              gameSecondsRemaining: 0,
              status: "starter",
            },
            {
              id: "105",
              score: "10",
              gameSecondsRemaining: 1200,
              status: "starter",
            },
            {
              id: "106",
              score: "5",
              gameSecondsRemaining: 1200,
              status: "starter",
            },
            {
              id: "107",
              score: "9",
              gameSecondsRemaining: 1200,
              status: "starter",
            },
            {
              id: "108",
              score: "6",
              gameSecondsRemaining: 1200,
              status: "starter",
            },
            {
              id: "109",
              score: "15",
              gameSecondsRemaining: 0,
              status: "starter",
            },
            {
              id: "110",
              score: "22",
              gameSecondsRemaining: 0,
              status: "nonstarter",
            },
            {
              id: "111",
              score: "",
              gameSecondsRemaining: 0,
              status: "nonstarter",
            },
          ],
        },
        {
          teamId: "b4-team-b",
          franchiseId: "0002",
          score: "77.00",
          gameSecondsRemaining: "2400",
          playersYetToPlay: 0,
          playersCurrentlyPlaying: 4,
          players: [],
        },
      ],
      matchups: [["0001", "0002"]],
    },
    ...overrides,
  };
}

it("builds slot-ordered starters, a points-sorted bench, totals, matchups and ranked standings", () => {
  const snap = buildSnapshot(inputs(), config, {
    now,
    observedAt: "2026-09-14T21:59:00Z",
    availableWeeks: [],
  });
  const alpha = snap.lineups.find((l) => l.teamId === "alpha")!;
  expect(alpha.starters.map((s) => s.slot)).toEqual([
    "QB",
    "RB",
    "RB",
    "WR",
    "WR",
    "TE",
    "FLEX",
    "PK",
    "Def",
  ]);
  expect(alpha.starters[6]).toMatchObject({
    id: "107",
    slot: "FLEX",
    points: 9,
    gameStatus: "live",
  });
  expect(alpha.starters[0]).toMatchObject({
    id: "101",
    points: 20.5,
    gameStatus: "final",
  });
  expect(alpha.bench.map((b) => [b.id, b.points, b.gameStatus])).toEqual([
    ["110", 22, "final"],
    ["111", null, "bye"],
  ]);
  expect(alpha.starterTotal).toBe(101.25);
  expect(alpha.benchTotal).toBe(22);
  expect(snap.matchups).toHaveLength(1);
  expect(snap.matchups[0]).toMatchObject({
    id: "1:alpha@black4",
    status: "live",
    home: {
      teamId: "black4",
      points: 77,
      playersDone: 5,
      playersPlaying: 4,
      playersYetToPlay: 0,
      result: null,
    },
    away: { teamId: "alpha", points: 101.25 },
  });
  expect(snap.weekStatus).toBe("live");
  expect(snap.resultsOfficial).toBe(false);
  expect(snap.games.map((g) => g.status)).toEqual(["final", "live"]);
  expect(snap.standings.map((s) => [s.rank, s.teamId])).toEqual([
    [1, "black4"],
    [2, "alpha"],
  ]);
  expect(snap.sources).toEqual({
    scores: "live",
    lineups: "live",
    standings: "live",
  });
  expect(snap.teams.map((t) => t.id)).toEqual(["alpha", "black4"]);
  expect(Date.parse(snap.nextUpdateExpectedAt) - now.getTime()).toBe(150_000);
});
it("keeps unknowns null when live scoring is unavailable, and marks official results", () => {
  const snap = buildSnapshot(inputs({ scores: null }), config, {
    now,
    observedAt: null,
    availableWeeks: [2],
  });
  expect(snap.sources.scores).toBe("unavailable");
  expect(snap.matchups[0]!.home.points).toBeNull();
  expect(snap.lineups[0]!.starters.every((s) => s.points === null)).toBe(true);
  expect(snap.lineups[0]!.starterTotal).toBeNull();
  expect(snap.lineups[0]!.starters[0]!.gameStatus).toBe("final"); // from the NFL game, not a score
  expect(snap.weeks.available).toEqual([2]);
  const base = inputs({ scores: null });
  const official = buildSnapshot(
    {
      ...base,
      calendar: {
        ...base.calendar,
        games: base.calendar.games.map((g) => ({
          ...g,
          gameSecondsRemaining: 0,
        })),
      },
      lineups: {
        week: 1,
        teams: base.lineups!.teams.map((t, i) => ({
          ...t,
          score: i ? "77.00" : "101.25",
          result: i ? "L" : "W",
        })),
      },
    },
    config,
    { now, observedAt: null, availableWeeks: [] },
  );
  expect(official.resultsOfficial).toBe(true);
  expect(official.weekStatus).toBe("final");
  expect(official.matchups[0]).toMatchObject({
    status: "final",
    away: { points: 101.25, result: "W" },
    home: { result: "L" },
  });
});
it("refuses to publish an unmapped franchise", () => {
  const base = inputs();
  base.lineups!.teams.push({
    teamId: "b4-team-zzz",
    franchiseId: "0009",
    starters: [],
    players: [],
    score: null,
    result: null,
  });
  expect(() =>
    buildSnapshot(base, config, { now, observedAt: null, availableWeeks: [] }),
  ).toThrow(/SCOREBOARD_TEAM_UNMAPPED/);
});
it("intervalFor slows down when nothing is being played", () => {
  const base = buildSnapshot(inputs(), config, {
    now,
    observedAt: null,
    availableWeeks: [],
  });
  expect(intervalFor(base, now)).toBe(150_000);
  const pre = {
    ...base,
    games: base.games.map((g) => ({
      ...g,
      status: "pending" as const,
      kickoffAt: "2026-09-17T00:15:00Z",
    })),
    lineups: [],
  };
  expect(intervalFor(pre, now)).toBe(600_000);
  const soon = {
    ...pre,
    games: [
      {
        ...pre.games[0]!,
        kickoffAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      },
    ],
  };
  expect(intervalFor(soon, now)).toBe(120_000);
  expect(intervalFor({ ...pre, resultsOfficial: true }, now)).toBe(900_000);
});
it("serializes within the size guard", () => {
  const snap = buildSnapshot(inputs(), config, {
    now,
    observedAt: null,
    availableWeeks: [],
  });
  const body = serializeSnapshot(snap);
  expect(JSON.parse(body).schemaVersion).toBe(1);
  expect(() =>
    serializeSnapshot({ ...snap, attribution: "x".repeat(200_000) }),
  ).toThrow(/SCOREBOARD_TOO_LARGE/);
});
it("KvPublisher PUTs to the namespace with a bearer token and never leaks it", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const token = "kv-token-abcdefghijklmnopqrstuvwxyz";
  const ok = new KvPublisher(
    { accountId: "a".repeat(32), namespaceId: "b".repeat(32), token },
    async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return new Response('{"success":true}', { status: 200 });
    },
  );
  const r = await ok.put("live.json", '{"schemaVersion":1}');
  expect(r).toEqual({ key: "live.json", bytes: 19 });
  expect(seen[0]!.url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/storage/kv/namespaces/${"b".repeat(32)}/values/live.json`,
  );
  expect(new Headers(seen[0]!.init.headers).get("Authorization")).toBe(
    `Bearer ${token}`,
  );
  expect(seen[0]!.init.method).toBe("PUT");
  const failing = new KvPublisher(
    { accountId: "a".repeat(32), namespaceId: "b".repeat(32), token },
    async () => new Response("no", { status: 403 }),
  );
  const error = await failing.put("weeks/1.json", "{}").catch((e) => e);
  expect(error.code).toBe("KV_PUT_FAILED");
  expect(
    JSON.stringify({ ...error, message: error.message, stack: error.stack }),
  ).not.toContain(token);
  await expect(ok.put("../etc", "{}")).rejects.toMatchObject({
    code: "KV_KEY_INVALID",
  });
});
