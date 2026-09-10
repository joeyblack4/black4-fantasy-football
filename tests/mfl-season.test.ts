import { it, expect } from "vitest";
import {
  settings,
  validateLineup,
  nflGames,
  calendarEvents,
} from "../src/mfl/season.js";
import { MflOwnerReadSchema } from "../src/mfl/contracts.js";
const rules = settings({
  league: {
    id: "62282",
    rosterSize: "16",
    partialLineupAllowed: "NO",
    starters: {
      count: "9",
      position: [
        ["QB", "1"],
        ["RB", "2-3"],
        ["WR", "2-3"],
        ["TE", "1-2"],
        ["PK", "1"],
        ["Def", "1"],
      ].map(([name, limit]) => ({ name, limit })),
    },
  },
});
const roster = [
  "QB",
  "RB",
  "RB",
  "WR",
  "WR",
  "TE",
  "WR",
  "PK",
  "Def",
  "WR",
].map((position, i) => ({ id: String(10000 + i), position, nflTeam: "ABC" }));
const starters = roster.slice(0, 9).map((p) => p.id);
const base = {
  starters,
  roster,
  currentStarters: starters,
  settings: rules,
  games: [
    {
      id: "game",
      week: 1,
      kickoffAt: "2026-09-09T20:00:00Z",
      teams: ["ABC"],
      gameSecondsRemaining: 3600,
    },
  ],
  now: "2026-09-09T19:00:00Z",
  lockPolicyVerified: true,
};
it("validates exactly nine, position minima and one flex without making football choices", () => {
  expect(validateLineup(base)).toMatchObject({ valid: true, submitted: false });
  expect(
    validateLineup(base).slots.filter((s) => s.slot === "FLEX"),
  ).toHaveLength(1);
  for (const invalid of [
    starters.slice(0, 8),
    [...starters, "10009"],
    starters.filter((id) => id !== "10007"),
  ])
    expect(validateLineup({ ...base, starters: invalid }).valid).toBe(false);
});
it("reports duplicate, unowned and position errors as structured results", () => {
  const r = validateLineup({
    ...base,
    starters: ["10000", "10000", ...starters.slice(2, 8), "19999"],
  });
  expect(r.issues.map((i) => i.code)).toEqual(
    expect.arrayContaining([
      "DUPLICATE_PLAYERS",
      "PLAYERS_NOT_OWNED",
      "POSITION_COUNT",
    ]),
  );
  expect(
    MflOwnerReadSchema.parse({
      type: "validateLineup",
      week: 1,
      starters: ["10000", "10000"],
    }).type,
  ).toBe("validateLineup");
});
it("allows a missing kicker or early-game-only lineup when the host permits partial lineups", () => {
  const settings = { ...rules, partialLineupAllowed: true };
  for (const chosen of [starters.filter((id) => id !== "10007"), ["10000"], []])
    expect(
      validateLineup({ ...base, settings, starters: chosen }),
    ).toMatchObject({ valid: true, submitted: false });
});
it("partial lineups retain maximum counts, ownership, duplicates and kickoff locks", () => {
  const settings = { ...rules, partialLineupAllowed: true };
  for (const chosen of [
    [...starters, "10009"],
    ["10003", "10004", "10006", "10009"],
    ["19999"],
    ["10000", "10000"],
  ])
    expect(validateLineup({ ...base, settings, starters: chosen }).valid).toBe(
      false,
    );
  expect(
    validateLineup({
      ...base,
      settings,
      now: "2026-09-09T20:00:00Z",
      starters: starters.filter((id) => id !== "10007"),
    }).issues,
  ).toContainEqual({ code: "LOCKED_PLAYER_CHANGE", playerIds: ["10007"] });
  expect(
    validateLineup({
      ...base,
      settings,
      currentStarters: ["10000"],
      starters: ["10000"],
      now: "2026-09-09T20:00:00Z",
    }).valid,
  ).toBe(true);
});
it("unknown partial-lineup policy cannot approve an incomplete lineup", () => {
  expect(
    validateLineup({
      ...base,
      settings: { ...rules, partialLineupAllowed: null },
      starters: ["10000"],
    }),
  ).toMatchObject({ valid: null, unknowns: ["partial-lineup-policy"] });
});
it("permits untouched locked players and forbids swapping either in or out at kickoff", () => {
  const now = "2026-09-09T20:00:00Z";
  expect(validateLineup({ ...base, now }).valid).toBe(true);
  const r = validateLineup({
    ...base,
    now,
    starters: [...starters.slice(0, 6), "10009", ...starters.slice(7)],
  });
  expect(
    r.issues.filter((i) => i.code === "LOCKED_PLAYER_CHANGE"),
  ).toHaveLength(2);
});
it("unknown settings and unknown kickoff never become false assurance", () => {
  expect(
    validateLineup({ ...base, settings: settings({ league: {} }) }).valid,
  ).not.toBe(true);
  expect(validateLineup({ ...base, lockPolicyVerified: false }).valid).toBe(
    null,
  );
  expect(
    validateLineup({ ...base, games: [], currentStarters: [] }).unknowns,
  ).toContain("kickoff-or-bye:10000");
});
it("normalizes upstream schedule timestamps and preserves uncertain calendar encoding", () => {
  expect(
    nflGames(
      {
        nflSchedule: {
          week: "1",
          matchup: {
            kickoff: "1788999600",
            team: [{ id: "NEP" }, { id: "SEA" }],
          },
        },
      },
      1,
    )[0]?.teams,
  ).toEqual(["NEP", "SEA"]);
  const e = calendarEvents({
    calendar: {
      event: { id: "1", type: "TRADE", start_time: "11", happens: "" },
    },
  })[0];
  expect(e).toMatchObject({
    startsAt: null,
    rawStart: "11",
    timingStatus: "unresolved-host-value",
  });
  expect(() => nflGames({ nflSchedule: { week: "2" } }, 1)).toThrow(
    "MFL_RESPONSE_SHAPE",
  );
});
it("preserves string player IDs including defenses and bounds broad reads", () => {
  expect(
    MflOwnerReadSchema.parse({ type: "availability", playerIds: ["0509"] }),
  ).toEqual({ type: "availability", playerIds: ["0509"] });
  expect(() =>
    MflOwnerReadSchema.parse({ type: "transactions", limit: 1000 }),
  ).toThrow();
  expect(
    MflOwnerReadSchema.parse({
      type: "players",
      unowned: true,
      nflTeam: "SEA",
    }),
  ).toMatchObject({ limit: 100, offset: 0 });
});
it("permits explicitly verified bye players without treating missing kickoff as a bye", () => {
  expect(
    validateLineup({
      ...base,
      games: [],
      byeTeams: ["ABC"],
      currentStarters: [],
    }).valid,
  ).toBe(true);
  expect(
    validateLineup({ ...base, games: [], currentStarters: [] }).valid,
  ).toBe(null);
});
