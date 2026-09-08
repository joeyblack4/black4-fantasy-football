import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.js";
export const GUARDRAIL_MAX_AGE_MS = 3600000;
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
