import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Principal } from "../auth.js";
import { RuntimeStore } from "../runtime/index.js";
import {
  ManifestRegistry,
  ManifestSchema,
  keyFingerprint,
  type Manifest,
} from "./manifests.js";

const MetadataSchema = z
  .object({
    id: z.string().min(1).max(500),
    model: z.string().min(1).max(500),
    provider_name: z.string().min(1).max(500),
    total_cost: z.number().finite().nonnegative(),
    native_tokens_prompt: z.number().int().nonnegative().safe().nullish(),
    native_tokens_completion: z.number().int().nonnegative().safe().nullish(),
    native_tokens_reasoning: z.number().int().nonnegative().safe().nullish(),
    request_id: z.string().max(500).nullish(),
    upstream_id: z.string().max(500).nullish(),
  })
  .refine(
    (value) =>
      value.total_cost !== 0 ||
      (value.native_tokens_prompt != null &&
        value.native_tokens_completion != null),
    { message: "Zero cost requires explicit native usage" },
  );
type Call = {
  id: string;
  manifest_id: string;
  agent_id: string;
  job_id: string | null;
  fence: number | null;
  generation_id: string | null;
  reported_model: string | null;
  reported_provider: string | null;
  requested_model: string;
  requested_provider: string;
  reconciliation_status: string;
  status: string;
  cost_micros: string | null;
  prompt_tokens: string | null;
  completion_tokens: string | null;
};
export type ReconcileReport = {
  manifestId: string;
  calls: { id: string; status: string }[];
  reservations: { id: string; status: string; actualMicros?: number }[];
};
function fail(code: string): never {
  throw new Error(code);
}
function micros(cost: number) {
  const amount = Math.ceil(cost * 1_000_000);
  if (!Number.isSafeInteger(amount) || amount < 0)
    fail("RECONCILE_COST_INVALID");
  return amount;
}

/** Operator-only metadata reads and accounting. Never activates a manifest or repeats inference. */
export class BillingReconciler {
  constructor(
    private db: Db,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  private async bound(
    tx: Pick<Tx, "query">,
    manifest: Manifest,
    secret: string,
  ) {
    if (manifest.key_fingerprint !== keyFingerprint(secret))
      fail("RECONCILE_KEY_MISMATCH");
    const d = ManifestSchema.parse(manifest.document);
    if (
      !(
        await tx.query(
          `SELECT 1 FROM runtime_bindings b JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1 AND b.league_id=$2 AND a.kind='ai'`,
          [d.agentId, d.leagueId],
        )
      ).rowCount
    )
      fail("RECONCILE_BINDING_MISMATCH");
  }
  private async alert(
    tx: Tx,
    agentId: string,
    jobId: string | null,
    details: Record<string, unknown>,
  ) {
    // Agent lock serializes this dedup check. Details contain identifiers/costs, never credentials or raw HTTP bodies.
    await tx.query(
      `INSERT INTO runtime_receipts(type,agent_id,job_id,details) SELECT 'billing.discrepancy',$1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM runtime_receipts WHERE type='billing.discrepancy' AND agent_id=$1 AND details=$3::jsonb)`,
      [agentId, jobId, details],
    );
  }
  private async aggregateBillingEvidence(tx: Pick<Tx, "query">, call: Call) {
    // An internal server-tool loop can be billed as an aggregate while /generation
    // describes one generation. Metadata alone cannot establish the aggregate basis.
    const diagnostics = (
      await tx.query<{ details: Record<string, unknown> }>(
        `SELECT details FROM runtime_receipts WHERE type='provider_diagnostic'
         AND agent_id=$1 AND details->>'callId'=$2
         AND details->>'kind' IN ('server_search_billing','server_search_billing_unresolved','aggregate_billing')`,
        [call.agent_id, call.id],
      )
    ).rows;
    const unresolved =
      call.status === "server_search_billing_unresolved" ||
      diagnostics.length > 0;
    const amounts = [
      call.cost_micros === null ? null : Number(call.cost_micros),
      ...diagnostics.map((r) => r.details.aggregateCostMicros),
    ].filter(
      (v): v is number =>
        typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
    );
    return { unresolved, observedAggregateCostsMicros: [...new Set(amounts)] };
  }
  async reconcile(
    actor: Principal,
    input: { manifestId: string; secret: string; limit?: number },
  ): Promise<ReconcileReport> {
    const registry = new ManifestRegistry(this.db),
      m = await registry.get(input.manifestId);
    if (actor.role !== "commissioner" || actor.leagueId !== m.document.leagueId)
      fail("RECONCILE_OPERATOR_FORBIDDEN");
    await this.bound(this.db, m, input.secret);
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("RECONCILE_LIMIT_INVALID");
    const report: ReconcileReport = {
      manifestId: m.id,
      calls: [],
      reservations: [],
    };
    const pending = (
      await this.db.query<Call>(
        `SELECT * FROM provider_calls WHERE manifest_id=$1 AND reconciliation_status='pending' ORDER BY started_at,id LIMIT $2`,
        [m.id, limit],
      )
    ).rows;
    for (const call of pending) {
      if (!call.generation_id) {
        report.calls.push({ id: call.id, status: "pending_unidentifiable" });
        continue;
      }
      if (
        (
          await this.db.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [m.document.agentId],
          )
        ).rowCount
      ) {
        report.calls.push({ id: call.id, status: "pending_active_job" });
        continue;
      }
      let metadata: z.infer<typeof MetadataSchema>;
      try {
        const response = await this.fetchImpl(
          "https://openrouter.ai/api/v1/generation?id=" +
            encodeURIComponent(call.generation_id),
          {
            headers: { authorization: "Bearer " + input.secret },
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) {
          report.calls.push({
            id: call.id,
            status: "pending_metadata_http_" + response.status,
          });
          continue;
        }
        const raw = (await response.json()) as { data?: unknown };
        const parsed = MetadataSchema.safeParse(raw.data);
        if (!parsed.success) {
          report.calls.push({
            id: call.id,
            status: "pending_metadata_incomplete",
          });
          continue;
        }
        metadata = parsed.data;
      } catch {
        report.calls.push({
          id: call.id,
          status: "pending_metadata_unavailable",
        });
        continue;
      }
      const cost = micros(metadata.total_cost);
      const status = await transaction(this.db, async (tx) => {
        await tx.query(
          "SELECT id FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
          [m.document.agentId],
        );
        await this.bound(tx, m, input.secret);
        if (
          (
            await tx.query(
              "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
              [m.document.agentId],
            )
          ).rowCount
        )
          return "pending_active_job";
        const current = (
          await tx.query<Call>(
            "SELECT * FROM provider_calls WHERE id=$1 FOR UPDATE",
            [call.id],
          )
        ).rows[0];
        if (current.reconciliation_status !== "pending")
          return "already_" + current.reconciliation_status;
        const duplicate = await tx.query(
          "SELECT 1 FROM provider_calls WHERE generation_id=$1 AND id<>$2 LIMIT 1",
          [metadata.id, call.id],
        );
        if (
          current.agent_id !== m.document.agentId ||
          current.manifest_id !== m.id ||
          current.requested_model !== m.document.model ||
          current.requested_provider !== m.document.providerSlug ||
          current.generation_id !== metadata.id ||
          ![m.document.model, m.document.canonicalModel]
            .filter(Boolean)
            .includes(metadata.model) ||
          !m.document.reportedProviderNames.includes(metadata.provider_name) ||
          duplicate.rowCount
        ) {
          await tx.query(
            "UPDATE provider_calls SET reconciliation_status='mismatch',status='reconciliation_identity_mismatch' WHERE id=$1",
            [call.id],
          );
          await this.alert(tx, current.agent_id, current.job_id, {
            callId: call.id,
            reason: duplicate.rowCount
              ? "duplicate_generation"
              : "metadata_identity_mismatch",
            observedGenerationId: metadata.id,
            observedModel: metadata.model,
            observedProvider: metadata.provider_name,
            observedCostMicros: cost,
          });
          return "mismatch";
        }
        const aggregate = await this.aggregateBillingEvidence(tx, current);
        if (aggregate.unresolved) {
          const differs = aggregate.observedAggregateCostsMicros.some(
            (amount) => amount !== cost,
          );
          await this.alert(tx, current.agent_id, current.job_id, {
            callId: current.id,
            reason: differs
              ? "server_search_aggregate_cost_difference"
              : "server_search_aggregate_basis_unresolved",
            observedAggregateCostsMicros:
              aggregate.observedAggregateCostsMicros,
            observedGenerationCostMicros: cost,
            adjustmentApplied: false,
            reservationReleased: false,
          });
          // Preserve the original call status, response cost and pending reconciliation.
          // Even an equal metadata figure cannot clear an explicitly unresolved basis.
          return differs
            ? "pending_aggregate_cost_discrepancy"
            : "pending_aggregate_billing_review";
        }
        // observe only uses query; retain its update inside this agent/call transaction.
        await new ManifestRegistry(tx as unknown as Db).observe(call.id, {
          status: "verified",
          model: metadata.model,
          provider: metadata.provider_name,
          generationId: metadata.id,
          requestId: metadata.request_id ?? undefined,
          upstreamId: metadata.upstream_id ?? undefined,
          costMicros: cost,
          promptTokens: metadata.native_tokens_prompt ?? undefined,
          completionTokens: metadata.native_tokens_completion ?? undefined,
          reasoningTokens: metadata.native_tokens_reasoning ?? undefined,
          reconciled: true,
        });
        return "verified";
      });
      report.calls.push({ id: call.id, status });
    }
    const reservations = (
      await this.db.query(
        `SELECT r.* FROM runtime_reservations r WHERE r.agent_id=$3 AND r.status IN ('uncertain','settled','released') AND (r.status='uncertain' OR EXISTS (SELECT 1 FROM provider_calls c WHERE c.job_id=r.job_id AND c.fence=r.fence AND c.manifest_id=$1)) ORDER BY CASE WHEN r.status='uncertain' THEN 0 ELSE 1 END,r.created_at DESC LIMIT $2`,
        [m.id, limit, m.document.agentId],
      )
    ).rows;
    for (const reservation of reservations) {
      const verify = async (tx: Pick<Tx, "query">): Promise<number> => {
        await this.bound(tx, m, input.secret);
        if (
          (
            await tx.query(
              "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
              [reservation.agent_id],
            )
          ).rowCount
        )
          fail("RECONCILE_ACTIVE_JOB");
        const calls = (
          await tx.query<Call>(
            "SELECT * FROM provider_calls WHERE job_id=$1 AND fence=$2 ORDER BY id",
            [reservation.job_id, reservation.fence],
          )
        ).rows;
        if (
          !calls.length ||
          calls.some(
            (c) =>
              c.manifest_id !== m.id ||
              c.agent_id !== reservation.agent_id ||
              !c.generation_id ||
              c.reconciliation_status !== "verified" ||
              c.requested_model !== m.document.model ||
              c.requested_provider !== m.document.providerSlug ||
              ![m.document.model, m.document.canonicalModel]
                .filter(Boolean)
                .includes(c.reported_model ?? "") ||
              !m.document.reportedProviderNames.includes(
                c.reported_provider ?? "",
              ) ||
              c.cost_micros === null ||
              Number(c.cost_micros) < 0 ||
              (Number(c.cost_micros) === 0 &&
                (c.prompt_tokens === null || c.completion_tokens === null)),
          )
        )
          fail("RECONCILE_CALLS_UNRESOLVED");
        // Also fence settlement if an aggregate diagnostic was added after the call
        // became verified (including older reconcilers that overwrote its status).
        for (const call of calls)
          if ((await this.aggregateBillingEvidence(tx, call)).unresolved)
            fail("RECONCILE_AGGREGATE_BILLING_UNRESOLVED");
        if (new Set(calls.map((c) => c.generation_id)).size !== calls.length)
          fail("RECONCILE_DUPLICATE_GENERATION");
        const duplicate = await tx.query(
          "SELECT generation_id FROM provider_calls WHERE generation_id=ANY($1::text[]) GROUP BY generation_id HAVING count(*)>1",
          [calls.map((c) => c.generation_id)],
        );
        if (duplicate.rowCount) fail("RECONCILE_DUPLICATE_GENERATION");
        const sum = calls.reduce((v, c) => v + Number(c.cost_micros), 0);
        if (!Number.isSafeInteger(sum) || sum < 0)
          fail("RECONCILE_COST_INVALID");
        return sum;
      };
      try {
        if (reservation.status === "uncertain") {
          const sum = await verify(this.db);
          await new RuntimeStore(this.db).reconcileReservation(
            reservation.id,
            sum,
            `OpenRouter exact generation metadata; manifest=${m.id}; job=${reservation.job_id}; fence=${reservation.fence}`,
            async (tx) => {
              if ((await verify(tx)) !== sum) fail("RECONCILE_COST_CHANGED");
            },
          );
          report.reservations.push({
            id: reservation.id,
            status: "settled",
            actualMicros: sum,
          });
        } else {
          const result = await transaction(this.db, async (tx) => {
            await tx.query(
              "SELECT id FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
              [reservation.agent_id],
            );
            const actual = await verify(tx);
            const current = (
              await tx.query(
                "SELECT * FROM runtime_reservations WHERE id=$1 FOR UPDATE",
                [reservation.id],
              )
            ).rows[0];
            const charged =
              current.status === "released" ? 0 : Number(current.actual_micros);
            if (charged !== actual) {
              await this.alert(tx, reservation.agent_id, reservation.job_id, {
                reservationId: reservation.id,
                reason: "settled_cost_difference",
                chargedMicros: charged,
                observedCostMicros: actual,
                adjustmentApplied: false,
              });
              return {
                id: reservation.id,
                status: "discrepancy_no_additional_charge",
                actualMicros: actual,
              };
            }
            return {
              id: reservation.id,
              status: "already_settled",
              actualMicros: actual,
            };
          });
          report.reservations.push(result);
        }
      } catch (error) {
        // Only this module's finite public reason codes are returned; arbitrary database/provider errors stay opaque.
        const code =
          error instanceof Error && /^RECONCILE_[A-Z_]+$/.test(error.message)
            ? error.message
            : "RECONCILE_RETRY_REQUIRED";
        report.reservations.push({ id: reservation.id, status: code });
      }
    }
    return report;
  }
}
