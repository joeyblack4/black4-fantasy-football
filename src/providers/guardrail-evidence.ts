import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.js";
export const GUARDRAIL_MAX_AGE_MS = 3600000;
export const SINGLE_PROVIDER_LIMITATION =
  "Independent wrong-provider denial is not testable against the currently advertised endpoints. Exact provider policy and local routing are verified; a live rejection by an independent serving endpoint is not claimed.";
export const MODEL_CONTROL_GAP_LIMITATION =
  "Upstream wrong-model rejection was not independently tested: no callable alternate model was found on the exact moonshotai/mxfp4 endpoint in the bounded Moonshot catalog search. The operator accepts exact key/model/provider policy, a real correct-model/tool canary, and executable local pin and wrong-return rejection checks instead. This is weaker upstream test coverage, not an equivalent live denial.";
export function singleServingBranch(
  assigned: string,
  activeTags: unknown,
): boolean {
  return (
    Array.isArray(activeTags) &&
    activeTags.length > 0 &&
    activeTags.includes(assigned) &&
    new Set(activeTags).size === activeTags.length &&
    activeTags.every(
      (t) =>
        typeof t === "string" &&
        (t === assigned || assigned.startsWith(t + "/")),
    )
  );
}
/** Empirical authenticated routing diagnostics, not a documented provider error-code contract.
 * One eligible input endpoint must be eliminated by exactly the tested guardrail dimension. */
export function empiricalRoutingRejection(
  body: any,
  kind: "wrong_model" | "wrong_provider",
) {
  const reason =
    kind === "wrong_model"
      ? "model-ignored-by-guardrail"
      : "provider-not-allowed-by-guardrail";
  const metadata = body.error?.metadata;
  return (
    body.httpStatus === 404 &&
    body.error?.code === 404 &&
    body.responseComplete === true &&
    body.hasGeneration === false &&
    body.hasChoices === false &&
    metadata?.failed_routing_step === "Filter by Guardrails" &&
    metadata.input_endpoint_count === 1 &&
    Array.isArray(metadata.ineligibility_reasons) &&
    metadata.ineligibility_reasons.length === 1 &&
    metadata.ineligibility_reasons[0]?.reason === reason &&
    metadata.ineligibility_reasons[0]?.endpoint_count === 1 &&
    !/authentication|unauthorized|quota|budget|insufficient credits|rate.limit|provider.unavailable|timed.out/i.test(
      String(body.error?.message ?? ""),
    )
  );
}
/** Read-only accounting proof: either settled zero, or the entire uncertain reservation still
 * contributes to the wallet hold. Never releases funds or claims an unobserved zero charge. */
export async function negativeChargeProtection(
  db: Pick<Db, "query">,
  body: any,
  agentId: string,
  allowHeld: boolean,
  allowObservedCost = false,
) {
  const r = (
    await db.query(
      `SELECT r.*,a.reserved_micros,
    (SELECT COALESCE(sum(amount_micros),0) FROM runtime_reservations x WHERE x.agent_id=r.agent_id AND x.status IN ('reserved','uncertain')) AS outstanding_micros
    FROM runtime_reservations r JOIN runtime_agents a ON a.id=r.agent_id WHERE r.id=$1`,
      [body.reservationId],
    )
  ).rows[0];
  if (!r || r.agent_id !== agentId || r.job_id !== body.jobId) return null;
  if (
    r.status === "settled" &&
    r.actual_micros !== null &&
    Number(r.actual_micros) === 0 &&
    (r.observed_micros === null || Number(r.observed_micros) === 0)
  )
    return {
      chargeProtected: true,
      costKnownZero: true,
      budgetProtection: "settled_zero" as const,
    };
  if (
    allowHeld &&
    r.status === "uncertain" &&
    r.actual_micros === null &&
    (r.observed_micros === null ||
      Number(r.observed_micros) === 0 ||
      (allowObservedCost &&
        BigInt(r.observed_micros) >= 0n &&
        BigInt(r.observed_micros) <= BigInt(r.amount_micros))) &&
    Number.isSafeInteger(body.reservationMicros) &&
    body.reservationMicros > 0 &&
    BigInt(r.amount_micros) === BigInt(body.reservationMicros) &&
    BigInt(r.reserved_micros) >= BigInt(r.outstanding_micros)
  )
    return {
      chargeProtected: true,
      costKnownZero: false,
      budgetProtection: "full_uncertain_reservation_held" as const,
    };
  return null;
}
export function evidenceHash(value: unknown): string {
  const ordered = (v: any): any =>
    Array.isArray(v)
      ? v.map(ordered)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, ordered(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
export async function saveGuardrailArtifact(
  db: Pick<Db, "query">,
  manifestId: string,
  kind: string,
  synthetic: boolean,
  body: Record<string, unknown>,
) {
  const id = randomUUID(),
    hash = evidenceHash(body);
  await db.query(
    "INSERT INTO provider_guardrail_artifacts(id,manifest_id,kind,synthetic,body,body_hash) VALUES($1,$2,$3,$4,$5,$6)",
    [id, manifestId, kind, synthetic, body, hash],
  );
  return id;
}
export async function readGuardrailArtifact(
  db: Pick<Db, "query">,
  id: string,
  manifestId: string,
  kind: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("GUARDRAIL_EVIDENCE_REQUIRED");
  const row = (
    await db.query(
      `SELECT *, clock_timestamp() BETWEEN observed_at AND observed_at + $4::bigint * interval '1 millisecond' AS evidence_fresh
       FROM provider_guardrail_artifacts WHERE id=$1 AND manifest_id=$2 AND kind=$3`,
      [id, manifestId, kind, GUARDRAIL_MAX_AGE_MS],
    )
  ).rows[0];
  if (!row || evidenceHash(row.body) !== row.body_hash)
    throw Error("GUARDRAIL_EVIDENCE_TAMPERED_OR_MISSING");
  if (row.evidence_fresh !== true) throw Error("GUARDRAIL_EVIDENCE_STALE");
  return row;
}
export async function guardrailClock(db: Pick<Db, "query">): Promise<string> {
  return (
    await db.query("SELECT clock_timestamp() AS now")
  ).rows[0].now.toISOString();
}
export async function guardrailTimestampFresh(
  db: Pick<Db, "query">,
  at: string,
  maxAgeMs: number,
): Promise<boolean> {
  return (
    (
      await db.query(
        "SELECT clock_timestamp() BETWEEN $1::timestamptz AND $1::timestamptz + $2::bigint * interval '1 millisecond' AS fresh",
        [at, maxAgeMs],
      )
    ).rows[0].fresh === true
  );
}
/** Only bounded error fields survive. No choices, model output, headers or credentials. */
export function protectedError(raw: unknown, secrets: string[]) {
  const clean = (value: any, depth = 0): any => {
    if (depth > 5) return "[DEPTH_LIMIT]";
    if (typeof value === "string") {
      let s = value;
      for (const secret of secrets)
        if (secret) s = s.split(secret).join("[REDACTED]");
      return s
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
        .slice(0, 4000);
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (Array.isArray(value))
      return value.slice(0, 20).map((v) => clean(v, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key) &&
              !secrets.some((secret) => secret && key.includes(secret)),
          )
          .slice(0, 40)
          .map(([k, v]) => [
            k,
            /secret|password|authorization|credential|token|api.?key|private.?key/i.test(
              k,
            )
              ? "[REDACTED]"
              : clean(v, depth + 1),
          ]),
      );
    return null;
  };
  return clean((raw as any)?.error ?? null);
}
