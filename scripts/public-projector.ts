import { createDb, migrate } from "../src/db.js";
import { PublicProjection } from "../src/publication/projection.js";
import { setTimeout as pause } from "node:timers/promises";
const leagueId = process.env.FOOTBALL_LEAGUE_ID;
if (!leagueId) throw Error("League binding required.");
const db = createDb();
await migrate(db);
const service = new PublicProjection(db);
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopped = true;
  });
try {
  while (!stopped) {
    try {
      await service.refresh(leagueId);
    } catch {
      console.error(
        "Public projection failed; stale public reads will return unavailable.",
      );
    }
    if (process.argv.includes("--once")) break;
    await pause(15000);
  }
} finally {
  await db.end();
}
