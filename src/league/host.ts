import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import { LeagueError, type Actor } from "./schema.js";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const MflHostConfigSchema = z
  .object({
    season: z.number().int().min(2000).max(2100),
    leagueId: z.string().regex(/^[0-9]{1,8}$/),
    configRef: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();
const CustomHostConfigSchema = z.object({}).strict();
export const HostBindingSchema = z.discriminatedUnion("host", [
  z
    .object({
      host: z.literal("custom"),
      version: z.number().int().nonnegative(),
      config: CustomHostConfigSchema,
    })
    .strict(),
  z
    .object({
      host: z.literal("mfl"),
      version: z.number().int().positive(),
      config: MflHostConfigSchema,
    })
    .strict(),
]);
export type HostBinding = z.infer<typeof HostBindingSchema>;
const common = {
  leagueId: id,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(160),
  reason: z.string().trim().min(8).max(2000),
};
export const BindHostSchema = z.discriminatedUnion("host", [
  z
    .object({
      ...common,
      host: z.literal("custom"),
      config: CustomHostConfigSchema,
    })
    .strict(),
  z
    .object({ ...common, host: z.literal("mfl"), config: MflHostConfigSchema })
    .strict(),
]);
function check(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new LeagueError(code, message);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
/** No row is legacy custom/version0. Database errors or malformed explicit bindings never fall back.
 * Config contains only host identifiers and an opaque trusted-operator reference, never credentials.
 */
export async function hostBinding(
  db: Db | Tx,
  leagueId: string,
): Promise<HostBinding> {
  id.parse(leagueId);
  const row = (
    await db.query(
      "SELECT host,version,config FROM league_host_bindings WHERE league_id=$1",
      [leagueId],
    )
  ).rows[0];
  if (!row) return { host: "custom", version: 0, config: {} };
  const parsed = HostBindingSchema.safeParse(row);
  check(
    parsed.success,
    "HOST_BINDING_INVALID",
    "Explicit football host binding is invalid; no fallback is permitted",
  );
  return parsed.data;
}
export async function getFootballHost(db: Db | Tx, leagueId: string) {
  const binding = await hostBinding(db, leagueId);
  return {
    kind: binding.host,
    version: binding.version,
    identity: binding.config,
  };
}
/** Mutating callers hold league lock7044 for their entire transaction; bindHost takes the same lock. */
export async function requireCustomHost(db: Db | Tx, leagueId: string) {
  const binding = await hostBinding(db, leagueId);
  check(
    binding.host === "custom",
    "FOOTBALL_HOST_MISMATCH",
    "This league uses MFL; custom football mutations, clocks and constitution ratification are disabled",
  );
  return binding;
}
/** Trusted provisioning only; this function makes no host request and does not claim readiness.
 * Changing a selection cannot migrate rosters, apply an MFL constitution, or activate any owner.
 */
export async function bindHost(db: Db, actor: Actor, input: unknown) {
  check(
    actor.role === "commissioner" && Boolean(actor.id),
    "FORBIDDEN",
    "Only the scoped commissioner can bind a football host",
  );
  const request = BindHostSchema.parse(input);
  check(
    actor.leagueId === request.leagueId,
    "FORBIDDEN",
    "Credential is scoped to another league",
  );
  const hash = createHash("sha256")
    .update(stable({ actor, request }))
    .digest("hex");
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
      request.leagueId,
    ]);
    const existing = (
      await tx.query(
        "SELECT * FROM league_host_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [request.leagueId, actor.id, request.idempotencyKey],
      )
    ).rows[0];
    if (existing) {
      check(
        existing.payload_hash === hash,
        "IDEMPOTENCY_CONFLICT",
        "This key already identifies a different host selection",
      );
      return {
        receiptId: existing.id,
        binding: HostBindingSchema.parse(existing.binding),
        replayed: true,
      };
    }
    check(
      (await tx.query("SELECT 1 FROM leagues WHERE id=$1", [request.leagueId]))
        .rowCount,
      "NOT_FOUND",
      "Create the local league identity before selecting its football host",
    );
    const previous = await hostBinding(tx, request.leagueId);
    check(
      previous.version === request.expectedVersion,
      "HOST_VERSION_CONFLICT",
      "Football host binding changed; inspect it before selecting another host",
    );
    check(
      !(
        await tx.query(
          "SELECT 1 FROM runtime_football_outbox WHERE league_id=$1 AND status='running' LIMIT 1",
          [request.leagueId],
        )
      ).rowCount,
      "HOST_DISPATCH_IN_FLIGHT",
      "Reconcile active football dispatch before changing the host",
    );
    check(
      !(
        await tx.query(
          "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' LIMIT 1",
          [request.leagueId],
        )
      ).rowCount,
      "HOST_OWNER_TURN_IN_FLIGHT",
      "Quiesce owner and staff jobs before changing the football host",
    );
    const binding = HostBindingSchema.parse({
      host: request.host,
      version: previous.version + 1,
      config: request.config,
    });
    await tx.query(
      `INSERT INTO league_host_bindings(league_id,host,version,config,changed_by,reason) VALUES($1,$2,$3,$4,$5,$6)
   ON CONFLICT(league_id) DO UPDATE SET host=excluded.host,version=excluded.version,config=excluded.config,changed_by=excluded.changed_by,reason=excluded.reason,changed_at=clock_timestamp()`,
      [
        request.leagueId,
        binding.host,
        binding.version,
        JSON.stringify(binding.config),
        actor.id,
        request.reason,
      ],
    );
    // Release approval belongs to the previous source of football truth, not the new host.
    await tx.query(
      "UPDATE public_league_releases SET enabled=false WHERE league_id=$1",
      [request.leagueId],
    );
    // Old queued intent was formed against another authority/version. Never reinterpret it on the new host.
    await tx.query(
      "UPDATE runtime_football_outbox SET status='held',error='HOST_BINDING_CHANGED',lease_until=NULL WHERE league_id=$1 AND status='pending'",
      [request.leagueId],
    );
    const receiptId = randomUUID();
    await tx.query(
      "INSERT INTO league_host_receipts(id,league_id,actor_id,idempotency_key,payload_hash,previous_binding,binding,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        receiptId,
        request.leagueId,
        actor.id,
        request.idempotencyKey,
        hash,
        JSON.stringify(previous),
        JSON.stringify(binding),
        request.reason,
      ],
    );
    return { receiptId, binding, replayed: false };
  });
}
