import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb } from "../src/db.js";
import { NativeSchedules } from "../src/runtime/native-schedules.js";

// Local operator repair, never sent as an owner acknowledgement. Before closing
// delivered work, verify its exact event cannot still execute in the native queue.
const [requestFile, mode] = process.argv.slice(2);
if (!requestFile || mode !== "--apply")
  throw Error(
    "Usage: tsx scripts/recover-native-schedule.ts REQUEST.json --apply. Review exact occurrence state and transport queue evidence first.",
  );
const { leagueId, ...request } = JSON.parse(
  await readFile(resolve(requestFile), "utf8"),
);
if (typeof leagueId !== "string" || !leagueId)
  throw Error("Recovery request requires leagueId");
const db = createDb(
  process.env.DATABASE_URL ??
    (await readFile(resolve(".local/deploy/database-url.host"), "utf8")).trim(),
);
try {
  console.log(
    JSON.stringify(
      await new NativeSchedules(db).failOccurrence(
        {
          id: "local-schedule-recovery-operator",
          role: "commissioner",
          leagueId,
        },
        request,
      ),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Schedule recovery failed",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
