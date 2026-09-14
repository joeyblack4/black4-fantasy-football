/**
 * Publishes the public scoreboard snapshot to Cloudflare KV.
 * Host-side, like the season dispatcher: reads MFL through the shared adapter with a
 * commissioner principal, derives the public projection, and PUTs live.json (plus
 * weeks/<n>.json once a week is archived). Never publishes a partial snapshot.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createDb } from "../src/db.js";
import type { Principal } from "../src/auth.js";
import { loadMflAdapter } from "../src/mfl/service.js";
import {
  ScoreboardConfigSchema,
  KvCredentialSchema,
  KvPublisher,
  ScoreboardError,
  buildSnapshot,
  intervalFor,
  serializeSnapshot,
  type ScoreboardInputs,
  type ScoreboardSnapshot,
} from "../src/publication/scoreboard.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const backfillIndex = argv.indexOf("--backfill-week");
const backfillWeek =
  backfillIndex === -1 ? null : Number(argv[backfillIndex + 1]);
if (
  !flag("--run") &&
  !flag("--once") &&
  !flag("--dry-run") &&
  backfillWeek === null
)
  throw Error("Use --run, --once, --dry-run or --backfill-week N.");
if (
  backfillWeek !== null &&
  !(Number.isInteger(backfillWeek) && backfillWeek >= 1 && backfillWeek <= 22)
)
  throw Error("SCOREBOARD_BACKFILL_WEEK_INVALID");
const dryRun = flag("--dry-run");
const once = flag("--once") || dryRun || backfillWeek !== null;

/** Operator-supplied private files only: absolute, regular, 0600, small. */
async function privateJson(path: string) {
  if (!isAbsolute(path)) throw Error("SCOREBOARD_PRIVATE_FILE_REQUIRED");
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 100_000)
    throw Error("SCOREBOARD_PRIVATE_FILE_PERMISSIONS");
  return JSON.parse(await readFile(path, "utf8"));
}

const config = ScoreboardConfigSchema.parse(
  JSON.parse(
    await readFile(
      resolve(
        process.env.FOOTBALL_PUBLIC_SCOREBOARD_CONFIG ??
          "config/public-scoreboard.json",
      ),
      "utf8",
    ),
  ),
);
if (
  process.env.FOOTBALL_LEAGUE_ID &&
  process.env.FOOTBALL_LEAGUE_ID !== config.leagueId
)
  throw Error("SCOREBOARD_LEAGUE_MISMATCH");
const leagueId = config.leagueId;
process.env.FOOTBALL_MFL_CONFIG_FILE ??= resolve(
  ".local/live/mfl/deployment.json",
);
process.env.MFL_SESSION_FILE ??= resolve(".local/live/mfl/session.json");
const publisher = dryRun
  ? null
  : new KvPublisher(
      KvCredentialSchema.parse(
        await privateJson(
          resolve(
            process.env.FOOTBALL_PUBLIC_KV_FILE ??
              ".local/public-scoreboard/kv.json",
          ),
        ),
      ),
    );
const db = createDb(
  process.env.DATABASE_URL ??
    (await readFile(resolve(".local/deploy/database-url.host"), "utf8")).trim(),
);
const actor: Principal = {
  id: "public-scoreboard",
  role: "commissioner",
  leagueId,
};
const SOURCE = "public-scoreboard";

async function saveHealth(
  status: "healthy" | "failed",
  cursor: Record<string, unknown>,
  code?: string,
) {
  await db.query(
    "INSERT INTO runtime_native_schedule_feeds(league_id,source,status,last_success_at,error_code,cursor) VALUES($1,$2,$3,CASE WHEN $3='healthy' THEN clock_timestamp() ELSE NULL END,$4,$5) ON CONFLICT(league_id,source) DO UPDATE SET status=EXCLUDED.status,observed_at=clock_timestamp(),last_success_at=CASE WHEN EXCLUDED.status='healthy' THEN clock_timestamp() ELSE runtime_native_schedule_feeds.last_success_at END,error_code=EXCLUDED.error_code,cursor=EXCLUDED.cursor",
    [leagueId, SOURCE, status, code ?? null, cursor],
  );
}
async function previousCursor(): Promise<Record<string, any>> {
  const row = (
    await db.query(
      "SELECT cursor FROM runtime_native_schedule_feeds WHERE league_id=$1 AND source=$2",
      [leagueId, SOURCE],
    )
  ).rows[0];
  return row?.cursor && typeof row.cursor === "object" ? row.cursor : {};
}

type WeekRead = {
  inputs: ScoreboardInputs;
  observedAt: string | null;
  currentWeek: number | null;
};
async function readWeek(week: number | null): Promise<WeekRead> {
  const adapter = await loadMflAdapter(db, leagueId);
  const settings = (await adapter.read(actor, { type: "leagueSettings" }))
    .data as any;
  const currentWeek =
    typeof settings.currentWeek === "number" ? settings.currentWeek : null;
  const target = week ?? currentWeek;
  if (!target) throw new ScoreboardError("SCOREBOARD_WEEK_UNKNOWN");
  const calendar = (
    await adapter.read(actor, { type: "calendar", week: target })
  ).data as any;
  const optional = async <T>(
    query: Record<string, unknown>,
  ): Promise<{ data: T | null; at: string | null }> => {
    try {
      const r = await adapter.read(actor, query);
      return { data: r.data as T, at: r.at };
    } catch (error) {
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          status: "read-unavailable",
          query: query.type,
          code: (error as any)?.code ?? "UNKNOWN",
        }),
      );
      return { data: null, at: null };
    }
  };
  const lineups = await optional<ScoreboardInputs["lineups"]>({
    type: "lineups",
    week: target,
  });
  const standings = await optional<ScoreboardInputs["standings"]>({
    type: "standings",
  });
  const scores = await optional<ScoreboardInputs["scores"]>({
    type: "scores",
    week: target,
  });
  return {
    currentWeek,
    observedAt: scores.at,
    inputs: {
      season:
        Number(
          settings.season?.year ??
            settings.season ??
            new Date().getUTCFullYear(),
        ) || new Date().getUTCFullYear(),
      calendar,
      lineups: lineups.data,
      standings: standings.data,
      scores: scores.data,
    },
  };
}

async function publish(key: string, snapshot: ScoreboardSnapshot) {
  const body = serializeSnapshot(snapshot);
  if (!publisher) {
    process.stdout.write(body + "\n");
    return { key, bytes: Buffer.byteLength(body, "utf8"), dryRun: true };
  }
  return { ...(await publisher.put(key, body)), dryRun: false };
}

const lease = await db.connect();
const claimed = (
  await lease.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1,7049)) AS claimed",
    [leagueId],
  )
).rows[0].claimed;
if (!claimed) {
  lease.release();
  await db.end();
  throw Error("SCOREBOARD_PUBLISHER_ALREADY_RUNNING");
}
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => abort.abort());
let previous = "";
let failures = 0;
try {
  const cursor = await previousCursor();
  let availableWeeks: number[] = Array.isArray(cursor.availableWeeks)
    ? cursor.availableWeeks.filter((n: unknown) => Number.isInteger(n))
    : [];
  let lastWeek: number | null = Number.isInteger(cursor.week)
    ? cursor.week
    : null;
  do {
    let intervalMs = 600_000;
    try {
      await lease.query("SELECT 1");
      const now = new Date();
      if (backfillWeek !== null) {
        const read = await readWeek(backfillWeek);
        const snapshot = buildSnapshot(read.inputs, config, {
          now,
          observedAt: read.observedAt,
          availableWeeks,
          week: backfillWeek,
        });
        const result = await publish(
          `${config.kvKeys.weekPrefix}${backfillWeek}.json`,
          snapshot,
        );
        if (!result.dryRun)
          availableWeeks = [...new Set([...availableWeeks, backfillWeek])].sort(
            (a, b) => a - b,
          );
        await saveHealth("healthy", {
          ...cursor,
          availableWeeks,
          backfilled: backfillWeek,
          pid: process.pid,
        });
        console.log(
          JSON.stringify({
            at: now.toISOString(),
            backfilled: backfillWeek,
            ...result,
          }),
        );
        break;
      }
      const read = await readWeek(null);
      const week = read.currentWeek!;
      // Week rollover: archive the outgoing week before switching the live key.
      if (
        lastWeek !== null &&
        week > lastWeek &&
        !availableWeeks.includes(lastWeek)
      ) {
        const prior = await readWeek(lastWeek);
        const archived = buildSnapshot(prior.inputs, config, {
          now,
          observedAt: prior.observedAt,
          availableWeeks,
          week: lastWeek,
        });
        const result = await publish(
          `${config.kvKeys.weekPrefix}${lastWeek}.json`,
          archived,
        );
        if (!result.dryRun)
          availableWeeks = [...new Set([...availableWeeks, lastWeek])].sort(
            (a, b) => a - b,
          );
      }
      const snapshot = buildSnapshot(read.inputs, config, {
        now,
        observedAt: read.observedAt,
        availableWeeks,
        week,
      });
      const results = [await publish(config.kvKeys.live, snapshot)];
      if (snapshot.resultsOfficial && !availableWeeks.includes(week)) {
        const result = await publish(
          `${config.kvKeys.weekPrefix}${week}.json`,
          snapshot,
        );
        results.push(result);
        if (!result.dryRun)
          availableWeeks = [...new Set([...availableWeeks, week])].sort(
            (a, b) => a - b,
          );
      }
      lastWeek = week;
      failures = 0;
      intervalMs = intervalFor(snapshot, now);
      const summary = {
        week,
        weekStatus: snapshot.weekStatus,
        resultsOfficial: snapshot.resultsOfficial,
        sources: snapshot.sources,
        matchups: snapshot.matchups.map(
          (m) =>
            `${m.away.teamId} ${m.away.points ?? "—"} @ ${m.home.teamId} ${m.home.points ?? "—"} (${m.status})`,
        ),
        intervalMs,
        bytes: results[0]!.bytes,
      };
      await saveHealth("healthy", {
        pid: process.pid,
        week,
        weekStatus: snapshot.weekStatus,
        resultsOfficial: snapshot.resultsOfficial,
        generatedAt: snapshot.generatedAt,
        intervalMs,
        availableWeeks,
        bytes: results[0]!.bytes,
        dryRun: results[0]!.dryRun,
      });
      const comparable = JSON.stringify({ ...summary, intervalMs: undefined });
      if (comparable !== previous || once)
        console.log(JSON.stringify({ at: now.toISOString(), ...summary }));
      previous = comparable;
    } catch (error) {
      failures += 1;
      intervalMs = Math.min(900_000, 60_000 * 2 ** Math.min(failures, 4));
      const code =
        error instanceof ScoreboardError
          ? error.code
          : ((error as any)?.code ?? "SCOREBOARD_CYCLE_FAILED");
      await saveHealth(
        "failed",
        { pid: process.pid, intervalMs, availableWeeks, week: lastWeek },
        String(code),
      ).catch(() => {});
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          status: "failed",
          code,
          details: error instanceof ScoreboardError ? error.details : undefined,
          message:
            error instanceof Error && !(error instanceof ScoreboardError)
              ? error.message.slice(0, 200)
              : undefined,
        }),
      );
      if (once) process.exitCode = 1;
    }
    if (once || abort.signal.aborted) break;
    try {
      await pause(intervalMs, undefined, { signal: abort.signal });
    } catch {
      break;
    }
  } while (!abort.signal.aborted);
} finally {
  await lease
    .query("SELECT pg_advisory_unlock(hashtextextended($1,7049))", [leagueId])
    .catch(() => {});
  lease.release();
  await db.end();
}
