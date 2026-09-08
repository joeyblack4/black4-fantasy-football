import { BuzzRuntimeOutbound } from "../src/buzz/runtime-outbound.js";
import { GovernanceService } from "../src/governance/index.js";
import { createOwnerResearchTools } from "../src/research/index.js";
import { ManifestRegistry } from "../src/providers/manifests.js";
import { FranchiseService, FranchiseOutbox } from "../src/franchise/index.js";
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
const manifestId = process.env.FOOTBALL_MANIFEST_ID,
  tariffPath = process.env.FOOTBALL_TARIFF_FILE;
const reservationMicros = Number(process.env.FOOTBALL_TURN_RESERVATION_MICROS),
  maxOutputTokens = Number(process.env.FOOTBALL_MAX_OUTPUT_TOKENS ?? 4000);
if (
  !manifestId ||
  !tariffPath ||
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
const registry = new ManifestRegistry(db);
const manifest = await registry.get(manifestId!);
const model = manifest.document.model,
  key = process.env[manifest.document.keyRef];
if (!key)
  throw new Error("Manifest's dedicated inference secret is unavailable.");
const canary = process.argv.includes("--canary");
if (manifest.status !== (canary ? "staged" : "active"))
  throw new Error("Manifest is not enabled for this worker mode.");
const bindings = [
  { id: manifest.document.agentId, league_id: manifest.document.leagueId },
];
const leagueIds = [manifest.document.leagueId];
const franchiseOutbox = new FranchiseOutbox(db, store);
const franchises = new FranchiseService(db);
const peers = (
  await db.query("SELECT agent_id FROM runtime_bindings WHERE league_id=$1", [
    leagueIds[0],
  ])
).rows.map((b) => b.agent_id);
const driver = new OpenRouterDriver(model, {
  apiKey: key,
  providerSlug: manifest.document.providerSlug,
  reportedProviderNames: manifest.document.reportedProviderNames,
  ...(manifest.document.quantization
    ? { quantization: manifest.document.quantization }
    : {}),
  identity: { registry, manifestId: manifest.id, canary },
  tariff,
  maxOutputTokens,
  reservationMicros,
  peers,
  readTools: [
    ...createOwnerResearchTools(db),
    {
      name: "governance_state",
      description:
        "Read founding meetings and exact proposals with your authenticated franchise visibility.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async (job) => {
        const b = (
          await db.query(
            "SELECT b.*,t.owner_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1",
            [job.agentId],
          )
        ).rows[0];
        if (!b) throw Error("Binding unavailable");
        const actor = {
          id: b.owner_id,
          role: "owner" as const,
          leagueId: b.league_id,
          teamId: b.team_id,
        };
        const ids = (
          await db.query(
            "SELECT id FROM governance_meetings WHERE league_id=$1 ORDER BY vote_deadline DESC LIMIT 5",
            [b.league_id],
          )
        ).rows;
        return {
          meetings: await Promise.all(
            ids.map((r) => new GovernanceService(db).snapshot(actor, r.id)),
          ),
        };
      },
    },
  ],
  leagueContext: async (agentId) => {
    const bound = (
      await db.query(
        "SELECT b.*,t.owner_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1 AND b.league_id=$2",
        [agentId, leagueIds[0]],
      )
    ).rows[0];
    if (!bound) throw new Error("Franchise binding changed.");
    const actor = {
      id: bound.owner_id,
      role: "owner" as const,
      leagueId: bound.league_id,
      teamId: bound.team_id,
    };
    return {
      football: await league.snapshot(bound.league_id, actor),
      franchise: await franchises.snapshot(actor),
      buzzDelivery: await new BuzzRuntimeOutbound(db).status(actor, {
        leagueId: bound.league_id,
      }),
    };
  },
});
const onlyCanaryJobId = canary
  ? await registry.createCanaryJob(manifest.id)
  : undefined;
const currentModel = (
  await db.query("SELECT model FROM runtime_agents WHERE id=$1", [
    manifest.document.agentId,
  ])
).rows[0].model;
const selectedDriver = canary
  ? {
      name: "OPENROUTER_ISOLATED_CANARY",
      synthetic: false,
      model: currentModel,
      run: async (job: import("../src/runtime/index.js").Job) =>
        driver.run({ ...job, model: manifest.document.model }),
    }
  : driver;
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
    const result = await runOne(store, selectedDriver, "live-" + process.pid, {
      leaseMs: 180000,
      maxCostMicros: reservationMicros,
      allowedAgentIds,
      onlyCanaryJobId,
    });
    if (!canary) {
      await outbox.dispatchOne("football-" + process.pid, { allowedAgentIds });
      await franchiseOutbox.dispatchOne("franchise-" + process.pid, {
        allowedAgentIds,
      });
    }
    if (result.status !== "idle")
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (canary || process.argv.includes("--once")) break;
    await pause(result.status === "idle" ? 500 : 10);
  }
} finally {
  await db.end();
}
