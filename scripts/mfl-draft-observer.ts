import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createDb } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { MflDraftObserver } from "../src/runtime/mfl-draft-observer.js";
const mode = process.argv[2];
if (!["--configure", "--poll", "--status"].includes(mode ?? ""))
  throw Error(
    "Use --configure, --poll [--once] or --status. This process never picks or calls a model.",
  );
const leagueId = process.env.FOOTBALL_LEAGUE_ID;
if (!leagueId) throw Error("FOOTBALL_LEAGUE_ID required");
const interval = Number(process.env.FOOTBALL_MFL_DRAFT_POLL_MS ?? 5000);
if (!Number.isInteger(interval) || interval < 5000 || interval > 60000)
  throw Error("Draft poll interval must be 5000–60000 ms");
if (
  mode === "--poll" &&
  process.env.FOOTBALL_MFL_DRAFT_OBSERVER_ENABLED !== "true"
)
  throw Error(
    "FOOTBALL_MFL_DRAFT_OBSERVER_ENABLED=true required to create draft-turn wake jobs",
  );
const db = createDb();
let stopped = false,
  last = "";
process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});
try {
  const auth = () =>
    authenticate(
      db,
      process.env.B4_LEAGUE_COMMISSIONER_TOKEN
        ? `Bearer ${process.env.B4_LEAGUE_COMMISSIONER_TOKEN}`
        : undefined,
    );
  const actor = await auth();
  if (actor.role !== "commissioner" || actor.leagueId !== leagueId)
    throw Error("Scoped commissioner required");
  const observer = new MflDraftObserver(db, new RuntimeStore(db));
  if (mode === "--configure") {
    const path = process.env.FOOTBALL_MFL_DRAFT_OBSERVER_CONFIG_FILE;
    if (!path || !isAbsolute(path))
      throw Error("Absolute FOOTBALL_MFL_DRAFT_OBSERVER_CONFIG_FILE required");
    const row = await observer.configure(
      actor,
      JSON.parse(await readFile(path, "utf8")),
    );
    console.log(
      JSON.stringify({
        status: row.status,
        epoch: row.epoch,
        hostVersion: row.host_version,
        synthetic: row.synthetic,
      }),
    );
  } else if (mode === "--status")
    console.log(
      JSON.stringify(
        (
          await db.query(
            "SELECT league_id,epoch,host_version,synthetic,status,hold_reason,last_observed_at,last_source_timestamp FROM runtime_mfl_draft_observers WHERE league_id=$1",
            [leagueId],
          )
        ).rows,
      ),
    );
  else
    while (!stopped) {
      try {
        const current = await auth();
        if (current.role !== "commissioner" || current.leagueId !== leagueId)
          throw Error("Observer credential changed");
        const result = await observer.poll(current),
          text = JSON.stringify(result);
        if (
          text !== last ||
          result.status === "woken" ||
          process.argv.includes("--once")
        )
          console.log(
            JSON.stringify({ at: new Date().toISOString(), ...result }),
          );
        last = text;
      } catch {
        if (last !== "READ_FAILED")
          console.error(
            JSON.stringify({
              status: "read_failed",
              message:
                "Draft observation unavailable; no pick or model call was made.",
            }),
          );
        last = "READ_FAILED";
      }
      if (process.argv.includes("--once")) break;
      await pause(interval);
    }
} finally {
  await db.end();
}
