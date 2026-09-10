import {
  harnessClaimPredicate,
  HarnessSelectionSchema,
  type HarnessSelection,
} from "./harness-assignment.js";
import {
  conversationClaimPredicate,
  ordinaryConversationFence,
  assertConversationJob,
  assertConversationBudget,
  assertConversationActions,
} from "./conversation.js";
import {
  rehearsalClaimPredicate,
  assertRehearsalClaim,
  assertRehearsalBudget,
  assertRehearsalCommit,
} from "./rehearsal.js";
import {
  reserveOwnerStageTurn,
  assertOwnerStageAction,
  recordOwnerStageSchedule,
  recordOwnerStageMemory,
} from "./owner-stage.js";
import { enqueueFranchise } from "../franchise/outbox.js";
import type { FranchiseAction } from "../franchise/schema.js";
import { enqueueFootball } from "./football-outbox.js";
import type { FootballAction } from "./football-schema.js";
import { reserveConventionTurn } from "./convention.js";
import { createHash, randomUUID } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";

export type Priority = "urgent" | "normal" | "background";
export type Job = {
  id: string;
  agentId: string;
  causalId: string;
  kind: "appointment" | "event" | "message" | "staff";
  priority?: Priority;
  role?: string;
  task?: string;
  parentJobId?: string;
  payload: Record<string, unknown>;
  dueAt: Date;
  sourceOccurredAt: Date | null;
  attempts: number;
  fence: number;
  workerId: string;
  leaseUntil: Date;
  model: string;
  memory: { key: string; content: string; version: number }[];
  recentMessages: Record<string, unknown>[];
  commitments: Record<string, unknown>[];
  rehearsal?: {
    epoch: string;
    hostVersion: number;
    nativeLeagueId: "46625";
    disposableFootball: true;
    modelExecution: "real-model" | "synthetic-test";
  };
};
export type Action =
  | FootballAction
  | FranchiseAction
  | { type: "delegate"; causalId: string; role: string; task: string }
  | { type: "cancel"; causalId: string }
  | { type: "remember"; key: string; content: string }
  | {
      type: "schedule";
      priority?: "normal" | "background";
      causalId: string;
      dueAt: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "message";
      causalId: string;
      recipientId: string;
      body: string;
      conversationId?: string;
      replyTo?: string;
    };
export type ScheduleInput = {
  priority?: "normal" | "background";
  causalId: string;
  dueAt: Date | string;
  payload: Record<string, unknown>;
};
export type MessageInput = {
  causalId: string;
  recipientId: string;
  body: string;
  conversationId?: string;
  replyTo?: string;
};
export type DriverResult = {
  actions: Action[];
  costMicros: number;
  /** Trusted adapter billing receipt; never accepted as a native model decision field. */
  costEvidenceId?: string;
  summary: string;
};
export type DriverRunContext = { signal: AbortSignal };
export interface AgentDriver {
  readonly name: string;
  readonly synthetic: boolean;
  readonly model: string;
  readonly harnessId?: string;
  readonly configDigest?: string;
  run(job: Job, context?: DriverRunContext): Promise<DriverResult>;
}
export class RuntimeError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
function assert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new RuntimeError(code);
}
function money(n: number) {
  assert(Number.isSafeInteger(n) && n >= 0, "INVALID_MONEY");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function key(value: string) {
  assert(
    typeof value === "string" && value.length > 0 && value.length <= 200,
    "INVALID_CAUSAL_ID",
  );
}
function payload(value: Record<string, unknown>) {
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Buffer.byteLength(JSON.stringify(value)) <= 16000,
    "INVALID_PAYLOAD",
  );
}
async function receipt(
  tx: Tx,
  type: string,
  agentId: string | null,
  jobId: string | null,
  details: unknown = {},
) {
  await tx.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES($1,$2,$3,$4)",
    [type, agentId, jobId, JSON.stringify(details)],
  );
}
function mapped(r: any): Job {
  return {
    id: r.id,
    agentId: r.agent_id,
    causalId: r.causal_id,
    kind: r.kind,
    payload: r.payload,
    dueAt: r.due_at,
    sourceOccurredAt: r.source_occurred_at,
    attempts: r.attempts,
    fence: r.fence,
    workerId: r.worker_id,
    leaseUntil: r.lease_until,
    model: r.model,
    priority: r.priority ?? "normal",
    role: r.staff_role ?? undefined,
    task: r.staff_task ?? undefined,
    parentJobId: r.parent_job_id ?? undefined,
    memory: r.memory ?? [],
    recentMessages: r.recentMessages ?? [],
    commitments: r.commitments ?? [],
    ...(r.rehearsal ? { rehearsal: r.rehearsal } : {}),
  };
}

export class RuntimeStore {
  constructor(readonly db: Db) {}
  /** Trusted bootstrap API. Do not expose to franchise actors. */
  async createAgent(input: {
    id: string;
    model: string;
    budgetMicros: number;
    kind?: "ai" | "human";
  }) {
    key(input.id);
    key(input.model);
    money(input.budgetMicros);
    return transaction(this.db, async (tx) => {
      await tx.query(
        "INSERT INTO runtime_agents(id,model,budget_micros,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [input.id, input.model, input.budgetMicros, input.kind ?? "ai"],
      );
      const r = (
        await tx.query("SELECT * FROM runtime_agents WHERE id=$1", [input.id])
      ).rows[0];
      assert(
        r.model === input.model &&
          Number(r.budget_micros) === input.budgetMicros &&
          r.kind === (input.kind ?? "ai"),
        "AGENT_CONFIG_CONFLICT",
      );
      return r;
    });
  }
  private async enqueue(
    tx: Tx,
    agentId: string,
    causalId: string,
    kind: string,
    body: Record<string, unknown>,
    due: Date | string | null,
    source?: Date | string,
    priority: Priority = "normal",
    staff?: { parentJobId: string; role: string; task: string },
  ) {
    key(causalId);
    payload(body);
    assert(
      ["urgent", "normal", "background"].includes(priority),
      "INVALID_PRIORITY",
    );
    const fingerprint = hash({
      kind,
      body,
      due: due === null ? null : new Date(due).toISOString(),
      source: source ? new Date(source).toISOString() : null,
      ...(priority !== "normal" ? { priority } : {}),
      ...(staff ? { staff } : {}),
    });
    const id = randomUUID();
    const inserted = await tx.query(
      "INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,source_occurred_at,priority,parent_job_id,staff_role,staff_task) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,clock_timestamp()),$8,$9,$10,$11,$12) ON CONFLICT(agent_id,causal_id) DO NOTHING RETURNING *",
      [
        id,
        agentId,
        causalId,
        fingerprint,
        kind,
        JSON.stringify(body),
        due,
        source ?? null,
        priority,
        staff?.parentJobId ?? null,
        staff?.role ?? null,
        staff?.task ?? null,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await tx.query(
          "SELECT * FROM runtime_jobs WHERE agent_id=$1 AND causal_id=$2",
          [agentId, causalId],
        )
      ).rows[0];
    assert(row.fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT");
    if (inserted.rowCount && kind === "message")
      await tx.query(
        "UPDATE runtime_jobs j SET status='awaiting_human' FROM runtime_agents a WHERE j.id=$1 AND a.id=j.agent_id AND a.kind='human'",
        [row.id],
      );
    if (inserted.rowCount)
      await receipt(tx, "job.enqueued", agentId, row.id, {
        kind,
        causalId,
        priority,
      });
    return row;
  }
  async requireLiveBinding(agentId: string) {
    assert(
      (
        await this.db.query(
          "SELECT 1 FROM runtime_bindings WHERE agent_id=$1",
          [agentId],
        )
      ).rowCount,
      "LIVE_AGENT_UNBOUND",
    );
  }

  async scheduleSelf(actor: string, input: ScheduleInput) {
    return transaction(this.db, async (tx) => {
      await this.lockAgent(tx, actor);
      return this.schedule(tx, actor, input);
    });
  }
  async cancelSelf(actor: string, causalId: string) {
    return transaction(this.db, async (tx) => {
      await this.lockAgent(tx, actor);
      return this.cancel(tx, actor, causalId);
    });
  }
  private async cancel(tx: Tx, actor: string, causalId: string) {
    key(causalId);
    const row = (
      await tx.query(
        "SELECT * FROM runtime_jobs WHERE agent_id=$1 AND causal_id=$2 FOR UPDATE",
        [actor, causalId],
      )
    ).rows[0];
    assert(row && row.kind === "appointment", "APPOINTMENT_NOT_FOUND");
    if (row.status === "cancelled") return row;
    assert(row.status === "pending", "APPOINTMENT_NOT_PENDING");
    const result = (
      await tx.query(
        "UPDATE runtime_jobs SET status='cancelled',completed_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [row.id],
      )
    ).rows[0];
    await receipt(tx, "appointment.cancelled", actor, row.id, { causalId });
    return result;
  }

  private async lockAgent(tx: Tx, id: string, allowDisabled = false) {
    const a = (
      await tx.query(
        "SELECT * FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
        [id],
      )
    ).rows[0];
    assert(a && (allowDisabled || a.enabled), "AGENT_UNAVAILABLE");
    return a;
  }
  private async schedule(tx: Tx, actor: string, input: ScheduleInput) {
    assert(
      input.priority === undefined ||
        input.priority === "normal" ||
        input.priority === "background",
      "OWNER_PRIORITY_FORBIDDEN",
    );
    const due = new Date(input.dueAt);
    assert(Number.isFinite(+due), "INVALID_DUE_AT");
    // A bounded backlog prevents an owner from filling storage or spawning unbounded future work.
    const old = await tx.query(
      "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND causal_id=$2",
      [actor, input.causalId],
    );
    if (!old.rowCount) {
      const count = (
        await tx.query(
          "SELECT count(*)::int AS n FROM runtime_jobs WHERE agent_id=$1 AND status IN ('pending','running')",
          [actor],
        )
      ).rows[0].n;
      assert(count < 1000, "BACKLOG_LIMIT");
    }
    return this.enqueue(
      tx,
      actor,
      input.causalId,
      "appointment",
      input.payload,
      due,
      undefined,
      input.priority ?? "normal",
    );
  }
  /** Trusted event adapter: actor identity must come from authenticated adapter configuration. */
  async ingestEvent(input: {
    agentId: string;
    causalId: string;
    payload: Record<string, unknown>;
    sourceOccurredAt?: Date | string;
    priority?: Priority;
  }) {
    return transaction(this.db, async (tx) => {
      await this.lockAgent(tx, input.agentId);
      return this.enqueue(
        tx,
        input.agentId,
        input.causalId,
        "event",
        input.payload,
        null,
        input.sourceOccurredAt,
        input.priority ?? "normal",
      );
    });
  }
  /** Internal transaction participant for durable adapter deliveries and wakeups. */
  async ingestEventTx(
    tx: Tx,
    input: {
      agentId: string;
      causalId: string;
      payload: Record<string, unknown>;
      priority?: Priority;
      sourceOccurredAt?: Date | string;
    },
  ) {
    // No model authority is accepted here; adapters must derive recipients from persisted records.
    assert(
      (
        await tx.query("SELECT 1 FROM runtime_agents WHERE id=$1", [
          input.agentId,
        ])
      ).rowCount,
      "AGENT_UNAVAILABLE",
    );
    return this.enqueue(
      tx,
      input.agentId,
      input.causalId,
      "event",
      input.payload,
      null,
      input.sourceOccurredAt,
      input.priority ?? "normal",
    );
  }

  async sendMessage(actor: string, input: MessageInput) {
    return transaction(this.db, async (tx) => {
      await this.lockAgent(tx, actor);
      await this.lockInboxes(tx, [input.recipientId]);
      return this.send(tx, actor, input);
    });
  }
  private async lockInboxes(tx: Tx, recipients: string[]) {
    // All recipients are locked in one stable order before multi-message completion.
    for (const id of [...new Set(recipients)].sort())
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('runtime-inbox:' || $1,0))",
        [id],
      );
  }

  private async send(tx: Tx, actor: string, input: MessageInput) {
    key(input.causalId);
    assert(actor !== input.recipientId, "SELF_MESSAGE");
    assert(
      typeof input.body === "string" &&
        input.body.length > 0 &&
        input.body.length <= 8000,
      "INVALID_MESSAGE",
    );
    const previous = (
      await tx.query(
        "SELECT * FROM runtime_messages WHERE sender_id=$1 AND causal_id=$2",
        [actor, input.causalId],
      )
    ).rows[0];
    if (previous) {
      assert(
        previous.recipient_id === input.recipientId &&
          previous.body === input.body &&
          (!input.conversationId ||
            previous.conversation_id === input.conversationId) &&
          (previous.reply_to ?? undefined) === input.replyTo,
        "IDEMPOTENCY_CONFLICT",
      );
      return previous;
    }
    assert(
      (
        await tx.query("SELECT 1 FROM runtime_agents WHERE id=$1 AND enabled", [
          input.recipientId,
        ])
      ).rowCount,
      "RECIPIENT_UNAVAILABLE",
    );
    const bindings = (
      await tx.query(
        "SELECT agent_id,league_id FROM runtime_bindings WHERE agent_id=ANY($1::text[])",
        [[actor, input.recipientId]],
      )
    ).rows;
    if (bindings.length)
      assert(
        bindings.length === 2 &&
          bindings[0].league_id === bindings[1].league_id,
        "PEER_SCOPE_FORBIDDEN",
      );
    const backlog = (
      await tx.query(
        "SELECT count(*)::int AS n FROM runtime_jobs WHERE agent_id=$1 AND kind='message' AND status IN ('pending','running','awaiting_human')",
        [input.recipientId],
      )
    ).rows[0].n;
    assert(backlog < 200, "RECIPIENT_BACKLOG_LIMIT");

    let conversationId = input.conversationId;
    if (!conversationId) {
      assert(!input.replyTo, "REPLY_REQUIRES_CONVERSATION");
      conversationId = randomUUID();
      await tx.query(
        "INSERT INTO runtime_conversations(id,first_agent,second_agent) VALUES($1,$2,$3)",
        [conversationId, actor, input.recipientId],
      );
    }
    const conv = (
      await tx.query(
        "SELECT * FROM runtime_conversations WHERE id=$1 FOR UPDATE",
        [conversationId],
      )
    ).rows[0];
    assert(
      conv &&
        new Set([conv.first_agent, conv.second_agent]).has(actor) &&
        new Set([conv.first_agent, conv.second_agent]).has(input.recipientId),
      "CONVERSATION_FORBIDDEN",
    );
    assert(conv.message_count < 24, "CONVERSATION_LIMIT");
    if (input.replyTo) {
      const original = (
        await tx.query("SELECT * FROM runtime_messages WHERE id=$1", [
          input.replyTo,
        ])
      ).rows[0];
      assert(
        original &&
          original.conversation_id === conversationId &&
          original.recipient_id === actor,
        "INVALID_REPLY",
      );
      await tx.query(
        "UPDATE runtime_messages SET responded_at=COALESCE(responded_at,clock_timestamp()) WHERE id=$1",
        [input.replyTo],
      );
      const human = (
        await tx.query(
          "SELECT 1 FROM runtime_agents WHERE id=$1 AND kind='human'",
          [actor],
        )
      ).rowCount;
      if (human) {
        await tx.query(
          "UPDATE runtime_messages SET delivered_at=COALESCE(delivered_at,clock_timestamp()) WHERE id=$1",
          [input.replyTo],
        );
        await tx.query(
          "UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp() WHERE id=$1 AND status='awaiting_human'",
          [original.recipient_job_id],
        );
        await receipt(tx, "human.replied", actor, original.recipient_job_id, {
          messageId: input.replyTo,
          conversationId,
        });
      }
    }
    const id = randomUUID();
    const job = await this.enqueue(
      tx,
      input.recipientId,
      "message:" + id,
      "message",
      { messageId: id, senderId: actor, conversationId, body: input.body },
      null,
    );
    const row = (
      await tx.query(
        "INSERT INTO runtime_messages(id,conversation_id,sender_id,recipient_id,causal_id,body,reply_to,recipient_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [
          id,
          conversationId,
          actor,
          input.recipientId,
          input.causalId,
          input.body,
          input.replyTo ?? null,
          job.id,
        ],
      )
    ).rows[0];
    await tx.query(
      "UPDATE runtime_conversations SET message_count=message_count+1 WHERE id=$1",
      [conversationId],
    );
    await receipt(tx, "message.sent", actor, null, {
      messageId: id,
      recipientId: input.recipientId,
      conversationId,
    });
    return row;
  }
  async claim(
    workerId: string,
    leaseMs = 30000,
    model?: string,
    allowedAgentIds?: string[],
    onlyCanaryJobId?: string,
    conversationSessionId?: string,
    harness?: HarnessSelection,
  ): Promise<Job | null> {
    if (harness !== undefined) HarnessSelectionSchema.parse(harness);
    if (allowedAgentIds !== undefined) {
      assert(allowedAgentIds.length <= 100, "INVALID_WORKER_SCOPE");
      allowedAgentIds.forEach(key);
    }
    assert(!(onlyCanaryJobId && conversationSessionId), "WORKER_MODE_CONFLICT");
    key(workerId);
    assert(
      Number.isInteger(leaseMs) && leaseMs >= 10 && leaseMs <= 600000,
      "INVALID_LEASE",
    );
    return transaction(this.db, async (tx) => {
      // Lock the franchise first: two workers cannot run different turns of the same owner concurrently.
      const candidate = (
        await tx.query(
          `SELECT a.id FROM runtime_agents a JOIN LATERAL (SELECT priority_rank,due_at FROM runtime_jobs p WHERE p.agent_id=a.id AND (($4::uuid IS NOT NULL AND p.execution_mode='conversation' AND ${conversationClaimPredicate("p", "$4")}) OR ($4::uuid IS NULL AND ${ordinaryConversationFence("p")} AND ${rehearsalClaimPredicate("p")} AND (($3::uuid IS NULL AND p.execution_mode='owner') OR (p.id=$3 AND p.execution_mode='provider_canary')))) AND p.status IN ('pending','running') AND p.due_at<=clock_timestamp() AND (p.status='pending' OR p.lease_until<=clock_timestamp()) ORDER BY priority_rank DESC,due_at,id LIMIT 1) ready ON true WHERE (a.enabled OR ($4::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM runtime_jobs c WHERE c.agent_id=a.id AND c.execution_mode='conversation' AND ${conversationClaimPredicate("c", "$4")})) OR ($3::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM runtime_jobs c JOIN provider_manifests m ON m.id::text=c.payload->>'manifestId' JOIN runtime_bindings b ON b.agent_id=c.agent_id AND b.league_id=m.league_id WHERE c.id=$3 AND c.agent_id=a.id AND c.execution_mode='provider_canary' AND m.agent_id=a.id AND m.status='staged'))) AND a.kind='ai' AND ${harnessClaimPredicate("a", "$5", "$6")} AND ($1::text IS NULL OR a.model=$1) AND ($2::text[] IS NULL OR a.id=ANY($2::text[])) AND EXISTS (SELECT 1 FROM runtime_jobs j WHERE j.agent_id=a.id AND j.status IN ('pending','running') AND j.due_at<=clock_timestamp() AND (j.status='pending' OR j.lease_until<=clock_timestamp())) AND NOT EXISTS (SELECT 1 FROM runtime_jobs r WHERE r.agent_id=a.id AND r.status='running' AND r.lease_until>clock_timestamp()) ORDER BY ready.priority_rank DESC,ready.due_at,a.id FOR NO KEY UPDATE OF a SKIP LOCKED LIMIT 1`,
          [
            model ?? null,
            allowedAgentIds ?? null,
            onlyCanaryJobId ?? null,
            conversationSessionId ?? null,
            harness?.harnessId ?? null,
            harness?.configDigest ?? null,
          ],
        )
      ).rows[0];
      if (!candidate) return null;
      // A staging transaction may commit while this query waits for the agent
      // lock. Recheck the selector with a fresh statement before touching jobs.
      if (
        !(
          await tx.query(
            `SELECT 1 FROM runtime_agents a WHERE a.id=$1 AND ${harnessClaimPredicate("a", "$2", "$3")}`,
            [
              candidate.id,
              harness?.harnessId ?? null,
              harness?.configDigest ?? null,
            ],
          )
        ).rowCount
      )
        return null;
      // The selection statement may have observed a pre-commit snapshot while acquiring the owner lock.
      // Recheck under our lock before selecting work to prevent a second live turn.
      if (
        (
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running' AND lease_until>clock_timestamp()",
            [candidate.id],
          )
        ).rowCount
      )
        return null;
      const job = (
        await tx.query(
          `SELECT j.* FROM runtime_jobs j WHERE agent_id=$1 AND (($3::uuid IS NOT NULL AND j.execution_mode='conversation' AND ${conversationClaimPredicate("j", "$3")}) OR ($3::uuid IS NULL AND ${ordinaryConversationFence("j")} AND ${rehearsalClaimPredicate("j")} AND (($2::uuid IS NULL AND execution_mode='owner') OR (id=$2 AND execution_mode='provider_canary')))) AND status IN ('pending','running') AND due_at<=clock_timestamp() AND (status='pending' OR lease_until<=clock_timestamp()) ORDER BY priority_rank DESC,due_at,id FOR UPDATE LIMIT 1`,
          [
            candidate.id,
            onlyCanaryJobId ?? null,
            conversationSessionId ?? null,
          ],
        )
      ).rows[0];
      if (!job) return null;
      const binding = (
        await tx.query(
          "SELECT league_id FROM runtime_bindings WHERE agent_id=$1",
          [candidate.id],
        )
      ).rows[0];
      if (binding)
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
          [binding.league_id],
        );
      const rehearsal = await assertRehearsalClaim(tx, {
        id: job.id,
        agentId: job.agent_id,
      });
      if (job.status === "running") {
        await tx.query(
          "UPDATE runtime_reservations SET status='uncertain' WHERE job_id=$1 AND fence=$2 AND status='reserved'",
          [job.id, job.fence],
        );
        await receipt(tx, "job.lease_expired", job.agent_id, job.id, {
          fence: job.fence,
          attempts: job.attempts,
        });
      }
      if (job.attempts >= job.max_attempts) {
        await tx.query(
          "UPDATE runtime_jobs SET status='dead',error='ATTEMPTS_EXHAUSTED',lease_until=NULL WHERE id=$1",
          [job.id],
        );
        await receipt(tx, "job.dead", job.agent_id, job.id);
        if (job.kind === "staff")
          await this.staffFailure(
            tx,
            {
              id: job.id,
              agentId: job.agent_id,
              parentJobId: job.parent_job_id,
              role: job.staff_role,
            },
            "ATTEMPTS_EXHAUSTED",
          );
        return null;
      }
      const r = (
        await tx.query(
          "UPDATE runtime_jobs SET status='running',attempts=attempts+1,fence=fence+1,worker_id=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',claimed_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [job.id, workerId, leaseMs],
        )
      ).rows[0];
      const agent = (
        await tx.query("SELECT model FROM runtime_agents WHERE id=$1", [
          job.agent_id,
        ])
      ).rows[0];
      await tx.query(
        "UPDATE runtime_messages SET delivered_at=COALESCE(delivered_at,clock_timestamp()) WHERE recipient_job_id=$1",
        [job.id],
      );
      await receipt(tx, "job.claimed", job.agent_id, job.id, {
        workerId,
        fence: r.fence,
        attempts: r.attempts,
        priority: r.priority,
        queueDelayMs: Math.max(0, +r.claimed_at - +r.due_at),
      });
      const memory = (
        await tx.query(
          "SELECT key,content,version FROM runtime_memory WHERE agent_id=$1 ORDER BY key",
          [job.agent_id],
        )
      ).rows;
      const recentMessages = (
        await tx.query(
          "SELECT id,conversation_id,sender_id,recipient_id,body,created_at FROM runtime_messages WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at DESC LIMIT 24",
          [job.agent_id],
        )
      ).rows;
      const commitments = (
        await tx.query(
          "SELECT id,causal_id,due_at,payload FROM runtime_jobs WHERE agent_id=$1 AND kind='appointment' AND status='pending' ORDER BY due_at LIMIT 30",
          [job.agent_id],
        )
      ).rows;
      return mapped({
        ...r,
        model: agent.model,
        memory,
        recentMessages,
        commitments,
        ...(rehearsal
          ? {
              rehearsal: {
                epoch: rehearsal.epoch,
                hostVersion: rehearsal.trial_host.version,
                nativeLeagueId: "46625",
                disposableFootball: true,
                modelExecution: rehearsal.synthetic
                  ? "synthetic-test"
                  : "real-model",
              },
            }
          : {}),
      });
    });
  }
  private async validClaim(tx: Tx, claim: Job) {
    const a = await this.lockAgent(tx, claim.agentId, true);
    const r = (
      await tx.query(
        "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_jobs WHERE id=$1 FOR UPDATE",
        [claim.id],
      )
    ).rows[0];
    assert(
      r &&
        r.agent_id === claim.agentId &&
        r.status === "running" &&
        r.worker_id === claim.workerId &&
        r.fence === claim.fence &&
        r.live,
      "STALE_CLAIM",
    );
    assert(
      r.kind === claim.kind &&
        (r.parent_job_id ?? undefined) === (claim.parentJobId ?? undefined),
      "CLAIM_CONTEXT_CHANGED",
    );
    const conversationAuthority = await assertConversationJob(tx, claim);
    if (!a.enabled)
      assert(
        Boolean(conversationAuthority) ||
          (r.execution_mode === "provider_canary" &&
            (
              await tx.query(
                "SELECT 1 FROM provider_manifests m JOIN runtime_bindings b ON b.agent_id=m.agent_id AND b.league_id=m.league_id WHERE m.id::text=$1 AND m.agent_id=$2 AND m.status='staged'",
                [r.payload?.manifestId ?? null, claim.agentId],
              )
            ).rowCount),
        "AGENT_UNAVAILABLE",
      );
    assert(a.kind === "ai", "HUMAN_CANNOT_BE_INVOKED");
    assert(a.model === claim.model, "MODEL_CHANGED");
    return a;
  }
  async heartbeat(claim: Job, leaseMs = 30000) {
    assert(
      Number.isInteger(leaseMs) && leaseMs >= 10 && leaseMs <= 600000,
      "INVALID_LEASE",
    );
    return transaction(this.db, async (tx) => {
      await this.validClaim(tx, claim);
      await tx.query(
        "UPDATE runtime_jobs SET lease_until=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",
        [claim.id, leaseMs],
      );
    });
  }
  async reserve(claim: Job, amountMicros: number) {
    money(amountMicros);
    return transaction(this.db, async (tx) => {
      const a = await this.validClaim(tx, claim);
      const old = (
        await tx.query(
          "SELECT * FROM runtime_reservations WHERE job_id=$1 AND fence=$2",
          [claim.id, claim.fence],
        )
      ).rows[0];
      if (old) {
        assert(
          Number(old.amount_micros) === amountMicros &&
            old.status === "reserved",
          "RESERVATION_CONFLICT",
        );
        return old.id as string;
      }
      assert(
        Number(a.budget_micros) -
          Number(a.spent_micros) -
          Number(a.reserved_micros) >=
          amountMicros,
        "BUDGET_EXHAUSTED",
      );
      const id = randomUUID();
      await assertRehearsalBudget(tx, claim, amountMicros);
      await assertConversationBudget(tx, claim, amountMicros);
      await reserveOwnerStageTurn(tx, claim, amountMicros);
      await reserveConventionTurn(tx, claim, amountMicros);
      await tx.query(
        "INSERT INTO runtime_reservations(id,agent_id,job_id,fence,amount_micros,status) VALUES($1,$2,$3,$4,$5,'reserved')",
        [id, claim.agentId, claim.id, claim.fence, amountMicros],
      );
      await tx.query(
        "UPDATE runtime_agents SET reserved_micros=reserved_micros+$2 WHERE id=$1",
        [claim.agentId, amountMicros],
      );
      await receipt(tx, "budget.reserved", claim.agentId, claim.id, {
        reservationId: id,
        amountMicros,
      });
      return id;
    });
  }
  async complete(
    claim: Job,
    result: DriverResult & {
      reservationId: string;
      driver: string;
      synthetic: boolean;
    },
  ) {
    money(result.costMicros);
    assert(result.actions.length <= 10, "ACTION_LIMIT");
    assert(result.summary.length <= 8000, "SUMMARY_LIMIT");
    return transaction(this.db, async (tx) => {
      await this.validClaim(tx, claim);
      const conversation = await assertConversationActions(
        tx,
        claim,
        result.actions,
        result.synthetic,
      );
      if (!conversation)
        await assertRehearsalCommit(
          tx,
          claim,
          result.actions,
          result.synthetic,
        );
      const executionMode = (
        await tx.query("SELECT execution_mode FROM runtime_jobs WHERE id=$1", [
          claim.id,
        ])
      ).rows[0]?.execution_mode;
      if (executionMode === "provider_canary")
        assert(result.actions.length === 0, "CANARY_ACTION_FORBIDDEN");
      if (claim.kind === "staff")
        assert(
          result.actions.every((a) => a.type === "remember"),
          "STAFF_ACTION_FORBIDDEN",
        );
      const r = (
        await tx.query(
          "SELECT * FROM runtime_reservations WHERE id=$1 FOR UPDATE",
          [result.reservationId],
        )
      ).rows[0];
      assert(
        r &&
          r.job_id === claim.id &&
          r.fence === claim.fence &&
          r.status === "reserved",
        "INVALID_RESERVATION",
      );
      assert(
        result.costMicros <= Number(r.amount_micros),
        "COST_EXCEEDS_RESERVATION",
      );
      await this.lockInboxes(
        tx,
        result.actions.flatMap((a) =>
          a.type === "message" ? [a.recipientId] : [],
        ),
      );
      for (const action of result.actions) {
        await assertOwnerStageAction(tx, claim.agentId, action.type, claim.id);
        if (action.type === "schedule") {
          const scheduled = await this.schedule(tx, claim.agentId, action);
          await recordOwnerStageSchedule(tx, claim, action, scheduled);
        } else if (action.type === "message")
          await this.send(tx, claim.agentId, action);
        else if (action.type === "delegate")
          await this.delegate(tx, claim, action);
        else if (
          [
            "governance",
            "brand",
            "service_request",
            "public_draft",
            "buzz_channel",
          ].includes(action.type)
        )
          await enqueueFranchise(tx, claim, action as FranchiseAction);
        else if (action.type === "football")
          await enqueueFootball(tx, claim, action);
        else if (action.type === "cancel")
          await this.cancel(tx, claim.agentId, action.causalId);
        else if (action.type === "remember") {
          await this.remember(
            tx,
            claim.agentId,
            claim.kind === "staff"
              ? "staff/" + claim.id.slice(0, 8) + "/" + action.key.slice(0, 70)
              : action.key,
            action.content,
          );
          await recordOwnerStageMemory(tx, claim, action);
        } else throw new RuntimeError("UNKNOWN_ACTION");
      }
      await tx.query(
        "UPDATE runtime_reservations SET status='settled',actual_micros=$2 WHERE id=$1",
        [r.id, result.costMicros],
      );
      await tx.query(
        "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3 WHERE id=$1",
        [claim.agentId, r.amount_micros, result.costMicros],
      );
      await tx.query(
        "UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),lease_until=NULL WHERE id=$1",
        [claim.id],
      );
      if (claim.kind === "staff")
        await this.enqueue(
          tx,
          claim.agentId,
          "staff-result:" + claim.id,
          "event",
          {
            kind: "staff.completed",
            staffJobId: claim.id,
            parentJobId: claim.parentJobId,
            role: claim.role,
            summary: result.summary,
            model: claim.model,
            synthetic: result.synthetic,
          },
          null,
        );
      await receipt(tx, "job.completed", claim.agentId, claim.id, {
        driver: result.driver,
        synthetic: result.synthetic,
        model: claim.model,
        summary: result.summary,
        costMicros: result.costMicros,
        actions: result.actions.length,
      });
    });
  }
  private async staffFailure(
    tx: Tx,
    job: { id: string; agentId: string; parentJobId?: string; role?: string },
    error: string,
  ) {
    await this.enqueue(
      tx,
      job.agentId,
      "staff-failed:" + job.id,
      "event",
      {
        kind: "staff.failed",
        staffJobId: job.id,
        parentJobId: job.parentJobId,
        role: job.role,
        error,
      },
      null,
    );
  }
  private async delegate(
    tx: Tx,
    claim: Job,
    input: { causalId: string; role: string; task: string },
  ) {
    assert(claim.kind !== "staff", "STAFF_RECURSION_FORBIDDEN");
    key(input.causalId);
    assert(
      typeof input.role === "string" &&
        input.role.length > 0 &&
        input.role.length <= 80 &&
        typeof input.task === "string" &&
        input.task.length > 0 &&
        input.task.length <= 12000,
      "INVALID_STAFF_TASK",
    );
    const causalId =
      "staff:" + hash({ parent: claim.id, causalId: input.causalId });
    const old = await tx.query(
      "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND causal_id=$2",
      [claim.agentId, causalId],
    );
    if (!old.rowCount) {
      assert(
        (
          await tx.query(
            "SELECT count(*)::int AS n FROM runtime_jobs WHERE agent_id=$1 AND kind='staff' AND status IN ('pending','running')",
            [claim.agentId],
          )
        ).rows[0].n < 4,
        "STAFF_BACKLOG_LIMIT",
      );
      assert(
        (
          await tx.query(
            "SELECT count(*)::int AS n FROM runtime_jobs WHERE parent_job_id=$1",
            [claim.id],
          )
        ).rows[0].n < 4,
        "STAFF_PARENT_LIMIT",
      );
    }
    return this.enqueue(
      tx,
      claim.agentId,
      causalId,
      "staff",
      {
        kind: "staff.task",
        role: input.role,
        task: input.task,
        parentJobId: claim.id,
      },
      null,
      undefined,
      "background",
      { parentJobId: claim.id, role: input.role, task: input.task },
    );
  }
  private async remember(
    tx: Tx,
    actor: string,
    keyName: string,
    content: string,
  ) {
    assert(
      typeof keyName === "string" &&
        keyName.length > 0 &&
        keyName.length <= 100 &&
        typeof content === "string" &&
        content.length > 0 &&
        content.length <= 8000,
      "INVALID_MEMORY",
    );
    const old = await tx.query(
      "SELECT 1 FROM runtime_memory WHERE agent_id=$1 AND key=$2",
      [actor, keyName],
    );
    if (!old.rowCount)
      assert(
        (
          await tx.query(
            "SELECT count(*)::int AS n FROM runtime_memory WHERE agent_id=$1",
            [actor],
          )
        ).rows[0].n < 100,
        "MEMORY_LIMIT",
      );
    const total = (
      await tx.query(
        "SELECT COALESCE(sum(octet_length(content)),0)::int AS n FROM runtime_memory WHERE agent_id=$1 AND key<>$2",
        [actor, keyName],
      )
    ).rows[0].n;
    assert(total + Buffer.byteLength(content) <= 32768, "MEMORY_BYTES_LIMIT");
    await tx.query(
      "INSERT INTO runtime_memory(agent_id,key,content) VALUES($1,$2,$3) ON CONFLICT(agent_id,key) DO UPDATE SET content=EXCLUDED.content,version=runtime_memory.version+1,updated_at=clock_timestamp()",
      [actor, keyName, content],
    );
    await receipt(tx, "memory.updated", actor, null, { key: keyName });
  }

  async recordExecution(
    claim: Job,
    info: {
      driver: string;
      synthetic: boolean;
      durationMs: number;
      outcome: "returned" | "threw";
    },
  ) {
    assert(
      Number.isFinite(info.durationMs) && info.durationMs >= 0,
      "INVALID_DURATION",
    );
    return transaction(this.db, async (tx) => {
      assert(
        (
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE id=$1 AND agent_id=$2 AND fence >= $3",
            [claim.id, claim.agentId, claim.fence],
          )
        ).rowCount,
        "UNKNOWN_EXECUTION",
      );
      await receipt(tx, "driver.execution", claim.agentId, claim.id, {
        ...info,
        fence: claim.fence,
        model: claim.model,
        measurement: "monotonic_wall_clock",
      });
    });
  }

  /** Record reported provider usage even if a lease expired; observation does not authorize tool actions. */
  async observeCost(
    claim: Job,
    reservationId: string,
    costMicros: number,
    generationId?: string,
  ) {
    money(costMicros);
    return transaction(this.db, async (tx) => {
      const r = (
        await tx.query(
          "SELECT * FROM runtime_reservations WHERE id=$1 FOR UPDATE",
          [reservationId],
        )
      ).rows[0];
      assert(
        r &&
          r.agent_id === claim.agentId &&
          r.job_id === claim.id &&
          r.fence === claim.fence,
        "INVALID_RESERVATION",
      );
      assert(
        r.observed_micros === null || Number(r.observed_micros) === costMicros,
        "COST_OBSERVATION_CONFLICT",
      );
      await tx.query(
        "UPDATE runtime_reservations SET observed_micros=$2 WHERE id=$1",
        [reservationId, costMicros],
      );
      await receipt(tx, "budget.cost_observed", claim.agentId, claim.id, {
        reservationId,
        costMicros,
        exceedsReservation: costMicros > Number(r.amount_micros),
        generationId: generationId?.slice(0, 200) ?? null,
      });
    });
  }
  async settleOverrun(claim: Job, reservationId: string, costMicros: number) {
    money(costMicros);
    return transaction(this.db, async (tx) => {
      await this.validClaim(tx, claim);
      const r = (
        await tx.query(
          "SELECT * FROM runtime_reservations WHERE id=$1 FOR UPDATE",
          [reservationId],
        )
      ).rows[0];
      assert(
        r &&
          r.job_id === claim.id &&
          r.fence === claim.fence &&
          r.status === "reserved",
        "INVALID_RESERVATION",
      );
      assert(costMicros > Number(r.amount_micros), "NOT_OVERRUN");
      await tx.query(
        "UPDATE runtime_reservations SET status='settled',actual_micros=$2,observed_micros=$2 WHERE id=$1",
        [reservationId, costMicros],
      );
      await tx.query(
        "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3,enabled=false WHERE id=$1",
        [claim.agentId, r.amount_micros, costMicros],
      );
      await tx.query(
        "UPDATE runtime_jobs SET status='dead',error='COST_OVERRUN',lease_until=NULL WHERE id=$1",
        [claim.id],
      );
      await receipt(tx, "budget.overrun", claim.agentId, claim.id, {
        reservationId,
        costMicros,
        reservedMicros: Number(r.amount_micros),
        agentFrozen: true,
        actionsExecuted: 0,
      });
    });
  }

  async fail(
    claim: Job,
    error: string,
    options: {
      retryable: boolean;
      chargeKnownZero: boolean;
      reservationId?: string;
      retryDelayMs?: number;
      observedCostMicros?: number;
    },
  ) {
    if (options.observedCostMicros !== undefined)
      money(options.observedCostMicros);
    const delay =
      options.retryDelayMs ?? Math.min(60000, 1000 * 2 ** (claim.attempts - 1));
    assert(
      Number.isSafeInteger(delay) && delay >= 0 && delay <= 86400000,
      "INVALID_RETRY_DELAY",
    );
    return transaction(this.db, async (tx) => {
      await this.validClaim(tx, claim);
      if (options.reservationId) {
        const r = (
          await tx.query(
            "SELECT * FROM runtime_reservations WHERE id=$1 FOR UPDATE",
            [options.reservationId],
          )
        ).rows[0];
        assert(
          r &&
            r.job_id === claim.id &&
            r.fence === claim.fence &&
            r.status === "reserved",
          "INVALID_RESERVATION",
        );
        if (options.observedCostMicros !== undefined) {
          assert(
            options.observedCostMicros <= Number(r.amount_micros),
            "COST_EXCEEDS_RESERVATION",
          );
          await tx.query(
            "UPDATE runtime_reservations SET status='settled',actual_micros=$2,observed_micros=$2 WHERE id=$1",
            [r.id, options.observedCostMicros],
          );
          await tx.query(
            "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3 WHERE id=$1",
            [claim.agentId, r.amount_micros, options.observedCostMicros],
          );
        } else {
          await tx.query(
            "UPDATE runtime_reservations SET status=$2 WHERE id=$1",
            [r.id, options.chargeKnownZero ? "released" : "uncertain"],
          );
          if (options.chargeKnownZero)
            await tx.query(
              "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2 WHERE id=$1",
              [claim.agentId, r.amount_micros],
            );
        }
      }
      const retry = options.retryable && claim.attempts < 3;
      if (!retry && claim.kind === "staff")
        await this.staffFailure(tx, claim, error.slice(0, 1000));
      await tx.query(
        "UPDATE runtime_jobs SET status=$2,error=$3,lease_until=NULL,due_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1",
        [claim.id, retry ? "pending" : "dead", error.slice(0, 1000), delay],
      );
      await receipt(
        tx,
        retry ? "job.retry" : "job.dead",
        claim.agentId,
        claim.id,
        {
          error: error.slice(0, 1000),
          chargeKnownZero: options.chargeKnownZero,
          observedCostMicros: options.observedCostMicros ?? null,
        },
      );
    });
  }
  /** Operator reconciliation requires an actual provider receipt, never inferred from a process crash. */
  async reconcileReservation(
    id: string,
    actualMicros: number,
    evidence: string,
    verify?: (tx: Tx) => Promise<void>,
  ) {
    money(actualMicros);
    assert(
      evidence.length >= 8 && evidence.length <= 2000,
      "EVIDENCE_REQUIRED",
    );
    return transaction(this.db, async (tx) => {
      const lookup = (
        await tx.query(
          "SELECT agent_id FROM runtime_reservations WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert(lookup, "RESERVATION_NOT_FOUND");
      await this.lockAgent(tx, lookup.agent_id, true);
      const r = (
        await tx.query(
          "SELECT * FROM runtime_reservations WHERE id=$1 FOR NO KEY UPDATE",
          [id],
        )
      ).rows[0];
      assert(r.status === "uncertain", "NOT_UNCERTAIN");
      await verify?.(tx);
      await tx.query(
        "UPDATE runtime_reservations SET status='settled',actual_micros=$2 WHERE id=$1",
        [id, actualMicros],
      );
      await tx.query(
        "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3,enabled=CASE WHEN $3::bigint>$2::bigint THEN false ELSE enabled END WHERE id=$1",
        [r.agent_id, r.amount_micros, actualMicros],
      );
      await receipt(tx, "budget.reconciled", r.agent_id, r.job_id, {
        reservationId: id,
        actualMicros,
        evidence,
        exceedsReservation: actualMicros > Number(r.amount_micros),
      });
    });
  }
  /** Commissioner-only archive. Never return this unfiltered through a franchise endpoint. */
  async snapshot() {
    const [agents, jobs, messages, receipts, reservations] = await Promise.all(
      [
        "SELECT * FROM runtime_agents ORDER BY id",
        "SELECT * FROM runtime_jobs ORDER BY created_at",
        "SELECT * FROM runtime_messages ORDER BY created_at",
        "SELECT * FROM runtime_receipts ORDER BY seq",
        "SELECT * FROM runtime_reservations ORDER BY created_at",
      ].map((q) => this.db.query(q)),
    );
    return {
      agents: agents.rows,
      jobs: jobs.rows,
      messages: messages.rows,
      receipts: receipts.rows,
      reservations: reservations.rows,
    };
  }
  async agentSnapshot(actor: string) {
    const agent = (
      await this.db.query("SELECT * FROM runtime_agents WHERE id=$1", [actor])
    ).rows[0];
    assert(agent, "AGENT_UNAVAILABLE");
    const [jobs, messages, receipts, reservations] = await Promise.all([
      this.db.query(
        "SELECT * FROM runtime_jobs WHERE agent_id=$1 ORDER BY created_at",
        [actor],
      ),
      this.db.query(
        "SELECT * FROM runtime_messages WHERE sender_id=$1 OR recipient_id=$1 ORDER BY created_at",
        [actor],
      ),
      this.db.query(
        "SELECT * FROM runtime_receipts WHERE agent_id=$1 ORDER BY seq",
        [actor],
      ),
      this.db.query(
        "SELECT * FROM runtime_reservations WHERE agent_id=$1 ORDER BY created_at",
        [actor],
      ),
    ]);
    return {
      agent,
      jobs: jobs.rows,
      messages: messages.rows,
      receipts: receipts.rows,
      reservations: reservations.rows,
      memory: (
        await this.db.query(
          "SELECT * FROM runtime_memory WHERE agent_id=$1 ORDER BY key",
          [actor],
        )
      ).rows,
    };
  }
}
