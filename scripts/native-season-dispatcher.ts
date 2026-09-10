import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createDb } from "../src/db.js";
import { authenticate, type Principal } from "../src/auth.js";
import { loadMflAdapter } from "../src/mfl/service.js";
import { NativeSchedules } from "../src/runtime/native-schedules.js";
import { NativeScheduleFeeds } from "../src/runtime/native-schedule-feeds.js";
import {
  nativeBuzzScheduleTransport,
  type NativeBuzzScheduleConfig,
} from "../src/runtime/native-schedule-buzz.js";

if (!process.argv.includes("--run") && !process.argv.includes("--once"))
  throw Error(
    "Use --run or --once. This dispatcher runs only owner-created appointments; it creates no season reminders.",
  );
const configPath = resolve(
  process.env.FOOTBALL_SEASON_DISPATCH_CONFIG ??
    ".local/season-infrastructure/dispatcher.json",
);
const config = JSON.parse(
  await readFile(configPath, "utf8"),
) as NativeBuzzScheduleConfig;
const identity = JSON.parse(
  await readFile(
    resolve(
      process.env.FOOTBALL_DRAFT_BUZZ_IDENTITY_FILE ??
        ".local/native-draft/buzz-identity.json",
    ),
    "utf8",
  ),
);
if (
  !config.leagueId ||
  identity.communityUrl !== config.relayUrl ||
  !identity.privateKey ||
  !config.notifierPubkey ||
  !Object.keys(config.owners ?? {}).length
)
  throw Error("SEASON_DISPATCH_BINDING_INVALID");
process.env.FOOTBALL_MFL_CONFIG_FILE ??= resolve(
  ".local/live/mfl/deployment.json",
);
process.env.MFL_SESSION_FILE ??= resolve(".local/live/mfl/session.json");
const db = createDb(
  process.env.DATABASE_URL ??
    (await readFile(resolve(".local/deploy/database-url.host"), "utf8")).trim(),
);
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  BUZZ_RELAY_URL: identity.communityUrl,
  BUZZ_PRIVATE_KEY: identity.privateKey,
};
delete environment.BUZZ_AUTH_TAG;
if (identity.authTag)
  environment.BUZZ_AUTH_TAG =
    typeof identity.authTag === "string"
      ? identity.authTag
      : JSON.stringify(identity.authTag);
const schedules = new NativeSchedules(db);
const nativeTransport = nativeBuzzScheduleTransport(config, environment);
async function ownerCredential(teamId: string): Promise<Principal> {
  const binding = config.owners[teamId];
  if (!binding || !/^[a-zA-Z0-9_-]+$/.test(binding.agentId))
    throw Error("SEASON_AGENT_ID_INVALID");
  const credential = JSON.parse(
    await readFile(
      resolve(`.local/native-league/${binding.agentId}.json`),
      "utf8",
    ),
  );
  const actor = await authenticate(db, `Bearer ${credential.token}`);
  if (
    actor.role !== "owner" ||
    actor.teamId !== teamId ||
    actor.leagueId !== config.leagueId
  )
    throw Error("SEASON_OWNER_CREDENTIAL_MISMATCH");
  return actor;
}
const transport = {
  ...nativeTransport,
  async inspectOwner(input: { leagueId: string; teamId: string }) {
    try {
      await ownerCredential(input.teamId);
    } catch {
      return {
        status: "unavailable" as const,
        reason:
          "Owner league credential unavailable; other franchises continue independently",
      };
    }
    return nativeTransport.inspectOwner(input);
  },
};
const feeds = new NativeScheduleFeeds(db, schedules, async (actor, query) => {
  const current = await ownerCredential(actor.teamId!);
  if (JSON.stringify(current) !== JSON.stringify(actor))
    throw Error("SEASON_OWNER_CREDENTIAL_CHANGED");
  return (await loadMflAdapter(db, config.leagueId)).read(current, query);
});
const lease = await db.connect();
const claimed = (
  await lease.query(
    "SELECT pg_try_advisory_lock(hashtextextended($1,7048)) AS claimed",
    [config.leagueId],
  )
).rows[0].claimed;
if (!claimed) {
  lease.release();
  await db.end();
  throw Error("SEASON_DISPATCHER_ALREADY_RUNNING");
}
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => abort.abort());
let previous = "";
try {
  do {
    try {
      await lease.query("SELECT 1");
      const league = (
        await db.query("SELECT current_week FROM leagues WHERE id=$1", [
          config.leagueId,
        ])
      ).rows[0];
      if (!league) throw Error("SEASON_LEAGUE_NOT_FOUND");
      const owners: Principal[] = [];
      for (const teamId of Object.keys(config.owners)) {
        try {
          owners.push(await ownerCredential(teamId));
          await db.query(
            "UPDATE runtime_native_schedule_feeds SET status='healthy',error_code=NULL,observed_at=clock_timestamp(),last_success_at=clock_timestamp() WHERE league_id=$1 AND source=$2 AND status='failed'",
            [config.leagueId, `credential:${teamId}`],
          );
        } catch {
          await feeds.save(
            config.leagueId,
            `credential:${teamId}`,
            "failed",
            {},
            "OWNER_CREDENTIAL_UNAVAILABLE",
          );
        }
      }
      const feed = owners.length
        ? await feeds.poll({
            leagueId: config.leagueId,
            owners,
            baseWeek: league.current_week,
          })
        : { status: "failed", errorCode: "NO_OWNER_CREDENTIALS_AVAILABLE" };
      const materialized = await schedules.materializeDue(config.leagueId);
      const deliveries: unknown[] = [];
      for (let n = 0; n < Object.keys(config.owners).length; n++) {
        const result = await schedules.dispatchOne(config.leagueId, transport);
        if (result.status === "idle") break;
        deliveries.push(result);
      }
      const result = { feed, materialized: materialized.created, deliveries };
      await feeds.save(config.leagueId, "dispatcher", "healthy", {
        pid: process.pid,
        intervalMs: 10000,
        ...result,
      });
      const comparable = JSON.stringify(result);
      if (comparable !== previous || process.argv.includes("--once"))
        console.log(
          JSON.stringify({ at: new Date().toISOString(), ...result }),
        );
      previous = comparable;
    } catch {
      await feeds.save(
        config.leagueId,
        "dispatcher",
        "failed",
        { pid: process.pid, intervalMs: 10000 },
        "DISPATCH_CYCLE_FAILED",
      );
      console.error(
        JSON.stringify({
          at: new Date().toISOString(),
          status: "failed",
          code: "DISPATCH_CYCLE_FAILED",
        }),
      );
      if (process.argv.includes("--once")) process.exitCode = 1;
    }
    if (process.argv.includes("--once") || abort.signal.aborted) break;
    try {
      await pause(10000, undefined, { signal: abort.signal });
    } catch {
      break;
    }
  } while (!abort.signal.aborted);
} finally {
  await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,7048))", [
    config.leagueId,
  ]);
  lease.release();
  await db.end();
}
