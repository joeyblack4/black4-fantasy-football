import { createHash } from "node:crypto";
import { z } from "zod";
import { statNames, ScoringRulesSchema, type ScoringRules } from "./index.js";
export type ObservedField = {
  path: string;
  types: string[];
  occurrences: number;
  formats: string[];
};
export type NflSchemaEvidence = {
  evidenceClass: "structural-only";
  payloadSha256: string;
  fields: ObservedField[];
  truncated: boolean;
  authentication: "unverified";
  commercialEntitlement: "unverified";
};
/** Describe an actual supplied payload without guessing NFL keys or retaining licensed values/secrets. */
export function inspectNflPayload(payload: unknown): NflSchemaEvidence {
  const encoded = JSON.stringify(payload);
  if (!encoded || Buffer.byteLength(encoded) > 16_000_000)
    throw new Error("Fixture must be JSON within sixteen megabytes");
  const fields = new Map<
    string,
    { types: Set<string>; occurrences: number; formats: Set<string> }
  >();
  let nodes = 0,
    truncated = false;
  function walk(value: unknown, path: string, depth: number) {
    if (++nodes > 50000 || depth > 20) {
      truncated = true;
      return;
    }
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const field = fields.get(path) ?? {
      types: new Set<string>(),
      occurrences: 0,
      formats: new Set<string>(),
    };
    field.types.add(type);
    field.occurrences++;
    if (typeof value === "number")
      field.formats.add(
        Number.isSafeInteger(value)
          ? "safe-integer"
          : Number.isFinite(value)
            ? "finite-number"
            : "invalid-number",
      );
    if (typeof value === "string") {
      if (
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
        Number.isFinite(Number(value))
      )
        field.formats.add("numeric-string");
      if (
        /^\d{4}-\d{2}-\d{2}T/.test(value) &&
        Number.isFinite(Date.parse(value))
      )
        field.formats.add("timestamp-string");
    }
    fields.set(path, field);
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry, path + "[*]", depth + 1);
        if (truncated) break;
      }
    } else if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, path + "[" + JSON.stringify(key) + "]", depth + 1);
        if (truncated) break;
      }
  }
  walk(payload, "$", 0);
  return {
    evidenceClass: "structural-only",
    payloadSha256: createHash("sha256").update(encoded).digest("hex"),
    fields: [...fields]
      .map(([path, f]) => ({
        path,
        types: [...f.types].sort(),
        occurrences: f.occurrences,
        formats: [...f.formats].sort(),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    truncated,
    authentication: "unverified",
    commercialEntitlement: "unverified",
  };
}
const path = z.string().min(1).max(2000).startsWith("$");
const binding = z
  .object({
    path,
    encoding: z.enum([
      "string",
      "number",
      "numeric-string",
      "timestamp-string",
    ]),
  })
  .strict();
export const NflMapperPlanSchema = z
  .object({
    provider: z.literal("rolling-insights"),
    version: z.string().min(1).max(120),
    fixtureSha256: z.string().regex(/^[0-9a-f]{64}$/),
    playerId: binding,
    gameId: binding,
    revision: binding,
    sourceAt: binding,
    gameStatus: binding,
    stats: z.partialRecord(z.enum(statNames), binding),
  })
  .strict();
export type NflMapperPlan = z.infer<typeof NflMapperPlanSchema>;
/** Structural coverage helps write the mapper. It cannot establish auth, NFL semantics or commercial rights. */
export function assessNflMapperPlan(
  evidence: NflSchemaEvidence | undefined,
  plan: NflMapperPlan | undefined,
  rules: ScoringRules,
) {
  const scoring = ScoringRulesSchema.parse(rules);
  const requiredStats = Object.entries(scoring.milliPointsPerUnit)
    .filter(([, coefficient]) => coefficient !== 0)
    .map(([stat]) => stat);
  if (
    scoring.defensePointsAllowed &&
    !requiredStats.includes("defensePointsAllowed")
  )
    requiredStats.push("defensePointsAllowed");
  const blockers: string[] = [];
  if (!evidence) blockers.push("AUTHENTICATED_NFL_FIXTURE_REQUIRED");
  if (!plan) blockers.push("EXPLICIT_FIELD_MAPPING_REQUIRED");
  if (evidence?.truncated) blockers.push("FIXTURE_SCHEMA_SCAN_TRUNCATED");
  if (evidence && plan) {
    const parsed = NflMapperPlanSchema.parse(plan);
    if (parsed.fixtureSha256 !== evidence.payloadSha256)
      blockers.push("FIXTURE_HASH_MISMATCH");
    const bindings: Record<string, z.infer<typeof binding> | undefined> = {
      playerId: parsed.playerId,
      gameId: parsed.gameId,
      revision: parsed.revision,
      sourceAt: parsed.sourceAt,
      gameStatus: parsed.gameStatus,
    };
    for (const stat of requiredStats)
      bindings["stats." + stat] =
        parsed.stats[stat as (typeof statNames)[number]];
    for (const [name, mapping] of Object.entries(bindings)) {
      if (!mapping) {
        blockers.push("MISSING_MAPPING:" + name);
        continue;
      }
      const observed = evidence.fields.find((f) => f.path === mapping.path);
      if (!observed) {
        blockers.push("UNOBSERVED_PATH:" + name);
        continue;
      }
      const compatible =
        mapping.encoding === "number"
          ? observed.types.includes("number")
          : mapping.encoding === "string"
            ? observed.types.includes("string")
            : observed.formats.includes(mapping.encoding);
      if (!compatible) blockers.push("UNVERIFIED_ENCODING:" + name);
    }
  }
  return {
    status: blockers.length ? "blocked" : "ready-for-mapper-review",
    requiredStats,
    blockers,
    liveReady: false,
    remainingChecks: [
      "authenticated-vendor-response",
      "player-and-game-identity-mapping",
      "NFL-stat-semantics",
      "revision-and-correction-behavior",
      "freshness-and-source-timestamps",
      "paid-commercial-entitlement",
      "mapper-fixture-and-live-canary",
    ],
  };
}
