import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createDb, migrate } from "../src/db.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { LeagueService } from "../src/league/index.js";
import {
  OpenRouterDriver,
  type ModelTariff,
} from "../src/providers/openrouter.js";

// This is a prepared integration path. It has not been run against paid credentials.
if (!process.argv.includes("--live"))
  throw new Error(
    "Use --live to run this paid-inference worker. Synthetic rehearsal uses scripts/worker.ts.",
  );
const model = process.env.FOOTBALL_MODEL,
  tariffPath = process.env.FOOTBALL_TARIFF_FILE,
  key = process.env.OPENROUTER_API_KEY;
const reservationMicros = Number(process.env.FOOTBALL_TURN_RESERVATION_MICROS),
  maxOutputTokens = Number(process.env.FOOTBALL_MAX_OUTPUT_TOKENS ?? 4000);
if (
  !model ||
  !tariffPath ||
  !key ||
  !Number.isSafeInteger(reservationMicros) ||
  reservationMicros <= 0
)
  throw new Error(
    "Dedicated key, exact model, verified tariff file and positive turn reservation required.",
  );
const tariff = JSON.parse(await readFile(tariffPath, "utf8")) as ModelTariff;
const db = createDb();
await migrate(db);
const store = new RuntimeStore(db),
  league = new LeagueService(db),
  outbox = new FootballOutbox(db, store, league);
const bindings = (
  await db.query(
    "SELECT a.id,b.league_id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE a.model=$1 AND a.kind='ai'",
    [model],
  )
).rows;
if (!bindings.length) {
  await db.end();
  throw new Error("No bound AI franchises use this exact model.");
}
const leagueIds = [...new Set(bindings.map((b) => b.league_id))];
if (leagueIds.length !== 1) {
  await db.end();
  throw new Error(
    "A live worker is scoped to one league; use separate model worker configuration.",
  );
}
const peers = (
  await db.query("SELECT agent_id FROM runtime_bindings WHERE league_id=$1", [
    leagueIds[0],
  ])
).rows.map((b) => b.agent_id);
const driver = new OpenRouterDriver(model, {
  apiKey: key,
  tariff,
  maxOutputTokens,
  reservationMicros,
  peers,
  leagueContext: async (agentId) => {
    const bound = (
      await db.query(
        "SELECT b.*,t.owner_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1 AND b.league_id=$2",
        [agentId, leagueIds[0]],
      )
    ).rows[0];
    if (!bound) throw new Error("Franchise binding changed.");
    return league.snapshot(bound.league_id, {
      id: bound.owner_id,
      role: "owner",
      leagueId: bound.league_id,
      teamId: bound.team_id,
    });
  },
});
let stopped = false;
process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});
console.log(
  "Live worker enabled for exact model " +
    model +
    ". External provider charges require reconciliation.",
);
try {
  while (!stopped) {
    const allowedAgentIds = bindings.map((b) => b.id);
    const result = await runOne(store, driver, "live-" + process.pid, {
      leaseMs: 180000,
      maxCostMicros: reservationMicros,
      allowedAgentIds,
    });
    await outbox.dispatchOne("football-" + process.pid, { allowedAgentIds });
    if (result.status !== "idle")
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (process.argv.includes("--once")) break;
    await pause(result.status === "idle" ? 500 : 10);
  }
} finally {
  await db.end();
}
