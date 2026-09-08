import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "../db.js";
import type { Principal } from "../auth.js";
import type { Job } from "../runtime/index.js";
import {
  readGuardrailArtifact,
  evidenceHash,
  GUARDRAIL_MAX_AGE_MS,
  empiricalRoutingRejection,
  negativeChargeProtection,
  singleServingBranch,
  SINGLE_PROVIDER_LIMITATION,
  MODEL_CONTROL_GAP_LIMITATION,
  guardrailTimestampFresh,
} from "./guardrail-evidence.js";
import { routingDriverHash } from "./guardrail-local-proof.js";
import { KnownZeroCostError } from "../runtime/worker.js";

export const ManifestSchema = z
  .object({
    leagueId: z.string().min(1),
    agentId: z.string().min(1),
    developer: z.enum([
      "OpenAI",
      "Anthropic",
      "Google",
      "xAI",
      "Meta",
      "DeepSeek",
      "Qwen",
      "Mistral",
      "Moonshot/Kimi",
      "Z.ai",
    ]),
    model: z
      .string()
      .regex(/^[^\s/]+\/[^\s]+$/)
      .refine((v) => !v.includes(":free") && !v.includes("auto")),
    canonicalModel: z
      .string()
      .regex(/^[^\s/]+\/[^\s]+$/)
      .refine((v) => !v.includes(":free") && !v.includes("auto"))
      .optional(),
    providerSlug: z.string().min(1).max(150),
    reportedProviderNames: z.array(z.string().min(1)).min(1).max(10),
    quantization: z.string().nullable(),
    modelVersion: z.string().nullable(),
    openWeight: z.boolean().nullable(),
    license: z.string().nullable(),
    keyRef: z.string().regex(/^B4_LEAGUE_[A-Z0-9_]+$/),
    upstreamKeyHash: z.string().min(1),
    guardrailId: z.string().min(1),
    harnessId: z.literal("black4-owner-loop"),
    buzzBridgeVersion: z.string().min(1),
    harnessVersion: z.string().min(1),
    toolPermissions: z.array(z.string()).max(30),
    walletId: z.string().min(1),
  })
  .strict();
export type ManifestDocument = z.infer<typeof ManifestSchema>;
export type Manifest = {
  id: string;
  version: number;
  status: string;
  document: ManifestDocument;
  key_fingerprint: string;
};
export const keyFingerprint = (key: string) =>
  createHash("sha256").update(key).digest("hex");
function authorize(actor: Principal, leagueId: string) {
  if (actor.role !== "commissioner" || actor.leagueId !== leagueId)
    throw new Error("MANIFEST_OPERATOR_FORBIDDEN");
}

/** Trusted runtime only. Neither secrets nor this administrative interface are owner tools. */
export class ManifestRegistry {
  constructor(private db: Db) {}
  async stage(
    actor: Principal,
    input: unknown,
    secret: string,
  ): Promise<Manifest> {
    const doc = ManifestSchema.parse(input);
    authorize(actor, doc.leagueId);
    if (!secret || doc.walletId !== doc.agentId)
      throw new Error("MANIFEST_KEY_OR_WALLET_INVALID");
    return transaction(this.db, async (tx) => {
      const bound = (
        await tx.query(
          `SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id
        WHERE a.id=$1 AND b.league_id=$2 AND a.kind='ai' FOR NO KEY UPDATE OF a`,
          [doc.agentId, doc.leagueId],
        )
      ).rows[0];
      if (!bound) throw new Error("MANIFEST_BINDING_INVALID");
      const version = Number(
        (
          await tx.query(
            "SELECT COALESCE(MAX(version),0)+1 AS v FROM provider_manifests WHERE agent_id=$1",
            [doc.agentId],
          )
        ).rows[0].v,
      );
      return (
        await tx.query(
          `INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            randomUUID(),
            doc.leagueId,
            doc.agentId,
            version,
            doc,
            keyFingerprint(secret),
          ],
        )
      ).rows[0];
    });
  }
  async get(id: string): Promise<Manifest> {
    const m = (
      await this.db.query("SELECT * FROM provider_manifests WHERE id=$1", [id])
    ).rows[0];
    if (!m) throw new Error("MANIFEST_NOT_FOUND");
    return m;
  }
  async preflight(id: string, job: Job, secret: string, canary = false) {
    const m = await this.get(id);
    if (
      m.document.agentId !== job.agentId ||
      m.document.model !== job.model ||
      m.key_fingerprint !== keyFingerprint(secret) ||
      m.status !== (canary ? "staged" : "active")
    )
      throw new KnownZeroCostError("MANIFEST_BINDING_OR_KEY_MISMATCH");
    if (
      !(
        await this.db.query(
          "SELECT 1 FROM runtime_jobs WHERE id=$1 AND agent_id=$2 AND fence=$3 AND worker_id=$4 AND status='running' AND lease_until>clock_timestamp()",
          [job.id, job.agentId, job.fence, job.workerId],
        )
      ).rowCount
    )
      throw new KnownZeroCostError("MANIFEST_STALE_JOB");
    const binding = await this.db.query(
      `SELECT 1 FROM runtime_bindings b JOIN runtime_agents a ON a.id=b.agent_id
      WHERE b.agent_id=$1 AND b.league_id=$2 AND ($4::boolean OR a.model=$3) AND a.kind='ai'`,
      [job.agentId, m.document.leagueId, job.model, canary],
    );
    if (!binding.rowCount)
      throw new KnownZeroCostError("MANIFEST_RUNTIME_BINDING_CHANGED");
    if (
      canary &&
      !(
        await this.db.query(
          "SELECT 1 FROM runtime_jobs WHERE id=$1 AND agent_id=$2 AND execution_mode='provider_canary' AND payload->>'manifestId'=$3 AND status='running' AND fence=$4 AND worker_id=$5",
          [job.id, job.agentId, id, job.fence, job.workerId],
        )
      ).rowCount
    )
      throw new KnownZeroCostError("MANIFEST_CANARY_JOB_REQUIRED");
    return m;
  }
  async createCanaryJob(id: string) {
    const m = await this.get(id);
    if (m.status !== "staged") throw Error("MANIFEST_NOT_STAGED");
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT id FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
        [m.document.agentId],
      );
      const jobId = randomUUID(),
        payload = { manifestId: id, purpose: "provider_identity_canary" };
      await tx.query(
        `INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,execution_mode,max_attempts)
        VALUES($1,$2,$3,$4,'event',$5,clock_timestamp(),'provider_canary',1)`,
        [
          jobId,
          m.document.agentId,
          "provider-canary:" + jobId,
          keyFingerprint(JSON.stringify(payload)),
          payload,
        ],
      );
      return jobId;
    });
  }
  async recordGuardrailCheck(
    actor: Principal,
    id: string,
    input: {
      kind: "assignment" | "wrong_model" | "wrong_provider" | "key_limit";
      passed: boolean;
      evidence: Record<string, unknown>;
      synthetic: boolean;
    },
  ) {
    const m = await this.get(id);
    authorize(actor, m.document.leagueId);
    if (m.status !== "staged")
      throw new Error("MANIFEST_IMMUTABLE_AFTER_ACTIVATION");
    await this.db.query(
      "INSERT INTO provider_guardrail_checks(id,manifest_id,check_kind,passed,evidence,synthetic) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        id,
        input.kind,
        input.passed,
        input.evidence,
        input.synthetic,
      ],
    );
  }
  async activate(actor: Principal, id: string) {
    const initial = await this.get(id);
    authorize(actor, initial.document.leagueId);
    await transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [initial.document.leagueId],
      );
      await tx.query("SELECT id FROM leagues WHERE id=$1 FOR UPDATE", [
        initial.document.leagueId,
      ]);
      await tx.query(
        "SELECT id FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
        [initial.document.agentId],
      );
      const m = (
        await tx.query(
          "SELECT * FROM provider_manifests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0] as Manifest;
      if (m.status !== "staged") throw new Error("MANIFEST_NOT_STAGED");
      if (
        (
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [m.document.agentId],
          )
        ).rowCount
      )
        throw new Error("MANIFEST_TURN_ACTIVE");
      // Both upgrades and initial activation must finish before the live draft opens.
      const league = (
        await tx.query("SELECT status FROM leagues WHERE id=$1", [
          m.document.leagueId,
        ])
      ).rows[0];
      if (league?.status === "drafting" || league?.status === "paused")
        throw new Error("MANIFEST_DRAFT_BLACKOUT");
      if (
        (
          await tx.query(
            `SELECT 1 FROM league_player_games WHERE league_id=$1 AND status='scheduled'
        AND kickoff_at BETWEEN clock_timestamp() AND clock_timestamp()+interval '30 minutes' LIMIT 1`,
            [m.document.leagueId],
          )
        ).rowCount
      )
        throw new Error("MANIFEST_LINEUP_LOCK_BLACKOUT");
      const checks = (
        await tx.query(
          `SELECT DISTINCT ON(check_kind) check_kind,passed,synthetic,evidence,created_at,
        clock_timestamp() BETWEEN created_at AND created_at + $2::bigint * interval '1 millisecond' AS evidence_fresh FROM provider_guardrail_checks
        WHERE manifest_id=$1 ORDER BY check_kind,created_at DESC`,
          [id, GUARDRAIL_MAX_AGE_MS],
        )
      ).rows;
      if (checks.length !== 4 || checks.some((c) => !c.passed || c.synthetic))
        throw new Error("MANIFEST_GUARDRAIL_CANARIES_REQUIRED");
      for (const check of checks) {
        if (check.evidence_fresh !== true)
          throw Error("MANIFEST_GUARDRAIL_EVIDENCE_STALE");
        const negative =
          check.check_kind === "wrong_model" ||
          check.check_kind === "wrong_provider";
        const artifact = await readGuardrailArtifact(
          tx,
          check.evidence.artifactId ?? "",
          id,
          negative ? "adjudication" : check.check_kind,
        );
        if (
          artifact.synthetic ||
          artifact.body.keyFingerprint !== m.key_fingerprint
        )
          throw Error("MANIFEST_GUARDRAIL_EVIDENCE_INVALID");
        if (!negative) {
          const e = artifact.body;
          if (
            !e.passed ||
            !e.bindingVerified ||
            e.manifestId !== id ||
            e.keyHash !== m.document.upstreamKeyHash ||
            e.guardrailId !== m.document.guardrailId ||
            (check.check_kind === "assignment" &&
              (!e.assigned || !e.complete || !e.exact))
          )
            throw Error("MANIFEST_GUARDRAIL_EVIDENCE_INVALID");
        } else {
          const e = artifact.body;
          if (e.evidenceBasis === "operator_accepted_kimi_model_control_gap") {
            if (
              check.check_kind !== "wrong_model" ||
              e.kind !== "wrong_model" ||
              e.manifestId !== id ||
              e.keyHash !== m.document.upstreamKeyHash ||
              e.guardrailId !== m.document.guardrailId ||
              m.document.model !== "moonshotai/kimi-k3" ||
              m.document.providerSlug !== "moonshotai/mxfp4" ||
              e.model !== m.document.model ||
              e.providerSlug !== m.document.providerSlug ||
              e.independentLiveProbePassed !== false ||
              e.limitation !== MODEL_CONTROL_GAP_LIMITATION ||
              e.catalog?.sourceUrl !== "https://openrouter.ai/api/v1/models" ||
              !Array.isArray(e.catalog?.searches) ||
              e.catalog.searches.length < 1 ||
              e.catalog.searches.length > 30 ||
              !e.catalog.searches.every(
                (r: any) =>
                  r.model?.startsWith("moonshotai/") &&
                  r.matchingCallableEndpoints === 0 &&
                  r.sourceUrl ===
                    "https://openrouter.ai/api/v1/models/" +
                      r.model +
                      "/endpoints" &&
                  /^[a-f0-9]{64}$/.test(r.responseHash ?? ""),
              ) ||
              !(await guardrailTimestampFresh(
                tx,
                e.catalog.observedAt,
                3600000,
              )) ||
              e.localProof?.driverHash !== (await routingDriverHash()) ||
              e.localProof?.model !== m.document.model ||
              e.localProof?.providerSlug !== m.document.providerSlug ||
              e.localProof?.exactRequestPin !== true ||
              e.localProof?.wrongProviderRejected !== true ||
              e.localProof?.wrongModelRejected !== true ||
              e.localProof?.syntheticTransport !== true ||
              e.localProof?.networkCalls !== 0 ||
              !Array.isArray(e.inspectionArtifactIds) ||
              e.inspectionArtifactIds.length !== 2 ||
              !checks
                .filter(
                  (c) =>
                    c.check_kind === "assignment" ||
                    c.check_kind === "key_limit",
                )
                .every((c) =>
                  e.inspectionArtifactIds.includes(c.evidence.artifactId),
                )
            )
              throw Error("MANIFEST_MODEL_CONTROL_GAP_INVALID");
            const positive = await tx.query(
              `SELECT 1 FROM provider_calls c JOIN runtime_jobs j ON j.id=c.job_id WHERE c.id=$1 AND c.manifest_id=$2 AND c.job_id=$3 AND c.status='verified' AND c.reconciliation_status='verified' AND c.purpose='canary' AND c.staff_role IS DISTINCT FROM 'guardrail-probe' AND c.generation_id IS NOT NULL AND c.cost_micros IS NOT NULL AND c.reported_model=ANY($4::text[]) AND c.reported_provider=ANY($5::text[]) AND j.status='completed' AND j.execution_mode='provider_canary' AND c.completed_at>clock_timestamp()-interval '1 hour' AND EXISTS(SELECT 1 FROM runtime_receipts r WHERE r.agent_id=c.agent_id AND r.type='provider_diagnostic' AND r.details->>'kind'='canary_read_tool' AND r.details->>'tool'='research_sources' AND r.details->>'executed'='true' AND r.created_at BETWEEN (SELECT min(started_at) FROM provider_calls WHERE job_id=c.job_id) AND c.completed_at)`,
              [
                e.positiveCallId,
                id,
                e.positiveJobId,
                [m.document.model, m.document.canonicalModel].filter(Boolean),
                m.document.reportedProviderNames,
              ],
            );
            if (!positive.rowCount)
              throw Error("MANIFEST_MODEL_TOOL_CANARY_REQUIRED");
            continue;
          }
          if (
            e.evidenceBasis === "single_serving_branch_policy_and_local_pin"
          ) {
            if (
              check.check_kind !== "wrong_provider" ||
              e.kind !== "wrong_provider" ||
              e.manifestId !== id ||
              e.keyHash !== m.document.upstreamKeyHash ||
              e.guardrailId !== m.document.guardrailId ||
              e.model !== m.document.model ||
              e.providerSlug !== m.document.providerSlug ||
              e.independentLiveProbePassed !== false ||
              e.limitation !== SINGLE_PROVIDER_LIMITATION ||
              !singleServingBranch(
                m.document.providerSlug,
                e.catalog?.activeTags,
              ) ||
              e.catalog?.sourceUrl !==
                "https://openrouter.ai/api/v1/models/" +
                  m.document.model +
                  "/endpoints" ||
              !/^[a-f0-9]{64}$/.test(e.catalog?.responseHash ?? "") ||
              !(await guardrailTimestampFresh(
                tx,
                e.catalog.observedAt,
                3600000,
              )) ||
              e.localProof?.driverHash !== (await routingDriverHash()) ||
              e.localProof?.model !== m.document.model ||
              e.localProof?.providerSlug !== m.document.providerSlug ||
              e.localProof?.exactRequestPin !== true ||
              e.localProof?.wrongProviderRejected !== true ||
              e.localProof?.wrongModelRejected !== true ||
              e.localProof?.syntheticTransport !== true ||
              e.localProof?.networkCalls !== 0 ||
              !Array.isArray(e.inspectionArtifactIds) ||
              e.inspectionArtifactIds.length !== 2 ||
              !checks
                .filter(
                  (c) =>
                    c.check_kind === "assignment" ||
                    c.check_kind === "key_limit",
                )
                .every((c) =>
                  e.inspectionArtifactIds.includes(c.evidence.artifactId),
                )
            )
              throw Error("MANIFEST_SINGLE_PROVIDER_ASSURANCE_INVALID");
            continue;
          }
          if (
            e.kind !== check.check_kind ||
            !e.restrictionVerified ||
            (!e.costKnownZero && !e.chargeProtected)
          )
            throw Error("MANIFEST_GUARDRAIL_EVIDENCE_INVALID");
          const capture = await readGuardrailArtifact(
              tx,
              e.captureId,
              id,
              "negative_response",
            ),
            b = capture.body;
          if (
            capture.synthetic ||
            b.kind !== check.check_kind ||
            b.keyFingerprint !== m.key_fingerprint ||
            b.responseBytesHash !== e.responseBytesHash ||
            b.hasGeneration ||
            b.hasChoices ||
            !b.responseComplete ||
            evidenceHash(b.requestBody) !== b.requestHash
          )
            throw Error("MANIFEST_GUARDRAIL_EVIDENCE_INVALID");
          const linked = await tx.query(
            `SELECT 1 FROM provider_calls c JOIN runtime_reservations r ON r.id=$3 AND r.job_id=c.job_id AND r.agent_id=c.agent_id WHERE c.id=$1 AND c.manifest_id=$2 AND c.staff_role='guardrail-probe' AND c.generation_id IS NULL AND c.requested_model=$4 AND c.requested_provider=$5 AND (c.cost_micros IS NULL OR c.cost_micros=0)`,
            [
              e.callId,
              id,
              e.reservationId,
              b.requestedModel,
              b.requestedProvider,
            ],
          );
          if (!linked.rowCount)
            throw Error("MANIFEST_GUARDRAIL_PROBE_LINK_REQUIRED");
          const empirical =
            e.evidenceBasis === "empirical_authenticated_routing";
          if (empirical && !empiricalRoutingRejection(b, check.check_kind))
            throw Error("MANIFEST_GUARDRAIL_ROUTING_INVALID");
          if (
            !(await negativeChargeProtection(
              tx,
              b,
              m.document.agentId,
              empirical,
            ))
          )
            throw Error("MANIFEST_GUARDRAIL_CHARGE_UNPROTECTED");
        }
      }
      if (
        !(
          await tx.query(
            `SELECT 1 FROM provider_calls WHERE manifest_id=$1 AND purpose='canary' AND status='verified'
        AND reconciliation_status='verified' AND cost_micros IS NOT NULL AND generation_id IS NOT NULL
        AND reported_model=ANY($2::text[]) AND reported_provider=ANY($3::text[]) AND completed_at>clock_timestamp()-interval '1 hour'
        AND EXISTS(SELECT 1 FROM runtime_jobs j WHERE j.id=provider_calls.job_id AND j.status='completed' AND j.execution_mode='provider_canary')`,
            [
              id,
              [m.document.model, m.document.canonicalModel].filter(Boolean),
              m.document.reportedProviderNames,
            ],
          )
        ).rowCount
      )
        throw new Error("MANIFEST_INFERENCE_CANARY_REQUIRED");
      await tx.query(
        "UPDATE provider_manifests SET status='retired' WHERE agent_id=$1 AND status='active'",
        [m.document.agentId],
      );
      await tx.query(
        "UPDATE provider_manifests SET status='active',activated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await tx.query("UPDATE runtime_agents SET model=$2 WHERE id=$1", [
        m.document.agentId,
        m.document.model,
      ]);
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,details) VALUES('model_activated',$1,$2)",
        [
          m.document.agentId,
          {
            manifestId: id,
            version: m.version,
            model: m.document.model,
            provider: m.document.providerSlug,
          },
        ],
      );
    });
  }
  /** Safe public qualification: never portray catalog/local assurance as a measured denial. */
  async modelRestrictionEvidence(id: string) {
    const row = (
      await this.db.query(
        "SELECT a.body FROM provider_guardrail_checks c JOIN provider_guardrail_artifacts a ON a.id=(c.evidence->>'artifactId')::uuid WHERE c.manifest_id=$1 AND c.check_kind='wrong_model' AND c.passed ORDER BY c.created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    if (!row) return { status: "unverified", liveModelRejectionTested: false };
    return row.body.evidenceBasis === "operator_accepted_kimi_model_control_gap"
      ? {
          status: "operator_accepted_policy_and_local_pin_only",
          liveModelRejectionTested: false,
          limitation: MODEL_CONTROL_GAP_LIMITATION,
        }
      : {
          status: "verified_negative_probe",
          liveModelRejectionTested: true,
          evidenceBasis: row.body.evidenceBasis,
        };
  }
  async providerRestrictionEvidence(id: string) {
    const row = (
      await this.db.query(
        "SELECT a.body FROM provider_guardrail_checks c JOIN provider_guardrail_artifacts a ON a.id=(c.evidence->>'artifactId')::uuid WHERE c.manifest_id=$1 AND c.check_kind='wrong_provider' AND c.passed ORDER BY c.created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    if (!row) return { status: "unverified", liveProbePassed: false };
    return row.body.evidenceBasis ===
      "single_serving_branch_policy_and_local_pin"
      ? {
          status: "policy_and_local_pin_only",
          liveProbePassed: false,
          limitation: SINGLE_PROVIDER_LIMITATION,
        }
      : {
          status: "verified_negative_probe",
          liveProbePassed: true,
          evidenceBasis: row.body.evidenceBasis,
        };
  }
  async begin(m: Manifest, job: Job, canary: boolean) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO provider_calls(id,manifest_id,agent_id,job_id,fence,staff_role,purpose,requested_model,requested_provider)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        m.id,
        job.agentId,
        job.id,
        job.fence,
        String(job.payload.staffRole ?? "owner"),
        canary ? "canary" : "owner",
        m.document.model,
        m.document.providerSlug,
      ],
    );
    return id;
  }
  async diagnostic(callId: string, details: Record<string, unknown>) {
    await this.db.query(
      "INSERT INTO runtime_receipts(type,agent_id,job_id,details) SELECT 'provider_diagnostic',agent_id,job_id,$2::jsonb || jsonb_build_object('callId',id,'manifestId',manifest_id,'jobId',job_id) FROM provider_calls WHERE id=$1",
      [callId, details],
    );
  }
  async observe(
    id: string,
    value: {
      status: string;
      model?: string;
      provider?: string;
      generationId?: string;
      requestId?: string;
      upstreamId?: string;
      costMicros?: number;
      promptTokens?: number;
      completionTokens?: number;
      reasoningTokens?: number;
      reconciled?: boolean;
    },
  ) {
    await this.db.query(
      `UPDATE provider_calls SET status=$2,reported_model=COALESCE($3,reported_model),reported_provider=COALESCE($4,reported_provider),
      generation_id=COALESCE($5,generation_id),request_id=COALESCE($6,request_id),upstream_id=COALESCE($7,upstream_id),cost_micros=COALESCE($8,cost_micros),
      prompt_tokens=COALESCE($9,prompt_tokens),completion_tokens=COALESCE($10,completion_tokens),reasoning_tokens=COALESCE($11,reasoning_tokens),
      reconciliation_status=CASE WHEN $12 THEN 'verified' ELSE reconciliation_status END,completed_at=clock_timestamp() WHERE id=$1`,
      [
        id,
        value.status,
        value.model ?? null,
        value.provider ?? null,
        value.generationId ?? null,
        value.requestId ?? null,
        value.upstreamId ?? null,
        value.costMicros ?? null,
        value.promptTokens ?? null,
        value.completionTokens ?? null,
        value.reasoningTokens ?? null,
        value.reconciled ?? false,
      ],
    );
  }
}
