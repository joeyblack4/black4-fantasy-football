import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { bindHost, hostBinding } from "../league/host.js";
import { fingerprint } from "../governance/validation.js";
import { MflMenuSchema } from "../governance/mfl-schema.js";
import { OwnerStageConfigSchema } from "./owner-stage.js";
import {
  RuntimeError,
  type RuntimeStore,
  type Job,
  type Action,
} from "./index.js";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const hashString = z.string().regex(/^[a-f0-9]{64}$/);
export const PreparedRehearsalDecisionSchema = z
  .object({
    decisionId: z.uuid(),
    proposalId: id,
    proposalHash: hashString,
    menuHash: hashString,
  })
  .strict();
export const RehearsalArmSchema = z
  .object({
    epoch: id,
    expectedHostVersion: z.number().int().positive(),
    trialConfigRef: id,
    capMicros: z.number().int().positive().max(20_000_000).default(5_000_000),
    synthetic: z.boolean().default(false),
    operatorEvidenceRef: z.string().min(8).max(2000),
    preparedDecision: PreparedRehearsalDecisionSchema.optional(),
    reason: z.string().min(10).max(2000),
  })
  .strict();
export const RehearsalCoveredCostHoldSchema = z
  .object({
    epoch: id,
    expectedHostVersion: z.number().int().positive(),
    agentId: id,
    manifestId: z.uuid(),
    jobId: z.uuid(),
    fence: z.number().int().positive(),
    callId: z.uuid(),
    reservationId: z.uuid(),
    idempotencyKey: id,
    reason: z.string().trim().min(10).max(2000),
    evidenceRef: z.string().trim().min(8).max(2000),
  })
  .strict();
const snapshotHash = z.string().regex(/^[a-f0-9]{64}$/);
export const RehearsalReviewSnapshotAttestationSchema = z
  .object({
    stageId: id,
    closureReceiptId: z.uuid(),
    idempotencyKey: id,
    expectedReviews: z
      .array(
        z
          .object({
            agentId: id,
            reviewReceiptId: z.uuid(),
            legacyEvidenceHash: snapshotHash,
            persistedSnapshotHash: snapshotHash,
          })
          .strict(),
      )
      .length(10),
    reason: z.string().trim().min(10).max(4000),
    evidenceRef: z.string().trim().min(1).max(2000),
  })
  .strict();

const preparedContentSchema = z
  .object({
    version: id,
    title: z.string().min(1).max(200),
    rationale: z.string().min(1).max(8000),
    menuId: id,
    menuHash: hashString,
    selections: z.record(id, id),
    teamOrder: z
      .array(id)
      .length(12)
      .refine((v) => new Set(v).size === 12),
    leaguePolicies: z.string().max(8000),
    hostVersion: z.number().int().positive(),
    revisionNo: z.number().int().min(1).max(3),
    replacesProposalId: id.nullable(),
    replacesProposalHash: hashString.nullable(),
  })
  .strict();
async function preparedRulesSnapshot(
  tx: Pick<Db, "query">,
  leagueId: string,
  originalHost: any,
  input: z.infer<typeof PreparedRehearsalDecisionSchema>,
) {
  const expected = PreparedRehearsalDecisionSchema.parse(input);
  const d = (
    await tx.query(
      "SELECT * FROM mfl_governance_decisions WHERE league_id=$1 AND id=$2",
      [leagueId, expected.decisionId],
    )
  ).rows[0];
  const p = (
    await tx.query(
      "SELECT * FROM mfl_governance_proposals WHERE league_id=$1 AND id=$2",
      [leagueId, expected.proposalId],
    )
  ).rows[0];
  check(
    d &&
      p &&
      d.proposal_id === p.id &&
      d.proposal_hash === expected.proposalHash &&
      p.content_hash === expected.proposalHash &&
      fingerprint(p.content) === expected.proposalHash,
    "REHEARSAL_PREPARED_PROPOSAL_MISMATCH",
  );
  const content = preparedContentSchema.parse(p.content);
  const meeting = (
    await tx.query(
      "SELECT * FROM mfl_governance_meetings WHERE league_id=$1 AND id=$2",
      [leagueId, p.meeting_id],
    )
  ).rows[0];
  const menu = (
    await tx.query(
      "SELECT * FROM mfl_governance_menus WHERE league_id=$1 AND id=$2",
      [leagueId, content.menuId],
    )
  ).rows[0];
  check(
    originalHost.host === "mfl" &&
      originalHost.config.leagueId === "62282" &&
      d.host_version === originalHost.version &&
      content.hostVersion === originalHost.version &&
      meeting?.host_version === originalHost.version &&
      meeting.menu_id === content.menuId &&
      menu?.host_version === originalHost.version,
    "REHEARSAL_PREPARED_HOST_MISMATCH",
  );
  check(
    menu.content_hash === expected.menuHash &&
      content.menuHash === expected.menuHash &&
      fingerprint(menu.content) === expected.menuHash,
    "REHEARSAL_PREPARED_MENU_MISMATCH",
  );
  const m = MflMenuSchema.parse(menu.content);
  check(
    m.menuId === menu.id &&
      p.version === content.version &&
      p.title === content.title &&
      p.revision_no === content.revisionNo,
    "REHEARSAL_PREPARED_METADATA_MISMATCH",
  );
  check(
    !(
      await tx.query(
        "SELECT 1 FROM mfl_governance_proposals WHERE league_id=$1 AND meeting_id=$2 AND author_team_id=$3 AND revision_no>$4",
        [leagueId, p.meeting_id, p.author_team_id, p.revision_no],
      )
    ).rowCount,
    "REHEARSAL_PREPARED_PROPOSAL_SUPERSEDED",
  );
  const teams = (
    await tx.query(
      "SELECT id,owner_id FROM league_teams WHERE league_id=$1 ORDER BY id",
      [leagueId],
    )
  ).rows;
  check(
    teams.length === 12 &&
      content.teamOrder.every((t) => teams.some((r) => r.id === t)),
    "REHEARSAL_PREPARED_TEAM_ORDER_MISMATCH",
  );
  const yes = (
    await tx.query(
      "SELECT count(*)::int AS n FROM mfl_governance_votes v JOIN league_teams t ON t.league_id=v.league_id AND t.id=v.team_id AND t.owner_id=v.owner_id WHERE v.league_id=$1 AND v.proposal_id=$2 AND v.choice='yes'",
      [leagueId, p.id],
    )
  ).rows[0].n;
  check(
    d.yes_votes >= 8 && d.yes_votes <= 12 && yes >= d.yes_votes,
    "REHEARSAL_PREPARED_QUORUM_MISMATCH",
  );
  check(
    Object.keys(content.selections).length === m.questions.length,
    "REHEARSAL_PREPARED_SELECTION_MISMATCH",
  );
  const selectedOptions = m.questions.map((q) => {
    const option = q.options.find((o) => o.id === content.selections[q.id]);
    check(option, "REHEARSAL_PREPARED_SELECTION_MISMATCH");
    return {
      questionId: q.id,
      questionLabel: q.label,
      optionId: option.id,
      label: option.label,
      content: option.content,
      evidenceRefs: option.evidenceRefs,
    };
  });
  return {
    decision: {
      id: d.id,
      proposalId: p.id,
      proposalHash: p.content_hash,
      hostVersion: d.host_version,
      yesVotesAtPreparation: d.yes_votes,
    },
    proposal: {
      id: p.id,
      version: content.version,
      title: content.title,
      hash: p.content_hash,
      selections: content.selections,
      teamOrder: content.teamOrder,
      leaguePolicies: content.leaguePolicies,
    },
    menu: { id: menu.id, hash: menu.content_hash },
    selectedOptions,
    applicationSections: m.applicationSections,
  };
}
async function boundPreparedRulesContext(db: Db, row: any) {
  const receipts = (
    await db.query(
      "SELECT details FROM runtime_receipts WHERE type='rehearsal.trial_rules_bound' AND details->>'leagueId'=$1 AND details->>'epoch'=$2 ORDER BY seq",
      [row.league_id, row.epoch],
    )
  ).rows;
  if (!receipts.length && row.synthetic) return null;
  check(receipts.length === 1, "REHEARSAL_PREPARED_RULES_BINDING_REQUIRED");
  const binding = receipts[0].details;
  check(
    binding.version === 1 &&
      binding.armRequestHash === row.request_hash &&
      fingerprint(binding.armRequest) === row.request_hash &&
      fingerprint(binding.armRequest?.preparedDecision) ===
        fingerprint(binding.preparedDecision) &&
      binding.operatorEvidenceRef === row.operator_evidence_ref &&
      fingerprint(binding.originalHost) === fingerprint(row.original_host),
    "REHEARSAL_PREPARED_RULES_BINDING_MISMATCH",
  );
  const currentHost = await hostBinding(db, row.league_id);
  check(
    row.trial_host &&
      currentHost.host === "mfl" &&
      currentHost.config.leagueId === "46625" &&
      fingerprint(currentHost) === fingerprint(row.trial_host),
    "REHEARSAL_PREPARED_CURRENT_HOST_MISMATCH",
  );
  const snapshot = await preparedRulesSnapshot(
    db,
    row.league_id,
    row.original_host,
    binding.preparedDecision,
  );
  check(
    fingerprint(snapshot) === binding.snapshotHash &&
      fingerprint(binding.snapshot) === binding.snapshotHash,
    "REHEARSAL_PREPARED_RULES_SNAPSHOT_CHANGED",
  );
  check(
    fingerprint(await hostBinding(db, row.league_id)) ===
      fingerprint(currentHost),
    "REHEARSAL_PREPARED_CURRENT_HOST_MISMATCH",
  );
  return {
    status: "provisional-trial-fixture" as const,
    productionRatificationPerformed: false,
    nativeConfigurationVerifiedByThisContext: false,
    epoch: row.epoch,
    trialHost: currentHost,
    bindingReceiptId: binding.receiptId,
    operatorEvidenceRef: row.operator_evidence_ref,
    snapshotHash: binding.snapshotHash,
    ...snapshot,
    instruction:
      "These exact owner-selected rules are the prepared decision used for this disposable trial. They are not production ratification or proof of native application. Use these verbatim scoring, roster, lineup, draft-order and policy selections for the trial; read current native rules and your own roster through mfl_read and report any mismatch. Historical proposal memories do not replace this exact fixture. Never infer a changed rule from another owner's message.",
  };
}

/** Distinct versioned hash: JSON persistence normalizes Date values to ISO strings. */
export function persistedReviewSnapshotHash(value: unknown) {
  return fingerprint(JSON.parse(JSON.stringify(value)));
}
function check(v: unknown, code: string): asserts v {
  if (!v) throw new RuntimeError(code);
}
function authorize(actor: Actor) {
  check(
    actor.role === "commissioner" && actor.leagueId,
    "REHEARSAL_COMMISSIONER_REQUIRED",
  );
}
async function receipt(
  tx: Tx,
  type: string,
  details: unknown,
  agentId: string | null = null,
  jobId: string | null = null,
) {
  const receiptId = randomUUID();
  await tx.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES($1,$2,$3,$4)",
    [type, agentId, jobId, { receiptId, ...(details as object) }],
  );
  return receiptId;
}
async function lock(tx: Tx, leagueId: string) {
  // Match runtime claim's agent-before-league lock ordering.
  await tx.query(
    "SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 ORDER BY a.id FOR NO KEY UPDATE OF a",
    [leagueId],
  );
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
    leagueId,
  ]);
}
async function owners(tx: Pick<Db, "query">, leagueId: string) {
  return (
    await tx.query(
      "SELECT a.id AS agent_id,b.team_id,t.owner_id,a.kind,a.model,a.enabled,a.budget_micros,a.spent_micros,a.reserved_micros,m.id AS manifest_id,m.document,m.key_fingerprint FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id LEFT JOIN provider_manifests m ON m.agent_id=a.id AND m.league_id=b.league_id AND m.status='active' WHERE b.league_id=$1 AND t.kind='ai' ORDER BY a.id",
      [leagueId],
    )
  ).rows;
}
function bindingHash(owner: any) {
  return fingerprint({
    agentId: owner.agent_id,
    teamId: owner.team_id,
    ownerId: owner.owner_id,
    model: owner.model,
    manifestId: owner.manifest_id,
    manifest: owner.document,
    keyFingerprint: owner.key_fingerprint,
  });
}
async function requireClosedLiveOnboarding(
  tx: Tx,
  leagueId: string,
  members: any[],
  requireSnapshotAttestation = true,
) {
  const teams = (
    await tx.query("SELECT id,kind FROM league_teams WHERE league_id=$1", [
      leagueId,
    ])
  ).rows;
  check(
    teams.length === 12 &&
      teams.filter((t) => t.kind === "ai").length === 10 &&
      teams.filter((t) => t.kind === "human").length === 2 &&
      members.length === 10 &&
      new Set(members.map((o) => o.team_id)).size === 10,
    "REHEARSAL_TWELVE_TEAMS_TEN_OWNERS_REQUIRED",
  );
  const stage = (
    await tx.query(
      "SELECT * FROM runtime_owner_stages WHERE league_id=$1 ORDER BY configured_at DESC,id DESC LIMIT 1",
      [leagueId],
    )
  ).rows[0];
  check(stage?.status === "reviewed", "REHEARSAL_CLOSED_ONBOARDING_REQUIRED");
  const stageConfig = OwnerStageConfigSchema.safeParse(stage.configuration);
  check(
    stageConfig.success &&
      stageConfig.data.synthetic === false &&
      fingerprint({
        config: stageConfig.data,
        charter: stage.charter,
        assignment: stage.assignment,
      }) === stage.content_hash,
    "REHEARSAL_LIVE_ONBOARDING_HASH_REQUIRED",
  );
  const closure = (
    await tx.query(
      "SELECT details FROM runtime_receipts WHERE type='owner_stage.closed' AND details->>'leagueId'=$1 AND details->>'stageId'=$2 ORDER BY seq DESC LIMIT 1",
      [leagueId, stage.id],
    )
  ).rows[0]?.details;
  check(
    closure?.status === "reviewed" &&
      Array.isArray(closure.ownerReviews) &&
      closure.ownerReviews.length === 10 &&
      new Set(closure.ownerReviews.map((r: any) => r.agentId)).size === 10,
    "REHEARSAL_TEN_CLOSED_REVIEWS_REQUIRED",
  );
  const reviews = (
    await tx.query(
      "SELECT r.*,f.actor_id AS brand_owner,f.agent_id AS brand_agent,v.team_id AS brand_team FROM runtime_owner_stage_reviews r LEFT JOIN franchise_receipts f ON f.id::text=r.evidence#>>'{brand,receiptId}' AND f.league_id=r.league_id LEFT JOIN franchise_brand_versions v ON v.receipt_id=f.id AND v.league_id=r.league_id WHERE r.league_id=$1 AND r.stage_id=$2",
      [leagueId, stage.id],
    )
  ).rows;
  check(
    reviews.length === 10 &&
      members.every((owner) => {
        const review = reviews.find((r) => r.agent_id === owner.agent_id),
          closed = closure.ownerReviews.find(
            (r: any) => r.agentId === owner.agent_id,
          );
        return (
          review &&
          closed &&
          closed.reviewReceiptId === review.receipt_id &&
          closed.evidenceHash === review.evidence_hash &&
          closed.researchStatus === "verified" &&
          review.brand_owner === owner.owner_id &&
          review.brand_agent === owner.agent_id &&
          review.brand_team === owner.team_id
        );
      }),
    "REHEARSAL_CURRENT_OWNER_REVIEWS_REQUIRED",
  );
  const snapshots = reviews.map((review) => ({
    agentId: review.agent_id,
    reviewReceiptId: review.receipt_id,
    legacyEvidenceHash: review.evidence_hash,
    persistedSnapshotHash: persistedReviewSnapshotHash(review.evidence),
  }));
  const attestation = (
    await tx.query(
      "SELECT details FROM runtime_receipts WHERE type='rehearsal.review_snapshots_attested' AND details->>'leagueId'=$1 AND details->>'stageId'=$2 AND details->>'closureReceiptId'=$3 ORDER BY seq DESC LIMIT 1",
      [leagueId, stage.id, closure.receiptId],
    )
  ).rows[0]?.details;
  if (requireSnapshotAttestation) {
    check(
      attestation?.algorithm === "json-persisted-v1" &&
        attestation.version === 1 &&
        attestation.stageContentHash === stage.content_hash &&
        Array.isArray(attestation.snapshots) &&
        attestation.snapshots.length === 10 &&
        new Set(attestation.snapshots.map((r: any) => r.agentId)).size === 10,
      "REHEARSAL_REVIEW_SNAPSHOT_ATTESTATION_REQUIRED",
    );
    check(
      snapshots.every((snapshot) => {
        const attested = attestation.snapshots.find(
          (r: any) => r.agentId === snapshot.agentId,
        );
        return (
          attested &&
          attested.reviewReceiptId === snapshot.reviewReceiptId &&
          attested.legacyEvidenceHash === snapshot.legacyEvidenceHash &&
          attested.persistedSnapshotHash === snapshot.persistedSnapshotHash &&
          persistedReviewSnapshotHash(attested.evidence) ===
            snapshot.persistedSnapshotHash
        );
      }),
      "REHEARSAL_REVIEW_SNAPSHOT_CHANGED",
    );
  }
  return {
    stageId: stage.id,
    closureReceiptId: closure.receiptId,
    contentHash: stage.content_hash,
    snapshotAttestationReceiptId: attestation?.receiptId ?? null,
    snapshotDescriptors: snapshots,
    ownerReviewReceiptIds: closure.ownerReviews.map(
      (r: any) => r.reviewReceiptId,
    ),
  };
}
async function quiescent(tx: Tx, leagueId: string) {
  const busy = (
    await tx.query(
      "SELECT j.id FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' UNION ALL SELECT id FROM runtime_football_outbox WHERE league_id=$1 AND status='running' UNION ALL SELECT id FROM runtime_franchise_outbox WHERE league_id=$1 AND status='running'",
      [leagueId],
    )
  ).rows;
  check(!busy.length, "REHEARSAL_WORK_IN_FLIGHT");
  check(
    !(
      await tx.query(
        "SELECT 1 FROM runtime_mfl_draft_observers WHERE league_id=$1 AND (status='active' OR lease_until>clock_timestamp())",
        [leagueId],
      )
    ).rowCount,
    "REHEARSAL_OBSERVER_NOT_HELD",
  );
}
async function unresolvedNative(tx: Tx, row: any) {
  return (
    await tx.query(
      "SELECT * FROM (SELECT DISTINCT ON(details->>'scope',details->>'idempotencyKey') details,seq FROM runtime_receipts WHERE type='mfl_operation' AND details->>'leagueId'=$1 AND seq>$2 ORDER BY details->>'scope',details->>'idempotencyKey',seq DESC) latest WHERE details->>'state' NOT IN ('verified','rejected')",
      [row.league_id, row.start_receipt_seq],
    )
  ).rows;
}

/** SQL alias is supplied only by runtime source, never request input. */
export function rehearsalClaimPredicate(alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw Error("INVALID_INTERNAL_ALIAS");
  return `((EXISTS(SELECT 1 FROM runtime_rehearsal_jobs x JOIN runtime_rehearsals r ON r.league_id=x.league_id AND r.epoch=x.epoch WHERE x.job_id=${alias}.id AND x.agent_id=${alias}.agent_id AND r.status='armed')) OR (NOT EXISTS(SELECT 1 FROM runtime_rehearsal_jobs x WHERE x.job_id=${alias}.id) AND NOT EXISTS(SELECT 1 FROM runtime_rehearsals r JOIN runtime_bindings b ON b.league_id=r.league_id WHERE b.agent_id=${alias}.agent_id AND r.status<>'restored')))`;
}
async function jobEpoch(
  tx: Pick<Db, "query">,
  job: Pick<Job, "id" | "agentId">,
) {
  return (
    await tx.query(
      "SELECT r.*,o.model AS pinned_model,o.binding_hash,o.manifest_id FROM runtime_rehearsal_jobs j JOIN runtime_rehearsals r ON r.league_id=j.league_id AND r.epoch=j.epoch JOIN runtime_rehearsal_owners o ON o.league_id=j.league_id AND o.epoch=j.epoch AND o.agent_id=j.agent_id WHERE j.job_id=$1 AND j.agent_id=$2",
      [job.id, job.agentId],
    )
  ).rows[0];
}
export async function assertRehearsalClaim(
  tx: Tx,
  job: Pick<Job, "id" | "agentId">,
) {
  const row = await jobEpoch(tx, job);
  if (!row) {
    check(
      !(
        await tx.query(
          "SELECT 1 FROM runtime_rehearsals r JOIN runtime_bindings b ON b.league_id=r.league_id WHERE b.agent_id=$1 AND r.status<>'restored'",
          [job.agentId],
        )
      ).rowCount,
      "REHEARSAL_UNRELATED_JOB",
    );
    return null;
  }
  check(row.status === "armed", "REHEARSAL_NOT_ARMED");
  const host = await hostBinding(tx, row.league_id);
  check(
    fingerprint(host) === fingerprint(row.trial_host) &&
      host.host === "mfl" &&
      host.config.leagueId === "46625",
    "REHEARSAL_HOST_DRIFT",
  );
  const owner = (await owners(tx, row.league_id)).find(
    (o) => o.agent_id === job.agentId,
  );
  check(
    owner && bindingHash(owner) === row.binding_hash,
    "REHEARSAL_OWNER_DRIFT",
  );
  return row;
}
/** Revalidated evidence, not a settlement: only a dead first-request 429 with no effects. */
async function coveredHoldEvidence(
  tx: Pick<Db, "query">,
  leagueId: string,
  request: z.infer<typeof RehearsalCoveredCostHoldSchema>,
) {
  const row = await jobEpoch(tx, {
    id: request.jobId,
    agentId: request.agentId,
  });
  check(
    row &&
      row.league_id === leagueId &&
      row.epoch === request.epoch &&
      row.status === "armed" &&
      row.trial_host?.version === request.expectedHostVersion &&
      row.trial_host?.host === "mfl" &&
      row.trial_host?.config?.leagueId === "46625",
    "REHEARSAL_COST_REVIEW_SCOPE",
  );
  check(
    fingerprint(await hostBinding(tx as Tx, leagueId)) ===
      fingerprint(row.trial_host),
    "REHEARSAL_HOST_DRIFT",
  );
  const owner = (await owners(tx, leagueId)).find(
    (o) => o.agent_id === request.agentId,
  );
  check(
    owner &&
      owner.manifest_id === request.manifestId &&
      row.manifest_id === request.manifestId &&
      bindingHash(owner) === row.binding_hash,
    "REHEARSAL_OWNER_DRIFT",
  );
  const job = (
    await tx.query("SELECT * FROM runtime_jobs WHERE id=$1", [request.jobId])
  ).rows[0];
  const r = (
    await tx.query("SELECT * FROM runtime_reservations WHERE id=$1", [
      request.reservationId,
    ])
  ).rows[0];
  const calls = (
    await tx.query(
      "SELECT * FROM provider_calls WHERE job_id=$1 ORDER BY started_at,id",
      [request.jobId],
    )
  ).rows;
  const call = calls[0];
  check(
    job &&
      job.agent_id === request.agentId &&
      job.status === "dead" &&
      job.fence === request.fence &&
      job.attempts === 1 &&
      request.fence === 1 &&
      job.error === "PROVIDER_HTTP_429_COST_UNCERTAIN",
    "REHEARSAL_COST_REVIEW_DEAD_FIRST_429_REQUIRED",
  );
  check(
    r &&
      r.agent_id === request.agentId &&
      r.job_id === request.jobId &&
      r.fence === request.fence &&
      r.status === "uncertain" &&
      Number(r.amount_micros) > 0 &&
      r.actual_micros === null &&
      r.observed_micros === null,
    "REHEARSAL_COST_REVIEW_FULL_UNKNOWN_HOLD_REQUIRED",
  );
  check(
    calls.length === 1 &&
      call.id === request.callId &&
      call.fence === request.fence &&
      call.agent_id === request.agentId &&
      call.manifest_id === request.manifestId &&
      call.purpose === "owner" &&
      call.status === "http_429_cost_uncertain" &&
      call.reconciliation_status === "pending" &&
      call.cost_micros === null &&
      call.reported_model === null &&
      call.reported_provider === null &&
      call.prompt_tokens === null &&
      call.completion_tokens === null &&
      call.requested_model === owner.document.model &&
      call.requested_provider === owner.document.providerSlug,
    "REHEARSAL_COST_REVIEW_CALL_MISMATCH",
  );
  const effects = (
    await tx.query(
      `SELECT
    (SELECT count(*) FROM runtime_football_outbox WHERE job_id=$1) football,
    (SELECT count(*) FROM runtime_franchise_outbox WHERE job_id=$1) franchise,
    (SELECT count(*) FROM research_paid_operations WHERE job_id=$1) research,
    (SELECT count(*) FROM runtime_receipts WHERE job_id=$1 AND type='rehearsal.owner_decision') decisions`,
      [request.jobId],
    )
  ).rows[0];
  check(
    Object.values(effects).every((v) => Number(v) === 0),
    "REHEARSAL_COST_REVIEW_EFFECTS_PRESENT",
  );
  const liabilities = (
    await tx.query(
      "SELECT COALESCE(sum(amount_micros),0)::text total FROM runtime_reservations WHERE agent_id=$1 AND status IN ('reserved','uncertain')",
      [request.agentId],
    )
  ).rows[0];
  check(
    Number(owner.reserved_micros) >= Number(liabilities.total),
    "REHEARSAL_COST_REVIEW_WALLET_HOLD_MISSING",
  );
  return {
    host: row.trial_host,
    bindingHash: row.binding_hash,
    reservation: {
      id: r.id,
      agentId: r.agent_id,
      jobId: r.job_id,
      fence: r.fence,
      status: r.status,
      heldMicros: Number(r.amount_micros),
      actualMicros: r.actual_micros,
      observedMicros: r.observed_micros,
    },
    job: {
      id: job.id,
      fence: job.fence,
      attempts: job.attempts,
      status: job.status,
      error: job.error,
    },
    call: JSON.parse(JSON.stringify(call)),
    effects,
  };
}

export async function rehearsalUsage(
  tx: Pick<Db, "query">,
  leagueId: string,
  epoch: string,
  agentId: string,
) {
  const usage = (
    await tx.query(
      `WITH model AS(SELECT COALESCE(sum(CASE WHEN r.status='released' THEN 0 WHEN r.status='settled' THEN r.actual_micros ELSE GREATEST(r.amount_micros,COALESCE(r.observed_micros,0)) END),0) cost,count(*) FILTER(WHERE r.status='uncertain') unresolved FROM runtime_reservations r JOIN runtime_rehearsal_jobs j ON j.job_id=r.job_id AND j.agent_id=r.agent_id WHERE j.league_id=$1 AND j.epoch=$2 AND j.agent_id=$3), research AS(SELECT COALESCE(sum(CASE WHEN p.status='completed' AND p.actual_micros IS NOT NULL THEN p.actual_micros ELSE p.reservation_micros END),0) cost,count(*) FILTER(WHERE p.status='unknown' OR (p.status='completed' AND p.actual_micros IS NULL)) unresolved FROM research_paid_operations p JOIN runtime_rehearsal_jobs j ON j.job_id=p.job_id AND j.agent_id=p.agent_id WHERE j.league_id=$1 AND j.epoch=$2 AND j.agent_id=$3) SELECT (m.cost+r.cost)::text AS committed_micros,(m.unresolved+r.unresolved)::int AS unresolved FROM model m CROSS JOIN research r`,
      [leagueId, epoch, agentId],
    )
  ).rows[0];
  let coveredUnresolved = 0;
  const acknowledgments = (
    await tx.query(
      "SELECT details FROM runtime_receipts WHERE type='rehearsal.cost_hold_acknowledged' AND agent_id=$1 AND details->>'leagueId'=$2 AND details->>'epoch'=$3",
      [agentId, leagueId, epoch],
    )
  ).rows;
  if (acknowledgments.length === 1) {
    const a = acknowledgments[0].details;
    const request = RehearsalCoveredCostHoldSchema.safeParse(a.request);
    if (
      request.success &&
      request.data.agentId === agentId &&
      request.data.epoch === epoch &&
      fingerprint(request.data) === a.requestHash
    ) {
      try {
        const evidence = await coveredHoldEvidence(tx, leagueId, request.data);
        if (
          fingerprint(evidence) === a.evidenceHash &&
          fingerprint(a.evidence) === a.evidenceHash
        )
          coveredUnresolved = 1;
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        // Changed evidence invalidates admission; it never changes the liability.
      }
    }
  }
  return {
    ...usage,
    covered_unresolved: coveredUnresolved,
    unreviewed_unresolved: Number(usage.unresolved) - coveredUnresolved,
  };
}
/** Called under the canonical wallet lock for model AND research reservations. */
export async function assertRehearsalBudget(tx: Tx, job: Job, amount: number) {
  const row = await assertRehearsalClaim(tx, job);
  if (!row) return;
  const used = await rehearsalUsage(tx, row.league_id, row.epoch, job.agentId);
  check(
    Number.isSafeInteger(amount) && amount >= 0,
    "REHEARSAL_INVALID_RESERVATION",
  );
  check(!used.unreviewed_unresolved, "REHEARSAL_COST_UNRESOLVED");
  check(
    !(await unresolvedNative(tx, row)).length,
    "REHEARSAL_NATIVE_UNRESOLVED",
  );
  check(
    Number(used.committed_micros) + amount <= Number(row.cap_micros),
    "REHEARSAL_CAP_EXHAUSTED",
  );
}
/** Explicit native journal recovery: permits reads while stopped, never write authority. */
export async function assertRehearsalReconciliation(
  tx: Tx,
  job: Pick<Job, "id" | "agentId">,
) {
  const row = await jobEpoch(tx, job);
  if (!row) {
    await assertRehearsalClaim(tx, job);
    return null;
  }
  check(
    ["armed", "stopped"].includes(row.status),
    "REHEARSAL_RECONCILIATION_SCOPE_CLOSED",
  );
  const host = await hostBinding(tx, row.league_id);
  check(
    host.host === "mfl" &&
      host.config.leagueId === "46625" &&
      fingerprint(host) === fingerprint(row.trial_host),
    "REHEARSAL_HOST_DRIFT",
  );
  const owner = (await owners(tx, row.league_id)).find(
    (o) => o.agent_id === job.agentId,
  );
  check(
    owner && bindingHash(owner) === row.binding_hash,
    "REHEARSAL_OWNER_DRIFT",
  );
  return { epoch: row.epoch, status: row.status, readOnly: true as const };
}
/** Outcome notices inherit their ORIGINAL outbox epoch, never whichever epoch happens to be open. */
export async function tagRehearsalOutcomeWake(
  tx: Tx,
  input: {
    jobId: string;
    outboxId: string;
    source: "football-failure" | "football-held";
  },
) {
  const origin = (
    await tx.query(
      "SELECT r.*,o.agent_id,o.host_version,o.host_identity,o.team_id,o.owner_id,p.team_id AS pinned_team,p.owner_id AS pinned_owner FROM runtime_football_outbox o JOIN runtime_rehearsal_jobs j ON j.job_id=o.job_id AND j.agent_id=o.agent_id AND j.league_id=o.league_id JOIN runtime_rehearsals r ON r.league_id=j.league_id AND r.epoch=j.epoch JOIN runtime_rehearsal_owners p ON p.league_id=j.league_id AND p.epoch=j.epoch AND p.agent_id=j.agent_id WHERE o.id=$1",
      [input.outboxId],
    )
  ).rows[0];
  if (!origin) return;
  check(
    origin.team_id === origin.pinned_team &&
      origin.owner_id === origin.pinned_owner &&
      origin.host_version === origin.trial_host.version &&
      fingerprint(origin.host_identity) ===
        fingerprint(origin.trial_host.config),
    "REHEARSAL_OUTCOME_ORIGIN_MISMATCH",
  );
  const wake = (
    await tx.query("SELECT * FROM runtime_jobs WHERE id=$1 FOR UPDATE", [
      input.jobId,
    ])
  ).rows[0];
  check(
    wake?.agent_id === origin.agent_id,
    "REHEARSAL_OUTCOME_RECIPIENT_MISMATCH",
  );
  const prior = (
    await tx.query("SELECT * FROM runtime_rehearsal_jobs WHERE job_id=$1", [
      input.jobId,
    ])
  ).rows[0];
  check(
    !prior ||
      (prior.league_id === origin.league_id &&
        prior.epoch === origin.epoch &&
        prior.agent_id === origin.agent_id),
    "REHEARSAL_WAKE_CONFLICT",
  );
  await tx.query(
    "INSERT INTO runtime_rehearsal_jobs(job_id,league_id,epoch,agent_id,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO NOTHING",
    [
      input.jobId,
      origin.league_id,
      origin.epoch,
      origin.agent_id,
      input.source,
    ],
  );
  if (origin.status !== "armed")
    await tx.query(
      "UPDATE runtime_jobs SET status='cancelled',error='REHEARSAL_OUTCOME_AFTER_STOP' WHERE id=$1 AND status='pending'",
      [input.jobId],
    );
}
export async function assertRehearsalCommit(
  tx: Tx,
  job: Job,
  actions: Action[],
  synthetic: boolean,
) {
  const row = await assertRehearsalClaim(tx, job);
  if (!row) return;
  check(synthetic === row.synthetic, "REHEARSAL_MODEL_PROVENANCE_MISMATCH");
  check(
    actions.every(
      (a) =>
        a.type === "remember" ||
        (a.type === "football" &&
          (a.command.type === "mflLocalDraftQueue" ||
            (a.command.type === "mfl" && a.command.action.type === "draft"))),
    ),
    "REHEARSAL_ACTION_FORBIDDEN",
  );
  await receipt(
    tx,
    "rehearsal.owner_decision",
    {
      leagueId: row.league_id,
      epoch: row.epoch,
      host: row.trial_host,
      disposableFootball: true,
      modelExecution: synthetic ? "synthetic-test" : "real-model",
      model: job.model,
      fence: job.fence,
      actions: actions.length,
    },
    job.agentId,
    job.id,
  );
}
/** Only trusted draft-observer/receipt adapters may tag their newly created wake. */
export async function tagRehearsalWake(
  tx: Tx,
  input: {
    jobId: string;
    leagueId: string;
    hostVersion: number;
    source: "draft-observer" | "football-receipt" | "operator";
  },
) {
  const row = (
    await tx.query(
      "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND status<>'restored'",
      [input.leagueId],
    )
  ).rows[0];
  if (!row) return;
  check(
    row.status === "armed" && row.trial_host?.version === input.hostVersion,
    "REHEARSAL_WAKE_HOST_MISMATCH",
  );
  const job = (
    await tx.query(
      "SELECT j.* FROM runtime_jobs j JOIN runtime_rehearsal_owners o ON o.agent_id=j.agent_id AND o.league_id=$2 AND o.epoch=$3 WHERE j.id=$1 FOR UPDATE OF j",
      [input.jobId, input.leagueId, row.epoch],
    )
  ).rows[0];
  const existing = (
    await tx.query("SELECT * FROM runtime_rehearsal_jobs WHERE job_id=$1", [
      input.jobId,
    ])
  ).rows[0];
  if (existing) {
    check(
      existing.league_id === row.league_id &&
        existing.epoch === row.epoch &&
        existing.agent_id === job?.agent_id,
      "REHEARSAL_WAKE_CONFLICT",
    );
    return;
  }
  check(
    job &&
      job.status === "pending" &&
      job.attempts === 0 &&
      job.created_at >= row.configured_at,
    "REHEARSAL_WAKE_NOT_FRESH",
  );
  await tx.query(
    "INSERT INTO runtime_rehearsal_jobs(job_id,league_id,epoch,agent_id,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO NOTHING",
    [job.id, row.league_id, row.epoch, job.agent_id, input.source],
  );
}

export class RehearsalRuntime {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
  ) {}
  /** One commissioner-reviewed liability per owner/epoch; does not settle, wake, or enable. */
  async acknowledgeCoveredCostHold(actor: Actor, input: unknown) {
    authorize(actor);
    const request = RehearsalCoveredCostHoldSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const prior = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='rehearsal.cost_hold_acknowledged' AND agent_id=$1 AND details->>'leagueId'=$2 AND details->>'epoch'=$3",
          [request.agentId, actor.leagueId, request.epoch],
        )
      ).rows;
      const requestHash = fingerprint(request);
      check(
        prior.length <= 1 &&
          (!prior.length || prior[0].details.requestHash === requestHash),
        "REHEARSAL_COST_REVIEW_CONFLICT",
      );
      const evidence = await coveredHoldEvidence(tx, actor.leagueId, request);
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [request.agentId],
          )
        ).rowCount,
        "REHEARSAL_COST_REVIEW_RUNNING_JOB",
      );
      const row = await jobEpoch(tx, {
        id: request.jobId,
        agentId: request.agentId,
      });
      check(
        !(await unresolvedNative(tx, row)).length,
        "REHEARSAL_NATIVE_UNRESOLVED",
      );
      if (prior.length) {
        check(
          prior[0].details.evidenceHash === fingerprint(evidence),
          "REHEARSAL_COST_REVIEW_EVIDENCE_CHANGED",
        );
        return { ...prior[0].details, replayed: true };
      }
      const details = {
        leagueId: actor.leagueId,
        epoch: request.epoch,
        request,
        requestHash,
        evidence,
        evidenceHash: fingerprint(evidence),
        reviewedBy: actor.id,
        disposition: "permit-new-work-with-full-cost-hold",
        reconciled: false,
        automaticWake: false,
        reservationStatus: "uncertain",
        unchangedCapMicros: Number(row.cap_micros),
      };
      const receiptId = await receipt(
        tx,
        "rehearsal.cost_hold_acknowledged",
        details,
        request.agentId,
        request.jobId,
      );
      return { ...details, receiptId, replayed: false };
    });
  }
  /** Explicit review-format attestation; never changes owner evidence or legacy hashes. */
  async attestClosedReviewSnapshots(actor: Actor, input: unknown) {
    authorize(actor);
    const request = RehearsalReviewSnapshotAttestationSchema.parse(input);
    check(
      new Set(request.expectedReviews.map((r) => r.agentId)).size === 10,
      "REHEARSAL_TEN_DISTINCT_REVIEW_SNAPSHOTS_REQUIRED",
    );
    const requestHash = fingerprint(request);
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const onboarding = await requireClosedLiveOnboarding(
        tx,
        actor.leagueId,
        await owners(tx, actor.leagueId),
        false,
      );
      check(
        onboarding.stageId === request.stageId &&
          onboarding.closureReceiptId === request.closureReceiptId,
        "REHEARSAL_CLOSED_REVIEW_SCOPE_MISMATCH",
      );
      check(
        onboarding.snapshotDescriptors.every((actual) => {
          const expected = request.expectedReviews.find(
            (r) => r.agentId === actual.agentId,
          );
          return expected && fingerprint(expected) === fingerprint(actual);
        }),
        "REHEARSAL_EXPECTED_REVIEW_SNAPSHOT_MISMATCH",
      );
      const existing = (
        await tx.query(
          "SELECT details FROM runtime_receipts WHERE type='rehearsal.review_snapshots_attested' AND details->>'leagueId'=$1 AND (details->>'idempotencyKey'=$2 OR (details->>'stageId'=$3 AND details->>'closureReceiptId'=$4)) ORDER BY seq DESC LIMIT 1",
          [
            actor.leagueId,
            request.idempotencyKey,
            request.stageId,
            request.closureReceiptId,
          ],
        )
      ).rows[0]?.details;
      if (existing) {
        check(
          existing.requestHash === requestHash,
          "REHEARSAL_REVIEW_ATTESTATION_CONFLICT",
        );
        // A replay also revalidates immutable attested contents, not just its key.
        await requireClosedLiveOnboarding(
          tx,
          actor.leagueId,
          await owners(tx, actor.leagueId),
        );
        return { ...existing, replayed: true };
      }
      const reviews = (
        await tx.query(
          "SELECT agent_id,evidence FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 ORDER BY agent_id",
          [actor.leagueId, request.stageId],
        )
      ).rows;
      const details = {
        receiptId: randomUUID(),
        algorithm: "json-persisted-v1",
        version: 1,
        leagueId: actor.leagueId,
        stageId: request.stageId,
        closureReceiptId: request.closureReceiptId,
        stageContentHash: onboarding.contentHash,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        reason: request.reason,
        evidenceRef: request.evidenceRef,
        reviewedBy: actor.id,
        snapshots: onboarding.snapshotDescriptors.map((snapshot) => ({
          ...snapshot,
          evidence: reviews.find((r) => r.agent_id === snapshot.agentId)!
            .evidence,
        })),
        legacyHashesUnchanged: true,
        reviewProjectionsUnchanged: true,
        closureUnchanged: true,
        automaticWake: false,
      };
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('rehearsal.review_snapshots_attested',$1)",
        [details],
      );
      return { ...details, replayed: false };
    });
  }
  async arm(actor: Actor, input: unknown) {
    authorize(actor);
    const request = RehearsalArmSchema.parse(input),
      requestHash = fingerprint(request);
    const prepared = await transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const currentMembers = await owners(tx, actor.leagueId);
      const onboarding = request.synthetic
        ? null
        : await requireClosedLiveOnboarding(tx, actor.leagueId, currentMembers);
      const old = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2",
          [actor.leagueId, request.epoch],
        )
      ).rows[0];
      if (old) {
        check(
          old.request_hash === requestHash,
          "REHEARSAL_IDEMPOTENCY_CONFLICT",
        );
        check(
          ["arming", "armed"].includes(old.status),
          "REHEARSAL_EPOCH_ALREADY_STOPPED",
        );
        return old;
      }
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_rehearsals WHERE league_id=$1 AND status<>'restored'",
            [actor.leagueId],
          )
        ).rowCount,
        "REHEARSAL_ALREADY_OPEN",
      );
      await quiescent(tx, actor.leagueId);
      const original = await hostBinding(tx, actor.leagueId);
      check(
        original.host === "mfl" &&
          original.config.leagueId === "62282" &&
          original.version === request.expectedHostVersion,
        "REHEARSAL_PRODUCTION_HOST_REQUIRED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_owner_stages WHERE league_id=$1 AND status IN ('active','paused') UNION ALL SELECT 1 FROM runtime_conventions WHERE league_id=$1 AND status='active'",
            [actor.leagueId],
          )
        ).rowCount,
        "REHEARSAL_FOUNDING_STILL_ACTIVE",
      );
      const members = currentMembers;
      check(
        members.length > 0 && members.every((o) => !o.enabled),
        "REHEARSAL_OWNERS_NOT_PAUSED",
      );
      check(
        members.every(
          (o) =>
            o.kind === "ai" &&
            (request.synthetic
              ? o.model.startsWith("synthetic/")
              : o.manifest_id && o.document?.model === o.model),
        ),
        "REHEARSAL_MODEL_MANIFEST_REQUIRED",
      );
      check(
        members.every(
          (o) =>
            Number(o.budget_micros) -
              Number(o.spent_micros) -
              Number(o.reserved_micros) >=
            request.capMicros,
        ),
        "REHEARSAL_WALLET_HEADROOM",
      );
      const startSeq = Number(
        (
          await tx.query(
            "SELECT COALESCE(max(seq),0)::text AS seq FROM runtime_receipts",
          )
        ).rows[0].seq,
      );
      const row = (
        await tx.query(
          "INSERT INTO runtime_rehearsals(league_id,epoch,status,request_hash,original_host,cap_micros,synthetic,operator_evidence_ref,reason,configured_by,start_receipt_seq) VALUES($1,$2,'arming',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            actor.leagueId,
            request.epoch,
            requestHash,
            original,
            request.capMicros,
            request.synthetic,
            request.operatorEvidenceRef,
            request.reason,
            actor.id,
            startSeq,
          ],
        )
      ).rows[0];
      if (request.preparedDecision) {
        const snapshot = await preparedRulesSnapshot(
          tx,
          actor.leagueId,
          original,
          request.preparedDecision,
        );
        await receipt(tx, "rehearsal.trial_rules_bound", {
          version: 1,
          leagueId: actor.leagueId,
          epoch: request.epoch,
          armRequestHash: requestHash,
          armRequest: request,
          originalHost: original,
          operatorEvidenceRef: request.operatorEvidenceRef,
          preparedDecision: request.preparedDecision,
          snapshot,
          snapshotHash: fingerprint(snapshot),
          operatorId: actor.id,
          productionRatificationPerformed: false,
          nativeConfigurationVerifiedByThisContext: false,
        });
      }
      for (const o of members)
        await tx.query(
          "INSERT INTO runtime_rehearsal_owners(league_id,epoch,agent_id,team_id,owner_id,model,manifest_id,binding_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            actor.leagueId,
            request.epoch,
            o.agent_id,
            o.team_id,
            o.owner_id,
            o.model,
            o.manifest_id,
            bindingHash(o),
          ],
        );
      await tx.query(
        "UPDATE public_league_releases SET enabled=false WHERE league_id=$1",
        [actor.leagueId],
      );
      const preserved = (
        await tx.query(
          "UPDATE runtime_franchise_outbox SET status='held',error='REHEARSAL_PRIOR_INTENT_PRESERVED' WHERE league_id=$1 AND status='pending' RETURNING id",
          [actor.leagueId],
        )
      ).rows;
      await receipt(tx, "rehearsal.arming", {
        leagueId: actor.leagueId,
        epoch: request.epoch,
        originalHost: original,
        capMicros: request.capMicros,
        walletsUnchanged: true,
        preservedFranchiseIntents: preserved.map((r) => r.id),
        operatorEvidenceRef: request.operatorEvidenceRef,
        onboarding,
      });
      return row;
    });
    if (prepared.status === "armed") return prepared;
    const original = prepared.original_host;
    const switched = await bindHost(this.db, actor, {
      leagueId: actor.leagueId,
      expectedVersion: request.expectedHostVersion,
      host: "mfl",
      config: {
        ...original.config,
        leagueId: "46625",
        configRef: request.trialConfigRef,
      },
      idempotencyKey: "rehearsal:" + request.epoch + ":arm",
      reason: request.reason,
    });
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      check(
        fingerprint(await hostBinding(tx, actor.leagueId)) ===
          fingerprint(switched.binding),
        "REHEARSAL_HOST_DRIFT",
      );
      const current = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2",
          [actor.leagueId, request.epoch],
        )
      ).rows[0];
      if (current?.status === "armed") return current;
      const row = (
        await tx.query(
          "UPDATE runtime_rehearsals SET status='armed',trial_host=$3 WHERE league_id=$1 AND epoch=$2 AND status='arming' RETURNING *",
          [actor.leagueId, request.epoch, switched.binding],
        )
      ).rows[0];
      check(row, "REHEARSAL_STATE_CHANGED");
      await receipt(tx, "rehearsal.armed", {
        leagueId: actor.leagueId,
        epoch: request.epoch,
        host: switched.binding,
        hostReceiptId: switched.receiptId,
        modelsStarted: false,
      });
      return row;
    });
  }
  async wakeOwner(
    actor: Actor,
    input: { epoch: string; agentId: string; causalId: string; reason: string },
  ) {
    authorize(actor);
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const row = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2 AND status='armed'",
          [actor.leagueId, input.epoch],
        )
      ).rows[0];
      check(row, "REHEARSAL_NOT_ARMED");
      const job = await this.runtime.ingestEventTx(tx, {
        agentId: input.agentId,
        causalId: "rehearsal:" + input.epoch + ":" + input.causalId,
        priority: "urgent",
        payload: {
          kind: "rehearsal.owner",
          rehearsal: {
            epoch: input.epoch,
            hostVersion: row.trial_host.version,
            nativeLeagueId: "46625",
            disposableFootball: true,
            modelExecution: row.synthetic ? "synthetic-test" : "real-model",
          },
          instruction: input.reason,
        },
      });
      await tagRehearsalWake(tx, {
        jobId: job.id,
        leagueId: actor.leagueId,
        hostVersion: row.trial_host.version,
        source: "operator",
      });
      return job;
    });
  }
  async stop(actor: Actor, input: { epoch: string; reason: string }) {
    authorize(actor);
    check(input.reason.length >= 10, "REHEARSAL_REASON_REQUIRED");
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const row = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2 FOR UPDATE",
          [actor.leagueId, input.epoch],
        )
      ).rows[0];
      check(
        row && ["armed", "stopped"].includes(row.status),
        "REHEARSAL_NOT_ARMED",
      );
      if (row.status === "stopped") return row;
      const observer = (
        await tx.query(
          "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_mfl_draft_observers WHERE league_id=$1 FOR UPDATE",
          [actor.leagueId],
        )
      ).rows[0];
      if (observer?.status === "active") {
        check(!observer.live, "REHEARSAL_OBSERVER_IN_FLIGHT");
        check(
          observer.host_version === row.trial_host.version &&
            fingerprint(observer.host_identity) ===
              fingerprint(row.trial_host.config),
          "REHEARSAL_OBSERVER_HOST_DRIFT",
        );
        await tx.query(
          "UPDATE runtime_mfl_draft_observers SET status='held',hold_reason='REHEARSAL_STOPPED',fence=fence+1,lease_until=NULL WHERE league_id=$1",
          [actor.leagueId],
        );
        await receipt(tx, "rehearsal.observer_held", {
          leagueId: actor.leagueId,
          epoch: input.epoch,
          observerEpoch: observer.epoch,
          previousFence: observer.fence,
        });
      }
      await quiescent(tx, actor.leagueId);
      await tx.query(
        "UPDATE runtime_agents a SET enabled=false FROM runtime_rehearsal_owners o WHERE o.agent_id=a.id AND o.league_id=$1 AND o.epoch=$2",
        [actor.leagueId, input.epoch],
      );
      const cancelled = (
        await tx.query(
          "UPDATE runtime_jobs j SET status='cancelled',error='REHEARSAL_STOPPED_PENDING' FROM runtime_rehearsal_jobs x WHERE x.job_id=j.id AND x.league_id=$1 AND x.epoch=$2 AND j.status='pending' RETURNING j.id",
          [actor.leagueId, input.epoch],
        )
      ).rows;
      const unsent = (
        await tx.query(
          "UPDATE runtime_football_outbox o SET status='dead',error='REHEARSAL_STOPPED_UNSENT' FROM runtime_rehearsal_jobs j WHERE j.job_id=o.job_id AND j.league_id=$1 AND j.epoch=$2 AND o.status='pending' AND o.attempts=0 RETURNING o.id",
          [actor.leagueId, input.epoch],
        )
      ).rows;
      await receipt(tx, "rehearsal.stopped", {
        leagueId: actor.leagueId,
        epoch: input.epoch,
        reason: input.reason,
        cancelledJobs: cancelled.map((x) => x.id),
        discardedNeverDispatchedIntents: unsent.map((x) => x.id),
        walletsUnchanged: true,
      });
      return (
        await tx.query(
          "UPDATE runtime_rehearsals SET status='stopped' WHERE league_id=$1 AND epoch=$2 RETURNING *",
          [actor.leagueId, input.epoch],
        )
      ).rows[0];
    });
  }
  async restore(actor: Actor, input: { epoch: string; reason: string }) {
    authorize(actor);
    check(input.reason.length >= 10, "REHEARSAL_REASON_REQUIRED");
    const row = await transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      const r = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2 FOR UPDATE",
          [actor.leagueId, input.epoch],
        )
      ).rows[0];
      check(
        r && ["stopped", "restoring", "restored"].includes(r.status),
        "REHEARSAL_MUST_STOP",
      );
      if (r.status === "restored") return r;
      await quiescent(tx, actor.leagueId);
      check(
        (await owners(tx, actor.leagueId)).every((o) => !o.enabled),
        "REHEARSAL_OWNERS_NOT_PAUSED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_football_outbox o JOIN runtime_rehearsal_jobs j ON j.job_id=o.job_id WHERE j.league_id=$1 AND j.epoch=$2 AND o.status NOT IN ('delivered','dead')",
            [actor.leagueId, input.epoch],
          )
        ).rowCount,
        "REHEARSAL_NATIVE_INTENTS_NOT_TERMINAL",
      );
      check(
        !(await unresolvedNative(tx, r)).length,
        "REHEARSAL_NATIVE_OUTCOME_UNKNOWN",
      );
      if (r.status === "stopped")
        check(
          fingerprint(await hostBinding(tx, actor.leagueId)) ===
            fingerprint(r.trial_host),
          "REHEARSAL_HOST_DRIFT",
        );
      await tx.query(
        "UPDATE runtime_rehearsals SET status='restoring' WHERE league_id=$1 AND epoch=$2",
        [actor.leagueId, input.epoch],
      );
      return r;
    });
    if (row.status === "restored") return row;
    const restored = await bindHost(this.db, actor, {
      leagueId: actor.leagueId,
      expectedVersion: row.trial_host.version,
      host: "mfl",
      config: row.original_host.config,
      idempotencyKey: "rehearsal:" + input.epoch + ":restore",
      reason: input.reason,
    });
    return transaction(this.db, async (tx) => {
      await lock(tx, actor.leagueId);
      check(
        fingerprint(await hostBinding(tx, actor.leagueId)) ===
          fingerprint(restored.binding),
        "REHEARSAL_HOST_DRIFT",
      );
      const current = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2",
          [actor.leagueId, input.epoch],
        )
      ).rows[0];
      if (current?.status === "restored") return current;
      await receipt(tx, "rehearsal.restored", {
        leagueId: actor.leagueId,
        epoch: input.epoch,
        host: restored.binding,
        hostReceiptId: restored.receiptId,
        walletsUnchanged: true,
        productionOwnersEnabled: false,
        publicReleaseEnabled: false,
      });
      return (
        await tx.query(
          "UPDATE runtime_rehearsals SET status='restored' WHERE league_id=$1 AND epoch=$2 RETURNING *",
          [actor.leagueId, input.epoch],
        )
      ).rows[0];
    });
  }
  async status(actor: Actor) {
    authorize(actor);
    const epochs = (
      await this.db.query(
        "SELECT * FROM runtime_rehearsals WHERE league_id=$1 ORDER BY configured_at DESC LIMIT 10",
        [actor.leagueId],
      )
    ).rows;
    return {
      leagueId: actor.leagueId,
      host: await hostBinding(this.db, actor.leagueId),
      epochs,
      owners: await Promise.all(
        (await owners(this.db, actor.leagueId)).map(async (o) => ({
          agentId: o.agent_id,
          model: o.model,
          enabled: o.enabled,
          budgetMicros: Number(o.budget_micros),
          spentMicros: Number(o.spent_micros),
          reservedMicros: Number(o.reserved_micros),
          rehearsal: await this.context(o.agent_id),
        })),
      ),
    };
  }
  async context(agentId: string) {
    const row = (
      await this.db.query(
        "SELECT r.* FROM runtime_rehearsals r JOIN runtime_rehearsal_owners o ON o.league_id=r.league_id AND o.epoch=r.epoch WHERE o.agent_id=$1 AND r.status<>'restored'",
        [agentId],
      )
    ).rows[0];
    if (!row) return null;
    return {
      epoch: row.epoch,
      status: row.status,
      preparedRules: await boundPreparedRulesContext(this.db, row),
      host: row.trial_host,
      capMicros: Number(row.cap_micros),
      usage: await rehearsalUsage(this.db, row.league_id, row.epoch, agentId),
      disposableFootball: true,
      modelExecution: row.synthetic ? "synthetic-test" : "real-model",
      allowedActions: [
        "remember",
        "football draft",
        "football local draft queue",
      ],
      activePermissions: [
        "remember",
        "football",
        "mfl_read",
        "research_sources",
        "research_search",
        "research_retrieve",
      ],
      publicationAllowed: false,
      instruction:
        "This is a disclosed draft rehearsal in disposable MFL46625. Use your actual assigned model and existing canonical wallet. Never claim these picks are live-season production decisions; do not publish or message production Buzz. Only draft, local draft preferences, and private memory actions are permitted.",
    };
  }
}
