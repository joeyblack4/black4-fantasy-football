/** Explicit conversation authority. It never starts a draft, changes an invoice or creates a wake. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { hostBinding } from "../league/host.js";
import { fingerprint } from "../governance/validation.js";
import { RuntimeError, type Job, type Action } from "./index.js";
const check = (v: unknown, code: string) => {
  if (!v) throw new RuntimeError(code);
};
export const ConversationOpenSchema = z
  .object({
    epoch: z.string().min(1).max(120),
    expectedHostVersion: z.number().int().positive(),
    channelIds: z
      .array(z.uuid())
      .min(1)
      .max(5)
      .refine((a) => new Set(a).size === a.length),
    expiresAt: z.iso.datetime(),
    maxTurnsPerOwner: z.number().int().min(1).max(20),
    maxSpendMicrosPerOwner: z.number().int().positive().max(20_000_000),
    idempotencyKey: z.string().min(1).max(120),
    reason: z.string().min(10).max(2000),
  })
  .strict();
export function conversationLeagueClosedPredicate(expression: string) {
  if (!/^[a-z_.]+$/.test(expression))
    throw Error("INVALID_INTERNAL_EXPRESSION");
  return `NOT EXISTS(SELECT 1 FROM runtime_conversation_sessions cs WHERE cs.league_id=${expression} AND cs.status='active')`;
}
export async function assertNoConversationSession(
  tx: Pick<Db, "query">,
  leagueId: string,
) {
  check(
    !(
      await tx.query(
        "SELECT 1 FROM runtime_conversation_sessions WHERE league_id=$1 AND status='active'",
        [leagueId],
      )
    ).rowCount,
    "CONVERSATION_NATIVE_WORK_HELD",
  );
}
/** Financial freezes are distinct from the deliberate autonomous-work pause. Never override them for chat. */
export function conversationFinancialClearPredicate(agentExpression: string) {
  if (!/^[a-z_.]+$/.test(agentExpression))
    throw Error("INVALID_INTERNAL_EXPRESSION");
  return `(NOT EXISTS(SELECT 1 FROM runtime_receipts cf WHERE cf.agent_id=${agentExpression} AND (cf.type='budget.overrun' OR cf.type='budget.reconciled' AND cf.details->>'exceedsReservation'='true')) AND NOT EXISTS(SELECT 1 FROM franchise_expenses ce WHERE ce.agent_id=${agentExpression} AND ce.status='settled' AND ce.actual_micros>ce.reserved_micros))`;
}
export function conversationClaimPredicate(
  alias: string,
  sessionParameter: string,
) {
  if (!/^[a-z_]+$/.test(alias) || !/^\$\d+$/.test(sessionParameter))
    throw Error("INVALID_INTERNAL_ALIAS");
  return `EXISTS(SELECT 1 FROM runtime_conversation_jobs cj JOIN runtime_conversation_sessions cs ON cs.id=cj.session_id WHERE cj.job_id=${alias}.id AND cj.agent_id=${alias}.agent_id AND cs.id=${sessionParameter}::uuid AND cs.status='active' AND cs.expires_at>clock_timestamp() AND ${conversationFinancialClearPredicate(alias + ".agent_id")})`;
}
export function ordinaryConversationFence(alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw Error("INVALID_INTERNAL_ALIAS");
  return `NOT EXISTS(SELECT 1 FROM runtime_bindings cb JOIN runtime_conversation_sessions cs ON cs.league_id=cb.league_id WHERE cb.agent_id=${alias}.agent_id AND cs.status='active')`;
}
async function bindings(tx: Pick<Db, "query">, leagueId: string) {
  return (
    await tx.query(
      "SELECT a.id AS agent_id,b.team_id,t.owner_id,a.model,a.enabled,a.kind,m.id AS manifest_id,m.document,m.key_fingerprint FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id LEFT JOIN provider_manifests m ON m.agent_id=a.id AND m.league_id=b.league_id AND m.status='active' WHERE b.league_id=$1 AND t.kind='ai' ORDER BY a.id",
      [leagueId],
    )
  ).rows;
}
function pin(row: any) {
  const { enabled, ...rest } = row;
  return fingerprint(rest);
}
async function log(
  tx: Tx,
  type: string,
  details: any,
  agentId: string | null = null,
  jobId: string | null = null,
) {
  const id = randomUUID();
  await tx.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES($1,$2,$3,$4)",
    [type, agentId, jobId, { ...details, receiptId: id }],
  );
  return id;
}
async function authority(
  tx: Pick<Db, "query">,
  job: Pick<Job, "id" | "agentId">,
) {
  const row = (
    await tx.query(
      "SELECT s.*,s.expires_at>clock_timestamp() AS session_live,cj.event_id,cj.event_hash,cj.channel_id,o.binding_hash,j.execution_mode FROM runtime_conversation_jobs cj JOIN runtime_conversation_sessions s ON s.id=cj.session_id JOIN runtime_conversation_owners o ON o.session_id=s.id AND o.agent_id=cj.agent_id JOIN runtime_jobs j ON j.id=cj.job_id WHERE cj.job_id=$1 AND cj.agent_id=$2",
      [job.id, job.agentId],
    )
  ).rows[0];
  if (!row) return null;
  check(
    fingerprint(row.configuration) === row.request_hash,
    "CONVERSATION_CONFIGURATION_DRIFT",
  );
  check(
    row.execution_mode === "conversation" &&
      row.status === "active" &&
      row.session_live,
    "CONVERSATION_AUTHORITY_CLOSED",
  );
  check(
    fingerprint(await hostBinding(tx as Tx, row.league_id)) ===
      fingerprint(row.host_snapshot),
    "CONVERSATION_HOST_DRIFT",
  );
  const owner = (await bindings(tx, row.league_id)).find(
    (o) => o.agent_id === job.agentId,
  );
  check(owner && pin(owner) === row.binding_hash, "CONVERSATION_OWNER_DRIFT");
  check(
    !(
      await tx.query(
        `SELECT 1 FROM runtime_agents fa WHERE fa.id=$1 AND NOT ${conversationFinancialClearPredicate("fa.id")}`,
        [job.agentId],
      )
    ).rowCount,
    "CONVERSATION_FINANCIAL_FREEZE",
  );
  const event = (
    await tx.query(
      "SELECT e.payload_hash FROM buzz_archive_events e JOIN buzz_conversations c ON c.league_id=e.league_id AND c.channel_id=e.channel_id JOIN buzz_participants p ON p.league_id=e.league_id AND p.agent_id=$4 WHERE e.league_id=$1 AND e.event_id=$2 AND e.channel_id=$3 AND c.member_pubkeys ? p.pubkey",
      [row.league_id, row.event_id, row.channel_id, job.agentId],
    )
  ).rows[0];
  check(event?.payload_hash === row.event_hash, "CONVERSATION_EVENT_DRIFT");
  return row;
}
export async function assertConversationJob(
  tx: Pick<Db, "query">,
  job: Pick<Job, "id" | "agentId">,
) {
  const row = await authority(tx, job);
  if (!row) {
    const mode = (
      await tx.query("SELECT execution_mode FROM runtime_jobs WHERE id=$1", [
        job.id,
      ])
    ).rows[0]?.execution_mode;
    check(mode !== "conversation", "CONVERSATION_ADMISSION_REQUIRED");
    const b = (
      await tx.query(
        "SELECT league_id FROM runtime_bindings WHERE agent_id=$1",
        [job.agentId],
      )
    ).rows[0];
    if (b) await assertNoConversationSession(tx, b.league_id);
  }
  return row;
}
export async function conversationDeliveryEligibleTx(
  tx: Pick<Db, "query">,
  input: { leagueId: string; agentId: string; eventId: string },
) {
  const session = (
    await tx.query(
      "SELECT *,expires_at>clock_timestamp() AS session_live FROM runtime_conversation_sessions WHERE league_id=$1 AND status='active'",
      [input.leagueId],
    )
  ).rows[0];
  if (!session) return { eligible: true, sessionId: null };
  if (
    !session.session_live ||
    (
      await tx.query(
        `SELECT 1 FROM runtime_agents fa WHERE fa.id=$1 AND NOT ${conversationFinancialClearPredicate("fa.id")}`,
        [input.agentId],
      )
    ).rowCount
  )
    return { eligible: false, sessionId: session.id };
  const row = (
    await tx.query(
      `SELECT e.*,p.pubkey FROM buzz_archive_events e JOIN buzz_participants p ON p.league_id=e.league_id AND p.agent_id=$2 JOIN buzz_conversations c ON c.league_id=e.league_id AND c.channel_id=e.channel_id JOIN runtime_conversation_owners o ON o.agent_id=p.agent_id AND o.session_id=$4 WHERE e.league_id=$1 AND e.event_id=$3 AND c.member_pubkeys ? p.pubkey AND c.member_pubkeys ? e.author_pubkey`,
      [input.leagueId, input.agentId, input.eventId, session.id],
    )
  ).rows[0];
  return {
    sessionId: session.id,
    eligible: Boolean(
      row &&
      row.kind === 9 &&
      session.configuration.channelIds.includes(row.channel_id) &&
      +row.observed_at >= +session.opened_at &&
      Number(row.source_created_at) >= Math.ceil(+session.opened_at / 1000),
    ),
  };
}
export function conversationFranchisePredicate(alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw Error("INVALID_INTERNAL_ALIAS");
  return `((${conversationLeagueClosedPredicate(alias + ".league_id")} AND NOT EXISTS(SELECT 1 FROM runtime_conversation_jobs cj WHERE cj.job_id=${alias}.job_id)) OR (${alias}.action->>'type'='buzz_channel' AND EXISTS(SELECT 1 FROM runtime_conversation_jobs cj JOIN runtime_conversation_sessions cs ON cs.id=cj.session_id WHERE cj.job_id=${alias}.job_id AND cj.agent_id=${alias}.agent_id AND cs.status='active' AND cs.expires_at>clock_timestamp() AND ${conversationFinancialClearPredicate(alias + ".agent_id")})))`;
}
export async function assertConversationFranchise(
  tx: Tx,
  jobId: string,
  agentId: string,
  action: Action,
) {
  const s = await assertConversationJob(tx, { id: jobId, agentId });
  if (s)
    check(
      action.type === "buzz_channel" &&
        s.configuration.channelIds.includes(action.channelId),
      "CONVERSATION_ACTION_FORBIDDEN",
    );
  return Boolean(s);
}
export async function admitConversationDeliveryTx(
  tx: Tx,
  input: {
    leagueId: string;
    agentId: string;
    eventId: string;
    jobId: string;
    expectedSessionId?: string | null;
  },
) {
  const s = (
    await tx.query(
      "SELECT *,expires_at>clock_timestamp() AS session_live FROM runtime_conversation_sessions WHERE league_id=$1 AND status='active'",
      [input.leagueId],
    )
  ).rows[0];
  if (input.expectedSessionId)
    check(
      s?.id === input.expectedSessionId && s.session_live,
      "CONVERSATION_ADMISSION_AUTHORITY_CHANGED",
    );
  if (!s) return { status: "not-managed" };
  // Expired sessions stay closed to autonomous work until explicit commissioner close.
  if (!s.session_live) return { status: "expired" };
  const row = (
    await tx.query(
      `SELECT e.*,j.id AS job_id,j.payload,j.status AS job_status,j.execution_mode,p.pubkey AS recipient_pubkey FROM buzz_inbound_deliveries d JOIN buzz_archive_events e ON e.league_id=d.league_id AND e.event_id=d.event_id JOIN runtime_jobs j ON j.id=d.inbox_id AND j.agent_id=d.agent_id JOIN buzz_participants p ON p.league_id=d.league_id AND p.agent_id=d.agent_id JOIN buzz_conversations c ON c.league_id=e.league_id AND c.channel_id=e.channel_id JOIN buzz_participants sender ON sender.league_id=e.league_id AND sender.pubkey=e.author_pubkey WHERE d.league_id=$1 AND d.agent_id=$2 AND d.event_id=$3 AND d.inbox_id=$4 AND c.member_pubkeys ? p.pubkey AND c.member_pubkeys ? sender.pubkey`,
      [input.leagueId, input.agentId, input.eventId, input.jobId],
    )
  ).rows[0];
  check(
    row &&
      row.kind === 9 &&
      s.configuration.channelIds.includes(row.channel_id) &&
      +row.observed_at >= +s.opened_at &&
      Number(row.source_created_at) >= Math.ceil(+s.opened_at / 1000) &&
      row.job_status === "pending" &&
      row.payload.kind === "buzz.message" &&
      row.payload.eventId === row.event_id &&
      row.payload.channelId === row.channel_id &&
      row.payload.body === row.content &&
      row.payload.senderPubkey === row.author_pubkey &&
      row.payload.recipientPubkey === row.recipient_pubkey,
    "CONVERSATION_CANONICAL_DELIVERY_REQUIRED",
  );
  const pinned = (
    await tx.query(
      "SELECT 1 FROM runtime_conversation_owners WHERE session_id=$1 AND agent_id=$2",
      [s.id, input.agentId],
    )
  ).rowCount;
  check(pinned, "CONVERSATION_OWNER_NOT_ADMITTED");
  const prior = (
    await tx.query("SELECT * FROM runtime_conversation_jobs WHERE job_id=$1", [
      input.jobId,
    ])
  ).rows[0];
  if (prior) {
    check(
      prior.session_id === s.id &&
        prior.event_id === input.eventId &&
        prior.event_hash === row.payload_hash,
      "CONVERSATION_ADMISSION_CONFLICT",
    );
    return { status: "admitted", sessionId: s.id };
  }
  check(
    row.execution_mode === "owner" &&
      !(
        await tx.query("SELECT 1 FROM runtime_rehearsal_jobs WHERE job_id=$1", [
          input.jobId,
        ])
      ).rowCount,
    "CONVERSATION_EXISTING_JOB_SCOPE",
  );
  await tx.query(
    "INSERT INTO runtime_conversation_jobs(job_id,session_id,agent_id,event_id,event_hash,channel_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      input.jobId,
      s.id,
      input.agentId,
      input.eventId,
      row.payload_hash,
      row.channel_id,
    ],
  );
  await tx.query(
    "UPDATE runtime_jobs SET execution_mode='conversation',max_attempts=1 WHERE id=$1",
    [input.jobId],
  );
  await tx.query(
    "INSERT INTO runtime_rehearsal_jobs(job_id,league_id,epoch,agent_id,source) VALUES($1,$2,$3,$4,'conversation')",
    [input.jobId, input.leagueId, s.epoch, input.agentId],
  );
  await authority(tx, { id: input.jobId, agentId: input.agentId });
  await log(
    tx,
    "conversation.admitted",
    {
      sessionId: s.id,
      eventId: input.eventId,
      channelId: row.channel_id,
      eventHash: row.payload_hash,
    },
    input.agentId,
    input.jobId,
  );
  return { status: "admitted", sessionId: s.id };
}
export async function assertConversationBudget(
  tx: Tx,
  job: Job,
  amount: number,
) {
  const s = await authority(tx, job);
  if (!s) return;
  const usage = (
    await tx.query(
      `SELECT count(*)::int turns,COALESCE(sum(CASE WHEN r.status='released' THEN 0 WHEN r.status='settled' AND r.actual_micros IS NOT NULL THEN r.actual_micros ELSE GREATEST(r.amount_micros,COALESCE(r.observed_micros,0)) END),0)::text cost FROM runtime_reservations r JOIN runtime_conversation_jobs cj ON cj.job_id=r.job_id AND cj.agent_id=r.agent_id WHERE cj.session_id=$1 AND cj.agent_id=$2`,
      [s.id, job.agentId],
    )
  ).rows[0];
  check(
    usage.turns < s.configuration.maxTurnsPerOwner,
    "CONVERSATION_TURN_LIMIT",
  );
  check(
    Number(usage.cost) + amount <= s.configuration.maxSpendMicrosPerOwner,
    "CONVERSATION_SPEND_LIMIT",
  );
}
export async function assertConversationActions(
  tx: Tx,
  job: Job,
  actions: Action[],
  synthetic: boolean,
) {
  const s = await assertConversationJob(tx, job);
  if (!s) return false;
  const r = (
    await tx.query(
      "SELECT synthetic FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2",
      [s.league_id, s.epoch],
    )
  ).rows[0];
  check(r?.synthetic === synthetic, "CONVERSATION_PROVENANCE_CHANGED");
  check(
    actions.every(
      (a) =>
        a.type === "remember" ||
        (a.type === "buzz_channel" &&
          s.configuration.channelIds.includes(a.channelId)),
    ),
    "CONVERSATION_ACTION_FORBIDDEN",
  );
  check(
    actions.filter((a) => a.type === "buzz_channel").length <= 3,
    "CONVERSATION_OUTBOUND_LIMIT",
  );
  await log(
    tx,
    "conversation.decision",
    {
      sessionId: s.id,
      eventId: s.event_id,
      model: job.model,
      synthetic,
      actions: actions.length,
      nativeWriteAuthority: false,
    },
    job.agentId,
    job.id,
  );
  return true;
}
export class ConversationRuntime {
  constructor(readonly db: Db) {}
  async open(actor: Actor, input: z.input<typeof ConversationOpenSchema>) {
    check(actor.role === "commissioner", "CONVERSATION_COMMISSIONER_REQUIRED");
    const v = ConversationOpenSchema.parse(input);
    return transaction(this.db, async (tx) => {
      // API mutations hold the shared counterpart until their response settles.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7060))",
        [actor.leagueId],
      );
      await tx.query(
        "SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 ORDER BY a.id FOR NO KEY UPDATE OF a",
        [actor.leagueId],
      );
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const old = (
        await tx.query(
          "SELECT * FROM runtime_conversation_sessions WHERE league_id=$1 AND idempotency_key=$2",
          [actor.leagueId, v.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        check(
          old.request_hash === fingerprint(v),
          "CONVERSATION_IDEMPOTENCY_CONFLICT",
        );
        return old;
      }
      await assertNoConversationSession(tx, actor.leagueId);
      const rehearsal = (
        await tx.query(
          "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2 AND status IN('armed','stopped')",
          [actor.leagueId, v.epoch],
        )
      ).rows[0];
      const host = await hostBinding(tx, actor.leagueId);
      check(
        rehearsal &&
          host.version === v.expectedHostVersion &&
          fingerprint(host) === fingerprint(rehearsal.trial_host),
        "CONVERSATION_EXACT_HELD_EPOCH_REQUIRED",
      );
      check(
        v.maxSpendMicrosPerOwner <= Number(rehearsal.cap_micros),
        "CONVERSATION_CAP_CANNOT_EXPAND",
      );
      const databaseNow = +(await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      check(
        Date.parse(v.expiresAt) > databaseNow &&
          Date.parse(v.expiresAt) <= databaseNow + 4 * 3600000,
        "CONVERSATION_EXPIRY_LIMIT",
      );
      const owners = await bindings(tx, actor.leagueId);
      check(
        owners.length === (rehearsal.synthetic ? owners.length : 10) &&
          owners.length > 0 &&
          owners.every(
            (o) =>
              !o.enabled &&
              o.kind === "ai" &&
              (rehearsal.synthetic || o.manifest_id),
          ),
        "CONVERSATION_PAUSED_PINNED_OWNERS_REQUIRED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' UNION ALL SELECT 1 FROM runtime_football_outbox WHERE league_id=$1 AND status='running' UNION ALL SELECT 1 FROM runtime_franchise_outbox WHERE league_id=$1 AND status='running' UNION ALL SELECT 1 FROM runtime_mfl_draft_observers WHERE league_id=$1 AND (status='active' OR lease_until>clock_timestamp())",
            [actor.leagueId],
          )
        ).rowCount,
        "CONVERSATION_QUIESCENCE_REQUIRED",
      );
      for (const channel of v.channelIds) {
        const members = (
          await tx.query(
            "SELECT p.agent_id FROM buzz_conversations c JOIN buzz_participants p ON p.league_id=c.league_id AND c.member_pubkeys ? p.pubkey WHERE c.league_id=$1 AND c.channel_id=$2 AND c.kind='private-channel'",
            [actor.leagueId, channel],
          )
        ).rows;
        check(
          owners.every((o) => members.some((m) => m.agent_id === o.agent_id)),
          "CONVERSATION_CHANNEL_MEMBERS_REQUIRED",
        );
      }
      const id = randomUUID(),
        receiptId = randomUUID();
      await tx.query(
        "INSERT INTO runtime_conversation_sessions(id,league_id,epoch,host_snapshot,status,configuration,request_hash,idempotency_key,expires_at,actor_id,receipt_id) VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10)",
        [
          id,
          actor.leagueId,
          v.epoch,
          host,
          v,
          fingerprint(v),
          v.idempotencyKey,
          v.expiresAt,
          actor.id,
          receiptId,
        ],
      );
      for (const o of owners)
        await tx.query(
          "INSERT INTO runtime_conversation_owners(session_id,agent_id,binding_hash) VALUES($1,$2,$3)",
          [id, o.agent_id, pin(o)],
        );
      await tx.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('conversation.opened',$1)",
        [
          {
            receiptId,
            sessionId: id,
            leagueId: actor.leagueId,
            actorId: actor.id,
            configuration: v,
            host,
            nativeWritesEnabled: false,
            walletsUnchanged: true,
            ownersEnabled: false,
          },
        ],
      );
      return (
        await tx.query(
          "SELECT * FROM runtime_conversation_sessions WHERE id=$1",
          [id],
        )
      ).rows[0];
    });
  }
  async close(actor: Actor, input: { sessionId: string; reason: string }) {
    check(
      actor.role === "commissioner" && input.reason.length >= 10,
      "CONVERSATION_COMMISSIONER_REQUIRED",
    );
    return transaction(this.db, async (tx) => {
      // API mutations hold the shared counterpart until their response settles.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7060))",
        [actor.leagueId],
      );
      await tx.query(
        "SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 ORDER BY a.id FOR NO KEY UPDATE OF a",
        [actor.leagueId],
      );
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [actor.leagueId],
      );
      const s = (
        await tx.query(
          "SELECT * FROM runtime_conversation_sessions WHERE id=$1 AND league_id=$2 FOR UPDATE",
          [input.sessionId, actor.leagueId],
        )
      ).rows[0];
      check(s, "CONVERSATION_SESSION_REQUIRED");
      if (s.status === "closed") return s;
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running' UNION ALL SELECT 1 FROM runtime_franchise_outbox WHERE league_id=$1 AND status='running'",
            [actor.leagueId],
          )
        ).rowCount,
        "CONVERSATION_WORK_IN_FLIGHT",
      );
      // Returning to ordinary mode must still require a separate explicit owner enable/start.
      await tx.query(
        "UPDATE runtime_agents a SET enabled=false FROM runtime_bindings b WHERE b.agent_id=a.id AND b.league_id=$1",
        [actor.leagueId],
      );
      await tx.query(
        "UPDATE runtime_conversation_sessions SET status='closed',closed_at=clock_timestamp() WHERE id=$1",
        [s.id],
      );
      await log(tx, "conversation.closed", {
        sessionId: s.id,
        reason: input.reason,
        actorId: actor.id,
        pendingPreserved: true,
        ownersDisabled: true,
        draftResumed: false,
      });
      return { id: s.id, status: "closed" };
    });
  }
  async context(job: Job) {
    const s = await authority(this.db, job);
    check(s, "CONVERSATION_ADMISSION_REQUIRED");
    return {
      status: "conversation-only",
      sessionId: s.id,
      epoch: s.epoch,
      expiresAt: s.expires_at,
      configuration: s.configuration,
      activePermissions: ["buzz_read", "remember", "buzz_channel"],
      currentEventId: s.event_id,
      currentChannelId: s.channel_id,
      instruction:
        "You are the same franchise owner, using your existing private memories, brand and exact assigned model. Collaborate with Joey and the other owners in this private Buzz conversation. Draft and governance execution remain paused. Discuss rules or choices freely as proposals, never claim a vote or pick was executed. Only remember and buzz_channel actions are authorized, with at most three messages per turn; no schedules, staff, native writes or publication. Respond to the actual incoming message; do not resume old commitments. Held native operations and unknown charges remain unresolved.",
    };
  }
}
