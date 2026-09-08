import { LeagueEventDispatcher } from "../src/league/dispatcher.js";
import { setTimeout as pause } from "node:timers/promises";
import { createDb, migrate } from "../src/db.js";
import { LeagueClock } from "../src/league/clock.js";

const leagueId = process.env.FOOTBALL_LEAGUE_ID;
if (!leagueId)
  throw new Error("FOOTBALL_LEAGUE_ID must identify one existing league.");
const db = createDb();
await migrate(db);
const clock = new LeagueClock(db),
  events = new LeagueEventDispatcher(db);
const actor = { id: "league-clock", role: "system" as const, leagueId };
let stopped = false;
let lastAttention = "";
process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});
try {
  while (!stopped) {
    const result = await clock.tick(actor, { leagueId, maxCommands: 5 });
    const delivered = await events.dispatchOnce(actor, {
      leagueId,
      limit: 100,
    });
    if (delivered.failed.length)
      console.error(
        JSON.stringify({ type: "league_dispatch_failed", ...delivered }),
      );
    const attention = JSON.stringify(
      result.work
        .filter((w) => w.status === "blocked")
        .map((w) => ({ kind: w.kind, reference: w.reference, code: w.code })),
    );
    if (
      result.work.some((w) => w.status === "applied") ||
      attention !== lastAttention ||
      process.argv.includes("--once")
    ) {
      console.log(JSON.stringify(result));
      lastAttention = attention;
    }
    if (process.argv.includes("--once")) break;
    await pause(1000);
  }
} finally {
  await db.end();
}
