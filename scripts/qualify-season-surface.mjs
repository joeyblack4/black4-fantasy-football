#!/usr/bin/env node
/** Read-only owner access audit. Never prints credentials, private prompts or bids. */
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedFranchises = [
  "anthropic",
  "deepseek",
  "google",
  "kimi",
  "meta",
  "minimax",
  "mistral",
  "openai",
  "qwen",
  "xai",
  "zai",
].map((company) => `b4-${company}`);
const footballQueries = [
  { type: "capabilities" },
  { type: "leagueSettings" },
  { type: "scoringRules" },
  { type: "roster" },
  { type: "calendar", week: 1 },
  { type: "validateLineup", week: 1, starters: [] },
];
const safeText = (value) =>
  typeof value === "string" ? value.slice(0, 160) : null;

function metadata(value) {
  const data = value?.data;
  const source =
    value?.metadata ?? data?.metadata ?? data?.sourceMetadata ?? value?.source;
  return {
    receiptId: safeText(value?.id),
    receiptAt: safeText(value?.at),
    synthetic: typeof value?.synthetic === "boolean" ? value.synthetic : null,
    interfaceVersion: safeText(
      data?.interfaceVersion ?? value?.interfaceVersion,
    ),
    source:
      typeof source === "string"
        ? source
        : safeText(source?.source ?? data?.source),
    retrievedAt: safeText(
      source?.retrievedAt ?? value?.retrievedAt ?? data?.retrievedAt,
    ),
    observedAt: safeText(
      source?.observedAt ?? value?.observedAt ?? data?.observedAt,
    ),
    sourceUpdatedAt: safeText(
      source?.sourceUpdatedAt ??
        value?.sourceUpdatedAt ??
        data?.sourceUpdatedAt,
    ),
    freshness: safeText(
      source?.freshness ?? value?.freshness ?? data?.freshness,
    ),
    sources: Array.isArray(source?.sources)
      ? source.sources.map((entry) => ({
          source: safeText(entry?.source),
          observedAt: safeText(entry?.observedAt),
          sourceUpdatedAt: safeText(entry?.sourceUpdatedAt),
          freshness: safeText(entry?.freshness),
        }))
      : [],
  };
}

async function request(config, method, path, input, fetchImpl) {
  const base = new URL(config.baseUrl);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  ) {
    return {
      status: "failed",
      httpStatus: null,
      errorCode: "INSECURE_REMOTE_ENDPOINT",
    };
  }
  try {
    const response = await fetchImpl(new URL(path, base), {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(input ? { "content-type": "application/json" } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    const value = await response.json();
    return response.ok
      ? { status: "accessible", httpStatus: response.status, value }
      : {
          status: "failed",
          httpStatus: response.status,
          errorCode: /^[A-Z_0-9-]+$/.test(value?.error ?? "")
            ? value.error
            : "HTTP_ERROR",
        };
  } catch {
    return {
      status: "unknown",
      httpStatus: null,
      errorCode: "READ_UNAVAILABLE",
    };
  }
}

export async function auditOwner(id, config, fetchImpl = fetch) {
  const row = {
    franchise: id,
    checkedAt: new Date().toISOString(),
    identity: null,
    checks: [],
    nativeExecution: "not_tested",
    privateDataIncluded: false,
  };
  const identity = await request(config, "GET", "/v1/me", undefined, fetchImpl);
  if (identity.status !== "accessible") {
    row.identity = identity;
    return row;
  }
  const actor = identity.value;
  const bindingMatches =
    actor?.role === "owner" &&
    actor?.agentId === id &&
    actor?.teamId === config.teamId &&
    actor?.leagueId === config.leagueId;
  row.identity = {
    status: bindingMatches ? "verified" : "failed",
    httpStatus: identity.httpStatus,
    role: safeText(actor?.role),
    agentId: safeText(actor?.agentId),
    teamId: safeText(actor?.teamId),
    leagueId: safeText(actor?.leagueId),
    ...(bindingMatches ? {} : { errorCode: "OWNER_BINDING_MISMATCH" }),
  };
  if (!bindingMatches) return row;
  for (const query of footballQueries) {
    const response = await request(
      config,
      "POST",
      "/v1/football/read",
      query,
      fetchImpl,
    );
    if (response.status !== "accessible") {
      row.checks.push({ capability: query.type, ...response });
      continue;
    }
    const value = response.value;
    const scopeMatches =
      value?.leagueId === config.leagueId && value?.teamId === config.teamId;
    row.checks.push({
      capability: query.type,
      status: scopeMatches ? "accessible" : "failed",
      httpStatus: response.httpStatus,
      metadata: metadata(value),
      ...(scopeMatches ? {} : { errorCode: "READ_SCOPE_MISMATCH" }),
      ...(query.type === "validateLineup"
        ? {
            submitted: value?.data?.submitted === false ? false : null,
            emptyLineupRejected: value?.data?.valid === false ? true : null,
          }
        : {}),
    });
  }
  const scheduler = await request(
    config,
    "GET",
    "/v1/owner/schedules",
    undefined,
    fetchImpl,
  );
  row.checks.push(
    scheduler.status === "accessible"
      ? {
          capability: "schedules",
          status: "accessible",
          httpStatus: scheduler.httpStatus,
          metadata: metadata(scheduler.value),
          executionVerified: false,
        }
      : { capability: "schedules", ...scheduler },
  );
  return row;
}

export async function runAudit({ directory = root, fetchImpl = fetch } = {}) {
  const registry = JSON.parse(
    await readFile(join(directory, "config/native-harnesses.json"), "utf8"),
  );
  const configured = Object.keys(registry.franchises).sort();
  const rosterMatches =
    configured.length === expectedFranchises.length &&
    expectedFranchises.every((id) => configured.includes(id));
  const rows = [];
  const documentParity = [];
  let commonAccess;
  for (const id of expectedFranchises) {
    const workspace = join(
      directory,
      "franchises",
      id.replace(/^b4-/, ""),
      "workspace",
    );
    try {
      const access = await readFile(
        join(workspace, "LEAGUE_ACCESS.md"),
        "utf8",
      );
      commonAccess ??= access;
      const canonicalLinks = await Promise.all(
        [
          "START_HERE.md",
          "RULEBOOK.md",
          "OWNER_CHARTER.md",
          "SEASON_OPERATIONS.md",
        ].map(
          async (name, index) =>
            (await realpath(join(workspace, name))) ===
            (await realpath(
              join(
                directory,
                "docs",
                [
                  "FRANCHISE_START.md",
                  "SEASON_RULES.md",
                  "OWNER_CHARTER.md",
                  "SEASON_OPERATIONS.md",
                ][index],
              ),
            )),
        ),
      );
      documentParity.push({
        franchise: id,
        sameAccessGuide: access === commonAccess,
        canonicalLinks: canonicalLinks.every(Boolean),
      });
    } catch {
      documentParity.push({
        franchise: id,
        sameAccessGuide: false,
        canonicalLinks: false,
      });
    }
  }
  for (const id of expectedFranchises) {
    let config;
    try {
      config = JSON.parse(
        await readFile(
          join(directory, ".local/native-league", `${id}.json`),
          "utf8",
        ),
      );
    } catch {
      rows.push({
        franchise: id,
        identity: { status: "failed", errorCode: "MISSING_OWNER_BINDING" },
        checks: [],
        nativeExecution: "not_tested",
      });
      continue;
    }
    rows.push(await auditOwner(id, config, fetchImpl));
  }
  const versions = [
    ...new Set(
      rows.flatMap((row) =>
        row.checks
          .filter((check) => check.capability === "capabilities")
          .map((check) => check.metadata?.interfaceVersion)
          .filter(Boolean),
      ),
    ),
  ];
  const allAccessible =
    rosterMatches &&
    rows.every(
      (row) =>
        row.identity?.status === "verified" &&
        row.checks.length === footballQueries.length + 1 &&
        row.checks.every((check) => check.status === "accessible"),
    );
  const capabilitiesKnownForAll = rows.every((row) =>
    row.checks.some(
      (check) =>
        check.capability === "capabilities" && check.metadata?.interfaceVersion,
    ),
  );
  return {
    checkedAt: new Date().toISOString(),
    mode: "read_only",
    scope:
      "Eleven owner identities and common HTTP read access; no model invocation, messaging, scheduling writes or football transactions.",
    expectedOwnerCount: expectedFranchises.length,
    registryMatches: rosterMatches,
    allReadAccessVerified: allAccessible,
    interfaceParity:
      capabilitiesKnownForAll && versions.length === 1 ? "verified" : "unknown",
    interfaceVersions: versions,
    nativeWakeQualification: "not_tested",
    commonDocumentationParity: documentParity.every(
      (row) => row.sameAccessGuide && row.canonicalLinks,
    )
      ? "verified"
      : "failed",
    documents: documentParity,
    rows,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length > 2) {
    console.error(
      "Usage: node scripts/qualify-season-surface.mjs (read-only JSON to stdout; week1 read/empty-lineup validation only)",
    );
    process.exitCode = 2;
  } else {
    try {
      const report = await runAudit();
      console.log(JSON.stringify(report, null, 2));
      if (
        !report.allReadAccessVerified ||
        report.interfaceParity !== "verified" ||
        report.commonDocumentationParity !== "verified"
      )
        process.exitCode = 1;
    } catch {
      console.error(
        "Qualification could not read its registry or owner configuration; no credentials or private payloads were printed.",
      );
      process.exitCode = 1;
    }
  }
}
