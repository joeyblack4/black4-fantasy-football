import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { nativeScheduleHealth } from "../src/runtime/native-schedule-health.js";

// Run from another powered host over SSH to detect a sleeping league Mac too.
// This command never sends work, acknowledges it, or exposes private prompts.
const config = JSON.parse(
  await readFile(
    resolve(
      process.env.FOOTBALL_SEASON_DISPATCH_CONFIG ??
        ".local/season-infrastructure/dispatcher.json",
    ),
    "utf8",
  ),
);
const db = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    (await readFile(resolve(".local/deploy/database-url.host"), "utf8")).trim(),
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
try {
  let power: "ac" | "battery" | "unknown" | "not-applicable" = "not-applicable";
  if (process.platform === "darwin") {
    power = "unknown";
    try {
      const { stdout } = await promisify(execFile)(
        "/usr/bin/pmset",
        ["-g", "batt"],
        { timeout: 5000 },
      );
      if (stdout.includes("Now drawing from 'AC Power'")) power = "ac";
      else if (stdout.includes("Now drawing from 'Battery Power'"))
        power = "battery";
    } catch {
      /* Unreadable power state remains an alarm. */
    }
  }
  const {
    rows: [clock],
  } = await db.query("SELECT clock_timestamp() AS now");
  const {
    rows: [dispatcher],
  } = await db.query(
    "SELECT status,observed_at,error_code FROM runtime_native_schedule_feeds WHERE league_id=$1 AND source='dispatcher'",
    [config.leagueId],
  );
  const { rows: overdueAppointments } = await db.query(
    "SELECT id,team_id,next_due_at FROM runtime_native_schedules WHERE league_id=$1 AND status='active' AND next_due_at < $2 ORDER BY next_due_at",
    [config.leagueId, clock.now],
  );
  const { rows: activeOccurrences } = await db.query(
    "SELECT id,schedule_id,team_id,status,scheduled_for,delivered_at,started_at,reason FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND status NOT IN ('completed','failed','cancelled') ORDER BY scheduled_for",
    [config.leagueId],
  );
  const { rows: upcoming } = await db.query(
    "SELECT id,team_id,label,next_due_at FROM runtime_native_schedules WHERE league_id=$1 AND status='active' AND next_due_at >= $2 AND next_due_at <= $2::timestamptz + interval '24 hours' ORDER BY next_due_at",
    [config.leagueId, clock.now],
  );
  const { rows: recent } = await db.query(
    "SELECT id,schedule_id,team_id,status,scheduled_for,delivered_at,started_at,completed_at,reason FROM runtime_native_schedule_occurrences WHERE league_id=$1 AND updated_at >= $2::timestamptz - interval '24 hours' ORDER BY updated_at DESC LIMIT 50",
    [config.leagueId, clock.now],
  );
  const health = nativeScheduleHealth({
    now: clock.now,
    power,
    dispatcher: dispatcher ?? null,
    overdueAppointments,
    activeOccurrences,
  });
  console.log(
    JSON.stringify(
      {
        at: clock.now,
        leagueId: config.leagueId,
        power,
        ...health,
        dispatcher,
        activeOccurrences,
        upcoming,
        recent,
      },
      null,
      2,
    ),
  );
  if (!health.healthy) process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      healthy: false,
      alerts: [{ code: "SCHEDULER_HEALTH_READ_FAILED" }],
    }),
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
