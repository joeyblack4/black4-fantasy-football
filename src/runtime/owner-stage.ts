import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import {
  RuntimeError,
  type Job,
  type Action,
  type RuntimeStore,
} from "./index.js";
import { fingerprint } from "../governance/validation.js";
import { validateStructuredOwnerMemory } from "./owner-memory-schema.js";
import {
  OwnerFollowupRecovery,
  followupRetestAuthorization,
  followupCompletionEvidence,
} from "./owner-followup.js";
import {
  ownerStageIntroDisposition,
  assertOwnerStageIntroReplacement,
} from "./owner-stage-disposition.js";
const Identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export const OwnerStageConfigSchema = z
  .object({
    stageId: Identifier,
    policyReceiptId: z.string().min(1).max(200),
    introChannelId: z.uuid(),
    initiativeDeadline: z.iso.datetime({ offset: true }),
    followupDeadline: z.iso.datetime({ offset: true }),
    synthetic: z.boolean().default(false),
    allowedActions: z
      .array(
        z.enum(["brand", "remember", "schedule", "cancel", "buzz_channel"]),
      )
      .min(1),
    readTools: z
      .array(
        z.enum([
          "research_sources",
          "research_retrieve",
          "research_search",
          "buzz_read",
        ]),
      )
      .min(1),
    limits: z
      .object({
        maxTurns: z.number().int().min(2).max(12),
        maxSpendMicros: z.number().int().positive().max(100_000_000),
        maxReservationMicros: z.number().int().positive().max(10_000_000),
      })
      .strict(),
  })
  .strict()
  .refine((x) => x.limits.maxReservationMicros <= x.limits.maxSpendMicros);
function check(v: unknown, c: string): asserts v {
  if (!v) throw new RuntimeError(c);
}
async function active(tx: Pick<Db, "query">, agentId: string) {
  return (
    await tx.query(
      "SELECT s.*,(SELECT r.details FROM runtime_receipts r WHERE r.type='owner_stage.deadlines_extended' AND r.details->>'leagueId'=s.league_id AND r.details->>'stageId'=s.id ORDER BY r.seq DESC LIMIT 1) AS deadline_extension,(SELECT r.details FROM runtime_receipts r WHERE r.type='owner_stage.allowance_amended' AND r.details->>'leagueId'=s.league_id AND r.details->>'stageId'=s.id ORDER BY r.seq DESC LIMIT 1) AS operational_extension,b.team_id,t.owner_id,a.model,a.budget_micros,a.spent_micros,a.reserved_micros FROM runtime_owner_stages s JOIN runtime_bindings b ON b.league_id=s.league_id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1 AND s.status IN ('active','paused') ORDER BY s.configured_at DESC LIMIT 1",
      [agentId],
    )
  ).rows[0];
}
function effectiveStageConfig(row: any) {
  const original = OwnerStageConfigSchema.parse(row.configuration);
  const allowance = row.operational_extension?.newAllowance;
  return {
    ...original,
    limits: {
      ...original.limits,
      maxTurns: allowance?.maxTurns ?? original.limits.maxTurns,
    },
    readTools: [
      ...new Set<string>([
        ...original.readTools,
        ...(allowance?.additionalReadTools ?? []),
      ]),
    ],
  };
}
function stageDeadlines(row: any) {
  const config = OwnerStageConfigSchema.parse(row.configuration);
  const original = {
    initiative: config.initiativeDeadline,
    followup: config.followupDeadline,
  };
  return {
    original,
    effective: row.deadline_extension?.newDeadlines ?? original,
    extensionReceiptId: row.deadline_extension?.receiptId ?? null,
  };
}
async function usage(tx: Pick<Db, "query">, row: any, agentId: string) {
  return (
    await tx.query(
      `WITH model_usage AS (
SELECT count(*)::int AS turns,COALESCE(sum(CASE WHEN r.status='released' THEN 0 WHEN r.status='settled' THEN COALESCE(r.actual_micros,r.observed_micros,r.amount_micros) ELSE GREATEST(r.amount_micros,COALESCE(r.observed_micros,r.amount_micros)) END),0)::text AS committed_micros,count(*) FILTER(WHERE r.status='uncertain')::int AS unresolved_costs,count(*) FILTER(WHERE r.status='uncertain' AND NOT EXISTS(SELECT 1 FROM runtime_receipts v WHERE v.type='owner_stage.cost_hold_reviewed' AND v.agent_id=t.agent_id AND v.job_id=t.job_id AND v.details->>'leagueId'=t.league_id AND v.details->>'stageId'=t.stage_id AND v.details->>'reservationId'=r.id::text AND v.details->>'fence'=r.fence::text))::int AS unreviewed_costs FROM runtime_owner_stage_turns t JOIN runtime_reservations r ON r.job_id=t.job_id AND r.fence=t.fence WHERE t.league_id=$1 AND t.stage_id=$2 AND t.agent_id=$3
      ), research_usage AS (
        SELECT COALESCE(sum(CASE WHEN p.status='completed' AND p.actual_micros IS NOT NULL THEN p.actual_micros ELSE p.reservation_micros END),0) AS committed,
          count(*) FILTER(WHERE p.status='unknown' OR (p.status='completed' AND p.actual_micros IS NULL))::int AS unresolved
        FROM research_paid_operations p JOIN runtime_owner_stage_turns t ON t.job_id=p.job_id AND t.fence=p.fence AND t.agent_id=p.agent_id
        WHERE t.league_id=$1 AND t.stage_id=$2 AND t.agent_id=$3 AND p.league_id=t.league_id
      ) SELECT m.turns,(m.committed_micros::numeric+p.committed)::text AS committed_micros,
        m.unresolved_costs+p.unresolved AS unresolved_costs,m.unreviewed_costs+p.unresolved AS unreviewed_costs,
        p.committed::text AS research_committed_micros,p.unresolved AS research_unresolved_costs
        FROM model_usage m CROSS JOIN research_usage p`,
      [row.league_id, row.id, agentId],
    )
  ).rows[0];
}
async function pending(tx: Pick<Db, "query">, row: any, agentId: string) {
  const disposition = await ownerStageIntroDisposition(tx, {
    leagueId: row.league_id,
    stageId: row.id,
    agentId,
    defaultCausalId: `onboarding:${row.id}:intro`,
  });
  const rows = (
    await tx.query(
      `SELECT id,status,action->>'type' AS type FROM runtime_franchise_outbox WHERE agent_id=$1 AND (status IN ('pending','running') OR (status='held' AND job_id IN(SELECT job_id FROM runtime_owner_stage_turns WHERE league_id=$2 AND stage_id=$3))) UNION ALL SELECT id,status,command->>'type' AS type FROM runtime_football_outbox WHERE agent_id=$1 AND (status IN ('pending','running') OR (status='held' AND job_id IN(SELECT job_id FROM runtime_owner_stage_turns WHERE league_id=$2 AND stage_id=$3)))`,
      [agentId, row.league_id, row.id],
    )
  ).rows;
  return rows.filter(
    (r) => !(r.status === "held" && disposition.priorOutboxIds.includes(r.id)),
  );
}
/** All jobs, including incoming chat and staff, consume the same onboarding allowance. */
export async function reserveOwnerStageTurn(tx: Tx, job: Job, amount: number) {
  const row = await active(tx, job.agentId);
  if (!row) return;
  const mode = (
    await tx.query("SELECT execution_mode FROM runtime_jobs WHERE id=$1", [
      job.id,
    ])
  ).rows[0]?.execution_mode;
  if (mode === "provider_canary") return;
  check(row.status === "active", "OWNER_STAGE_PAUSED");
  const config = effectiveStageConfig(row),
    used = await usage(tx, row, job.agentId);
  check(
    !(
      await tx.query(
        "SELECT 1 FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
        [row.league_id, row.id, job.agentId],
      )
    ).rowCount,
    "OWNER_STAGE_AWAIT_NEXT_ASSIGNMENT",
  );
  check(
    !(await pending(tx, row, job.agentId)).length,
    "OWNER_STAGE_OUTBOX_REQUIRES_DRAIN",
  );
  check(!used.unreviewed_costs, "OWNER_STAGE_COST_REQUIRES_REVIEW");
  check(used.turns < config.limits.maxTurns, "OWNER_STAGE_TURN_LIMIT");
  check(
    amount <= config.limits.maxReservationMicros &&
      Number(used.committed_micros) + amount <= config.limits.maxSpendMicros,
    "OWNER_STAGE_SPEND_LIMIT",
  );
  await tx.query(
    "INSERT INTO runtime_owner_stage_turns(league_id,stage_id,agent_id,job_id,fence) VALUES($1,$2,$3,$4,$5)",
    [row.league_id, row.id, job.agentId, job.id, job.fence],
  );
}
/** Caller must already hold the agent row and verify the live job/fence. */
export async function assertOwnerStageResearchBudget(
  tx: Tx,
  job: Job,
  amount: number,
  tool: "research_search" | "research_retrieve",
) {
  check(
    Number.isSafeInteger(amount) && amount >= 0,
    "OWNER_STAGE_INVALID_RESEARCH_HOLD",
  );
  const row = await active(tx, job.agentId);
  if (!row) return;
  check(row.status === "active", "OWNER_STAGE_PAUSED");
  const config = OwnerStageConfigSchema.parse(row.configuration);
  check(config.readTools.includes(tool), "OWNER_STAGE_RESEARCH_TOOL_FORBIDDEN");
  check(
    (
      await tx.query(
        "SELECT 1 FROM runtime_owner_stage_turns WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3 AND job_id=$4 AND fence=$5",
        [row.league_id, row.id, job.agentId, job.id, job.fence],
      )
    ).rowCount,
    "OWNER_STAGE_PREVIOUS_INTENT_HELD",
  );
  check(
    !(
      await tx.query(
        "SELECT 1 FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
        [row.league_id, row.id, job.agentId],
      )
    ).rowCount,
    "OWNER_STAGE_AWAIT_NEXT_ASSIGNMENT",
  );
  const used = await usage(tx, row, job.agentId);
  check(!used.unreviewed_costs, "OWNER_STAGE_COST_REQUIRES_REVIEW");
  check(
    amount <= config.limits.maxReservationMicros &&
      Number(used.committed_micros) + amount <= config.limits.maxSpendMicros,
    "OWNER_STAGE_SPEND_LIMIT",
  );
}
/** Also called at dispatcher execution, so a previously queued intent cannot bypass a new stage. */
export async function assertOwnerStageAction(
  tx: Pick<Db, "query">,
  agentId: string,
  type: string,
  jobId?: string,
) {
  const row = await active(tx, agentId);
  if (!row) return;
  check(row.status === "active", "OWNER_STAGE_PAUSED");
  const config = OwnerStageConfigSchema.parse(row.configuration);
  check(
    config.allowedActions.includes(type as any),
    "OWNER_STAGE_ACTION_FORBIDDEN",
  );
  if (jobId)
    check(
      (
        await tx.query(
          "SELECT 1 FROM runtime_owner_stage_turns WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3 AND job_id=$4",
          [row.league_id, row.id, agentId, jobId],
        )
      ).rowCount,
      "OWNER_STAGE_PREVIOUS_INTENT_HELD",
    );
}
export async function recordOwnerStageSchedule(
  tx: Tx,
  job: Job,
  action: Extract<Action, { type: "schedule" }>,
  appointment: any,
) {
  const row = await active(tx, job.agentId);
  if (!row) return;
  const timing = (
    await tx.query(
      "SELECT clock_timestamp() AS now,claimed_at FROM runtime_jobs WHERE id=$1 AND fence=$2",
      [job.id, job.fence],
    )
  ).rows[0];
  check(timing?.claimed_at, "OWNER_STAGE_FOLLOWUP_ORIGIN");
  const now = timing.now,
    requested = new Date(action.dueAt),
    deadline = new Date(stageDeadlines(row).effective.followup);
  check(
    action.payload.kind === "onboarding.followup" &&
      action.payload.stageId === row.id &&
      typeof action.payload.task === "string" &&
      action.payload.task.length >= 10,
    "OWNER_STAGE_FOLLOWUP_SHAPE",
  );
  check(
    requested >= timing.claimed_at && requested <= deadline && now <= deadline,
    "OWNER_STAGE_FOLLOWUP_DEADLINE",
  );
  const history = (
    await tx.query(
      "SELECT r.details,j.status,j.error FROM runtime_receipts r JOIN runtime_jobs j ON j.id=(r.details->>'appointmentId')::uuid WHERE r.type='owner_stage.schedule_authored' AND r.agent_id=$1 AND r.details->>'stageId'=$2 ORDER BY r.seq",
      [job.agentId, row.id],
    )
  ).rows;
  const retest = await followupRetestAuthorization(
    tx,
    row.league_id,
    row.id,
    job.agentId,
  );
  if (retest) {
    check(
      appointment.id !== retest.priorAppointmentId,
      "OWNER_STAGE_RETEST_REQUIRES_NEW_APPOINTMENT",
    );
    const usedRetest = history.find(
      (r) => r.details.retestAuthorizationReceiptId === retest.receiptId,
    );
    const replacement = retest.failedRetestReplacement;
    const usedReplacement =
      replacement &&
      history.find(
        (r) =>
          r.details.retestReplacementAuthorizationReceiptId ===
          replacement.receiptId,
      );
    const exactFailedRecovery =
      replacement &&
      usedRetest?.status === "dead" &&
      usedRetest.details.appointmentId === replacement.failedAppointmentId &&
      (!usedReplacement ||
        usedReplacement.details.appointmentId === appointment.id);
    check(
      !usedRetest ||
        usedRetest.details.appointmentId === appointment.id ||
        exactFailedRecovery,
      "OWNER_STAGE_FOLLOWUP_RETEST_ALREADY_USED",
    );
  }
  const occupying = history.filter(
    (r) =>
      !["cancelled", "dead"].includes(r.status) &&
      !(
        retest &&
        r.status === "completed" &&
        r.details.appointmentId === retest.priorAppointmentId
      ),
  );
  check(
    occupying.every((r) => r.details.appointmentId === appointment.id),
    "OWNER_STAGE_ONE_FOLLOWUP_LIMIT",
  );
  check(
    !["dead", "cancelled"].includes(appointment.status),
    "OWNER_STAGE_REPLACEMENT_REQUIRES_NEW_CAUSAL_ID",
  );
  if (!history.some((r) => r.details.appointmentId === appointment.id)) {
    const latenessMs = Math.max(0, now.getTime() - requested.getTime());
    await tx.query(
      "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.schedule_authored',$1,$2,$3)",
      [
        job.agentId,
        job.id,
        {
          stageId: row.id,
          appointmentId: appointment.id,
          originFence: job.fence,
          ...(retest
            ? {
                retestAuthorizationReceiptId: retest.receiptId,
                retestsCompletedAppointmentId: retest.priorAppointmentId,
                ...(retest.failedRetestReplacement
                  ? {
                      retestReplacementAuthorizationReceiptId:
                        retest.failedRetestReplacement.receiptId,
                    }
                  : {}),
              }
            : {}),
          dueAt: action.dueAt,
          recordedAt: now.toISOString(),
          latenessMs,
          replacesFailedAppointments: history
            .filter((r) => r.status === "dead")
            .map((r) => ({
              appointmentId: r.details.appointmentId,
              error: r.error,
            })),
        },
      ],
    );
    if (latenessMs > 0)
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.schedule_late',$1,$2,$3)",
        [
          job.agentId,
          job.id,
          {
            stageId: row.id,
            appointmentId: appointment.id,
            originFence: job.fence,
            requestedDueAt: action.dueAt,
            originClaimedAt: timing.claimed_at.toISOString(),
            observedAt: now.toISOString(),
            latenessMs,
            disposition: "immediately-eligible-original-due-time-preserved",
          },
        ],
      );
  }
}
export async function recordOwnerStageMemory(
  tx: Tx,
  job: Job,
  action: Extract<Action, { type: "remember" }>,
) {
  const row = await active(tx, job.agentId);
  if (!row) return;
  const structuredMemory = validateStructuredOwnerMemory(
    action.key,
    action.content,
  );
  if (
    action.key === "owner/onboarding-followup" &&
    job.payload.kind === "onboarding.followup" &&
    job.payload.stageId === row.id
  ) {
    const authored = (
      await tx.query(
        "SELECT 1 FROM runtime_receipts WHERE type='owner_stage.schedule_authored' AND agent_id=$1 AND details->>'stageId'=$2 AND details->>'appointmentId'=$3",
        [job.agentId, row.id, job.id],
      )
    ).rowCount;
    if (authored) {
      const memory = (
        await tx.query(
          "SELECT content,version,updated_at FROM runtime_memory WHERE agent_id=$1 AND key=$2",
          [job.agentId, action.key],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.followup_memory_written',$1,$2,$3)",
        [
          job.agentId,
          job.id,
          {
            leagueId: row.league_id,
            stageId: row.id,
            appointmentId: job.id,
            fence: job.fence,
            source: "appointment-action",
            memory: {
              content: memory.content,
              version: memory.version,
              updatedAt: memory.updated_at.toISOString(),
              contentHash: fingerprint(memory.content),
            },
          },
        ],
      );
    }
  }
  if (action.key === "owner/memory-probe") {
    const memory = (
      await tx.query(
        "SELECT version,content FROM runtime_memory WHERE agent_id=$1 AND key=$2",
        [job.agentId, action.key],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.memory_written',$1,$2,$3)",
      [
        job.agentId,
        job.id,
        {
          stageId: row.id,
          key: action.key,
          version: memory.version,
          contentHash: fingerprint(memory.content),
        },
      ],
    );
  }
  if (action.key === "owner/memory-readback") {
    check(
      structuredMemory?.kind === "readback",
      "OWNER_STAGE_STRUCTURED_MEMORY_JSON_REQUIRED",
    );
    const proof = structuredMemory.proof;
    const observed = job.memory.find((m) => m.key === proof.key);
    check(
      observed &&
        observed.version === proof.sourceVersion &&
        observed.content === proof.value,
      "OWNER_STAGE_MEMORY_READBACK_MISMATCH",
    );
    const source = (
      await tx.query(
        "SELECT seq,job_id,details FROM runtime_receipts WHERE type='owner_stage.memory_written' AND agent_id=$1 AND details->>'stageId'=$2 AND details->>'version'=$3 AND details->>'contentHash'=$4 ORDER BY seq DESC LIMIT 1",
        [
          job.agentId,
          row.id,
          String(proof.sourceVersion),
          fingerprint(proof.value),
        ],
      )
    ).rows[0];
    check(
      source && source.job_id !== job.id,
      "OWNER_STAGE_MEMORY_FRESH_JOB_REQUIRED",
    );
    await tx.query(
      "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.memory_roundtrip',$1,$2,$3)",
      [
        job.agentId,
        job.id,
        {
          stageId: row.id,
          sourceReceiptSeq: source.seq,
          sourceJobId: source.job_id,
          readJobId: job.id,
          key: proof.key,
          sourceVersion: proof.sourceVersion,
          contentHash: fingerprint(proof.value),
          isolation: "agent-scoped-job-memory",
          usedFor: proof.usedFor ?? null,
          packetSourceVersion:
            job.memory.find((m) => m.key === "owner_operating_packet_v1")
              ?.version ?? null,
          packetContentHash: job.memory.find(
            (m) => m.key === "owner_operating_packet_v1",
          )
            ? fingerprint(
                job.memory.find((m) => m.key === "owner_operating_packet_v1")!
                  .content,
              )
            : null,
        },
      ],
    );
  }
}
async function researchQualification(
  db: Pick<Db, "query">,
  row: any,
  agentId: string,
) {
  const config = OwnerStageConfigSchema.parse(row.configuration);
  const legacySearches = (
    await db.query(
      `SELECT r.seq,r.details,p.id AS provider_call_id,p.status AS provider_status FROM runtime_receipts r JOIN runtime_owner_stage_turns t ON t.job_id=r.job_id AND t.agent_id=r.agent_id JOIN provider_calls p ON p.id::text=r.details->>'callId' AND p.job_id=t.job_id AND p.agent_id=t.agent_id AND p.fence=t.fence WHERE r.type='provider_diagnostic' AND r.agent_id=$1 AND t.stage_id=$2 AND t.league_id=$3 AND r.details->>'kind'='owner_server_web_search' AND jsonb_typeof(r.details->'count')='number' AND (r.details->>'count')::numeric>0 AND jsonb_typeof(r.details->'citations')='array' AND jsonb_array_length(r.details->'citations')>0 AND p.status='verified' AND p.cost_micros IS NOT NULL ORDER BY r.seq DESC LIMIT 100`,
      [agentId, row.id, row.league_id],
    )
  ).rows;
  const paid = (
    await db.query(
      `SELECT p.id,p.kind,p.result,p.response_hash,p.credits_used,p.actual_micros,p.completed_at,r.url,r.details FROM research_paid_operations p JOIN runtime_owner_stage_turns t ON t.job_id=p.job_id AND t.agent_id=p.agent_id AND t.fence=p.fence AND t.league_id=p.league_id JOIN research_receipts r ON r.id=p.id AND r.job_id=p.job_id AND r.agent_id=p.agent_id AND r.league_id=p.league_id WHERE p.agent_id=$1 AND t.stage_id=$2 AND t.league_id=$3 AND p.status='completed' AND p.actual_micros IS NOT NULL AND p.credits_used IS NOT NULL AND p.response_hash IS NOT NULL AND p.result->>'status'='retrieved' AND p.result->>'provider'='firecrawl' AND p.result->'synthetic'=$4::jsonb AND r.status='completed' AND r.source_id='firecrawl' AND r.details->>'paidOperationId'=p.id::text AND r.details->>'responseHash'=p.response_hash AND r.details->>'requestHash'=p.request_hash AND r.tool=CASE WHEN p.kind='search' THEN 'research_search' ELSE 'research_retrieve' END ORDER BY p.completed_at DESC LIMIT 100`,
      [agentId, row.id, row.league_id, JSON.stringify(config.synthetic)],
    )
  ).rows;
  const publicUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
      const u = new URL(value);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  };
  const searches = [
    ...paid
      .filter(
        (p) =>
          p.kind === "search" &&
          Array.isArray(p.result.results) &&
          p.result.results.some((r: any) => publicUrl(r.url)),
      )
      .map((p) => ({
        source: "firecrawl",
        receiptId: p.id,
        completedAt: p.completed_at,
        details: {
          citations: p.result.results.filter((r: any) => publicUrl(r.url)),
        },
        creditsUsed: p.credits_used,
        actualMicros: p.actual_micros,
      })),
    ...legacySearches
      .filter((p) => p.details.citations.some((c: any) => publicUrl(c.url)))
      .map((p) => ({ ...p, source: "openrouter-server-search" })),
  ];
  const legacyPages = (
    await db.query(
      "SELECT r.id,r.url,r.status,r.details,r.completed_at FROM research_receipts r JOIN runtime_owner_stage_turns t ON t.job_id=r.job_id AND t.agent_id=r.agent_id AND t.league_id=r.league_id JOIN runtime_jobs j ON j.id=t.job_id AND j.fence=t.fence WHERE r.agent_id=$1 AND t.stage_id=$2 AND t.league_id=$3 AND r.source_id IS DISTINCT FROM 'firecrawl' AND r.tool='research_retrieve' AND r.status IN ('retrieved','cached') AND r.created_at>=t.created_at ORDER BY r.completed_at DESC LIMIT 100",
      [agentId, row.id, row.league_id],
    )
  ).rows.filter((p) => publicUrl(p.url));
  const pages = [
    ...paid
      .filter(
        (p) =>
          p.kind === "scrape" &&
          publicUrl(p.url) &&
          Array.isArray(p.result.results) &&
          p.result.results.some(
            (r: any) =>
              r.url === p.url &&
              typeof r.excerpt === "string" &&
              r.excerpt.trim().length > 0 &&
              typeof r.contentHash === "string" &&
              /^[a-f0-9]{64}$/.test(r.contentHash),
          ),
      )
      .map((p) => ({
        source: "firecrawl",
        id: p.id,
        url: p.url,
        status: "retrieved",
        completed_at: p.completed_at,
        details: p.details,
      })),
    ...legacyPages,
  ];
  const match = searches
    .map((search) => ({
      search,
      page: pages.find((page) =>
        search.details.citations.some((c: any) => c.url === page.url),
      ),
    }))
    .find((pair) => pair.page);
  const search = match?.search ?? searches[0],
    page = match?.page ?? pages[0];
  const researchBaseline = {
    status: match ? "verified" : "incomplete",
    search: search ?? null,
    page: page ?? null,
    pageMatchesSearchCitation: !!match,
    operatorReviewRequired: !match,
    note: "Search needs verified owner/stage/fence evidence and public result URLs; a successful page-read receipt must match one result. Firecrawl also requires its settled operation, matching receipt hashes and observed credits. Missing baseline remains a capability gap; unknown billing stays unresolved.",
  };
  return researchBaseline;
}

export class OwnerStageRuntime {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
  ) {}
  async configure(actor: Actor, input: unknown) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    const config = OwnerStageConfigSchema.parse(input);
    const [charter, assignmentDocument] = await Promise.all([
      readFile(new URL("../../docs/OWNER_CHARTER.md", import.meta.url), "utf8"),
      readFile(
        new URL("../../docs/OWNER_ONBOARDING_ASSIGNMENT.md", import.meta.url),
        "utf8",
      ),
    ]);
    const assignment = assignmentDocument
      .split(
        "## Operator-only qualification plan — not owner instructions to execute tests",
      )[0]!
      .trim();
    check(
      charter.length < 30000 && assignment.length < 30000,
      "OWNER_STAGE_CHARTER_TOO_LARGE",
    );
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const old = (
        await tx.query(
          "SELECT * FROM runtime_owner_stages WHERE league_id=$1 AND id=$2",
          [actor.leagueId, config.stageId],
        )
      ).rows[0];
      const hash = fingerprint({ config, charter, assignment });
      if (old) {
        check(old.content_hash === hash, "OWNER_STAGE_CONFIG_CONFLICT");
        return old;
      }
      const now = (await tx.query("SELECT clock_timestamp() AS now")).rows[0]
        .now;
      check(
        new Date(config.initiativeDeadline) > now &&
          new Date(config.followupDeadline) >
            new Date(config.initiativeDeadline),
        "OWNER_STAGE_DEADLINES_INVALID",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_conventions WHERE league_id=$1 AND status='active'",
            [actor.leagueId],
          )
        ).rowCount,
        "OWNER_STAGE_CONVENTION_STILL_ACTIVE",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' UNION ALL SELECT 1 FROM runtime_franchise_outbox WHERE league_id=$1 AND status='running' UNION ALL SELECT 1 FROM runtime_football_outbox WHERE league_id=$1 AND status='running'",
            [actor.leagueId],
          )
        ).rowCount,
        "OWNER_STAGE_WORK_IN_FLIGHT",
      );
      const preservedJobs = (
        await tx.query(
          "SELECT j.id,j.status,j.kind,j.causal_id,j.payload FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.execution_mode='owner' AND j.status='pending' FOR UPDATE OF j",
          [actor.leagueId],
        )
      ).rows;
      if (preservedJobs.length) {
        await tx.query(
          "UPDATE runtime_jobs SET status='cancelled',error='OWNER_STAGE_PREVIOUS_JOB_PRESERVED',completed_at=clock_timestamp() WHERE id=ANY($1::uuid[])",
          [preservedJobs.map((j) => j.id)],
        );
        await tx.query(
          "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.previous_jobs_preserved',$1)",
          [
            {
              leagueId: actor.leagueId,
              stageId: config.stageId,
              actorId: actor.id,
              jobs: preservedJobs.map((j) => ({
                id: j.id,
                previousStatus: j.status,
                kind: j.kind,
                causalId: j.causal_id,
                payloadHash: fingerprint(j.payload),
              })),
            },
          ],
        );
      }
      const receiptId = randomUUID();
      const row = (
        await tx.query(
          "INSERT INTO runtime_owner_stages(league_id,id,stage,configuration,charter,assignment,content_hash,configured_by,receipt_id) VALUES($1,$2,'onboarding',$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            actor.leagueId,
            config.stageId,
            config,
            charter,
            assignment,
            hash,
            actor.id,
            receiptId,
          ],
        )
      ).rows[0];
      // Existing work is preserved for explicit review, never silently executed under the new assignment.
      await tx.query(
        "UPDATE runtime_franchise_outbox SET status='held',error='OWNER_STAGE_PREVIOUS_INTENT_HELD' WHERE league_id=$1 AND status='pending'",
        [actor.leagueId],
      );
      await tx.query(
        "UPDATE runtime_football_outbox SET status='held',error='OWNER_STAGE_PREVIOUS_INTENT_HELD' WHERE league_id=$1 AND status='pending'",
        [actor.leagueId],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.configured',$1)",
        [
          {
            leagueId: actor.leagueId,
            stageId: row.id,
            receiptId,
            contentHash: hash,
            policyReceiptId: config.policyReceiptId,
            actorId: actor.id,
            synthetic: config.synthetic,
          },
        ],
      );
      return row;
    });
  }
  async wakeOwner(actor: Actor, agentId: string) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    return transaction(this.db, async (tx) => {
      const row = await active(tx, agentId);
      check(row && row.league_id === actor.leagueId, "OWNER_STAGE_SCOPE");
      return this.runtime.ingestEventTx(tx, {
        agentId,
        priority: "urgent",
        causalId: "owner-stage:" + row.id + ":initial",
        payload: {
          kind: "owner.onboarding",
          stageId: row.id,
          stageReceiptId: row.receipt_id,
          instruction:
            "Read your durable ownerStage charter and assignment. Review your existing brand; keep or revise it explicitly. Complete only onboarding outputs. No governance, football, native queue changes or public publication.",
        },
      });
    });
  }
  async amendOperationalAllowance(
    actor: Actor,
    input: {
      stageId: string;
      idempotencyKey: string;
      maxTurns?: number;
      addReadTools?: Array<"mfl_read">;
      reason: string;
    },
  ) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    const request = z
      .object({
        stageId: Identifier,
        idempotencyKey: Identifier,
        maxTurns: z.number().int().min(2).max(16).optional(),
        addReadTools: z.array(z.literal("mfl_read")).max(1).default([]),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7044,hashtext($1))", [
        actor.leagueId,
      ]);
      const row = (
        await tx.query(
          "SELECT * FROM runtime_owner_stages WHERE league_id=$1 AND id=$2 FOR UPDATE",
          [actor.leagueId, request.stageId],
        )
      ).rows[0];
      check(
        row && ["active", "paused"].includes(row.status),
        "OWNER_STAGE_SCOPE",
      );
      const original = OwnerStageConfigSchema.parse(row.configuration);
      const history = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.allowance_amended' AND details->>'leagueId'=$1 AND details->>'stageId'=$2 ORDER BY seq DESC",
          [actor.leagueId, request.stageId],
        )
      ).rows.map((r) => r.details);
      const requestHash = fingerprint(request),
        replay = history.find(
          (r) => r.idempotencyKey === request.idempotencyKey,
        );
      if (replay) {
        check(
          replay.requestHash === requestHash,
          "OWNER_STAGE_ALLOWANCE_CONFLICT",
        );
        return { ...replay, replayed: true };
      }
      const oldAllowance = history[0]?.newAllowance ?? {
        maxTurns: original.limits.maxTurns,
        additionalReadTools: [],
      };
      const newAllowance = {
        maxTurns: request.maxTurns ?? oldAllowance.maxTurns,
        additionalReadTools: [
          ...new Set<string>([
            ...oldAllowance.additionalReadTools,
            ...request.addReadTools,
          ]),
        ],
      };
      check(
        newAllowance.maxTurns >= oldAllowance.maxTurns,
        "OWNER_STAGE_ALLOWANCE_REDUCTION",
      );
      check(
        newAllowance.maxTurns !== oldAllowance.maxTurns ||
          newAllowance.additionalReadTools.length !==
            oldAllowance.additionalReadTools.length,
        "OWNER_STAGE_ALLOWANCE_UNCHANGED",
      );
      const details = {
        receiptId: randomUUID(),
        leagueId: actor.leagueId,
        stageId: request.stageId,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        oldAllowance,
        newAllowance,
        previousReceiptId: history[0]?.receiptId ?? null,
        originalContentHash: row.content_hash,
        maxSpendMicros: original.limits.maxSpendMicros,
        maxReservationMicros: original.limits.maxReservationMicros,
        allowedActions: original.allowedActions,
        reason: request.reason,
        reviewedBy: actor.id,
        automaticWake: false,
        manifestPermissionsRemainCeiling: true,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.allowance_amended',$1)",
        [details],
      );
      return { ...details, replayed: false };
    });
  }
  async extendDeadlines(
    actor: Actor,
    input: {
      stageId: string;
      idempotencyKey: string;
      followupDeadline: string;
      initiativeDeadline?: string;
      reason: string;
    },
  ) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    const request = z
      .object({
        stageId: Identifier,
        idempotencyKey: Identifier,
        followupDeadline: z.iso.datetime({ offset: true }),
        initiativeDeadline: z.iso.datetime({ offset: true }).optional(),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7044,hashtext($1))", [
        actor.leagueId,
      ]);
      const row = (
        await tx.query(
          "SELECT * FROM runtime_owner_stages WHERE league_id=$1 AND id=$2 FOR UPDATE",
          [actor.leagueId, request.stageId],
        )
      ).rows[0];
      check(
        row && ["active", "paused"].includes(row.status),
        "OWNER_STAGE_SCOPE",
      );
      const history = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.deadlines_extended' AND details->>'leagueId'=$1 AND details->>'stageId'=$2 ORDER BY seq DESC",
          [actor.leagueId, request.stageId],
        )
      ).rows.map((r) => r.details);
      const hash = fingerprint(request),
        replay = history.find(
          (r) => r.idempotencyKey === request.idempotencyKey,
        );
      if (replay) {
        check(replay.requestHash === hash, "OWNER_STAGE_DEADLINE_CONFLICT");
        return { ...replay, replayed: true };
      }
      row.deadline_extension = history[0];
      const previous = stageDeadlines(row);
      const next = {
        initiative: request.initiativeDeadline ?? previous.effective.initiative,
        followup: request.followupDeadline,
      };
      const now = (await tx.query("SELECT clock_timestamp() AS now")).rows[0]
        .now;
      check(
        new Date(next.initiative) >= new Date(previous.effective.initiative) &&
          new Date(next.followup) >= new Date(previous.effective.followup),
        "OWNER_STAGE_DEADLINE_SHORTENING",
      );
      check(
        new Date(next.followup) > now &&
          new Date(next.followup) > new Date(next.initiative),
        "OWNER_STAGE_DEADLINE_ORDER",
      );
      check(
        new Date(next.initiative) > new Date(previous.effective.initiative) ||
          new Date(next.followup) > new Date(previous.effective.followup),
        "OWNER_STAGE_DEADLINE_UNCHANGED",
      );
      const details = {
        receiptId: randomUUID(),
        leagueId: actor.leagueId,
        stageId: request.stageId,
        idempotencyKey: request.idempotencyKey,
        requestHash: hash,
        originalDeadlines: previous.original,
        oldDeadlines: previous.effective,
        newDeadlines: next,
        previousReceiptId: previous.extensionReceiptId,
        reason: request.reason,
        reviewedBy: actor.id,
        originalContentHash: row.content_hash,
        stageStatus: row.status,
        automaticWake: false,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.deadlines_extended',$1)",
        [details],
      );
      return { ...details, replayed: false };
    });
  }
  /** A reviewed incident may allow new work; its full unresolved cost remains held. */
  async reviewCostHold(
    actor: Actor,
    input: {
      agentId: string;
      reservationId: string;
      reason: string;
      evidenceRef: string;
    },
  ) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    const request = z
      .object({
        agentId: Identifier,
        reservationId: z.uuid(),
        reason: z.string().trim().min(10).max(4000),
        evidenceRef: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7044,hashtext($1))", [
        actor.leagueId,
      ]);
      await tx.query("SELECT id FROM runtime_agents WHERE id=$1 FOR UPDATE", [
        request.agentId,
      ]);
      const row = await active(tx, request.agentId);
      check(row && row.league_id === actor.leagueId, "OWNER_STAGE_SCOPE");
      const reservation = (
        await tx.query(
          "SELECT r.*,j.status AS job_status,j.fence AS job_fence FROM runtime_reservations r JOIN runtime_jobs j ON j.id=r.job_id JOIN runtime_owner_stage_turns t ON t.job_id=r.job_id AND t.fence=r.fence AND t.agent_id=r.agent_id WHERE r.id=$1 AND r.agent_id=$2 AND t.league_id=$3 AND t.stage_id=$4 FOR UPDATE OF r,j",
          [request.reservationId, request.agentId, row.league_id, row.id],
        )
      ).rows[0];
      check(
        reservation && reservation.status === "uncertain",
        "OWNER_STAGE_UNCERTAIN_RESERVATION_REQUIRED",
      );
      check(
        reservation.job_status === "dead" &&
          reservation.job_fence === reservation.fence,
        "OWNER_STAGE_DEAD_FENCE_REQUIRED",
      );
      const requestHash = fingerprint(request);
      const old = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.cost_hold_reviewed' AND agent_id=$1 AND job_id=$2 AND details->>'reservationId'=$3 AND details->>'stageId'=$4 AND details->>'leagueId'=$5 ORDER BY seq DESC LIMIT 1",
          [
            request.agentId,
            reservation.job_id,
            reservation.id,
            row.id,
            row.league_id,
          ],
        )
      ).rows[0]?.details;
      if (old) {
        check(
          old.requestHash === requestHash,
          "OWNER_STAGE_COST_REVIEW_CONFLICT",
        );
        return { ...old, replayed: true };
      }
      const details = {
        receiptId: randomUUID(),
        leagueId: row.league_id,
        stageId: row.id,
        agentId: request.agentId,
        reservationId: reservation.id,
        jobId: reservation.job_id,
        fence: reservation.fence,
        heldMicros: Number(reservation.amount_micros),
        observedMicros:
          reservation.observed_micros === null
            ? null
            : Number(reservation.observed_micros),
        reviewedBy: actor.id,
        reason: request.reason,
        evidenceRef: request.evidenceRef,
        requestHash,
        disposition: "permit-new-work-with-full-cost-hold",
        reservationStatus: "uncertain",
        reconciled: false,
        automaticWake: false,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.cost_hold_reviewed',$1,$2,$3)",
        [request.agentId, reservation.job_id, details],
      );
      return { ...details, replayed: false };
    });
  }
  async mayInfer(agentId: string, amountMicros?: number) {
    const row = await active(this.db, agentId);
    if (!row) return true;
    if (row.status !== "active") return false;
    if (
      (
        await this.db.query(
          "SELECT 1 FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
          [row.league_id, row.id, agentId],
        )
      ).rowCount
    )
      return false;
    const config = effectiveStageConfig(row),
      used = await usage(this.db, row, agentId);
    return (
      !(await pending(this.db, row, agentId)).length &&
      !used.unreviewed_costs &&
      used.turns < config.limits.maxTurns &&
      Number(used.committed_micros) +
        (amountMicros ?? config.limits.maxReservationMicros) <=
        config.limits.maxSpendMicros
    );
  }
  async context(agentId: string) {
    const row = await active(this.db, agentId);
    if (!row) return { stage: "not-configured" as const };
    const config = OwnerStageConfigSchema.parse(row.configuration);
    check(
      fingerprint({
        config,
        charter: row.charter,
        assignment: row.assignment,
      }) === row.content_hash,
      "OWNER_STAGE_CHARTER_CHANGED",
    );
    const effective = effectiveStageConfig(row);
    const researchBaseline = await researchQualification(this.db, row, agentId);
    const search = researchBaseline.search,
      page = researchBaseline.page;
    const paidEvidence = (
      await this.db.query(
        "SELECT id,credits_used,actual_micros,completed_at FROM research_paid_operations WHERE agent_id=$1 AND league_id=$2 AND id=ANY($3::uuid[]) AND status='completed'",
        [
          agentId,
          row.league_id,
          [
            search?.receiptId,
            page?.source === "firecrawl" ? page.id : null,
          ].filter(Boolean),
        ],
      )
    ).rows;
    const searchPaid = paidEvidence.find((r) => r.id === search?.receiptId),
      pagePaid = paidEvidence.find((r) => r.id === page?.id);
    const researchQualificationSummary = {
      status: researchBaseline.status,
      pageMatchesSearchCitation: researchBaseline.pageMatchesSearchCitation,
      search: search
        ? {
            source: search.source,
            receiptId: search.receiptId ?? search.provider_call_id ?? null,
            completedAt: searchPaid?.completed_at ?? search.completedAt ?? null,
            urls: (search.details?.citations ?? [])
              .slice(0, 3)
              .map((c: any) => String(c.url).slice(0, 2000)),
            creditsUsed: searchPaid?.credits_used ?? null,
            allocatedCostMicros: searchPaid?.actual_micros ?? null,
          }
        : null,
      page: page
        ? {
            source: page.source ?? "public-page-reader",
            receiptId: page.id,
            completedAt: pagePaid?.completed_at ?? page.completed_at ?? null,
            url: String(page.url).slice(0, 2000),
            creditsUsed: pagePaid?.credits_used ?? null,
            allocatedCostMicros: pagePaid?.actual_micros ?? null,
          }
        : null,
      instruction:
        "These are your own current-stage database-verified research receipts, including work completed in turns that later failed. Older memory or Buzz posts saying SEARCH_NOT_CONFIGURED are historical when superseded by these receipts. Do not repeat paid search merely to re-prove access. Receipt completion times are authoritative; content freshness still depends on its source. Shared search credits are a paid internal allocation, not free resources; unknown credit/cost values remain null.",
    };
    const followupRetest = await followupRetestAuthorization(
      this.db,
      row.league_id,
      row.id,
      agentId,
    );
    const peers = (
      await this.db.query(
        "SELECT b.agent_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.league_id=$1 AND t.kind='ai' ORDER BY b.agent_id",
        [row.league_id],
      )
    ).rows.map((r) => r.agent_id as string);
    const assignedPeerAgentId =
      peers.length > 1
        ? peers[(peers.indexOf(agentId) + 1) % peers.length]
        : null;
    const introDisposition = await ownerStageIntroDisposition(this.db, {
      leagueId: row.league_id,
      stageId: row.id,
      agentId,
      defaultCausalId: `onboarding:${row.id}:intro`,
    });
    const [appointments, introductions] = await Promise.all([
      this.db.query(
        "SELECT j.id,j.status,j.causal_id,j.due_at,j.payload,j.completed_at,j.error FROM runtime_receipts r JOIN runtime_jobs j ON j.id=(r.details->>'appointmentId')::uuid WHERE r.type='owner_stage.schedule_authored' AND r.agent_id=$1 AND r.details->>'stageId'=$2 AND j.status<>'cancelled' ORDER BY r.seq DESC LIMIT 1",
        [agentId, row.id],
      ),
      this.db.query(
        "SELECT id,status,action,service_receipt,error FROM runtime_franchise_outbox WHERE agent_id=$1 AND league_id=$2 AND action->>'type'='buzz_channel' AND causal_id=$3 ORDER BY created_at DESC LIMIT 1",
        [agentId, row.league_id, introDisposition.causalId],
      ),
    ]);
    return {
      stage: "onboarding" as const,
      synthetic: config.synthetic,
      followupRetest,
      researchQualification: researchQualificationSummary,
      assignedPeerAgentId,
      capabilityAvailability: effective.readTools.map((name) => ({
        name,
        status: "permitted-not-yet-proven-callable",
        instruction:
          "Record actual successful source/receipt or explicit failure; schema exposure alone does not prove access.",
      })),
      stageId: row.id,
      status: row.status,
      receiptId: row.receipt_id,
      contentHash: row.content_hash,
      policyReceiptId: config.policyReceiptId,
      configuredBy: row.configured_by,
      configuredAt: row.configured_at,
      charter: row.charter,
      assignment: row.assignment,
      allowedActions: config.allowedActions,
      readTools: effective.readTools,
      activePermissions:
        row.status === "active"
          ? [...config.allowedActions, ...effective.readTools]
          : [],
      limits: effective.limits,
      operationalAllowance: {
        originalMaxTurns: config.limits.maxTurns,
        amendment: row.operational_extension ?? null,
        budgetUnchanged: true,
        actionPermissionsUnchanged: true,
      },
      usage: await usage(this.db, row, agentId),
      deadlines: stageDeadlines(row).effective,
      deadlineHistory: stageDeadlines(row),
      assignedModel: row.model,
      harness: "black4-owner-loop",
      wallet: {
        seasonAllocationMicros: 600_000_000,
        initialUpstreamAllocationMicros: 40_000_000,
        actualBudgetMicros: Number(row.budget_micros),
        actualSpentMicros: Number(row.spent_micros),
        actualReservedMicros: Number(row.reserved_micros),
        instruction:
          "Approved allocations are not remaining provider balances. Research/subscription proposals must fit the same business economics; no new account spend is authorized by this text.",
      },
      introChannelId: config.introChannelId,
      introCausalId: introDisposition.causalId,
      introDisposition,
      existingWork: {
        followup: appointments.rows[0] ?? null,
        introduction: introductions.rows[0] ?? null,
        instruction:
          "If followup exists, inspect its status before scheduling: pending/running means await or perform it. Completed appointments normally occupy the slot. Only an explicit followupRetest receipt permits one NEW owner-chosen appointment after the named completed attempt that the operator reviewed as unsuccessful; preserve the old attempt and do not call it successful. A dead first followup may be replaced under the existing limit. A dead retest cannot be repeated unless followupRetest.failedRetestReplacement explicitly names it; that additional receipt permits only one fresh owner-chosen replacement, preserving every failed attempt and cost. The replacement appointment itself must emit remember owner/onboarding-followup after doing useful work; a later retrospective note cannot qualify. If introduction exists, its causalId and content are immutable: do not emit another introduction or reuse that key with different text. Read its receipt/archive; use a fresh causalId only for a genuinely new peer response. Accepted sends require canonical observation.",
      },
      requiredMemoryKeys: [
        "owner_operating_packet_v1",
        "owner_capability_needs_v1",
        "owner/memory-probe",
        "owner/memory-readback",
        "owner/onboarding-followup",
      ],
      memoryReadPath:
        "Every fresh worker Job.memory is loaded from runtime_memory WHERE agent_id=this franchise. First write owner/memory-probe with your own unique phrase; a subsequent fresh job must read it and remember owner/memory-readback JSON {key:'owner/memory-probe',value:the exact observed value,sourceVersion:the observed version,usedFor:the concrete decision/action informed by restored memory}. Same-turn claims cannot satisfy this test.",
      peerCheck:
        "Mention assignedPeerAgentId in your introduction, receive/read a real other-owner message through buzz_read or native inbox, and respond with buzz_channel.replyTo set to that observed event ID. Never fabricate another owner's message. Do not broadcast to all owners.",
      instruction:
        "Current stage overrides old pending job descriptions. Save owner_operating_packet_v1 with your own brand keep/revise decision, operating plan, budget/research choices and commissioner-policy acknowledgment. Intro must use the listed channel and introCausalId. Schedule one useful future appointment payload {kind:onboarding.followup,stageId,task}, after this turn began and by the effective followup deadline; if its requested time passes during generation it becomes immediately eligible with lateness recorded; complete it and save owner/onboarding-followup evidence. Read actual receipts rather than repeating actions. Governance/football are blocked; Chris has no proxy; public batches require human approval. No automatic stage transition.",
    };
  }
  async checkpoint(actor: Actor) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    const rows = (
      await this.db.query(
        "SELECT b.agent_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.league_id=$1 AND t.kind='ai' ORDER BY b.agent_id",
        [actor.leagueId],
      )
    ).rows;
    return Promise.all(rows.map((r) => this.evidence(r.agent_id)));
  }
  private async evidence(agentId: string, db: Pick<Db, "query"> = this.db) {
    const row = await active(db, agentId);
    check(row, "OWNER_STAGE_NOT_ACTIVE");
    const config = OwnerStageConfigSchema.parse(row.configuration);
    const brand = (
      await db.query(
        "SELECT v.*,r.actor_id,r.agent_id FROM franchise_brand_versions v JOIN franchise_receipts r ON r.id=v.receipt_id WHERE v.league_id=$1 AND v.team_id=$2 ORDER BY v.version DESC LIMIT 1",
        [row.league_id, row.team_id],
      )
    ).rows[0];
    const brandValid =
      brand &&
      brand.actor_id === row.owner_id &&
      brand.agent_id === agentId &&
      fingerprint(brand.payload) === brand.content_hash;
    const packet = (
      await db.query(
        "SELECT content,version,updated_at FROM runtime_memory WHERE agent_id=$1 AND key='owner_operating_packet_v1' AND updated_at>=$2",
        [agentId, row.configured_at],
      )
    ).rows[0];
    const turns = (
      await db.query(
        "SELECT j.id,j.kind,j.completed_at FROM runtime_owner_stage_turns t JOIN runtime_jobs j ON j.id=t.job_id WHERE t.agent_id=$1 AND t.stage_id=$2 AND t.league_id=$3 AND j.status='completed' ORDER BY j.completed_at",
        [agentId, row.id, row.league_id],
      )
    ).rows;
    const introDisposition = await ownerStageIntroDisposition(db, {
      leagueId: row.league_id,
      stageId: row.id,
      agentId,
      defaultCausalId: `onboarding:${row.id}:intro`,
    });
    let intro = (
      await db.query(
        `SELECT o.id AS outbox_id,o.service_receipt,e.event_id,e.content,e.observed_at,e.sequence FROM runtime_franchise_outbox o JOIN runtime_owner_stage_turns t ON t.job_id=o.job_id AND t.fence=o.origin_fence JOIN buzz_archive_events e ON e.league_id=o.league_id AND e.event_id=o.service_receipt->'result'->>'eventId' JOIN buzz_participants p ON p.league_id=e.league_id AND p.pubkey=e.author_pubkey WHERE o.agent_id=$1 AND t.stage_id=$2 AND o.league_id=$3 AND o.action->>'type'='buzz_channel' AND o.action->>'causalId'=$4 AND o.action->>'channelId'=$5 AND o.status='delivered' AND e.channel_id=$5::uuid AND p.agent_id=$1 AND p.owner_id=$6 ORDER BY e.sequence DESC LIMIT 1`,
        [
          agentId,
          row.id,
          row.league_id,
          introDisposition.causalId,
          config.introChannelId,
          row.owner_id,
        ],
      )
    ).rows[0];
    if (intro && introDisposition.receiptId) {
      try {
        await assertOwnerStageIntroReplacement(db, {
          leagueId: row.league_id,
          stageId: row.id,
          agentId,
          action: {
            causalId: introDisposition.causalId,
            channelId: config.introChannelId,
            content: intro.content,
          },
        });
      } catch {
        intro = undefined;
      }
    }
    const followupHistory = (
      await db.query(
        "SELECT j.id,j.status,j.payload,j.due_at,j.claimed_at,j.completed_at FROM runtime_receipts r JOIN runtime_jobs j ON j.id=(r.details->>'appointmentId')::uuid WHERE r.type='owner_stage.schedule_authored' AND r.agent_id=$1 AND r.details->>'stageId'=$2 ORDER BY r.seq DESC",
        [agentId, row.id],
      )
    ).rows;
    const followup = followupHistory[0];
    const followupProof = await followupCompletionEvidence(
      db,
      row.league_id,
      row.id,
      agentId,
      followup?.id,
    );
    const followupNote = followupProof.note;
    const memoryProof = (
      await db.query(
        "SELECT r.seq,r.job_id,r.details FROM runtime_receipts r JOIN runtime_jobs j ON j.id=r.job_id WHERE r.type='owner_stage.memory_roundtrip' AND r.agent_id=$1 AND r.details->>'stageId'=$2 AND j.status='completed' ORDER BY r.seq DESC LIMIT 1",
        [agentId, row.id],
      )
    ).rows[0];
    const needs = (
      await db.query(
        "SELECT content,version,updated_at FROM runtime_memory WHERE agent_id=$1 AND key='owner_capability_needs_v1' AND updated_at>=$2",
        [agentId, row.configured_at],
      )
    ).rows[0];
    const exchange = (
      await db.query(
        `SELECT o.id AS response_outbox_id,e.event_id AS response_event_id,e.content AS response_content,peer.event_id AS received_event_id,peer.content AS received_content,p.agent_id AS peer_agent_id FROM runtime_franchise_outbox o JOIN runtime_owner_stage_turns t ON t.job_id=o.job_id AND t.fence=o.origin_fence JOIN buzz_archive_events e ON e.league_id=o.league_id AND e.event_id=o.service_receipt->'result'->>'eventId' JOIN buzz_archive_events peer ON peer.league_id=o.league_id AND peer.event_id=o.action->>'replyTo' AND peer.channel_id=e.channel_id JOIN buzz_participants p ON p.league_id=peer.league_id AND p.pubkey=peer.author_pubkey JOIN buzz_participants own ON own.league_id=e.league_id AND own.pubkey=e.author_pubkey WHERE o.agent_id=$1 AND t.stage_id=$2 AND o.league_id=$3 AND o.action->>'type'='buzz_channel' AND o.status='delivered' AND e.channel_id=$4::uuid AND own.agent_id=$1 AND p.agent_id IS NOT NULL AND p.agent_id<>$1 AND peer.observed_at>=$5 ORDER BY e.sequence DESC LIMIT 1`,
        [
          agentId,
          row.id,
          row.league_id,
          config.introChannelId,
          row.configured_at,
        ],
      )
    ).rows[0];
    const researchBaseline = await researchQualification(db, row, agentId);
    const review = (
      await db.query(
        "SELECT receipt_id,reviewed_by,reviewed_at,evidence_hash FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
        [row.league_id, row.id, agentId],
      )
    ).rows[0];
    const costUnknown = (
      await db.query(
        `SELECT r.id AS reservation_id,r.job_id,r.fence,r.amount_micros,r.observed_micros,r.status,v.details AS review FROM runtime_reservations r JOIN runtime_owner_stage_turns t ON t.job_id=r.job_id AND t.fence=r.fence AND t.agent_id=r.agent_id LEFT JOIN LATERAL(SELECT details FROM runtime_receipts v WHERE v.type='owner_stage.cost_hold_reviewed' AND v.agent_id=r.agent_id AND v.job_id=r.job_id AND v.details->>'reservationId'=r.id::text AND v.details->>'fence'=r.fence::text AND v.details->>'leagueId'=t.league_id AND v.details->>'stageId'=t.stage_id ORDER BY v.seq DESC LIMIT 1)v ON true WHERE t.agent_id=$1 AND t.stage_id=$2 AND t.league_id=$3 AND r.status='uncertain'`,
        [agentId, row.id, row.league_id],
      )
    ).rows;
    const used = await usage(db, row, agentId),
      outbox = await pending(db, row, agentId),
      missing: string[] = [];
    if (!brandValid) missing.push("verified-own-brand");
    if (!packet) missing.push("owner-operating-packet");
    if (!turns.length) missing.push("completed-owner-stage-turn");
    if (!intro) missing.push("canonical-buzz-introduction");
    if (!memoryProof) missing.push("fresh-job-private-memory-readback");
    if (
      !memoryProof?.details.usedFor ||
      !memoryProof?.details.packetSourceVersion
    )
      missing.push("use-of-restored-operating-memory");
    if (!exchange) missing.push("authenticated-buzz-receive-and-response");
    if (!needs) missing.push("structured-capability-needs-review");
    if (
      followup?.status !== "completed" ||
      !followupNote ||
      !followup.claimed_at ||
      followupNote.updated_at < followup.claimed_at
    )
      missing.push("completed-useful-followup");
    if (used.unreviewed_costs) missing.push("stage-cost-reconciliation");
    if (outbox.length) missing.push("stage-action-outcomes");
    return {
      agentId,
      leagueId: row.league_id,
      stageId: row.id,
      status: missing.length
        ? "incomplete"
        : review
          ? "reviewed-awaiting-next-assignment"
          : "ready-for-review",
      review: review ?? null,
      researchBaseline,
      followupProvenance: followupProof.provenance,
      advisories: [
        ...(researchBaseline.status === "incomplete"
          ? ["Research baseline needs operator disposition before convention"]
          : []),
        ...(introDisposition.receiptId
          ? [
              "An earlier introduction remains unconfirmed; only the separately authorized replacement can satisfy canonical introduction evidence",
            ]
          : []),
        ...(used.unresolved_costs > used.unreviewed_costs
          ? [
              "Commissioner-reviewed costs remain UNKNOWN and fully reserved; readiness review does not reconcile or waive them",
            ]
          : []),
      ],
      missing,
      evidence: {
        brand: brandValid
          ? {
              receiptId: brand.receipt_id,
              version: brand.version,
              payload: brand.payload,
            }
          : null,
        packet: packet ?? null,
        memoryProof: memoryProof ?? null,
        exchange: exchange ?? null,
        capabilityNeeds: needs ?? null,
        researchBaseline,
        ownerTurns: turns,
        intro: intro ?? null,
        introDisposition,
        followup: followup ?? null,
        followupHistory,
        followupNote: followupNote ?? null,
        usage: used,
        costUnknown,
        outbox,
      },
      humanReviewRequired: true,
    };
  }
  async reviewOwner(actor: Actor, input: { agentId: string; note: string }) {
    check(actor.role === "commissioner", "OWNER_STAGE_COMMISSIONER_REQUIRED");
    check(
      input.note.length >= 10 && input.note.length <= 4000,
      "OWNER_STAGE_REVIEW_NOTE_REQUIRED",
    );
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const bound = await active(tx, input.agentId);
      check(bound?.league_id === actor.leagueId, "OWNER_STAGE_SCOPE");
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [input.agentId],
          )
        ).rowCount,
        "OWNER_STAGE_REVIEW_WORK_IN_FLIGHT",
      );
      const evidence = await this.evidence(input.agentId, tx);
      check(!evidence.missing.length, "OWNER_STAGE_EVIDENCE_INCOMPLETE");
      const hash = fingerprint(evidence.evidence),
        old = (
          await tx.query(
            "SELECT * FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
            [actor.leagueId, evidence.stageId, input.agentId],
          )
        ).rows[0];
      if (old) {
        check(
          old.evidence_hash === hash,
          "OWNER_STAGE_REVIEW_EVIDENCE_CHANGED",
        );
        return old;
      }
      const receiptId = randomUUID();
      const row = (
        await tx.query(
          "INSERT INTO runtime_owner_stage_reviews(league_id,stage_id,agent_id,evidence_hash,evidence,note,reviewed_by,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            actor.leagueId,
            evidence.stageId,
            input.agentId,
            hash,
            evidence.evidence,
            input.note,
            actor.id,
            receiptId,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,details) VALUES('owner_stage.reviewed',$1,$2)",
        [
          input.agentId,
          {
            leagueId: actor.leagueId,
            stageId: evidence.stageId,
            receiptId,
            evidenceHash: hash,
            reviewedBy: actor.id,
          },
        ],
      );
      return row;
    });
  }
  async authorizeFollowupRetest(
    actor: Actor,
    input: Parameters<OwnerFollowupRecovery["authorizeFollowupRetest"]>[1],
  ) {
    return new OwnerFollowupRecovery(this.db).authorizeFollowupRetest(
      actor,
      input,
    );
  }
  async authorizeFailedFollowupRetestReplacement(
    actor: Actor,
    input: Parameters<
      OwnerFollowupRecovery["authorizeFailedFollowupRetestReplacement"]
    >[1],
  ) {
    return new OwnerFollowupRecovery(
      this.db,
    ).authorizeFailedFollowupRetestReplacement(actor, input);
  }
  async attestLegacyFollowup(
    actor: Actor,
    input: {
      agentId: string;
      appointmentId: string;
      reason: string;
      evidenceRef: string;
    },
  ) {
    return new OwnerFollowupRecovery(this.db).attestLegacyFollowup(
      actor,
      input,
    );
  }
  /** Explicit human gate. Closing onboarding never opens a meeting or casts a vote. */
  async closeReviewed(actor: Actor, input: { stageId: string; note: string }) {
    check(
      actor.role === "commissioner" && actor.leagueId,
      "OWNER_STAGE_COMMISSIONER_REQUIRED",
    );
    const request = z
      .object({
        stageId: Identifier,
        note: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(input);
    return transaction(this.db, async (tx) => {
      // Match claim's agent-before-league lock order, so no owner can begin or
      // commit another turn between qualification and the closing receipt.
      const owners = (
        await tx.query(
          "SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.league_id=$1 AND t.kind='ai' AND a.kind='ai' ORDER BY a.id FOR UPDATE OF a",
          [actor.leagueId],
        )
      ).rows;
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const row = (
        await tx.query(
          "SELECT * FROM runtime_owner_stages WHERE league_id=$1 AND id=$2 FOR UPDATE",
          [actor.leagueId, request.stageId],
        )
      ).rows[0];
      check(row, "OWNER_STAGE_SCOPE");
      const requestHash = fingerprint(request);
      const previous = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='owner_stage.closed' AND details->>'leagueId'=$1 AND details->>'stageId'=$2 ORDER BY seq DESC LIMIT 1",
          [actor.leagueId, request.stageId],
        )
      ).rows[0]?.details;
      if (previous) {
        check(
          row.status === "reviewed" && previous.requestHash === requestHash,
          "OWNER_STAGE_CLOSE_CONFLICT",
        );
        return { ...previous, replayed: true };
      }
      check(
        row.status === "active" || row.status === "paused",
        "OWNER_STAGE_NOT_ACTIVE",
      );
      check(owners.length === 10, "OWNER_STAGE_TEN_OWNERS_REQUIRED");
      const config = OwnerStageConfigSchema.parse(row.configuration);
      check(
        fingerprint({
          config,
          charter: row.charter,
          assignment: row.assignment,
        }) === row.content_hash,
        "OWNER_STAGE_CHARTER_CHANGED",
      );
      const reviews = (
        await tx.query(
          "SELECT * FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=ANY($3::text[]) ORDER BY agent_id",
          [actor.leagueId, request.stageId, owners.map((o) => o.id)],
        )
      ).rows;
      check(reviews.length === 10, "OWNER_STAGE_TEN_REVIEWS_REQUIRED");
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' LIMIT 1",
            [actor.leagueId],
          )
        ).rowCount,
        "OWNER_STAGE_CLOSE_WORK_IN_FLIGHT",
      );
      const evidenceReceipts: Record<string, unknown>[] = [];
      for (const owner of owners) {
        const evidence = await this.evidence(owner.id, tx);
        check(evidence.stageId === request.stageId, "OWNER_STAGE_SCOPE");
        check(!evidence.missing.length, "OWNER_STAGE_EVIDENCE_INCOMPLETE");
        check(
          evidence.researchBaseline.status === "verified",
          "OWNER_STAGE_RESEARCH_BASELINE_REQUIRED",
        );
        const review = reviews.find((r) => r.agent_id === owner.id)!;
        check(
          review.evidence_hash === fingerprint(evidence.evidence),
          "OWNER_STAGE_REVIEW_EVIDENCE_CHANGED",
        );
        evidenceReceipts.push({
          agentId: owner.id,
          reviewReceiptId: review.receipt_id,
          evidenceHash: review.evidence_hash,
          researchStatus: evidence.researchBaseline.status,
          preservedUncertainCosts: evidence.evidence.costUnknown,
          introDisposition: evidence.evidence.introDisposition,
        });
      }
      // Retired convention intents remain frozen. Exempt them only when the
      // exact old job/fence, stopped convention and onboarding hold audit agree.
      const outstanding = (
        await tx.query(
          `WITH candidates AS (
            SELECT 'franchise' AS source,o.id,o.agent_id,o.job_id,o.origin_fence,o.status,o.error,o.created_at FROM runtime_franchise_outbox o WHERE o.league_id=$1 AND (o.status IN ('pending','running') OR (o.status='held' AND NOT EXISTS(SELECT 1 FROM runtime_owner_intro_dispositions d WHERE d.league_id=$1 AND d.stage_id=$2 AND d.prior_outbox_id=o.id AND d.agent_id=o.agent_id)))
            UNION ALL SELECT 'football',o.id,o.agent_id,o.job_id,o.origin_fence,o.status,o.error,o.created_at FROM runtime_football_outbox o WHERE o.league_id=$1 AND o.status IN ('pending','running','held')
          ) SELECT o.id,o.source,t.meeting_id,
            (o.status='held' AND o.error='OWNER_STAGE_PREVIOUS_INTENT_HELD' AND o.created_at<$3 AND c.status='stopped'
             AND NOT EXISTS(SELECT 1 FROM runtime_owner_stage_turns current WHERE current.league_id=$1 AND current.stage_id=$2 AND current.job_id=o.job_id AND current.fence=o.origin_fence AND current.agent_id=o.agent_id)
             AND EXISTS(SELECT 1 FROM runtime_receipts r WHERE r.type='owner_stage.configured' AND r.details->>'leagueId'=$1 AND r.details->>'stageId'=$2 AND r.details->>'receiptId'=$4)) AS historical_hold_verified
            FROM candidates o LEFT JOIN runtime_convention_turns t ON t.league_id=$1 AND t.job_id=o.job_id AND t.fence=o.origin_fence AND t.agent_id=o.agent_id
            LEFT JOIN runtime_conventions c ON c.league_id=t.league_id AND c.meeting_id=t.meeting_id`,
          [actor.leagueId, request.stageId, row.configured_at, row.receipt_id],
        )
      ).rows;
      check(
        outstanding.every((o) => o.historical_hold_verified === true),
        "OWNER_STAGE_CLOSE_ACTIONS_OUTSTANDING",
      );
      const wakeups = (
        await tx.query(
          `SELECT j.id,j.agent_id,j.causal_id,j.payload FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='pending' AND j.execution_mode='owner' AND j.payload->>'stageId'=$2 AND (j.payload->>'kind'='owner.onboarding' OR j.payload->>'kind' LIKE 'owner.onboarding.%' OR j.payload->>'kind' LIKE 'onboarding.%') FOR UPDATE OF j`,
          [actor.leagueId, request.stageId],
        )
      ).rows;
      for (const wakeup of wakeups) {
        await tx.query(
          "UPDATE runtime_jobs SET status='cancelled',error='OWNER_STAGE_CLOSED' WHERE id=$1 AND status='pending'",
          [wakeup.id],
        );
        await tx.query(
          "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.wakeup_cancelled',$1,$2,$3)",
          [
            wakeup.agent_id,
            wakeup.id,
            {
              leagueId: actor.leagueId,
              stageId: request.stageId,
              causalId: wakeup.causal_id,
              payloadHash: fingerprint(wakeup.payload),
              cancelledBy: actor.id,
            },
          ],
        );
      }
      await tx.query(
        "UPDATE runtime_owner_stages SET status='reviewed' WHERE league_id=$1 AND id=$2",
        [actor.leagueId, request.stageId],
      );
      const receipt = {
        receiptId: randomUUID(),
        leagueId: actor.leagueId,
        stageId: request.stageId,
        requestHash,
        status: "reviewed",
        reviewedBy: actor.id,
        note: request.note,
        ownerReviews: evidenceReceipts,
        preservedHistoricalHeldIntents: outstanding.map((o) => ({
          outboxId: o.id,
          source: o.source,
          meetingId: o.meeting_id,
          status: "held",
          configuredReceiptId: row.receipt_id,
        })),
        cancelledOnboardingJobIds: wakeups.map((w) => w.id),
        conventionStarted: false,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.closed',$1)",
        [receipt],
      );
      return { ...receipt, replayed: false };
    });
  }
}
