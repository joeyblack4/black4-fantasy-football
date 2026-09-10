/** League facts and mechanical legality only; no football advice or player health inference. */
import { list, csv } from "./codec.js";
import { MflError } from "./contracts.js";
export const SEASON_INTERFACE_VERSION = "2026-09-10.1";
export const int = (v: unknown): number | null =>
  typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
export const text = (v: unknown): string | null =>
  typeof v === "string"
    ? v
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .slice(0, 2000)
    : null;
export const timestamp = (v: unknown): string | null => {
  const n = int(v);
  return n !== null && n >= 946684800 && n <= 4133980800
    ? new Date(n * 1000).toISOString()
    : null;
};
export function settings(raw: any) {
  const l = raw?.league;
  if (!l || typeof l !== "object") throw new MflError("MFL_RESPONSE_SHAPE");
  const positions = list(l.starters?.position).map((p: any) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(p.limit ?? "");
    return {
      position: text(p.name),
      min: m ? Number(m[1]) : null,
      max: m ? Number(m[2] ?? m[1]) : null,
    };
  });
  return {
    leagueId: text(l.id),
    name: text(l.name),
    rosterSize: int(l.rosterSize),
    starters: { count: int(l.starters?.count), positions },
    partialLineupAllowed:
      l.partialLineupAllowed === "NO"
        ? false
        : l.partialLineupAllowed === "YES"
          ? true
          : null,
    injuredReserve: int(l.injuredReserve),
    taxiSquad: int(l.taxiSquad),
    rostersPerPlayer: int(l.rostersPerPlayer),
    season: {
      startWeek: int(l.startWeek),
      endWeek: int(l.endWeek),
      lastRegularSeasonWeek: int(l.lastRegularSeasonWeek),
    },
    waivers: {
      type: text(l.currentWaiverType),
      seasonBudget: text(l.bbidSeasonLimit),
      increment: text(l.bbidIncrement),
      conditional: text(l.bbidConditional),
      maxWaiverRounds: int(l.maxWaiverRounds),
      tiebreaker: text(l.bbidTiebreaker),
    },
    tradeExpirationDays: int(l.defaultTradeExpirationDays),
    standingsOrder: csv(l.standingsSort),
    bestLineup: text(l.bestLineup),
    // These fields are deliberately not invented from similarly named scoring fields.
    lineupLockPolicy: null as string | null,
    hideStarters: null as boolean | null,
    source: "mfl:league",
    rulebook: "docs/SEASON_RULES.md",
  };
}
export type LeagueSettings = ReturnType<typeof settings>;
export type Player = {
  id: string;
  name?: string | null;
  position?: string | null;
  nflTeam?: string | null;
  status?: string;
};
export type Game = {
  id: string;
  week: number;
  kickoffAt: string | null;
  teams: string[];
  gameSecondsRemaining: number | null;
};
export function nflGames(raw: any, week: number): Game[] {
  if (!raw?.nflSchedule || Number(raw.nflSchedule.week) !== week)
    throw new MflError("MFL_RESPONSE_SHAPE");
  return list(raw.nflSchedule.matchup).map((m: any, i) => ({
    id: `nfl:${week}:${
      list(m.team)
        .map((t: any) => t.id)
        .sort()
        .join("-") || i
    }`,
    week,
    kickoffAt: timestamp(m.kickoff),
    teams: list(m.team).map((t: any) => String(t.id)),
    gameSecondsRemaining: int(m.gameSecondsRemaining),
  }));
}
export function calendarEvents(raw: any) {
  if (!raw?.calendar) throw new MflError("MFL_RESPONSE_SHAPE");
  return list(raw.calendar.event).map((e: any) => ({
    id: String(e.id),
    type: text(e.type),
    title: text(e.title),
    startsAt: timestamp(e.start_time),
    endsAt: timestamp(e.end_time),
    rawStart: text(e.start_time),
    rawEnd: text(e.end_time),
    repeatsFollowingWeeks: int(e.happens),
    timingStatus: timestamp(e.start_time)
      ? "timestamp"
      : "unresolved-host-value",
    processingStatus: "scheduled-not-confirmed",
  }));
}
export function validateLineup(input: {
  starters: string[];
  roster: Player[];
  currentStarters: string[];
  settings: LeagueSettings;
  games: Game[];
  now: string;
  lockPolicyVerified: boolean;
  byeTeams?: string[];
}) {
  const { starters, roster, currentStarters, settings: rules, games } = input;
  const issues: {
    code: string;
    playerIds?: string[];
    position?: string | null;
    required?: unknown;
    actual?: number;
  }[] = [];
  const unknowns: string[] = [];
  const unique = new Set(starters),
    owned = new Map(roster.map((p) => [p.id, p]));
  if (unique.size !== starters.length)
    issues.push({
      code: "DUPLICATE_PLAYERS",
      playerIds: starters.filter((p, i) => starters.indexOf(p) !== i),
    });
  const unowned = starters.filter((id) => !owned.has(id));
  if (unowned.length)
    issues.push({ code: "PLAYERS_NOT_OWNED", playerIds: unowned });
  const count = rules.starters.count;
  const partial = rules.partialLineupAllowed;
  if (count === null) unknowns.push("starting-player-count");
  else if (
    starters.length > count ||
    (partial === false && starters.length < count)
  )
    issues.push({
      code: "STARTER_COUNT",
      required: count,
      actual: starters.length,
    });
  else if (starters.length < count && partial === null)
    unknowns.push("partial-lineup-policy");
  const counts: Record<string, number> = {};
  for (const id of unique) {
    const p = owned.get(id);
    if (p) {
      if (!p.position) unknowns.push(`position:${id}`);
      else counts[p.position] = (counts[p.position] ?? 0) + 1;
    }
  }
  if (!rules.starters.positions.length) unknowns.push("position-limits");
  for (const p of rules.starters.positions) {
    if (!p.position || p.min === null || p.max === null) {
      unknowns.push("position-limits");
      continue;
    }
    const actual = counts[p.position] ?? 0;
    if ((partial === false && actual < p.min) || actual > p.max)
      issues.push({
        code: "POSITION_COUNT",
        position: p.position,
        required: { min: p.min, max: p.max },
        actual,
      });
    else if (actual < p.min && partial === null)
      unknowns.push("partial-lineup-policy");
  }
  for (const pos of Object.keys(counts))
    if (!rules.starters.positions.some((p) => p.position === pos))
      issues.push({ code: "POSITION_NOT_ALLOWED", position: pos });
  const slots: { slot: string; playerId: string }[] = [];
  const remaining = [...unique];
  for (const p of rules.starters.positions) {
    for (let i = 0; i < (p.min ?? 0); i++) {
      const ix = remaining.findIndex(
        (id) => owned.get(id)?.position === p.position,
      );
      if (ix >= 0)
        slots.push({
          slot: `${p.position}${i + 1}`,
          playerId: remaining.splice(ix, 1)[0]!,
        });
    }
  }
  for (const id of remaining) slots.push({ slot: "FLEX", playerId: id });
  const changes = [...new Set([...currentStarters, ...starters])].filter(
    (id) => currentStarters.includes(id) !== unique.has(id),
  );
  if (!input.lockPolicyVerified) unknowns.push("lineup-lock-policy");
  const locks = roster.map((p) => {
    const game = games.find((g) => p.nflTeam && g.teams.includes(p.nflTeam));
    const locked =
      input.lockPolicyVerified &&
      !!p.nflTeam &&
      input.byeTeams?.includes(p.nflTeam)
        ? false
        : game?.kickoffAt && input.lockPolicyVerified
          ? Date.parse(game.kickoffAt) <= Date.parse(input.now)
          : null;
    return { playerId: p.id, kickoffAt: game?.kickoffAt ?? null, locked };
  });
  for (const id of changes) {
    const lock = locks.find((l) => l.playerId === id);
    if (lock?.locked === true)
      issues.push({ code: "LOCKED_PLAYER_CHANGE", playerIds: [id] });
    else if (!lock || lock.locked === null)
      unknowns.push(`kickoff-or-bye:${id}`);
  }
  return {
    valid: issues.length ? false : unknowns.length ? null : true,
    issues,
    unknowns: [...new Set(unknowns)],
    slots,
    locks,
    submitted: false,
    checkedAt: input.now,
    advice: false,
  };
}
