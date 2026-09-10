import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { fingerprint } from "../governance/validation.js";
const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const pauseSchema = z
  .object({
    meetingId: identifier,
    idempotencyKey: z.string().min(1).max(160),
    expectedHostVersion: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
  })
  .strict();
const resumeSchema = z
  .object({
    pauseId: z.uuid(),
    proposalExtensionMs: z.number().int().min(0).max(1800000).default(0),
    idempotencyKey: z.string().min(1).max(160),
    reason: z.string().min(1).max(2000),
  })
  .strict();
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw Error(code);
}
export async function activeConventionPause(
  tx: Pick<Db, "query">,
  leagueId: string,
  meetingId?: string,
) {
  return (
    (
      await tx.query(
        "SELECT id,meeting_id,paused_at FROM runtime_convention_pauses WHERE league_id=$1 AND status='paused' AND ($2::text IS NULL OR meeting_id=$2)",
        [leagueId, meetingId ?? null],
      )
    ).rows[0] ?? null
  );
}
export async function assertConventionNotPaused(
  tx: Pick<Db, "query">,
  leagueId: string,
  meetingId?: string,
) {
  check(
    !(await activeConventionPause(tx, leagueId, meetingId)),
    "CONVENTION_PAUSED",
  );
}
async function quiet(tx: Tx, leagueId: string) {
  const agents = (
    await tx.query(
      "SELECT a.id,a.enabled FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 AND a.kind='ai' ORDER BY a.id FOR NO KEY UPDATE OF a",
      [leagueId],
    )
  ).rows;
  check(
    agents.length === 10 && agents.every((a) => !a.enabled),
    "CONVENTION_PAUSE_OWNERS_MUST_BE_DISABLED",
  );
  check(
    !(
      await tx.query(
        "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' UNION ALL SELECT 1 FROM runtime_franchise_outbox WHERE league_id=$1 AND status='running' UNION ALL SELECT 1 FROM runtime_football_outbox WHERE league_id=$1 AND status='running'",
        [leagueId],
      )
    ).rowCount,
    "CONVENTION_PAUSE_NOT_QUIESCENT",
  );
}
async function frozenContent(tx: Tx, leagueId: string, meetingId: string) {
  const proposals = (
    await tx.query(
      "SELECT * FROM mfl_governance_proposals WHERE league_id=$1 AND meeting_id=$2 ORDER BY id",
      [leagueId, meetingId],
    )
  ).rows;
  const votes = (
    await tx.query(
      "SELECT v.* FROM mfl_governance_votes v JOIN mfl_governance_proposals p ON p.league_id=v.league_id AND p.id=v.proposal_id WHERE p.league_id=$1 AND p.meeting_id=$2 ORDER BY v.proposal_id,v.team_id",
      [leagueId, meetingId],
    )
  ).rows;
  return {
    hash: fingerprint(JSON.parse(JSON.stringify({ proposals, votes }))),
    proposalIds: proposals.map((p) => ({
      id: p.id,
      hash: p.content_hash,
      version: p.version,
    })),
    votes: votes.map((v) => ({
      proposalId: v.proposal_id,
      teamId: v.team_id,
      choice: v.choice,
    })),
  };
}
async function snapshot(tx: Tx, leagueId: string, meetingId: string) {
  const meeting = (
    await tx.query(
      "SELECT * FROM mfl_governance_meetings WHERE league_id=$1 AND id=$2 FOR UPDATE",
      [leagueId, meetingId],
    )
  ).rows[0];
  const convention = (
    await tx.query(
      "SELECT * FROM runtime_conventions WHERE league_id=$1 AND meeting_id=$2 FOR UPDATE",
      [leagueId, meetingId],
    )
  ).rows[0];
  const waves = (
    await tx.query(
      "SELECT wave,phase,due_at,expires_at,status,completed_at FROM runtime_convention_waves WHERE league_id=$1 AND meeting_id=$2 ORDER BY due_at,wave FOR UPDATE",
      [leagueId, meetingId],
    )
  ).rows;
  check(
    meeting && convention && convention.status === "active",
    "CONVENTION_PAUSE_ACTIVE_MFL_MEETING_REQUIRED",
  );
  return { meeting, convention, waves };
}
/** Operator-only control. No backdated times, owner enabling, budget changes or native writes. */
export class ConventionControlService {
  constructor(private db: Db) {}
  async pause(actor: Actor, input: z.input<typeof pauseSchema>) {
    const v = pauseSchema.parse(input);
    return this.control(
      actor,
      v.idempotencyKey,
      { type: "pause", ...v },
      async (tx) => {
        await quiet(tx, actor.leagueId);
        await assertConventionNotPaused(tx, actor.leagueId);
        const before = await snapshot(tx, actor.leagueId, v.meetingId);
        const host = (
          await tx.query(
            "SELECT host,version FROM league_host_bindings WHERE league_id=$1",
            [actor.leagueId],
          )
        ).rows[0];
        check(
          host?.host === "mfl" &&
            host.version === v.expectedHostVersion &&
            before.meeting.host_version === host.version &&
            before.convention.host_version === host.version,
          "CONVENTION_PAUSE_HOST_CHANGED",
        );
        const pausedAt = (
          await tx.query(
            "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          )
        ).rows[0].now;
        check(
          pausedAt < before.meeting.vote_deadline,
          "CONVENTION_PAUSE_WINDOW_CLOSED",
        );
        check(
          !(
            await tx.query(
              "SELECT 1 FROM mfl_governance_approvals WHERE league_id=$1 AND host_version=$2",
              [actor.leagueId, host.version],
            )
          ).rowCount,
          "CONVENTION_PAUSE_ALREADY_APPROVED",
        );
        const content = await frozenContent(tx, actor.leagueId, v.meetingId),
          id = randomUUID();
        await tx.query(
          "INSERT INTO runtime_convention_pauses(id,league_id,meeting_id,host_version,paused_at,status,before_snapshot,frozen_content_hash,paused_by,reason) VALUES($1,$2,$3,$4,$5,'paused',$6,$7,$8,$9)",
          [
            id,
            actor.leagueId,
            v.meetingId,
            host.version,
            pausedAt,
            { ...before, content },
            content.hash,
            actor.id,
            v.reason,
          ],
        );
        return {
          pauseId: id,
          meetingId: v.meetingId,
          status: "paused",
          pausedAt: pausedAt.toISOString(),
          deadlines: {
            discussionOpensAt: before.meeting.discussion_opens_at,
            proposalDeadline: before.meeting.proposal_deadline,
            voteDeadline: before.meeting.vote_deadline,
          },
          contentHash: content.hash,
          proposalCount: content.proposalIds.length,
          voteCount: content.votes.length,
          workersEnabled: false,
          nativeWrites: false,
        };
      },
    );
  }
  async resume(actor: Actor, input: z.input<typeof resumeSchema>) {
    return this.resumeInternal(actor, input, false);
  }
  /** One common recovery allocation, without increasing the original money limits. */
  async resumeVotingRecovery(
    actor: Actor,
    input: { pauseId: string; idempotencyKey: string; reason: string },
  ) {
    const v = resumeSchema.omit({ proposalExtensionMs: true }).parse(input);
    return this.resumeInternal(actor, v, true);
  }
  private async resumeInternal(
    actor: Actor,
    input: z.input<typeof resumeSchema>,
    votingRecovery: boolean,
  ) {
    const v = resumeSchema.parse(input);
    return this.control(
      actor,
      v.idempotencyKey,
      { type: votingRecovery ? "resumeVotingRecovery" : "resume", ...v },
      async (tx) => {
        await quiet(tx, actor.leagueId);
        const p = (
          await tx.query(
            "SELECT * FROM runtime_convention_pauses WHERE id=$1 AND league_id=$2 FOR UPDATE",
            [v.pauseId, actor.leagueId],
          )
        ).rows[0];
        check(p?.status === "paused", "CONVENTION_PAUSE_NOT_ACTIVE");
        const before = await snapshot(tx, actor.leagueId, p.meeting_id);
        const host = (
          await tx.query(
            "SELECT host,version FROM league_host_bindings WHERE league_id=$1",
            [actor.leagueId],
          )
        ).rows[0];
        check(
          host?.host === "mfl" && host.version === p.host_version,
          "CONVENTION_PAUSE_HOST_CHANGED",
        );
        // JSON roundtrip normalizes Dates exactly as the persisted snapshot.
        check(
          fingerprint(JSON.parse(JSON.stringify(before))) ===
            fingerprint({
              meeting: p.before_snapshot.meeting,
              convention: p.before_snapshot.convention,
              waves: p.before_snapshot.waves,
            }),
          "CONVENTION_PAUSE_STATE_CHANGED",
        );
        const content = await frozenContent(tx, actor.leagueId, p.meeting_id);
        check(
          content.hash === p.frozen_content_hash,
          "CONVENTION_PAUSE_CONTENT_CHANGED",
        );
        check(
          v.proposalExtensionMs === 0 ||
            (p.paused_at < before.meeting.proposal_deadline &&
              content.votes.length === 0),
          "CONVENTION_PROPOSAL_EXTENSION_REQUIRES_PREVOTE_PAUSE",
        );
        if (votingRecovery) {
          check(
            p.paused_at >= before.meeting.proposal_deadline &&
              p.paused_at < before.meeting.vote_deadline,
            "CONVENTION_RECOVERY_VOTING_PAUSE_REQUIRED",
          );
          check(
            !before.waves.some((w: any) => w.wave === "voting-recovery"),
            "CONVENTION_RECOVERY_ALREADY_GRANTED",
          );
          check(
            !before.waves.some(
              (w: any) => w.phase === "voting" && w.status === "pending",
            ),
            "CONVENTION_RECOVERY_PRIOR_WAVES_PENDING",
          );
          check(
            !(
              await tx.query(
                "SELECT 1 FROM runtime_convention_control_receipts WHERE league_id=$1 AND response->>'meetingId'=$2 AND response->>'recoveryVotingTurn'='true'",
                [actor.leagueId, p.meeting_id],
              )
            ).rowCount,
            "CONVENTION_RECOVERY_ALREADY_GRANTED",
          );
        }
        const resumedAt = (
          await tx.query(
            "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          )
        ).rows[0].now;
        const durationMs = resumedAt.getTime() - p.paused_at.getTime();
        check(
          durationMs >= 0 && durationMs <= 86400000,
          "CONVENTION_PAUSE_DURATION_OUT_OF_RANGE",
        );
        const total =
          Number(
            (
              await tx.query(
                "SELECT COALESCE(sum(duration_ms),0)::text AS total FROM runtime_convention_pauses WHERE league_id=$1 AND meeting_id=$2",
                [actor.leagueId, p.meeting_id],
              )
            ).rows[0].total,
          ) + durationMs;
        check(total <= 86400000, "CONVENTION_PAUSE_CUMULATIVE_LIMIT");
        const cumulativeProposalExtensionMs =
          Number(
            (
              await tx.query(
                "SELECT COALESCE(sum((response->>'proposalExtensionMs')::bigint),0)::text AS total FROM runtime_convention_control_receipts WHERE league_id=$1 AND response->>'meetingId'=$2 AND response->>'status'='resumed'",
                [actor.leagueId, p.meeting_id],
              )
            ).rows[0].total,
          ) + v.proposalExtensionMs;
        check(
          cumulativeProposalExtensionMs <= 1800000,
          "CONVENTION_PROPOSAL_EXTENSION_CUMULATIVE_LIMIT",
        );
        for (const table of [
          "mfl_governance_meetings",
          "runtime_conventions",
        ]) {
          const idColumn =
            table === "runtime_conventions" ? "meeting_id" : "id";
          await tx.query(
            `UPDATE ${table} SET discussion_opens_at=CASE WHEN discussion_opens_at>$3 THEN discussion_opens_at+$4::bigint*interval '1 millisecond' ELSE discussion_opens_at END,proposal_deadline=CASE WHEN proposal_deadline>$3 THEN proposal_deadline+($4::bigint+$5::bigint)*interval '1 millisecond' ELSE proposal_deadline END,vote_deadline=CASE WHEN vote_deadline>$3 THEN vote_deadline+($4::bigint+$5::bigint)*interval '1 millisecond' ELSE vote_deadline END WHERE league_id=$1 AND ${idColumn}=$2`,
            [
              actor.leagueId,
              p.meeting_id,
              p.paused_at,
              durationMs,
              v.proposalExtensionMs,
            ],
          );
        }
        await tx.query(
          "UPDATE runtime_convention_waves SET due_at=due_at+($3::bigint+CASE WHEN due_at>=$5 THEN $4::bigint ELSE 0 END)*interval '1 millisecond',expires_at=expires_at+($3::bigint+CASE WHEN expires_at>=$5 THEN $4::bigint ELSE 0 END)*interval '1 millisecond' WHERE league_id=$1 AND meeting_id=$2 AND status='pending'",
          [
            actor.leagueId,
            p.meeting_id,
            durationMs,
            v.proposalExtensionMs,
            before.meeting.proposal_deadline,
          ],
        );
        let recoveryExtensionMs = 0;
        if (votingRecovery) {
          const shiftedDeadline = new Date(
            before.meeting.vote_deadline.getTime() + durationMs,
          );
          recoveryExtensionMs = Math.max(
            0,
            resumedAt.getTime() + 600000 - shiftedDeadline.getTime(),
          );
          for (const table of [
            "mfl_governance_meetings",
            "runtime_conventions",
          ]) {
            const idColumn =
              table === "runtime_conventions" ? "meeting_id" : "id";
            await tx.query(
              `UPDATE ${table} SET vote_deadline=vote_deadline+$3::bigint*interval '1 millisecond' WHERE league_id=$1 AND ${idColumn}=$2`,
              [actor.leagueId, p.meeting_id, recoveryExtensionMs],
            );
          }
          await tx.query(
            "UPDATE runtime_convention_waves SET due_at=due_at+$3::bigint*interval '1 millisecond',expires_at=expires_at+$3::bigint*interval '1 millisecond' WHERE league_id=$1 AND meeting_id=$2 AND status='pending' AND phase='closed'",
            [actor.leagueId, p.meeting_id, recoveryExtensionMs],
          );
          await tx.query(
            "INSERT INTO runtime_convention_waves(league_id,meeting_id,wave,phase,due_at,expires_at) SELECT league_id,meeting_id,'voting-recovery','voting',$3,vote_deadline FROM runtime_conventions WHERE league_id=$1 AND meeting_id=$2",
            [actor.leagueId, p.meeting_id, resumedAt],
          );
          check(
            (await frozenContent(tx, actor.leagueId, p.meeting_id)).hash ===
              content.hash,
            "CONVENTION_RECOVERY_CONTENT_CHANGED",
          );
        }
        const after = await snapshot(tx, actor.leagueId, p.meeting_id);
        await tx.query(
          "UPDATE runtime_convention_pauses SET status='resumed',resumed_at=$2,duration_ms=$3,resumed_by=$4,resume_reason=$5,after_snapshot=$6 WHERE id=$1",
          [p.id, resumedAt, durationMs, actor.id, v.reason, after],
        );
        return {
          pauseId: p.id,
          meetingId: p.meeting_id,
          status: "resumed",
          pausedAt: p.paused_at.toISOString(),
          resumedAt: resumedAt.toISOString(),
          durationMs,
          cumulativePauseMs: total,
          proposalExtensionMs: v.proposalExtensionMs,
          cumulativeProposalExtensionMs,
          recoveryVotingTurn: votingRecovery,
          recoveryExtensionMs,
          recoveryMinimumVotingWindowMs: votingRecovery ? 600000 : null,
          recoveryOwners: votingRecovery
            ? (
                await tx.query(
                  "SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 AND a.kind='ai' ORDER BY a.id",
                  [actor.leagueId],
                )
              ).rows.map((r) => r.id)
            : [],
          limitsUnchanged: true,
          contentHash: content.hash,
          deadlines: {
            discussionOpensAt: after.meeting.discussion_opens_at,
            proposalDeadline: after.meeting.proposal_deadline,
            voteDeadline: after.meeting.vote_deadline,
          },
          workersEnabled: false,
          nativeWrites: false,
        };
      },
    );
  }
  private async control(
    actor: Actor,
    key: string,
    request: unknown,
    work: (tx: Tx) => Promise<Record<string, unknown>>,
  ) {
    check(
      actor.role === "commissioner",
      "CONVENTION_CONTROL_COMMISSIONER_REQUIRED",
    );
    return transaction(this.db, async (tx) => {
      await quiet(tx, actor.leagueId);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const requestHash = fingerprint({ actor, request });
      const old = (
        await tx.query(
          "SELECT * FROM runtime_convention_control_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [actor.leagueId, actor.id, key],
        )
      ).rows[0];
      if (old) {
        check(
          old.request_hash === requestHash,
          "CONVENTION_CONTROL_IDEMPOTENCY_CONFLICT",
        );
        return { ...old.response, replayed: true };
      }
      const response = {
        receiptId: randomUUID(),
        ...(await work(tx)),
        replayed: false,
      };
      await tx.query(
        "INSERT INTO runtime_convention_control_receipts(league_id,actor_id,idempotency_key,request_hash,response) VALUES($1,$2,$3,$4,$5)",
        [actor.leagueId, actor.id, key, requestHash, response],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('convention.control',$1)",
        [{ actorId: actor.id, leagueId: actor.leagueId, request, response }],
      );
      return response;
    });
  }
}
