/**
 * Public scoreboard projection for the MFL-hosted league.
 * Pure derivations from adapter read payloads; no network, no database.
 * Unknown values stay null. Nothing is invented for a missing source.
 */
import { z } from "zod";

export const SCOREBOARD_SCHEMA_VERSION = 1 as const;
export const SCOREBOARD_MAX_BYTES = 150_000;
export const SLOT_POSITIONS = [
  "QB",
  "RB",
  "WR",
  "TE",
  "FLEX",
  "PK",
  "Def",
] as const;
export const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);

export const ScoreboardConfigSchema = z
  .object({
    version: z.literal(1),
    leagueId: z.string().min(1),
    leagueName: z.string().min(1).max(120),
    attribution: z.string().min(1).max(200),
    slotOrder: z.array(z.enum(SLOT_POSITIONS)).min(1).max(20),
    kvKeys: z
      .object({
        live: z.string().regex(/^[a-z0-9./-]+$/),
        weekPrefix: z.string().regex(/^[a-z0-9./-]+$/),
      })
      .strict(),
    teams: z
      .array(
        z
          .object({
            teamId: z.string().min(1),
            siteId: z.string().regex(/^[a-z0-9-]+$/),
            name: z.string().min(1).max(80),
            owner: z.string().min(1).max(80),
            kind: z.enum(["ai", "human"]),
          })
          .strict(),
      )
      .min(2)
      .max(32),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.teams.map((t) => t.teamId)).size === c.teams.length &&
      new Set(c.teams.map((t) => t.siteId)).size === c.teams.length,
    { message: "teamId and siteId must be unique" },
  );
export type ScoreboardConfig = z.infer<typeof ScoreboardConfigSchema>;

export type Slot = (typeof SLOT_POSITIONS)[number];
export type GameStatus = "pending" | "live" | "final";
export type PlayerLine = {
  id: string;
  name: string | null;
  position: string | null;
  nflTeam: string | null;
  points: number | null;
  gameStatus: GameStatus | "bye" | null;
  secondsRemaining: number | null;
};
export type Lineup = {
  teamId: string;
  starters: (PlayerLine & { slot: Slot })[];
  bench: PlayerLine[];
  starterTotal: number | null;
  benchTotal: number | null;
};
export type Side = {
  teamId: string;
  points: number | null;
  secondsRemaining: number | null;
  playersDone: number | null;
  playersPlaying: number | null;
  playersYetToPlay: number | null;
  result: "W" | "L" | "T" | null;
};
export type Matchup = {
  id: string;
  home: Side;
  away: Side;
  status: GameStatus;
};
export type Standing = {
  rank: number;
  teamId: string;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  winPct: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  allPlayPct: number | null;
};
export type Game = {
  id: string;
  kickoffAt: string | null;
  teams: string[];
  secondsRemaining: number | null;
  status: GameStatus;
};
export type ScoreboardSnapshot = {
  schemaVersion: typeof SCOREBOARD_SCHEMA_VERSION;
  league: { id: string; season: number; name: string };
  week: number;
  weekStatus: GameStatus | "pre" | "final";
  resultsOfficial: boolean;
  generatedAt: string;
  sourceObservedAt: string | null;
  nextUpdateExpectedAt: string;
  weeks: { available: number[] };
  attribution: string;
  teams: { id: string; name: string; owner: string; kind: "ai" | "human" }[];
  standings: Standing[];
  matchups: Matchup[];
  lineups: Lineup[];
  games: Game[];
  sources: {
    scores: "live" | "unavailable";
    lineups: "live" | "unavailable";
    standings: "live" | "unavailable";
  };
};

/** The `data` payloads of the adapter reads this projection consumes. */
export type ScoreboardInputs = {
  season: number;
  calendar: {
    week: number;
    games: {
      id: string;
      kickoffAt: string | null;
      teams: string[];
      gameSecondsRemaining: number | null;
    }[];
    byeTeams?: string[];
    matchups: {
      week: number;
      teams: { franchiseId: string; teamId: string | null; isHome: boolean }[];
    }[];
  };
  lineups: {
    week: number;
    teams: {
      teamId: string;
      franchiseId: string;
      starters: string[];
      players: {
        id: string;
        name?: string;
        position?: string;
        nflTeam?: string;
        status: string;
      }[];
      score: string | null;
      result: string | null;
    }[];
  } | null;
  standings: {
    teams: {
      teamId: string;
      wins: string | null;
      losses: string | null;
      ties: string | null;
      winningPercentage: string | null;
      pointsFor: string | null;
      pointsAgainst: string | null;
      allPlayPercentage: string | null;
    }[];
  } | null;
  scores: {
    week: number;
    teams: {
      teamId: string;
      franchiseId: string;
      score: string | null;
      gameSecondsRemaining: string | number | null;
      playersYetToPlay?: number | null;
      playersCurrentlyPlaying?: number | null;
      players?:
        | {
            id: string;
            score: string | null;
            gameSecondsRemaining: number | null;
            status: string | null;
          }[]
        | null;
    }[];
    matchups?: string[][];
  } | null;
};

export class ScoreboardError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const points = (v: unknown) => {
  const n = num(v);
  return n === null ? null : round2(n);
};
const gameStatusFromSeconds = (s: number | null): GameStatus | null =>
  s === null ? null : s <= 0 ? "final" : s >= 3600 ? "pending" : "live";
const sum = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? round2(known.reduce((a, b) => a + b, 0)) : null;
};

/** Sort key per the league's adopted order: winning percentage, points for, all-play percentage. */
function compareStandings(a: Standing, b: Standing) {
  const keys: (keyof Standing)[] = ["winPct", "pointsFor", "allPlayPct"];
  for (const k of keys) {
    const x = a[k] as number | null,
      y = b[k] as number | null;
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    if (x !== y) return y - x;
  }
  return a.teamId.localeCompare(b.teamId);
}

export function buildSnapshot(
  inputs: ScoreboardInputs,
  config: ScoreboardConfig,
  opts: {
    now: Date;
    observedAt: string | null;
    availableWeeks: number[];
    week?: number;
  },
): ScoreboardSnapshot {
  const byTeamId = new Map(config.teams.map((t) => [t.teamId, t]));
  const site = (teamId: string | null | undefined) => {
    const t = teamId ? byTeamId.get(teamId) : undefined;
    if (!t)
      throw new ScoreboardError("SCOREBOARD_TEAM_UNMAPPED", {
        teamId: teamId ?? null,
      });
    return t.siteId;
  };
  const week = opts.week ?? inputs.calendar.week;
  const byeTeams = new Set(inputs.calendar.byeTeams ?? []);
  const games: Game[] = inputs.calendar.games.map((g) => {
    const secondsRemaining = num(g.gameSecondsRemaining);
    const kickoff = g.kickoffAt ? Date.parse(g.kickoffAt) : NaN;
    let status: GameStatus =
      gameStatusFromSeconds(secondsRemaining) ?? "pending";
    if (
      status === "final" &&
      Number.isFinite(kickoff) &&
      kickoff > opts.now.getTime()
    )
      status = "pending"; // MFL reports 0 for some not-yet-started games in the offseason feed.
    return {
      id: g.id,
      kickoffAt: g.kickoffAt ?? null,
      teams: g.teams,
      secondsRemaining,
      status,
    };
  });
  const gameByNfl = new Map<string, Game>();
  for (const g of games) for (const t of g.teams) gameByNfl.set(t, g);

  const scoresByTeam = new Map(
    (inputs.scores?.teams ?? []).map((t) => [t.teamId, t]),
  );
  const playerScores = new Map<
    string,
    { points: number | null; secondsRemaining: number | null }
  >();
  for (const t of inputs.scores?.teams ?? [])
    for (const p of t.players ?? [])
      playerScores.set(p.id, {
        points: points(p.score),
        secondsRemaining: num(p.gameSecondsRemaining),
      });

  const line = (p: {
    id: string;
    name?: string;
    position?: string;
    nflTeam?: string;
  }): PlayerLine => {
    const live = playerScores.get(p.id);
    const nflTeam = p.nflTeam ?? null;
    const game = nflTeam ? gameByNfl.get(nflTeam) : undefined;
    let gameStatus: PlayerLine["gameStatus"] = null;
    if (nflTeam && (byeTeams.has(nflTeam) || (!game && games.length)))
      gameStatus = "bye";
    else if (
      live?.secondsRemaining !== null &&
      live?.secondsRemaining !== undefined
    )
      gameStatus = gameStatusFromSeconds(live.secondsRemaining);
    else if (game) gameStatus = game.status;
    return {
      id: p.id,
      name: p.name ?? null,
      position: p.position ?? null,
      nflTeam,
      points: live?.points ?? null,
      gameStatus,
      secondsRemaining:
        live?.secondsRemaining ?? game?.secondsRemaining ?? null,
    };
  };

  const lineups: Lineup[] = (inputs.lineups?.teams ?? []).map((t) => {
    const byId = new Map(t.players.map((p) => [p.id, p]));
    const slots: ({ slot: Slot; player: PlayerLine } | null)[] =
      config.slotOrder.map(() => null);
    const overflow: (PlayerLine & { slot: Slot })[] = [];
    for (const id of t.starters) {
      const p = byId.get(id) ?? { id };
      const pl = line(p);
      const pos = pl.position as Slot | null;
      let placed = false;
      const claim = (want: Slot) => {
        const i = config.slotOrder.findIndex(
          (s, i) => s === want && slots[i] === null,
        );
        if (i === -1) return false;
        slots[i] = { slot: want, player: pl };
        return true;
      };
      if (pos && (SLOT_POSITIONS as readonly string[]).includes(pos))
        placed = claim(pos);
      if (!placed && pos && FLEX_POSITIONS.has(pos)) placed = claim("FLEX");
      if (!placed) overflow.push({ ...pl, slot: (pos ?? "FLEX") as Slot });
    }
    const starters = [
      ...slots
        .filter((s): s is { slot: Slot; player: PlayerLine } => s !== null)
        .map((s) => ({ ...s.player, slot: s.slot })),
      ...overflow,
    ];
    const starterIds = new Set(t.starters);
    const bench = t.players
      .filter((p) => !starterIds.has(p.id))
      .map(line)
      .sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity));
    return {
      teamId: site(t.teamId),
      starters,
      bench,
      starterTotal: sum(starters.map((s) => s.points)),
      benchTotal: sum(bench.map((b) => b.points)),
    };
  });
  const lineupBySite = new Map(lineups.map((l) => [l.teamId, l]));
  const lineupSource = new Map(
    (inputs.lineups?.teams ?? []).map((t) => [site(t.teamId), t]),
  );

  const standings: Standing[] = (inputs.standings?.teams ?? [])
    .map((t) => ({
      rank: 0,
      teamId: site(t.teamId),
      wins: num(t.wins),
      losses: num(t.losses),
      ties: num(t.ties),
      winPct: num(t.winningPercentage),
      pointsFor: points(t.pointsFor),
      pointsAgainst: points(t.pointsAgainst),
      allPlayPct: num(t.allPlayPercentage),
    }))
    .sort(compareStandings)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  const resultsOfficial =
    !!inputs.lineups &&
    inputs.lineups.teams.length > 0 &&
    inputs.lineups.teams.every(
      (t) => t.score !== null && ["W", "L", "T"].includes(t.result ?? ""),
    );

  const side = (teamId: string): Side => {
    const sid = site(teamId);
    const sc = scoresByTeam.get(teamId);
    const lu = lineupBySite.get(sid);
    const src = lineupSource.get(sid);
    const starterCount = lu?.starters.length ?? null;
    const yet = sc?.playersYetToPlay ?? null;
    const playing = sc?.playersCurrentlyPlaying ?? null;
    const done =
      starterCount !== null && yet !== null && playing !== null
        ? Math.max(0, starterCount - yet - playing)
        : null;
    const scorePoints = points(sc?.score);
    return {
      teamId: sid,
      points: scorePoints ?? (resultsOfficial ? points(src?.score) : null),
      secondsRemaining: num(sc?.gameSecondsRemaining),
      playersDone: done,
      playersPlaying: playing,
      playersYetToPlay: yet,
      result:
        resultsOfficial && src && ["W", "L", "T"].includes(src.result ?? "")
          ? (src.result as Side["result"])
          : null,
    };
  };
  const matchupStatus = (a: Side, b: Side): GameStatus => {
    const starters = [a, b].flatMap(
      (s) => lineupBySite.get(s.teamId)?.starters ?? [],
    );
    const statuses = starters.map((s) => s.gameStatus);
    if (resultsOfficial) return "final";
    if (!statuses.length) return "pending";
    if (statuses.some((s) => s === "live")) return "live";
    const settled = statuses.every((s) => s === "final" || s === "bye");
    if (settled) return "final";
    return statuses.some((s) => s === "final") ? "live" : "pending";
  };
  const pairs: { home: string; away: string }[] = inputs.calendar.matchups
    .length
    ? inputs.calendar.matchups
        .filter((m) => m.week === week && m.teams.length === 2)
        .map((m) => {
          const home = m.teams.find((t) => t.isHome) ?? m.teams[1]!;
          const away = m.teams.find((t) => t !== home)!;
          return { home: site(home.teamId), away: site(away.teamId) };
        })
    : (inputs.scores?.matchups ?? [])
        .map((ids) =>
          ids.map(
            (fid) =>
              inputs.scores!.teams.find((t) => t.franchiseId === fid)?.teamId ??
              null,
          ),
        )
        .filter(
          (ids): ids is string[] =>
            ids.length === 2 && ids.every((x) => x !== null),
        )
        .map(([away, home]) => ({ home: site(home), away: site(away) }));
  const teamIdBySite = new Map(config.teams.map((t) => [t.siteId, t.teamId]));
  const matchups: Matchup[] = pairs.map(({ home, away }) => {
    const h = side(teamIdBySite.get(home)!),
      a = side(teamIdBySite.get(away)!);
    return {
      id: `${week}:${away}@${home}`,
      home: h,
      away: a,
      status: matchupStatus(h, a),
    };
  });

  const weekStatus: ScoreboardSnapshot["weekStatus"] = resultsOfficial
    ? "final"
    : !games.length
      ? "pre"
      : games.every((g) => g.status === "final")
        ? "final"
        : games.every((g) => g.status === "pending")
          ? "pre"
          : "live";

  const generatedAt = opts.now.toISOString();
  const partial: Omit<ScoreboardSnapshot, "nextUpdateExpectedAt"> = {
    schemaVersion: SCOREBOARD_SCHEMA_VERSION,
    league: {
      id: config.leagueId,
      season: inputs.season,
      name: config.leagueName,
    },
    week,
    weekStatus,
    resultsOfficial,
    generatedAt,
    sourceObservedAt: opts.observedAt,
    weeks: {
      available: [...new Set(opts.availableWeeks)].sort((a, b) => a - b),
    },
    attribution: config.attribution,
    teams: config.teams.map((t) => ({
      id: t.siteId,
      name: t.name,
      owner: t.owner,
      kind: t.kind,
    })),
    standings,
    matchups,
    lineups,
    games,
    sources: {
      scores: inputs.scores ? "live" : "unavailable",
      lineups: inputs.lineups ? "live" : "unavailable",
      standings: inputs.standings ? "live" : "unavailable",
    },
  };
  const interval = intervalFor(partial, opts.now);
  return {
    ...partial,
    nextUpdateExpectedAt: new Date(opts.now.getTime() + interval).toISOString(),
  };
}

/** Milliseconds until the next publish. Fast only while football is actually being played. */
export function intervalFor(
  snapshot: Pick<
    ScoreboardSnapshot,
    "games" | "weekStatus" | "resultsOfficial" | "lineups"
  >,
  now: Date,
): number {
  const anyLive =
    snapshot.games.some((g) => g.status === "live") ||
    snapshot.lineups.some((l) =>
      l.starters.some((s) => s.gameStatus === "live"),
    );
  if (anyLive) return 150_000;
  const soon = snapshot.games.some((g) => {
    if (g.status !== "pending" || !g.kickoffAt) return false;
    const delta = Date.parse(g.kickoffAt) - now.getTime();
    return delta >= -300_000 && delta <= 15 * 60_000;
  });
  if (soon) return 120_000;
  if (snapshot.resultsOfficial) return 900_000;
  return 600_000;
}

export function serializeSnapshot(snapshot: ScoreboardSnapshot): string {
  const body = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > SCOREBOARD_MAX_BYTES)
    throw new ScoreboardError("SCOREBOARD_TOO_LARGE", { bytes });
  return body;
}

export type KvCredential = {
  accountId: string;
  namespaceId: string;
  token: string;
};
export const KvCredentialSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    namespaceId: z.string().regex(/^[a-f0-9]{32}$/),
    token: z.string().min(20).max(400),
  })
  .strict();
/** Alternative: write through the operator's logged-in wrangler CLI in the site checkout; no API token is stored. */
export const WranglerKvSchema = z
  .object({
    mode: z.literal("wrangler"),
    namespaceId: z.string().regex(/^[a-f0-9]{32}$/),
    wranglerDir: z.string().min(1),
  })
  .strict();
export const KvTargetSchema = z.union([KvCredentialSchema, WranglerKvSchema]);
export type KvTarget = z.infer<typeof KvTargetSchema>;
export interface KvWriter {
  put(key: string, body: string): Promise<{ key: string; bytes: number }>;
}
export const KV_KEY = /^(?!.*\.\.)[a-z0-9][a-z0-9./-]{0,99}$/;

/** Writes snapshot bodies to Cloudflare Workers KV through the REST API. The token never appears in errors or logs. */
export class KvPublisher implements KvWriter {
  constructor(
    private credential: KvCredential,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async put(
    key: string,
    body: string,
    contentType = "application/json",
  ): Promise<{ key: string; bytes: number }> {
    if (!KV_KEY.test(key)) throw new ScoreboardError("KV_KEY_INVALID", { key });
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.credential.accountId}/storage/kv/namespaces/${this.credential.namespaceId}/values/${encodeURIComponent(key)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.credential.token}`,
          "Content-Type": contentType,
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ScoreboardError("KV_PUT_FAILED", {
        key,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
    if (!response.ok)
      throw new ScoreboardError("KV_PUT_FAILED", {
        key,
        status: response.status,
      });
    return { key, bytes: Buffer.byteLength(body, "utf8") };
  }
}

/**
 * Writes through `wrangler kv key put --remote` in the site checkout, using the operator's
 * existing wrangler login. Runs the CLI with an argument array (no shell) and a temp file.
 */
export class WranglerKvPublisher implements KvWriter {
  constructor(
    private target: z.infer<typeof WranglerKvSchema>,
    private run: (
      file: string,
      args: string[],
      options: { cwd: string },
    ) => Promise<{ code: number; stderr: string }> = defaultRun,
  ) {}
  async put(
    key: string,
    body: string,
  ): Promise<{ key: string; bytes: number }> {
    if (!KV_KEY.test(key)) throw new ScoreboardError("KV_KEY_INVALID", { key });
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "black4-scoreboard-"));
    const file = join(dir, "snapshot.json");
    try {
      await writeFile(file, body, { mode: 0o600 });
      const result = await this.run(
        "npx",
        [
          "--no-install",
          "wrangler",
          "kv",
          "key",
          "put",
          "--remote",
          "--namespace-id",
          this.target.namespaceId,
          key,
          "--path",
          file,
        ],
        { cwd: this.target.wranglerDir },
      );
      if (result.code !== 0)
        throw new ScoreboardError("KV_PUT_FAILED", {
          key,
          tool: "wrangler",
          stderr: result.stderr.slice(-300),
        });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { key, bytes: Buffer.byteLength(body, "utf8") };
  }
}
async function defaultRun(
  file: string,
  args: string[],
  options: { cwd: string },
) {
  const { execFile } = await import("node:child_process");
  return new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, timeout: 60_000, env: { ...process.env, CI: "1" } },
      (error, _stdout, stderr) =>
        resolve({
          code: error
            ? typeof (error as any).code === "number"
              ? (error as any).code
              : 1
            : 0,
          stderr: String(stderr ?? ""),
        }),
    );
  });
}
export function kvWriterFor(target: KvTarget): KvWriter {
  return "mode" in target
    ? new WranglerKvPublisher(target)
    : new KvPublisher(target);
}
