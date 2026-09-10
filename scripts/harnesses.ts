import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDb } from "../src/db.js";
import {
  leagueHarnessSelection,
  LEAGUE_HARNESS_PROFILE,
  DeveloperSchema,
  RuntimeConfigSchema,
  setupBlockers,
} from "../src/harnesses/catalog.js";
import { prepareWorkspace } from "../src/harnesses/workspaces.js";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--prepare", "--inventory"].includes(flag)))
  throw Error(
    "Use --inventory for read-only state, or --prepare for local workspaces only.",
  );
if (!process.env.FOOTBALL_DATABASE_URL_FILE)
  throw Error(
    "Explicit FOOTBALL_DATABASE_URL_FILE required; no development database fallback.",
  );
const db = createDb(
  (await readFile(process.env.FOOTBALL_DATABASE_URL_FILE, "utf8")).trim(),
);
try {
  // No migrations, provider calls, secret values, or state changes. Read one coherent snapshot.
  const tx = await db.connect();
  let rows;
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    rows = (
      await tx.query(
        `SELECT a.id AS agent_id, a.model, a.enabled, t.league_id, t.id AS team_id,
      p.id AS manifest_id, p.document->>'developer' AS developer,
      p.document->>'canonicalModel' AS canonical_model,
      p.document->>'providerSlug' AS provider,
      p.document->>'harnessId' AS legacy_harness,
      EXISTS(SELECT 1 FROM runtime_jobs j WHERE j.agent_id=a.id AND j.status='running' AND j.lease_until>clock_timestamp()) AS busy
      FROM league_teams t LEFT JOIN runtime_bindings b ON b.league_id=t.league_id AND b.team_id=t.id
      LEFT JOIN runtime_agents a ON a.id=b.agent_id AND a.kind='ai'
      LEFT JOIN LATERAL (SELECT id,document FROM provider_manifests WHERE agent_id=a.id AND league_id=t.league_id AND status='active' ORDER BY version DESC LIMIT 1) p ON true
      WHERE t.league_id=$1 AND t.kind='ai' ORDER BY t.id`,
        [process.env.FOOTBALL_LEAGUE_ID ?? "black4-fantasy-2026"],
      )
    ).rows;
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
  const root = resolve(
    process.env.FOOTBALL_WORKSPACES_ROOT ??
      `.local/franchise-runtimes/${LEAGUE_HARNESS_PROFILE}`,
  );
  const charter = flags.has("--prepare")
    ? await readFile(
        new URL("../docs/OWNER_CHARTER.md", import.meta.url),
        "utf8",
      )
    : "";
  const franchises = [];
  const incomplete =
    rows.length !== 10 ||
    new Set(rows.map((r) => r.developer)).size !== 10 ||
    rows.some(
      (row) =>
        !row.agent_id ||
        !row.manifest_id ||
        !DeveloperSchema.safeParse(row.developer).success,
    );
  if (flags.has("--prepare") && (incomplete || rows.some((row) => row.busy)))
    throw Error(
      "HARNESS_FLEET_INCOMPLETE_OR_BUSY: preparation requires all ten assigned AI franchises idle.",
    );
  for (const row of rows) {
    if (
      !row.agent_id ||
      !row.manifest_id ||
      !DeveloperSchema.safeParse(row.developer).success
    ) {
      franchises.push({
        ...row,
        config: null,
        blockers: ["BOUND_AGENT_AND_ACTIVE_PROVIDER_MANIFEST_REQUIRED"],
      });
      continue;
    }
    const developer = DeveloperSchema.parse(row.developer);
    const selection = leagueHarnessSelection(developer);
    const config = RuntimeConfigSchema.parse({
      version: 1,
      leagueId: row.league_id,
      agentId: row.agent_id,
      teamId: row.team_id,
      developer,
      assignedModel: row.model,
      canonicalModel: row.canonical_model ?? row.model,
      harnessId: selection.harnessId,
      harnessVersion: null,
      providerModel: null,
      credentialRef:
        "B4_LEAGUE_NATIVE_" + row.agent_id.replace(/^b4-/, "").toUpperCase(),
      status: "staged",
      productionActions: false,
      exceptionReason: selection.exceptionReason,
    });
    if (flags.has("--prepare") && row.busy)
      throw Error("FRANCHISE_TURN_ACTIVE: " + row.agent_id);
    franchises.push({
      ...row,
      config,
      blockers: setupBlockers(config),
      ...(flags.has("--prepare")
        ? { workspace: await prepareWorkspace(root, config, charter) }
        : {}),
    });
  }
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        selectionProfile: LEAGUE_HARNESS_PROFILE,
        status: incomplete
          ? "INCOMPLETE_INVENTORY"
          : flags.has("--prepare")
            ? "PREPARED_LOCALLY"
            : "READ_ONLY_INVENTORY",
        databaseMutations: 0,
        modelCalls: 0,
        productionActions: false,
        franchises,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
