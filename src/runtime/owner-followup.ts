import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "../db.js";
import type { Actor } from "../league/schema.js";
import { fingerprint } from "../governance/validation.js";
const check = (value: unknown, code: string) => {
  if (!value) throw new Error(code);
};
const Request = z
  .object({
    agentId: z.string().min(1).max(120),
    appointmentId: z.uuid(),
    reason: z.string().trim().min(10).max(4000),
    evidenceRef: z.string().trim().min(1).max(1000),
  })
  .strict();

const RetestRequest = Request.extend({
  outcome: z
    .enum(["zero_actions", "unsupported_result"])
    .default("zero_actions"),
  completionReceiptSequence: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
  observedFailure: z.string().trim().min(20).max(4000).optional(),
}).superRefine((value, context) => {
  if (
    value.outcome === "unsupported_result" &&
    (!value.completionReceiptSequence || !value.observedFailure)
  )
    context.addIssue({
      code: "custom",
      message:
        "Unsupported-result retest requires the exact completion receipt and a concrete observed failure",
    });
});

export async function followupRetestAuthorization(
  db: Pick<Db, "query">,
  leagueId: string,
  stageId: string,
  agentId: string,
) {
  const original =
    (
      await db.query(
        "SELECT details FROM runtime_receipts WHERE type='owner_stage.followup_retest_authorized' AND agent_id=$1 AND details->>'leagueId'=$2 AND details->>'stageId'=$3 ORDER BY seq DESC LIMIT 1",
        [agentId, leagueId, stageId],
      )
    ).rows[0]?.details ?? null;
  if (!original) return null;
  const replacement = (
    await db.query(
      "SELECT details FROM runtime_receipts WHERE type='owner_stage.followup_retest_replacement_authorized' AND agent_id=$1 AND details->>'leagueId'=$2 AND details->>'stageId'=$3 AND details->>'retestAuthorizationReceiptId'=$4 ORDER BY seq DESC LIMIT 1",
      [agentId, leagueId, stageId, original.receiptId],
    )
  ).rows[0]?.details;
  return {
    ...original,
    ...(replacement ? { failedRetestReplacement: replacement } : {}),
  };
}

export async function followupCompletionEvidence(
  db: Pick<Db, "query">,
  leagueId: string,
  stageId: string,
  agentId: string,
  appointmentId?: string,
) {
  if (!appointmentId) return { note: null, provenance: null };
  const retest = await followupRetestAuthorization(
    db,
    leagueId,
    stageId,
    agentId,
  );
  if (retest?.priorAppointmentId === appointmentId)
    return { note: null, provenance: null };
  const rows = (
    await db.query(
      `SELECT r.seq,r.type,r.details FROM runtime_receipts r JOIN runtime_jobs j ON j.id=r.job_id AND j.agent_id=r.agent_id
     JOIN runtime_owner_stage_turns t ON t.job_id=j.id AND t.fence=j.fence AND t.agent_id=j.agent_id
     WHERE r.agent_id=$1 AND r.job_id=$2 AND r.type IN ('owner_stage.followup_memory_written','owner_stage.followup_legacy_attested')
       AND r.details->>'leagueId'=$3 AND r.details->>'stageId'=$4 AND r.details->>'fence'=j.fence::text
       AND t.league_id=$3 AND t.stage_id=$4 AND j.status='completed' AND j.kind='appointment'
       AND j.payload->>'kind'='onboarding.followup' AND j.payload->>'stageId'=$4
       AND EXISTS(SELECT 1 FROM runtime_receipts c WHERE c.type='job.completed' AND c.agent_id=j.agent_id AND c.job_id=j.id AND jsonb_typeof(c.details->'actions')='number' AND (c.details->>'actions')::integer>0)
     ORDER BY r.seq DESC`,
      [agentId, appointmentId, leagueId, stageId],
    )
  ).rows;
  for (const row of rows) {
    const m = row.details.memory;
    if (
      typeof m?.content !== "string" ||
      !Number.isInteger(m.version) ||
      m.version < 1 ||
      fingerprint(m.content) !== m.contentHash ||
      !Number.isFinite(Date.parse(m.updatedAt))
    )
      continue;
    return {
      note: {
        content: m.content,
        version: m.version,
        updated_at: new Date(m.updatedAt),
      },
      provenance: {
        receiptSequence: row.seq,
        type: row.type,
        appointmentId,
        fence: row.details.fence,
        contentHash: m.contentHash,
        source: row.details.source ?? "appointment-action",
      },
    };
  }
  return { note: null, provenance: null };
}

export class OwnerFollowupRecovery {
  constructor(private db: Db) {}
  private async scope(
    tx: Pick<Db, "query">,
    actor: Actor,
    request: z.infer<typeof Request>,
  ) {
    const row = (
      await tx.query(
        `SELECT s.*,j.id AS appointment_id,j.status AS job_status,j.fence,j.claimed_at,j.completed_at,j.kind,j.payload,c.seq AS completion_seq,c.details->'actions' AS actions,
        j.xmin::text AS job_xmin,c.xmin::text AS completion_xmin
       FROM runtime_owner_stages s JOIN runtime_bindings b ON b.league_id=s.league_id
       JOIN runtime_jobs j ON j.agent_id=b.agent_id AND j.id=$2
       JOIN runtime_owner_stage_turns t ON t.job_id=j.id AND t.fence=j.fence AND t.agent_id=j.agent_id AND t.league_id=s.league_id AND t.stage_id=s.id
       JOIN LATERAL(SELECT c.seq,c.details,c.xmin FROM runtime_receipts c WHERE c.type='job.completed' AND c.job_id=j.id AND c.agent_id=j.agent_id ORDER BY c.seq DESC LIMIT 1)c ON true
       WHERE b.agent_id=$1 AND s.league_id=$3 AND s.status IN ('active','paused')
        AND s.id=(SELECT current.id FROM runtime_owner_stages current WHERE current.league_id=s.league_id AND current.status IN ('active','paused') ORDER BY current.configured_at DESC LIMIT 1)
        AND j.id=(SELECT (r.details->>'appointmentId')::uuid FROM runtime_receipts r WHERE r.type='owner_stage.schedule_authored' AND r.agent_id=$1 AND r.details->>'stageId'=s.id ORDER BY r.seq DESC LIMIT 1)`,
        [request.agentId, request.appointmentId, actor.leagueId],
      )
    ).rows[0];
    check(
      row &&
        row.job_status === "completed" &&
        row.kind === "appointment" &&
        row.payload.kind === "onboarding.followup" &&
        row.payload.stageId === row.id,
      "OWNER_STAGE_COMPLETED_FOLLOWUP_REQUIRED",
    );
    return row;
  }
  async authorizeFollowupRetest(
    actor: Actor,
    input: z.input<typeof RetestRequest>,
  ) {
    check(
      actor.role === "commissioner" && actor.leagueId,
      "OWNER_STAGE_COMMISSIONER_REQUIRED",
    );
    const request = RetestRequest.parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM runtime_agents WHERE id=$1 FOR UPDATE", [
        request.agentId,
      ]);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const priorReplay = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.followup_retest_authorized' AND agent_id=$1 AND job_id=$2 AND details->>'leagueId'=$3 ORDER BY seq DESC LIMIT 1",
          [request.agentId, request.appointmentId, actor.leagueId],
        )
      ).rows[0]?.details;
      if (priorReplay) {
        check(
          priorReplay.requestHash === fingerprint(request),
          "OWNER_STAGE_FOLLOWUP_RETEST_CONFLICT",
        );
        return { ...priorReplay, replayed: true };
      }
      const row = await this.scope(tx, actor, request);
      if (request.outcome === "zero_actions")
        check(row.actions === 0, "OWNER_STAGE_ZERO_ACTION_FOLLOWUP_REQUIRED");
      else {
        check(
          typeof row.actions === "number" && row.actions > 0,
          "OWNER_STAGE_FOLLOWUP_ACTION_REQUIRED",
        );
        check(
          String(row.completion_seq) === request.completionReceiptSequence,
          "OWNER_STAGE_COMPLETION_RECEIPT_MISMATCH",
        );
      }
      const hash = fingerprint(request),
        previous = await followupRetestAuthorization(
          tx,
          row.league_id,
          row.id,
          request.agentId,
        );
      if (previous) {
        check(
          previous.requestHash === hash,
          "OWNER_STAGE_FOLLOWUP_RETEST_CONFLICT",
        );
        return { ...previous, replayed: true };
      }
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [request.agentId],
          )
        ).rowCount,
        "OWNER_STAGE_QUIESCENT_OWNER_REQUIRED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j JOIN runtime_receipts r ON j.id=(r.details->>'appointmentId')::uuid WHERE r.type='owner_stage.schedule_authored' AND r.agent_id=$1 AND r.details->>'stageId'=$2 AND j.status IN ('pending','running')",
            [request.agentId, row.id],
          )
        ).rowCount,
        "OWNER_STAGE_FOLLOWUP_IN_FLIGHT",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
            [row.league_id, row.id, request.agentId],
          )
        ).rowCount,
        "OWNER_STAGE_ALREADY_REVIEWED",
      );
      const details = {
        receiptId: randomUUID(),
        leagueId: row.league_id,
        stageId: row.id,
        agentId: request.agentId,
        priorAppointmentId: row.appointment_id,
        priorFence: row.fence,
        priorStatus: "completed",
        priorActions: row.actions,
        outcome: request.outcome,
        observedFailure: request.observedFailure ?? null,
        priorCompletedAt: row.completed_at,
        completionReceiptSequence: row.completion_seq,
        requestHash: hash,
        reason: request.reason,
        evidenceRef: request.evidenceRef,
        reviewedBy: actor.id,
        disposition: "permit-one-new-owner-authored-followup",
        automaticWake: false,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.followup_retest_authorized',$1,$2,$3)",
        [request.agentId, request.appointmentId, details],
      );
      return { ...details, replayed: false };
    });
  }
  /** One operator-reviewed recovery of a failed retest, without a wake or cost waiver. */
  async authorizeFailedFollowupRetestReplacement(
    actor: Actor,
    input: {
      agentId: string;
      stageId: string;
      appointmentId: string;
      failedFence: number;
      failedError: string;
      failureReceiptSequence: string;
      expectedKnownCostMicros: number;
      reason: string;
      evidenceRef: string;
    },
  ) {
    check(
      actor.role === "commissioner" && actor.leagueId,
      "OWNER_STAGE_COMMISSIONER_REQUIRED",
    );
    const request = Request.extend({
      stageId: z.string().min(1).max(120),
      failedFence: z.number().int().positive(),
      failedError: z.string().min(1).max(1000),
      failureReceiptSequence: z.string().regex(/^[1-9][0-9]*$/),
      expectedKnownCostMicros: z.number().int().nonnegative().safe(),
    })
      .strict()
      .parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM runtime_agents WHERE id=$1 FOR UPDATE", [
        request.agentId,
      ]);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const original = await followupRetestAuthorization(
        tx,
        actor.leagueId,
        request.stageId,
        request.agentId,
      );
      check(original, "OWNER_STAGE_RETEST_AUTHORIZATION_REQUIRED");
      const requestHash = fingerprint(request);
      if (original.failedRetestReplacement) {
        check(
          original.failedRetestReplacement.requestHash === requestHash,
          "OWNER_STAGE_RETEST_REPLACEMENT_CONFLICT",
        );
        return { ...original.failedRetestReplacement, replayed: true };
      }
      const row = (
        await tx.query(
          `SELECT j.*,s.status AS stage_status,r.id AS reservation_id,r.status AS cost_status,r.actual_micros,r.observed_micros,c.details AS failure_details,c.seq AS failure_seq
        FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id
        JOIN runtime_owner_stages s ON s.league_id=b.league_id AND s.id=$3
        JOIN runtime_owner_stage_turns t ON t.job_id=j.id AND t.fence=j.fence AND t.agent_id=j.agent_id AND t.league_id=s.league_id AND t.stage_id=s.id
        JOIN runtime_reservations r ON r.job_id=j.id AND r.fence=j.fence AND r.agent_id=j.agent_id
        JOIN runtime_receipts c ON c.job_id=j.id AND c.agent_id=j.agent_id AND c.type='job.dead' AND c.seq=$4 AND c.created_at>=j.claimed_at
          AND c.seq=(SELECT max(d.seq) FROM runtime_receipts d WHERE d.type='job.dead' AND d.job_id=j.id AND d.agent_id=j.agent_id)
        WHERE j.agent_id=$1 AND j.id=$2 AND b.league_id=$5
          AND s.id=(SELECT id FROM runtime_owner_stages WHERE league_id=b.league_id ORDER BY configured_at DESC,id DESC LIMIT 1)`,
          [
            request.agentId,
            request.appointmentId,
            request.stageId,
            request.failureReceiptSequence,
            actor.leagueId,
          ],
        )
      ).rows[0];
      check(
        row &&
          ["active", "paused"].includes(row.stage_status) &&
          row.status === "dead" &&
          row.kind === "appointment" &&
          row.payload.kind === "onboarding.followup" &&
          row.payload.stageId === request.stageId,
        "OWNER_STAGE_FAILED_RETEST_REQUIRED",
      );
      check(
        row.fence === request.failedFence &&
          row.error === request.failedError &&
          row.failure_details.error === request.failedError,
        "OWNER_STAGE_FAILED_RETEST_FENCE_MISMATCH",
      );
      check(
        row.cost_status === "settled" &&
          row.actual_micros !== null &&
          Number(row.actual_micros) === request.expectedKnownCostMicros &&
          row.failure_details.observedCostMicros ===
            request.expectedKnownCostMicros,
        "OWNER_STAGE_FAILED_RETEST_KNOWN_COST_REQUIRED",
      );
      const authored = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.schedule_authored' AND agent_id=$1 AND details->>'stageId'=$2 AND details->>'retestAuthorizationReceiptId'=$3 ORDER BY seq",
          [request.agentId, request.stageId, original.receiptId],
        )
      ).rows;
      check(
        authored.length === 1 &&
          authored[0].details.appointmentId === request.appointmentId,
        "OWNER_STAGE_EXACT_USED_RETEST_REQUIRED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j WHERE j.agent_id=$1 AND (j.status='running' OR (j.status='pending' AND j.kind='appointment' AND j.payload->>'stageId'=$2))",
            [request.agentId, request.stageId],
          )
        ).rowCount,
        "OWNER_STAGE_FOLLOWUP_IN_FLIGHT",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
            [actor.leagueId, request.stageId, request.agentId],
          )
        ).rowCount,
        "OWNER_STAGE_ALREADY_REVIEWED",
      );
      const details = {
        receiptId: randomUUID(),
        leagueId: actor.leagueId,
        stageId: request.stageId,
        agentId: request.agentId,
        retestAuthorizationReceiptId: original.receiptId,
        originalCompletedAppointmentId: original.priorAppointmentId,
        failedAppointmentId: request.appointmentId,
        failedFence: row.fence,
        failedError: row.error,
        failureReceiptSequence: String(row.failure_seq),
        reservationId: row.reservation_id,
        knownCostMicros: Number(row.actual_micros),
        requestHash,
        reason: request.reason,
        evidenceRef: request.evidenceRef,
        reviewedBy: actor.id,
        automaticWake: false,
        walletUnchanged: true,
        disposition: "permit-one-replacement-of-exact-failed-retest",
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.followup_retest_replacement_authorized',$1,$2,$3)",
        [request.agentId, request.appointmentId, details],
      );
      return { ...details, replayed: false };
    });
  }
  async attestLegacyFollowup(actor: Actor, input: z.input<typeof Request>) {
    check(
      actor.role === "commissioner" && actor.leagueId,
      "OWNER_STAGE_COMMISSIONER_REQUIRED",
    );
    const request = Request.parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT id FROM runtime_agents WHERE id=$1 FOR UPDATE", [
        request.agentId,
      ]);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const row = await this.scope(tx, actor, request);
      const previous = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.followup_legacy_attested' AND agent_id=$1 AND job_id=$2 ORDER BY seq DESC LIMIT 1",
          [request.agentId, request.appointmentId],
        )
      ).rows[0]?.details;
      const requestHash = fingerprint(request);
      if (previous) {
        check(
          previous.requestHash === requestHash,
          "OWNER_STAGE_LEGACY_ATTESTATION_CONFLICT",
        );
        return { ...previous, replayed: true };
      }
      check(
        typeof row.actions === "number" && row.actions > 0,
        "OWNER_STAGE_FOLLOWUP_ACTION_REQUIRED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [request.agentId],
          )
        ).rowCount,
        "OWNER_STAGE_QUIESCENT_OWNER_REQUIRED",
      );
      const memory = (
        await tx.query(
          `SELECT m.content,m.version,m.updated_at,m.xmin::text AS memory_xmin,
          (SELECT r.seq FROM runtime_receipts r WHERE r.agent_id=m.agent_id AND r.type='memory.updated' AND r.details->>'key'=m.key AND r.xmin=m.xmin AND r.created_at BETWEEN $2 AND $3 ORDER BY r.seq DESC LIMIT 1) AS memory_receipt_seq
         FROM runtime_memory m WHERE m.agent_id=$1 AND m.key='owner/onboarding-followup'`,
          [request.agentId, row.claimed_at, row.completed_at],
        )
      ).rows[0];
      check(
        memory &&
          !["0", "1", "2"].includes(memory.memory_xmin) &&
          memory.memory_xmin === row.job_xmin &&
          memory.memory_xmin === row.completion_xmin &&
          memory.memory_receipt_seq &&
          memory.updated_at >= row.claimed_at &&
          memory.updated_at <= row.completed_at,
        "OWNER_STAGE_LEGACY_TRANSACTION_PROOF_REQUIRED",
      );
      const details = {
        receiptId: randomUUID(),
        leagueId: row.league_id,
        stageId: row.id,
        agentId: request.agentId,
        appointmentId: row.appointment_id,
        fence: row.fence,
        source: "operator-attested-legacy-same-commit",
        sourceTransaction: memory.memory_xmin,
        completionReceiptSequence: row.completion_seq,
        memoryReceiptSequence: memory.memory_receipt_seq,
        memory: {
          content: memory.content,
          version: memory.version,
          updatedAt: memory.updated_at.toISOString(),
          contentHash: fingerprint(memory.content),
        },
        requestHash,
        reason: request.reason,
        evidenceRef: request.evidenceRef,
        reviewedBy: actor.id,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.followup_legacy_attested',$1,$2,$3)",
        [request.agentId, request.appointmentId, details],
      );
      return { ...details, replayed: false };
    });
  }
}
