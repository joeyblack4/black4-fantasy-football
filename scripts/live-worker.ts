import { buildOwnerRuntimeStatus } from "../src/runtime/owner-status.js";
import { RehearsalRuntime } from "../src/runtime/rehearsal.js";
import { OwnerStageRuntime } from "../src/runtime/owner-stage.js";
import {
  BuzzRuntimeOutbound,
  managedOutboundTransport,
} from "../src/buzz/runtime-outbound.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
import {
  createBuzzChannelReadTools,
  buildBuzzOwnerContext,
} from "../src/buzz/read-tools.js";
import {
  ConventionRuntime,
  createGovernanceReadTools,
} from "../src/runtime/convention.js";
import { createOwnerResearchTools } from "../src/research/index.js";
import { FirecrawlClient, FirecrawlResearch } from "../src/research/index.js";
import { ManifestRegistry } from "../src/providers/manifests.js";
import { FranchiseService, FranchiseOutbox } from "../src/franchise/index.js";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { createDb, migrate } from "../src/db.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { LeagueService } from "../src/league/index.js";
import { getFootballHost } from "../src/league/host.js";
import { loadMflAdapter, MflDeploymentSchema } from "../src/mfl/service.js";
import { createMflOwnerReadTools } from "../src/runtime/mfl-tools.js";
import {
  OpenRouterDriver,
  type ModelTariff,
} from "../src/providers/openrouter.js";

// Paid inference requires an explicitly enabled manifest and reconciled provider identity evidence.
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
const firecrawlConfigPath = process.env.FOOTBALL_FIRECRAWL_CONFIG_FILE;
const firecrawlBudget =
  !canary && firecrawlConfigPath
    ? JSON.parse(await readFile(firecrawlConfigPath, "utf8"))
    : undefined;
const firecrawl = firecrawlBudget
  ? new FirecrawlResearch(db, {
      enabled: true,
      budget: firecrawlBudget,
      client: new FirecrawlClient({
        enabled: true,
        apiKey: process.env[firecrawlBudget.keyRef] ?? "",
      }),
    })
  : undefined;
if (manifest.status !== (canary ? "staged" : "active"))
  throw new Error("Manifest is not enabled for this worker mode.");
const bindings = [
  { id: manifest.document.agentId, league_id: manifest.document.leagueId },
];
const leagueIds = [manifest.document.leagueId];
const buzzChannel =
  !canary && process.env.FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED === "true"
    ? new BuzzChannelService(
        db,
        managedOutboundTransport(db, {
          executable: process.env.B4_LEAGUE_BUZZ_EXECUTABLE ?? "",
          allowExternalSends: true,
        }),
      )
    : undefined;
const franchiseOutbox = new FranchiseOutbox(
  db,
  store,
  undefined,
  undefined,
  buzzChannel,
);
const convention = new ConventionRuntime(db, store);
const ownerStageRuntime = new OwnerStageRuntime(db, store);
const rehearsal = new RehearsalRuntime(db, store);
const franchises = new FranchiseService(db);
const peers = (
  await db.query("SELECT agent_id FROM runtime_bindings WHERE league_id=$1", [
    leagueIds[0],
  ])
).rows.map((b) => b.agent_id);
const mflOwnerSkill = await readFile(
  new URL("../skills/mfl-owner/SKILL.md", import.meta.url),
  "utf8",
);
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
  repairInvalidResponses: !canary,
  webSearch:
    !canary &&
    !firecrawl &&
    process.env.FOOTBALL_SERVER_SEARCH_ENABLED === "true",
  requireCanaryToolChoice:
    canary && process.env.FOOTBALL_CANARY_FORCE_TOOL_CHOICE === "true",
  maxCalls: canary ? 2 : 6,
  // Long non-streaming reasoning responses need their body to finish. Runtime
  // heartbeats retain the job lease; timeout still preserves uncertain charges.
  requestTimeoutMs: canary ? 120000 : 300000,
  ...(!canary && process.env.FOOTBALL_REASONING_EFFORT
    ? {
        reasoningEffort: process.env.FOOTBALL_REASONING_EFFORT as
          "low" | "medium" | "high",
      }
    : {}),
  peers,
  readTools: [
    ...createOwnerResearchTools(db, {
      retrievalMode: canary ? "catalog-only" : "general-public",
      ...(firecrawl ? { firecrawl } : {}),
      serverSearchAvailable:
        !canary &&
        !firecrawl &&
        process.env.FOOTBALL_SERVER_SEARCH_ENABLED === "true" &&
        manifest.document.toolPermissions.includes("research_search"),
    }),
    ...createMflOwnerReadTools(db),
    ...createGovernanceReadTools(db, store),
    ...createBuzzChannelReadTools(db),
  ],
  leagueContext: async (agentId, job) => {
    if (canary)
      return { kind: "isolated-model-canary", ownerWorkEnabled: false };
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
    const host = await getFootballHost(db, bound.league_id);
    const meetingContext = await convention.context(agentId);
    const ownerStage = await ownerStageRuntime.context(agentId);
    const football =
      host.kind === "mfl"
        ? {
            host: "mfl",
            hostVersion: host.version,
            roster:
              meetingContext.status === "managed" ||
              ownerStage.stage === "onboarding"
                ? { status: "read-on-demand-via-mfl_read" }
                : await (
                    await loadMflAdapter(db, bound.league_id)
                  ).read(actor, { type: "roster" }),
            ownerSkill: mflOwnerSkill,
            commandContract:
              "Use football.command={type:'mfl',action:<native MFL owner action>}. To save your own local ranked queue use football.command={type:'mflLocalDraftQueue',expectedVersion,playerIds}; read it with mfl_read {type:'localDraftQueue'}. This is a local preference list, never an automatic/native uploaded queue. Custom-engine commands are rejected. Read rules, draft, scores and private pending work through mfl_read. Unknown writes are held for reconciliation and must not be retried under a new causal ID.",
          }
        : {
            host: "custom",
            snapshot: await league.snapshot(bound.league_id, actor),
          };
    const deployment =
      host.kind === "mfl"
        ? MflDeploymentSchema.parse(
            JSON.parse(
              await readFile(process.env.FOOTBALL_MFL_CONFIG_FILE!, "utf8"),
            ),
          )
        : null;
    if (
      deployment &&
      (deployment.config.leagueId !== bound.league_id ||
        deployment.config.mflLeagueId !== host.identity.leagueId ||
        deployment.config.season !== host.identity.season ||
        deployment.configRef !== host.identity.configRef)
    )
      throw new Error("OWNER_STATUS_MFL_BINDING_MISMATCH");
    return {
      rehearsal: await rehearsal.context(agentId),
      ownerRuntimeStatus: await buildOwnerRuntimeStatus(db, job, {
        manifestId: manifest.id,
        maxOutputTokens,
        maxCallsPerTurn: 6,
        requestTimeoutMs: 300000,
        turnReservationMicros: reservationMicros,
        reasoningEffort: (process.env.FOOTBALL_REASONING_EFFORT ?? null) as
          "low" | "medium" | "high" | null,
        firecrawlConfigured: Boolean(firecrawl),
        serverSearchEnabled:
          !firecrawl && process.env.FOOTBALL_SERVER_SEARCH_ENABLED === "true",
        mflWritesEnabled: deployment?.writesEnabled ?? false,
        ...(process.env.FOOTBALL_HARNESS_PATCH_RECEIPT
          ? { patchReceiptId: process.env.FOOTBALL_HARNESS_PATCH_RECEIPT }
          : {}),
      }),
      football,
      convention: meetingContext,
      ownerStage,
      buzzWorkspace: await buildBuzzOwnerContext(db, agentId),
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
    if (!canary) {
      await convention.tick(leagueIds[0]);
      // Drain durable outcomes before spending on another owner turn.
      for (let n = 0; n < 10; n++) {
        const franchise = await franchiseOutbox.dispatchOne(
          "franchise-" + process.pid,
          { allowedAgentIds, leaseMs: 180000 },
        );
        const football = await outbox.dispatchOne("football-" + process.pid, {
          allowedAgentIds,
          leaseMs: 180000,
        });
        if (franchise.status === "idle" && football.status === "idle") break;
      }
      if (
        !(await ownerStageRuntime.mayInfer(bindings[0]!.id, reservationMicros))
      ) {
        if (process.argv.includes("--once")) break;
        await pause(1000);
        continue;
      }
    }
    const result = await runOne(store, selectedDriver, "live-" + process.pid, {
      leaseMs: 180000,
      maxCostMicros: reservationMicros,
      allowedAgentIds,
      onlyCanaryJobId,
    });
    if (!canary) {
      await outbox.dispatchOne("football-" + process.pid, {
        allowedAgentIds,
        leaseMs: 180000,
      });
      await franchiseOutbox.dispatchOne("franchise-" + process.pid, {
        allowedAgentIds,
        leaseMs: 180000,
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
