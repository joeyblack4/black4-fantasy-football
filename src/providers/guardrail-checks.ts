import { randomUUID, createHash } from "node:crypto";
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

import {
  saveGuardrailArtifact,
  readGuardrailArtifact,
  evidenceHash,
  protectedError,
  guardrailClock,
  guardrailTimestampFresh,
  empiricalRoutingRejection,
  negativeChargeProtection,
  singleServingBranch,
  SINGLE_PROVIDER_LIMITATION,
  MODEL_CONTROL_GAP_LIMITATION,
} from "./guardrail-evidence.js";
import { proveLocalRouting } from "./guardrail-local-proof.js";

const origin = "https://openrouter.ai/api/v1";
const source = "https://openrouter.ai/docs/api/reference/errors-and-debugging";
export const NegativeProbeSchema = z
  .object({
    kind: z.enum(["wrong_model", "wrong_provider"]),
    model: z.string().regex(/^[^\s/]+\/[^\s]+$/),
    providerSlug: z.string().min(1).max(150),
    reservationMicros: z.number().int().positive().safe(),
    controlRevision: z
      .object({
        priorCaptureId: z.uuid(),
        reason: z.enum([
          "operator-reviewed-control-confounded-by-account-training-policy",
          "operator-reviewed-ancestor-provider-selector-overlap",
        ]),
      })
      .strict()
      .optional(),
    endpointControl: z
      .object({
        model: z.string(),
        providerSlug: z.string(),
        observedAt: z.iso.datetime(),
        sourceUrl: z.url(),
        responseHash: z.string().regex(/^[a-f0-9]{64}$/),
        supportsMaxTokens: z.literal(true),
      })
      .strict()
      .optional(),
    tariff: z.object({
      inputUsdPerMillion: z.number().finite().nonnegative(),
      outputUsdPerMillion: z.number().finite().nonnegative(),
      verifiedAt: z.iso.datetime(),
    }),
  })
  .strict();
const DocumentedNegativeAdjudicationSchema = z
  .object({
    captureId: z.uuid(),
    kind: z.enum(["wrong_model", "wrong_provider"]),
    responseBytesHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedSignature: z
      .object({
        httpStatus: z.number().int().min(400).max(499),
        // An operator must supply an actual documented machine discriminator, not a status code or guessed phrase.
        discriminatorPath: z
          .array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/))
          .min(1)
          .max(4),
        discriminatorValue: z.string().min(6).max(200),
        reason: z.enum(["model_allowlist", "provider_allowlist"]),
        documentationUrl: z
          .url()
          .refine((v) => v.startsWith("https://openrouter.ai/docs/")),
        documentationQuote: z.string().min(20).max(2000),
      })
      .strict(),
  })
  .strict();
export const EmpiricalNegativeAdjudicationSchema = z
  .object({
    captureId: z.uuid(),
    kind: z.enum(["wrong_model", "wrong_provider"]),
    responseBytesHash: z.string().regex(/^[a-f0-9]{64}$/),
    empiricalRouting: z
      .object({
        basis: z.literal("authenticated_single_endpoint_guardrail_filter"),
        reason: z.enum([
          "model-ignored-by-guardrail",
          "provider-not-allowed-by-guardrail",
        ]),
        documentationUrl: z.literal(
          "https://openrouter.ai/docs/guides/features/guardrails/overview",
        ),
        documentationScope: z.literal(
          "General allowlist behavior only; exact routing diagnostics are empirical authenticated evidence, not documented error codes.",
        ),
      })
      .strict(),
  })
  .strict();
export const NegativeAdjudicationSchema = z.union([
  DocumentedNegativeAdjudicationSchema,
  EmpiricalNegativeAdjudicationSchema,
]);
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
  private async record(
    actor: Principal,
    m: Manifest,
    kind: "assignment" | "key_limit" | "wrong_model" | "wrong_provider",
    passed: boolean,
    evidence: Record<string, unknown>,
  ) {
    const linkage = {
      manifestId: m.id,
      keyFingerprint: m.key_fingerprint,
      keyHash: m.document.upstreamKeyHash,
      guardrailId: m.document.guardrailId,
    };
    const artifactId =
      kind === "assignment" || kind === "key_limit"
        ? await saveGuardrailArtifact(
            this.db,
            m.id,
            kind,
            this.options.synthetic,
            { ...evidence, ...linkage },
          )
        : undefined;
    return this.registry.recordGuardrailCheck(actor, m.id, {
      kind,
      passed,
      synthetic: this.options.synthetic,
      evidence: {
        checker: "black4-guardrails-v1",
        observedAt: await guardrailClock(this.db),
        ...evidence,
        ...linkage,
        ...(artifactId ? { artifactId } : {}),
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
          JSON.stringify([d.canonicalModel ?? d.model]) &&
        JSON.stringify(guard.data?.allowed_providers) ===
          JSON.stringify([d.providerSlug]) &&
        !guard.data?.ignored_models?.includes(d.canonicalModel ?? d.model) &&
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
  /** No HTTP transport, key access or billing mutation. Reviews a captured request exactly once. */
  async adjudicate(actor: Principal, id: string, input: unknown) {
    const review = NegativeAdjudicationSchema.parse(input),
      m = await this.registry.get(id);
    if (actor.role !== "commissioner" || actor.leagueId !== m.document.leagueId)
      throw Error("GUARDRAIL_OPERATOR_FORBIDDEN");
    if (m.status !== "staged") throw Error("GUARDRAIL_STAGED_KEY_REQUIRED");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM provider_manifests WHERE id=$1 FOR UPDATE",
        [id],
      );
      const current = (
        await client.query(
          "SELECT status FROM provider_manifests WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (current.status !== "staged")
        throw Error("GUARDRAIL_STAGED_KEY_REQUIRED");
      const artifact = await readGuardrailArtifact(
          client,
          review.captureId,
          id,
          "negative_response",
        ),
        b = artifact.body;
      if (
        artifact.synthetic !== this.options.synthetic ||
        b.keyFingerprint !== m.key_fingerprint ||
        b.keyHash !== m.document.upstreamKeyHash ||
        b.guardrailId !== m.document.guardrailId ||
        b.kind !== review.kind
      )
        throw Error("GUARDRAIL_EVIDENCE_BINDING_MISMATCH");
      if (
        !b.responseComplete ||
        !b.responseBytesHash ||
        b.responseBytesHash !== review.responseBytesHash ||
        b.hasGeneration ||
        b.hasChoices ||
        !b.error ||
        b.result === "unexpected_acceptance"
      )
        throw Error("GUARDRAIL_REJECTION_CAPTURE_REQUIRED");
      if (
        evidenceHash(b.requestBody) !== b.requestHash ||
        b.requestedModel !== b.requestBody.model ||
        b.requestedProvider !== b.requestBody.provider?.only?.[0] ||
        b.requestBody.provider?.only?.length !== 1 ||
        b.requestBody.provider?.allow_fallbacks !== false
      )
        throw Error("GUARDRAIL_REQUEST_TAMPERED");
      if (
        review.kind === "wrong_model"
          ? b.requestedModel === m.document.model ||
            b.requestedModel === m.document.canonicalModel ||
            b.requestedProvider !== m.document.providerSlug
          : b.requestedModel !== m.document.model ||
            b.requestedProvider === m.document.providerSlug
      )
        throw Error("GUARDRAIL_PROBE_NOT_SINGLE_VARIABLE");
      const empirical = "empiricalRouting" in review;
      if (empirical) {
        const reason =
          review.kind === "wrong_model"
            ? "model-ignored-by-guardrail"
            : "provider-not-allowed-by-guardrail";
        if (
          review.empiricalRouting.reason !== reason ||
          !empiricalRoutingRejection(b, review.kind)
        )
          throw Error("GUARDRAIL_EMPIRICAL_ROUTING_NOT_PROOF");
        const c = b.endpointControl;
        if (
          !artifact.synthetic &&
          (!c ||
            c.model !== b.requestedModel ||
            c.providerSlug !== b.requestedProvider ||
            c.supportsMaxTokens !== true ||
            c.sourceUrl !==
              origin + "/models/" + b.requestedModel + "/endpoints" ||
            !/^[a-f0-9]{64}$/.test(c.responseHash ?? "") ||
            !(await guardrailTimestampFresh(client, c.observedAt, 3600000)))
        )
          throw Error("GUARDRAIL_FRESH_ENDPOINT_CONTROL_REQUIRED");
      } else {
        const expected = review.expectedSignature,
          dimension = review.kind === "wrong_model" ? "model" : "provider";
        if (
          expected.reason !== dimension + "_allowlist" ||
          expected.httpStatus !== b.httpStatus ||
          [401, 402, 408, 429].includes(expected.httpStatus)
        )
          throw Error("GUARDRAIL_REJECTION_KIND_MISMATCH");
        const conflictingReason = [b.error?.message, b.error?.metadata?.reason]
          .filter((v) => typeof v === "string")
          .join(" ");
        if (
          /\b(authentication|unauthorized|quota|budget|insufficient credits|rate limit|unavailable|not found|timed out)\b/i.test(
            conflictingReason,
          )
        )
          throw Error("GUARDRAIL_CONFLICTING_REJECTION_NOT_PROOF");
        const discriminator = expected.discriminatorPath.reduce(
          (v: any, k) => v?.[k],
          b.error,
        );
        const specific = expected.discriminatorValue.toLowerCase();
        if (
          expected.discriminatorPath.at(-1) === "message" ||
          discriminator !== expected.discriminatorValue ||
          !specific.includes(dimension) ||
          !/allowlist|allow_list|not_allowed|restriction|guardrail/.test(
            specific,
          ) ||
          /auth|quota|budget|unavailable|rate_limit|not_found|timeout/.test(
            specific,
          )
        )
          throw Error("GUARDRAIL_GENERIC_REJECTION_NOT_PROOF");
        const quote = expected.documentationQuote.toLowerCase();
        if (
          !quote.includes(expected.discriminatorValue.toLowerCase()) ||
          !quote.includes(dimension) ||
          !/allowlist|allowed|restrict|guardrail/.test(quote)
        )
          throw Error("GUARDRAIL_DOCUMENTED_SIGNATURE_REQUIRED");
      }
      if (
        !Array.isArray(b.inspectionArtifactIds) ||
        b.inspectionArtifactIds.length !== 2
      )
        throw Error("GUARDRAIL_INSPECTION_LINK_REQUIRED");
      for (const kind of ["assignment", "key_limit"]) {
        const rows = await client.query(
          "SELECT id FROM provider_guardrail_artifacts WHERE id=ANY($1::uuid[]) AND kind=$2",
          [b.inspectionArtifactIds, kind],
        );
        if (rows.rowCount !== 1)
          throw Error("GUARDRAIL_INSPECTION_LINK_REQUIRED");
        const inspection = await readGuardrailArtifact(
          client,
          rows.rows[0].id,
          id,
          kind,
        );
        if (
          inspection.synthetic !== artifact.synthetic ||
          !inspection.body.passed ||
          inspection.body.keyFingerprint !== m.key_fingerprint
        )
          throw Error("GUARDRAIL_INSPECTION_LINK_REQUIRED");
      }
      const call = (
        await client.query(
          "SELECT * FROM provider_calls WHERE id=$1 AND manifest_id=$2 AND job_id=$3",
          [b.callId, id, b.jobId],
        )
      ).rows[0];
      if (
        !call ||
        call.staff_role !== "guardrail-probe" ||
        call.requested_model !== b.requestedModel ||
        call.requested_provider !== b.requestedProvider ||
        call.generation_id ||
        !call.status.startsWith("guardrail_probe_") ||
        Number(call.cost_micros ?? 0) > 0 ||
        Number(b.costMicros ?? 0) > 0
      )
        throw Error("GUARDRAIL_PROBE_CALL_LINK_REQUIRED");
      const protection = await negativeChargeProtection(
        client,
        b,
        m.document.agentId,
        empirical,
      );
      if (!protection)
        throw Error(
          empirical
            ? "GUARDRAIL_CHARGE_NOT_PROTECTED"
            : "GUARDRAIL_ZERO_COST_RECONCILIATION_REQUIRED",
        );
      const old = (
        await client.query(
          "SELECT * FROM provider_guardrail_artifacts WHERE manifest_id=$1 AND kind='adjudication' AND body->>'captureId'=$2",
          [id, review.captureId],
        )
      ).rows[0];
      const reviewHash = evidenceHash(review);
      if (old) {
        if (old.body.reviewHash !== reviewHash)
          throw Error("GUARDRAIL_ADJUDICATION_CONFLICT");
        await client.query("COMMIT");
        return { artifactId: old.id, passed: true, replayed: true };
      }
      const adjudication = {
        ...review,
        reviewHash,
        operatorId: actor.id,
        keyFingerprint: m.key_fingerprint,
        probeId: b.probeId,
        callId: b.callId,
        reservationId: b.reservationId,
        inspectionArtifactIds: b.inspectionArtifactIds,
        restrictionVerified: true,
        ...protection,
        evidenceBasis: empirical
          ? "empirical_authenticated_routing"
          : "documented_signature",
      };
      const artifactId = await saveGuardrailArtifact(
        client,
        id,
        "adjudication",
        artifact.synthetic,
        adjudication,
      );
      await client.query(
        "INSERT INTO provider_guardrail_checks(id,manifest_id,check_kind,passed,evidence,synthetic) VALUES($1,$2,$3,true,$4,$5)",
        [
          randomUUID(),
          id,
          review.kind,
          {
            checker: "black4-guardrail-adjudication-v1",
            artifactId,
            probeId: b.probeId,
            captureId: review.captureId,
          },
          artifact.synthetic,
        ],
      );
      await client.query("COMMIT");
      return { artifactId, passed: true, replayed: false };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async probe(actor: Principal, id: string, apiKey: string, input: unknown) {
    const spec = NegativeProbeSchema.parse(input),
      m = await this.bound(actor, id, apiKey),
      d = m.document;
    if (
      spec.kind === "wrong_model"
        ? spec.model === d.model ||
          spec.model === d.canonicalModel ||
          spec.providerSlug !== d.providerSlug
        : spec.model !== d.model || spec.providerSlug === d.providerSlug
    )
      throw Error("GUARDRAIL_PROBE_NOT_SINGLE_VARIABLE");
    if (spec.controlRevision) {
      const prior = await readGuardrailArtifact(
        this.db,
        spec.controlRevision.priorCaptureId,
        id,
        "negative_response",
      );
      const b = prior.body,
        reasons = b.error?.metadata?.ineligibility_reasons;
      const ancestor =
        spec.controlRevision.reason ===
        "operator-reviewed-ancestor-provider-selector-overlap";
      const validCondition = ancestor
        ? spec.kind === "wrong_provider" &&
          b.result === "unexpected_acceptance" &&
          b.hasGeneration === true &&
          b.requestedModel === d.model &&
          d.providerSlug.startsWith(b.requestedProvider + "/") &&
          !d.providerSlug.startsWith(spec.providerSlug + "/") &&
          !spec.providerSlug.startsWith(d.providerSlug + "/")
        : !b.hasGeneration &&
          !b.hasChoices &&
          Array.isArray(reasons) &&
          reasons.some(
            (r: any) => r.reason === "paid-model-training-violation-by-account",
          ) &&
          reasons.some(
            (r: any) =>
              r.reason ===
              (spec.kind === "wrong_model"
                ? "model-ignored-by-guardrail"
                : "provider-not-allowed-by-guardrail"),
          );
      if (
        prior.synthetic !== this.options.synthetic ||
        b.kind !== spec.kind ||
        b.keyFingerprint !== m.key_fingerprint ||
        !b.responseComplete ||
        !validCondition ||
        (b.requestedModel === spec.model &&
          b.requestedProvider === spec.providerSlug) ||
        b.controlRevision
      )
        throw Error("GUARDRAIL_REVIEWED_CONTROL_REVISION_INVALID");
      const protection = await negativeChargeProtection(
        this.db,
        b,
        d.agentId,
        true,
        ancestor,
      );
      if (!protection) throw Error("GUARDRAIL_CHARGE_NOT_PROTECTED");
    }
    if (!this.options.synthetic || spec.endpointControl) {
      const c = spec.endpointControl,
        expectedUrl = origin + "/models/" + spec.model + "/endpoints";
      if (
        !c ||
        c.model !== spec.model ||
        c.providerSlug !== spec.providerSlug ||
        c.sourceUrl !== expectedUrl ||
        !(await guardrailTimestampFresh(this.db, c.observedAt, 3600000))
      )
        throw Error("GUARDRAIL_FRESH_ENDPOINT_CONTROL_REQUIRED");
    }
    if (
      !(await guardrailTimestampFresh(
        this.db,
        spec.tariff.verifiedAt,
        86400000,
      ))
    )
      throw Error("GUARDRAIL_PROBE_TARIFF_STALE");
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
          `SELECT evidence FROM provider_guardrail_checks WHERE manifest_id=$1 AND check_kind=$2 AND evidence->>'checker'='black4-guardrails-v1' AND evidence ? 'probeId' AND COALESCE(evidence->'controlRevision'->>'priorCaptureId','')=$3 ORDER BY created_at DESC LIMIT 1`,
          [id, spec.kind, spec.controlRevision?.priorCaptureId ?? ""],
        )
      ).rows[0];
      if (existing)
        return { ...existing.evidence, replayed: true, mayRetry: false };
      const checks = (
        await this.db.query(
          `SELECT DISTINCT ON(check_kind) id,check_kind,passed,synthetic,created_at,evidence,clock_timestamp() BETWEEN created_at AND created_at + interval '5 minutes' AS evidence_fresh FROM provider_guardrail_checks WHERE manifest_id=$1 AND check_kind IN ('assignment','key_limit') ORDER BY check_kind,created_at DESC`,
          [id],
        )
      ).rows;
      if (
        checks.length !== 2 ||
        checks.some(
          (c) =>
            !c.passed ||
            c.synthetic !== this.options.synthetic ||
            c.evidence_fresh !== true,
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
        ...(spec.controlRevision
          ? { controlRevision: spec.controlRevision }
          : {}),
        probeId,
        jobId,
        reservationId,
        callId,
        requestedModel: spec.model,
        requestedProvider: spec.providerSlug,
        reservationMicros: spec.reservationMicros,
        endpointControl: spec.endpointControl ?? null,
        requestBody: body,
        requestHash: evidenceHash(body),
        inspectionCheckIds: checks.map((c) => c.id),
        inspectionArtifactIds: checks.map((c) => c.evidence.artifactId),
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
        raw: any = null,
        responseComplete = false,
        responseBytesHash: string | null = null,
        responseRequestId: string | null = null;
      const dispatchedAt = await guardrailClock(this.db);
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
        const requestId = response.headers.get("x-request-id");
        if (requestId && /^[A-Za-z0-9:_-]{1,200}$/.test(requestId))
          responseRequestId = requestId;
        const reader = response.body?.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          while (true) {
            const part = await reader.read();
            if (part.done) {
              responseComplete = true;
              break;
            }
            size += part.value.length;
            if (size > 32768) {
              await reader.cancel();
              break;
            }
            chunks.push(part.value);
          }
          if (responseComplete) {
            const bytes = Buffer.concat(chunks);
            responseBytesHash = createHash("sha256")
              .update(bytes)
              .digest("hex");
            raw = JSON.parse(bytes.toString("utf8"));
          }
        }
      } catch {
        /* Dispatch or parse ambiguity retains the whole reservation. */
      }
      const result = classifyNegativeProbe(status, raw);
      const responseArtifactId = await saveGuardrailArtifact(
        this.db,
        id,
        "negative_response",
        this.options.synthetic,
        {
          ...base,
          ...result,
          manifestId: m.id,
          keyFingerprint: m.key_fingerprint,
          keyHash: d.upstreamKeyHash,
          guardrailId: d.guardrailId,
          kind: spec.kind,
          dispatchedAt,
          observedAt: await guardrailClock(this.db),
          responseComplete,
          responseBytesHash,
          responseRequestId,
          error: protectedError(raw, [apiKey]),
          hasGeneration: typeof raw?.id === "string",
          hasChoices: Array.isArray(raw?.choices) && raw.choices.length > 0,
          costMicros: null,
          costReconciled: false,
        },
      );
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
      const capture = {
        ...base,
        ...result,
        manifestId: m.id,
        keyFingerprint: m.key_fingerprint,
        keyHash: d.upstreamKeyHash,
        guardrailId: d.guardrailId,
        responseArtifactId,
        kind: spec.kind,
        dispatchedAt,
        observedAt: await guardrailClock(this.db),
        responseComplete,
        responseBytesHash,
        responseRequestId,
        error: protectedError(raw, [apiKey]),
        hasGeneration: !!generationId,
        hasChoices: Array.isArray(raw?.choices) && raw.choices.length > 0,
        costMicros: cost ?? null,
        costReconciled: reconciled,
      };
      const captureId = await saveGuardrailArtifact(
        this.db,
        id,
        "negative_response",
        this.options.synthetic,
        capture,
      );
      const evidence = {
        ...base,
        ...result,
        captureId,
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

  /** Alternative assurance, explicitly NOT a passed live wrong-provider probe. Only eligible
   * when current catalog exposes the exact tag and ancestor aliases, with no independent tier. */
  async certifySingleServingFamily(
    actor: Principal,
    id: string,
    secrets: Secrets,
  ) {
    const m = await this.bound(actor, id, secrets.apiKey),
      d = m.document;
    if (actor.role !== "commissioner" || actor.leagueId !== d.leagueId)
      throw Error("GUARDRAIL_OPERATOR_FORBIDDEN");
    await this.inspect(actor, id, secrets);
    const sourceUrl = origin + "/models/" + d.model + "/endpoints";
    const response = await this.http(sourceUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("GUARDRAIL_CATALOG_UNAVAILABLE");
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
      throw Error("GUARDRAIL_CATALOG_TOO_LARGE");
    const data = JSON.parse(raw)?.data;
    if (
      data?.id !== d.model ||
      !Array.isArray(data.endpoints) ||
      !data.endpoints.length ||
      data.endpoints.length > 100 ||
      data.endpoints.some(
        (e: any) => typeof e.status !== "number" || typeof e.tag !== "string",
      )
    )
      throw Error("GUARDRAIL_CATALOG_INVALID");
    const active = data.endpoints.filter((e: any) => e.status === 0),
      activeTags = active.map((e: any) => e.tag);
    if (
      !singleServingBranch(d.providerSlug, activeTags) ||
      !active.some(
        (e: any) =>
          e.tag === d.providerSlug &&
          e.supported_parameters?.includes("max_tokens"),
      )
    )
      throw Error("GUARDRAIL_INDEPENDENT_PROVIDER_CONTROL_EXISTS");
    const localProof = await proveLocalRouting(d);
    const inspections = (
      await this.db.query(
        `SELECT DISTINCT ON(check_kind) evidence->>'artifactId' id FROM provider_guardrail_checks WHERE manifest_id=$1 AND check_kind IN ('assignment','key_limit') AND passed ORDER BY check_kind,created_at DESC`,
        [id],
      )
    ).rows.map((r) => r.id);
    if (inspections.length !== 2)
      throw Error("GUARDRAIL_INSPECTION_LINK_REQUIRED");
    const body = {
      manifestId: id,
      kind: "wrong_provider",
      keyFingerprint: m.key_fingerprint,
      keyHash: d.upstreamKeyHash,
      guardrailId: d.guardrailId,
      model: d.model,
      providerSlug: d.providerSlug,
      evidenceBasis: "single_serving_branch_policy_and_local_pin",
      independentLiveProbePassed: false,
      limitation: SINGLE_PROVIDER_LIMITATION,
      operatorId: actor.id,
      inspectionArtifactIds: inspections,
      localProof,
      catalog: {
        sourceUrl,
        responseHash: createHash("sha256").update(raw).digest("hex"),
        observedAt: await guardrailClock(this.db),
        activeTags,
      },
    };
    const artifactId = await saveGuardrailArtifact(
      this.db,
      id,
      "adjudication",
      this.options.synthetic,
      body,
    );
    await this.registry.recordGuardrailCheck(actor, id, {
      kind: "wrong_provider",
      passed: true,
      synthetic: this.options.synthetic,
      evidence: {
        checker: "black4-single-serving-branch-assurance-v1",
        artifactId,
        liveProbePassed: false,
        limitation: SINGLE_PROVIDER_LIMITATION,
      },
    });
    return {
      artifactId,
      gateSatisfied: true,
      liveProbePassed: false,
      limitation: SINGLE_PROVIDER_LIMITATION,
      model: d.model,
      providerSlug: d.providerSlug,
      activeTags,
    };
  }
  /** Exact operator-approved Kimi exception. It does not record a passed upstream model probe. */
  async certifyKimiModelControlGap(
    actor: Principal,
    id: string,
    secrets: Secrets,
    acceptedLimitation: string,
  ) {
    const m = await this.bound(actor, id, secrets.apiKey),
      d = m.document;
    if (
      actor.role !== "commissioner" ||
      actor.leagueId !== d.leagueId ||
      acceptedLimitation !== MODEL_CONTROL_GAP_LIMITATION
    )
      throw Error("GUARDRAIL_OPERATOR_ACCEPTANCE_REQUIRED");
    if (
      d.model !== "moonshotai/kimi-k3" ||
      d.providerSlug !== "moonshotai/mxfp4"
    )
      throw Error("GUARDRAIL_KIMI_EXCEPTION_SCOPE");
    await this.inspect(actor, id, secrets);
    const getPublic = async (url: string) => {
      const r = await this.http(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error("GUARDRAIL_CATALOG_UNAVAILABLE");
      const raw = await r.text();
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
        throw Error("GUARDRAIL_CATALOG_TOO_LARGE");
      return {
        data: JSON.parse(raw).data,
        sourceUrl: url,
        responseHash: createHash("sha256").update(raw).digest("hex"),
        observedAt: await guardrailClock(this.db),
      };
    };
    const catalog = await getPublic(origin + "/models");
    if (!Array.isArray(catalog.data)) throw Error("GUARDRAIL_CATALOG_INVALID");
    const family = catalog.data.filter(
      (x: any) =>
        typeof x.id === "string" &&
        x.id.startsWith("moonshotai/") &&
        x.id !== d.model &&
        x.canonical_slug !== d.canonicalModel,
    );
    if (family.length < 1 || family.length > 30)
      throw Error("GUARDRAIL_CATALOG_SEARCH_BOUND");
    const searches = [];
    for (const model of family) {
      const record = await getPublic(
        origin + "/models/" + model.id + "/endpoints",
      );
      if (record.data?.id !== model.id || !Array.isArray(record.data.endpoints))
        throw Error("GUARDRAIL_CATALOG_INVALID");
      const matches = record.data.endpoints.filter(
        (e: any) =>
          e.tag === d.providerSlug &&
          e.status === 0 &&
          e.supported_parameters?.includes("max_tokens"),
      );
      if (matches.length)
        throw Error("GUARDRAIL_ALTERNATE_MODEL_CONTROL_EXISTS");
      searches.push({
        model: model.id,
        canonicalModel: model.canonical_slug,
        sourceUrl: record.sourceUrl,
        responseHash: record.responseHash,
        observedAt: record.observedAt,
        matchingCallableEndpoints: 0,
      });
    }
    const positive = (
      await this.db.query(
        `SELECT c.id,c.job_id FROM provider_calls c JOIN runtime_jobs j ON j.id=c.job_id WHERE c.manifest_id=$1 AND c.purpose='canary' AND c.staff_role IS DISTINCT FROM 'guardrail-probe' AND c.status='verified' AND c.reconciliation_status='verified' AND c.cost_micros IS NOT NULL AND c.generation_id IS NOT NULL AND c.reported_model=ANY($2::text[]) AND c.reported_provider=ANY($3::text[]) AND j.status='completed' AND j.execution_mode='provider_canary' AND c.completed_at>clock_timestamp()-interval '1 hour' AND EXISTS(SELECT 1 FROM runtime_receipts r WHERE r.agent_id=c.agent_id AND r.type='provider_diagnostic' AND r.details->>'kind'='canary_read_tool' AND r.details->>'tool'='research_sources' AND r.details->>'executed'='true' AND r.created_at BETWEEN (SELECT min(started_at) FROM provider_calls WHERE job_id=c.job_id) AND c.completed_at) ORDER BY c.completed_at DESC LIMIT 1`,
        [
          id,
          [d.model, d.canonicalModel].filter(Boolean),
          d.reportedProviderNames,
        ],
      )
    ).rows[0];
    if (!positive) throw Error("GUARDRAIL_POSITIVE_MODEL_TOOL_CANARY_REQUIRED");
    const localProof = await proveLocalRouting(d);
    const inspections = (
      await this.db.query(
        `SELECT DISTINCT ON(check_kind) evidence->>'artifactId' id FROM provider_guardrail_checks WHERE manifest_id=$1 AND check_kind IN ('assignment','key_limit') AND passed ORDER BY check_kind,created_at DESC`,
        [id],
      )
    ).rows.map((r) => r.id);
    const body = {
      manifestId: id,
      kind: "wrong_model",
      keyFingerprint: m.key_fingerprint,
      keyHash: d.upstreamKeyHash,
      guardrailId: d.guardrailId,
      model: d.model,
      providerSlug: d.providerSlug,
      evidenceBasis: "operator_accepted_kimi_model_control_gap",
      independentLiveProbePassed: false,
      limitation: MODEL_CONTROL_GAP_LIMITATION,
      operatorId: actor.id,
      inspectionArtifactIds: inspections,
      localProof,
      positiveCallId: positive.id,
      positiveJobId: positive.job_id,
      catalog: {
        sourceUrl: catalog.sourceUrl,
        responseHash: catalog.responseHash,
        observedAt: catalog.observedAt,
        scope:
          "all currently listed moonshotai models with a distinct canonical identity",
        searches,
      },
    };
    const artifactId = await saveGuardrailArtifact(
      this.db,
      id,
      "adjudication",
      this.options.synthetic,
      body,
    );
    await this.registry.recordGuardrailCheck(actor, id, {
      kind: "wrong_model",
      passed: true,
      synthetic: this.options.synthetic,
      evidence: {
        checker: "black4-operator-accepted-model-control-gap-v1",
        artifactId,
        liveModelRejectionTested: false,
        limitation: MODEL_CONTROL_GAP_LIMITATION,
      },
    });
    return {
      artifactId,
      gateSatisfied: true,
      liveModelRejectionTested: false,
      limitation: MODEL_CONTROL_GAP_LIMITATION,
      modelsChecked: searches.length,
      positiveCallId: positive.id,
    };
  }
}
