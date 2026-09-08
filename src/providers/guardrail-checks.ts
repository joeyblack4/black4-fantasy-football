import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Principal } from "../auth.js";
import type { Db } from "../db.js";
import { RuntimeStore } from "../runtime/index.js";
import { usdToMicros } from "../money.js";
import {
  ManifestRegistry,
  keyFingerprint,
  type Manifest,
} from "./manifests.js";

const origin = "https://openrouter.ai/api/v1";
const source = "https://openrouter.ai/docs/api/reference/errors-and-debugging";
export const NegativeProbeSchema = z
  .object({
    kind: z.enum(["wrong_model", "wrong_provider"]),
    model: z.string().regex(/^[^\s/]+\/[^\s]+$/),
    providerSlug: z.string().min(1).max(150),
    reservationMicros: z.number().int().positive().safe(),
    tariff: z.object({
      inputUsdPerMillion: z.number().finite().nonnegative(),
      outputUsdPerMillion: z.number().finite().nonnegative(),
      verifiedAt: z.iso.datetime(),
    }),
  })
  .strict();
export type NegativeProbe = z.infer<typeof NegativeProbeSchema>;
type Secrets = {
  apiKey: string;
  managementKey: string;
  provisioningJournal: unknown[];
};
type Options = {
  synthetic: boolean;
  allowNetwork?: boolean;
  fetchImpl?: typeof fetch;
};
const amount = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  try {
    return usdToMicros(value);
  } catch {
    return undefined;
  }
};

/** No documented discriminator currently proves a model/provider allowlist rejection.
 * Even 403 can mean budget, moderation, or permissions. Never infer zero cost from it. */
export function classifyNegativeProbe(status: number | null, raw: unknown) {
  const value = raw as any;
  return {
    passed: false,
    result:
      status === null
        ? "transport_uncertain"
        : status >= 200 && status < 300 && !value?.error
          ? "unexpected_acceptance"
          : "restriction_reason_unresolved",
    httpStatus: status,
    errorType:
      typeof value?.error?.metadata?.error_type === "string" &&
      /^[a-z_]{1,100}$/.test(value.error.metadata.error_type)
        ? value.error.metadata.error_type
        : null,
    responseHash: keyFingerprint(JSON.stringify(raw ?? null)),
    documentation: source,
    restrictionProof:
      "No documented model/provider-specific rejection code verified; operator evidence required.",
  };
}

/** Trusted operator only. These checks never run the owner harness or execute football actions. */
export class GuardrailChecker {
  private registry: ManifestRegistry;
  private http: typeof fetch;
  constructor(
    private db: Db,
    private options: Options,
  ) {
    if (options.synthetic && !options.fetchImpl)
      throw Error("GUARDRAIL_SYNTHETIC_TRANSPORT_REQUIRED");
    if (!options.synthetic && (!options.allowNetwork || options.fetchImpl))
      throw Error("GUARDRAIL_REAL_TRANSPORT_REQUIRED");
    this.http = options.fetchImpl ?? fetch;
    this.registry = new ManifestRegistry(db);
  }
  private async bound(actor: Principal, id: string, secret: string) {
    const m = await this.registry.get(id),
      d = m.document;
    if (actor.role !== "commissioner" || actor.leagueId !== d.leagueId)
      throw Error("GUARDRAIL_OPERATOR_FORBIDDEN");
    if (
      m.status !== "staged" ||
      !secret ||
      keyFingerprint(secret) !== m.key_fingerprint
    )
      throw Error("GUARDRAIL_STAGED_KEY_REQUIRED");
    if (
      !(
        await this.db.query(
          `SELECT 1 FROM runtime_bindings b JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1 AND b.league_id=$2 AND a.kind='ai'`,
          [d.agentId, d.leagueId],
        )
      ).rowCount
    )
      throw Error("GUARDRAIL_BINDING_CHANGED");
    return m;
  }
  private async get(path: string, key: string) {
    const response = await this.http(origin + path, {
      headers: { authorization: "Bearer " + key },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("GUARDRAIL_READ_HTTP_" + response.status);
    return (await response.json()) as any;
  }
  private record(
    actor: Principal,
    m: Manifest,
    kind: "assignment" | "key_limit" | "wrong_model" | "wrong_provider",
    passed: boolean,
    evidence: Record<string, unknown>,
  ) {
    return this.registry.recordGuardrailCheck(actor, m.id, {
      kind,
      passed,
      synthetic: this.options.synthetic,
      evidence: {
        checker: "black4-guardrails-v1",
        observedAt: new Date().toISOString(),
        ...evidence,
      },
    });
  }
  async inspect(actor: Principal, id: string, secrets: Secrets) {
    const m = await this.bound(actor, id, secrets.apiKey),
      d = m.document;
    if (!secrets.managementKey)
      throw Error("GUARDRAIL_MANAGEMENT_KEY_REQUIRED");
    const journal = z
      .array(
        z.object({
          phase: z.string(),
          keyHash: z.string().optional(),
          keyFingerprint: z.string().optional(),
          guardrailId: z.string().optional(),
          assignmentVerified: z.boolean().optional(),
        }),
      )
      .parse(secrets.provisioningJournal);
    const saved = journal.find(
      (r) =>
        r.phase === "key_saved" &&
        r.keyHash === d.upstreamKeyHash &&
        r.keyFingerprint === m.key_fingerprint &&
        r.guardrailId === d.guardrailId,
    );
    const ready = journal.find(
      (r) =>
        r.phase === "restricted_key_ready_for_negative_tests" &&
        r.keyHash === d.upstreamKeyHash &&
        r.keyFingerprint === m.key_fingerprint &&
        r.guardrailId === d.guardrailId &&
        r.assignmentVerified === true,
    );
    const bindingVerified = !!saved && !!ready;
    const reports: Record<string, unknown> = {};
    try {
      const guard = await this.get(
        "/guardrails/" + encodeURIComponent(d.guardrailId),
        secrets.managementKey,
      );
      let assigned = false,
        complete = false;
      // Bounded pagination; never mistake a truncated assignment list for absence proof.
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await this.get(
          "/guardrails/" +
            encodeURIComponent(d.guardrailId) +
            "/assignments/keys?limit=100&offset=" +
            offset,
          secrets.managementKey,
        );
        if (
          !Array.isArray(page.data) ||
          !Number.isInteger(page.total_count) ||
          page.data.length > 100
        )
          throw Error("GUARDRAIL_ASSIGNMENT_SHAPE");
        assigned ||= page.data.some(
          (r: any) =>
            r.key_hash === d.upstreamKeyHash &&
            r.guardrail_id === d.guardrailId,
        );
        if (offset + page.data.length >= page.total_count) {
          complete = true;
          break;
        }
        if (page.data.length === 0) break;
      }
      const exact =
        guard.data?.id === d.guardrailId &&
        JSON.stringify(guard.data?.allowed_models) ===
          JSON.stringify([d.model]) &&
        JSON.stringify(guard.data?.allowed_providers) ===
          JSON.stringify([d.providerSlug]) &&
        !guard.data?.ignored_models?.includes(d.model) &&
        !guard.data?.ignored_providers?.includes(d.providerSlug);
      const passed = bindingVerified && assigned && complete && exact;
      const evidence = {
        passed,
        bindingVerified,
        assigned,
        complete,
        exact,
        guardrailId: d.guardrailId,
        keyHash: d.upstreamKeyHash,
        responseHash: keyFingerprint(JSON.stringify(guard)),
      };
      await this.record(actor, m, "assignment", passed, evidence);
      reports.assignment = evidence;
    } catch (e) {
      const evidence = {
        passed: false,
        result:
          e instanceof Error && /^GUARDRAIL_[A-Z_0-9]+$/.test(e.message)
            ? e.message
            : "GUARDRAIL_READ_UNRESOLVED",
      };
      await this.record(actor, m, "assignment", false, evidence);
      reports.assignment = evidence;
    }
    try {
      const current = (await this.get("/key", secrets.apiKey)).data;
      const managed = (
        await this.get(
          "/keys/" + encodeURIComponent(d.upstreamKeyHash),
          secrets.managementKey,
        )
      ).data;
      const wallet = (
        await this.db.query(
          "SELECT budget_micros FROM runtime_agents WHERE id=$1",
          [d.agentId],
        )
      ).rows[0];
      const limit = amount(current?.limit),
        remaining = amount(current?.limit_remaining);
      const passed =
        bindingVerified &&
        managed?.hash === d.upstreamKeyHash &&
        managed?.disabled === false &&
        current?.is_management_key === false &&
        limit !== undefined &&
        limit > 0 &&
        limit <= Number(wallet.budget_micros) &&
        remaining !== undefined &&
        remaining > 0 &&
        remaining <= limit &&
        managed?.limit === current?.limit &&
        current?.limit_reset === null &&
        managed?.limit_reset === null &&
        current?.include_byok_in_limit === true &&
        managed?.include_byok_in_limit === true;
      const evidence = {
        passed,
        bindingVerified,
        limitMicros: limit ?? null,
        remainingMicros: remaining ?? null,
        reset: current?.limit_reset ?? null,
        includesByok: current?.include_byok_in_limit === true,
        managedHashMatches: managed?.hash === d.upstreamKeyHash,
      };
      await this.record(actor, m, "key_limit", passed, evidence);
      reports.keyLimit = evidence;
    } catch (e) {
      const evidence = {
        passed: false,
        result:
          e instanceof Error && /^GUARDRAIL_[A-Z_0-9]+$/.test(e.message)
            ? e.message
            : "GUARDRAIL_READ_UNRESOLVED",
      };
      await this.record(actor, m, "key_limit", false, evidence);
      reports.keyLimit = evidence;
    }
    return reports;
  }
  async probe(actor: Principal, id: string, apiKey: string, input: unknown) {
    const spec = NegativeProbeSchema.parse(input),
      m = await this.bound(actor, id, apiKey),
      d = m.document;
    if (
      spec.kind === "wrong_model"
        ? spec.model === d.model || spec.providerSlug !== d.providerSlug
        : spec.model !== d.model || spec.providerSlug === d.providerSlug
    )
      throw Error("GUARDRAIL_PROBE_NOT_SINGLE_VARIABLE");
    const age = Date.now() - Date.parse(spec.tariff.verifiedAt);
    if (age < 0 || age > 86400000) throw Error("GUARDRAIL_PROBE_TARIFF_STALE");
    const body = {
      model: spec.model,
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 2,
      stream: false,
      provider: { only: [spec.providerSlug], allow_fallbacks: false },
    };
    const estimate = Math.ceil(
      ((Buffer.byteLength(JSON.stringify(body)) + 4096) *
        spec.tariff.inputUsdPerMillion +
        2 * spec.tariff.outputUsdPerMillion) *
        1.25,
    );
    if (spec.reservationMicros < estimate)
      throw Error("GUARDRAIL_PROBE_RESERVATION_TOO_SMALL");
    const client = await this.db.connect(),
      lock = "guardrail-probe:" + id + ":" + spec.kind;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,7050))", [
        lock,
      ]);
      const existing = (
        await this.db.query(
          `SELECT evidence FROM provider_guardrail_checks WHERE manifest_id=$1 AND check_kind=$2 AND evidence->>'checker'='black4-guardrails-v1' AND evidence ? 'probeId' ORDER BY created_at DESC LIMIT 1`,
          [id, spec.kind],
        )
      ).rows[0];
      if (existing)
        return { ...existing.evidence, replayed: true, mayRetry: false };
      const checks = (
        await this.db.query(
          `SELECT DISTINCT ON(check_kind) check_kind,passed,synthetic,created_at FROM provider_guardrail_checks WHERE manifest_id=$1 AND check_kind IN ('assignment','key_limit') ORDER BY check_kind,created_at DESC`,
          [id],
        )
      ).rows;
      if (
        checks.length !== 2 ||
        checks.some(
          (c) =>
            !c.passed ||
            c.synthetic !== this.options.synthetic ||
            Date.now() - new Date(c.created_at).getTime() > 300000,
        )
      )
        throw Error("GUARDRAIL_FRESH_ASSIGNMENT_AND_BUDGET_REQUIRED");
      const runtime = new RuntimeStore(this.db),
        jobId = await this.registry.createCanaryJob(id);
      const job = await runtime.claim(
        "guardrail-check-" + randomUUID(),
        300000,
        undefined,
        [d.agentId],
        jobId,
      );
      if (!job) throw Error("GUARDRAIL_FRANCHISE_BUSY");
      let reservationId: string;
      try {
        reservationId = await runtime.reserve(job, spec.reservationMicros);
      } catch {
        await runtime.fail(job, "GUARDRAIL_RESERVATION_FAILED", {
          retryable: false,
          chargeKnownZero: true,
        });
        throw Error("GUARDRAIL_RESERVATION_FAILED");
      }
      const callId = randomUUID(),
        probeId = randomUUID();
      const base = {
        probeId,
        jobId,
        reservationId,
        callId,
        requestedModel: spec.model,
        requestedProvider: spec.providerSlug,
        reservationMicros: spec.reservationMicros,
        mayRetry: false,
      };
      // Checkpoint precedes inference. A crash leaves budget held and replay refuses another POST.
      await this.record(actor, m, spec.kind, false, {
        ...base,
        result: "prepared_cost_uncertain",
      });
      await this.db.query(
        `INSERT INTO provider_calls(id,manifest_id,agent_id,job_id,fence,staff_role,purpose,requested_model,requested_provider,status) VALUES($1,$2,$3,$4,$5,'guardrail-probe','canary',$6,$7,'guardrail_probe_dispatched')`,
        [
          callId,
          id,
          d.agentId,
          job.id,
          job.fence,
          spec.model,
          spec.providerSlug,
        ],
      );
      let status: number | null = null,
        raw: any = null;
      try {
        await this.bound(actor, id, apiKey);
        await runtime.heartbeat(job, 300000);
        const response = await this.http(origin + "/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer " + apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        status = response.status;
        raw = await response.json();
      } catch {
        /* Dispatch or parse ambiguity retains the whole reservation. */
      }
      const result = classifyNegativeProbe(status, raw);
      const generationId =
        typeof raw?.id === "string" && raw.id.length <= 500
          ? raw.id
          : undefined;
      const observed = amount(raw?.usage?.cost);
      let metadata: any = null;
      if (generationId) {
        try {
          metadata = (
            await this.get(
              "/generation?id=" + encodeURIComponent(generationId),
              apiKey,
            )
          ).data;
        } catch {
          /* No blind retry. */
        }
      }
      const nativeUsageKnown = [
        metadata?.native_tokens_prompt,
        metadata?.native_tokens_completion,
      ].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      );
      const reconciled =
        metadata?.id === generationId &&
        typeof metadata?.model === "string" &&
        typeof metadata?.provider_name === "string" &&
        amount(metadata?.total_cost) !== undefined &&
        (metadata.total_cost !== 0 || nativeUsageKnown);
      const cost = reconciled ? amount(metadata.total_cost) : observed;
      // Negative probes can never supply the successful positive identity canary required for activation.
      await this.registry.observe(callId, {
        status: "guardrail_probe_" + result.result,
        generationId,
        costMicros: cost,
        model: typeof raw?.model === "string" ? raw.model : undefined,
        provider:
          typeof metadata?.provider_name === "string"
            ? metadata.provider_name
            : undefined,
      });
      if (cost !== undefined)
        await runtime.observeCost(job, reservationId, cost, generationId);
      if (reconciled && cost !== undefined) {
        if (cost > spec.reservationMicros)
          await runtime.settleOverrun(job, reservationId, cost);
        else
          await runtime.fail(job, "GUARDRAIL_NEGATIVE_PROBE_NOT_PROVEN", {
            retryable: false,
            chargeKnownZero: false,
            reservationId,
            observedCostMicros: cost,
          });
      } else
        await runtime.fail(job, "GUARDRAIL_PROBE_COST_UNCERTAIN", {
          retryable: false,
          chargeKnownZero: false,
          reservationId,
        });
      const evidence = {
        ...base,
        ...result,
        costMicros: cost ?? null,
        costReconciled: reconciled,
        generationId: generationId ?? null,
      };
      await this.record(actor, m, spec.kind, false, evidence);
      return evidence;
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1,7050))",
        [lock],
      );
      client.release();
    }
  }
}
