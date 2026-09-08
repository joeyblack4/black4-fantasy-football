import { setTimeout as pause } from "node:timers/promises";
import { createDb, migrate } from "../src/db.js";
import { XPublisher } from "../src/publication/x-publisher.js";
const leagueId = process.env.FOOTBALL_LEAGUE_ID;
if (!leagueId) throw new Error("FOOTBALL_LEAGUE_ID must identify one league.");
// Set only after account setup and explicit operator activation. Exact batch approval is also required.
const enabled = process.env.FOOTBALL_X_PUBLISHING_ENABLED === "true";
const userAccessToken = process.env.FOOTBALL_X_USER_ACCESS_TOKEN;
if (!enabled || !userAccessToken)
  throw new Error(
    "X publisher is disabled. Configure explicit activation and a league-scoped OAuth2 user token.",
  );
const db = createDb();
await migrate(db);
const publisher = new XPublisher(db, { leagueId, enabled, userAccessToken });
const actor = { id: "x-publisher", role: "system" as const, leagueId };
let stopped = false;
process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});
try {
  while (!stopped) {
    const result = await publisher.tick(actor);
    if (result.status !== "idle" || process.argv.includes("--once"))
      console.log(JSON.stringify(result));
    if (process.argv.includes("--once")) break;
    await pause(5000);
  }
} finally {
  await db.end();
}
