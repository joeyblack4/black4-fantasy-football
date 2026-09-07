import { createHash, randomUUID } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";
import {
  LeagueService,
  LeagueError,
  type CommandReceipt,
} from "../league/index.js";
import { RuntimeError, type Job, type RuntimeStore } from "./index.js";
import {
  FootballActionSchema,
  type FootballAction,
} from "./football-schema.js";
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new RuntimeError(code);
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
/** Only called inside RuntimeStore.complete after fencing verification. No engine call occurs here. */
export async function enqueueFootball(tx: Tx, job: Job, input: FootballAction) {
  const action = FootballActionSchema.parse(input);
  const binding = (
    await tx.query(
      "SELECT b.league_id,b.team_id,t.owner_id,t.kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1",
      [job.agentId],
    )
  ).rows[0];
  assert(binding && binding.kind === "ai", "FOOTBALL_BINDING_REQUIRED");
  if (action.command.type === "proposeTrade")
    assert(
      (
        await tx.query(
          "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2",
          [binding.league_id, action.command.toTeamId],
        )
      ).rowCount,
      "FOOTBALL_PEER_SCOPE_FORBIDDEN",
    );
  const cmd = action.command;
  const players =
    cmd.type === "draftPick"
      ? [cmd.playerId]
      : cmd.type === "setDraftQueue"
        ? cmd.playerIds
        : cmd.type === "setLineup"
          ? Object.values(cmd.slots)
          : cmd.type === "proposeTrade"
            ? [...cmd.givePlayers, ...cmd.receivePlayers]
            : cmd.type === "submitClaim" || cmd.type === "addFreeAgent"
              ? [
                  cmd.addPlayerId,
                  ...(cmd.dropPlayerId ? [cmd.dropPlayerId] : []),
                ]
              : [];
  if (players.length)
    assert(
      (
        await tx.query(
          "SELECT id FROM league_players WHERE league_id=$1 AND id=ANY($2::text[])",
          [binding.league_id, [...new Set(players)]],
        )
      ).rowCount === new Set(players).size,
      "FOOTBALL_PLAYER_SCOPE_FORBIDDEN",
    );

  const fingerprint = createHash("sha256")
    .update(canonical({ binding, command: action.command }))
    .digest("hex");
  const existing = await tx.query(
    "SELECT 1 FROM runtime_football_outbox WHERE agent_id=$1 AND causal_id=$2",
    [job.agentId, action.causalId],
  );
  if (!existing.rowCount)
    assert(
      (
        await tx.query(
          "SELECT count(*)::int AS n FROM runtime_football_outbox WHERE agent_id=$1 AND status IN ('pending','running')",
          [job.agentId],
        )
      ).rows[0].n < 100,
      "FOOTBALL_BACKLOG_LIMIT",
    );
  const id = randomUUID();
  const inserted = await tx.query(
    "INSERT INTO runtime_football_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,command) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(agent_id,causal_id) DO NOTHING RETURNING *",
    [
      id,
      job.agentId,
      job.id,
      action.causalId,
      fingerprint,
      job.fence,
      binding.league_id,
      binding.team_id,
      binding.owner_id,
      JSON.stringify(action.command),
    ],
  );
  const row =
    inserted.rows[0] ??
    (
      await tx.query(
        "SELECT * FROM runtime_football_outbox WHERE agent_id=$1 AND causal_id=$2",
        [job.agentId, action.causalId],
      )
    ).rows[0];
  assert(row.fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT");
  if (inserted.rowCount)
    await tx.query(
      "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('football.queued',$1,$2,$3)",
      [
        job.agentId,
        job.id,
        JSON.stringify({
          outboxId: row.id,
          commandType: action.command.type,
          causalId: action.causalId,
        }),
      ],
    );
  return row;
}
export type FootballClaim = {
  id: string;
  agent_id: string;
  job_id: string;
  league_id: string;
  team_id: string;
  owner_id: string;
  command: FootballAction["command"];
  fence: number;
  worker_id: string;
  attempts: number;
};
export class FootballOutbox {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
    readonly league = new LeagueService(db),
  ) {}
  async claim(
    workerId: string,
    leaseMs = 30000,
    allowedAgentIds?: string[],
  ): Promise<FootballClaim | null> {
    assert(
      allowedAgentIds === undefined ||
        (allowedAgentIds.length <= 100 &&
          allowedAgentIds.every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
          )),
      "INVALID_WORKER_SCOPE",
    );
    assert(
      workerId.length > 0 &&
        workerId.length <= 200 &&
        Number.isSafeInteger(leaseMs) &&
        leaseMs >= 10 &&
        leaseMs <= 600000,
      "INVALID_OUTBOX_CLAIM",
    );
    return transaction(this.db, async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM runtime_football_outbox WHERE ($1::text[] IS NULL OR agent_id=ANY($1::text[])) AND status IN ('pending','running') AND next_attempt_at<=clock_timestamp() AND (status='pending' OR lease_until<=clock_timestamp()) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
          [allowedAgentIds ?? null],
        )
      ).rows[0];
      if (!row) return null;
      if (row.attempts >= 5) {
        await tx.query(
          "UPDATE runtime_football_outbox SET status='dead',error='DISPATCH_ATTEMPTS_EXHAUSTED',lease_until=NULL WHERE id=$1",
          [row.id],
        );
        return null;
      }
      return (
        await tx.query(
          "UPDATE runtime_football_outbox SET status='running',attempts=attempts+1,fence=fence+1,worker_id=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 RETURNING *",
          [row.id, workerId, leaseMs],
        )
      ).rows[0];
    });
  }
  private async check(tx: Tx, claim: FootballClaim) {
    const row = (
      await tx.query(
        "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_football_outbox WHERE id=$1 FOR UPDATE",
        [claim.id],
      )
    ).rows[0];
    assert(
      row &&
        row.status === "running" &&
        row.fence === claim.fence &&
        row.worker_id === claim.worker_id &&
        row.live,
      "STALE_OUTBOX_CLAIM",
    );
    return row;
  }
  /** An uncertain retry always executes this identical command key; the league stores its receipt. */
  async execute(claim: FootballClaim): Promise<CommandReceipt> {
    const context = await transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      const binding = (
        await tx.query(
          "SELECT b.*,t.owner_id,t.kind,a.enabled,a.kind AS runtime_kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1",
          [row.agent_id],
        )
      ).rows[0];
      assert(
        binding &&
          binding.enabled &&
          binding.kind === "ai" &&
          binding.runtime_kind === "ai" &&
          binding.league_id === row.league_id &&
          binding.team_id === row.team_id &&
          binding.owner_id === row.owner_id,
        "FOOTBALL_AUTHORITY_CHANGED",
      );
      const parsed = FootballActionSchema.parse({
        type: "football",
        causalId: "dispatch",
        command: row.command,
      });
      return {
        actor: {
          id: binding.owner_id,
          role: "owner" as const,
          leagueId: binding.league_id,
          teamId: binding.team_id,
        },
        command: {
          ...parsed.command,
          leagueId: binding.league_id,
          idempotencyKey: "runtime-football:" + row.id,
        },
      };
    });
    return this.league.execute(context.actor, context.command);
  }
  async acknowledge(claim: FootballClaim, receipt: CommandReceipt) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      // Validate the receipt against authority storage. The dispatcher cannot invent success.
      const persisted = (
        await tx.query(
          "SELECT response FROM league_command_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [row.league_id, row.owner_id, "runtime-football:" + row.id],
        )
      ).rows[0];
      assert(
        persisted?.response?.receiptId === receipt.receiptId,
        "UNVERIFIED_FOOTBALL_RECEIPT",
      );
      const official: CommandReceipt = persisted.response;
      await tx.query(
        "UPDATE runtime_football_outbox SET status='delivered',engine_receipt=$2,delivered_at=clock_timestamp(),lease_until=NULL WHERE id=$1",
        [row.id, JSON.stringify(official)],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('football.executed',$1,$2,$3)",
        [
          row.agent_id,
          row.job_id,
          JSON.stringify({
            outboxId: row.id,
            receiptId: official.receiptId,
            commandType: row.command.type,
            replayed: receipt.replayed,
          }),
        ],
      );
      const participants = new Set<string>([row.agent_id]);
      for (const teamId of [
        official.result.fromTeamId,
        official.result.toTeamId,
      ])
        if (typeof teamId === "string") {
          const target = (
            await tx.query(
              "SELECT agent_id FROM runtime_bindings WHERE league_id=$1 AND team_id=$2",
              [row.league_id, teamId],
            )
          ).rows[0];
          if (target) participants.add(target.agent_id);
        }
      for (const agentId of [...participants].sort())
        await this.runtime.ingestEventTx(tx, {
          agentId,
          causalId: "football-result:" + row.id,
          payload: {
            kind: "football.result",
            outboxId: row.id,
            initiatedBy: row.agent_id,
            commandType: row.command.type,
            receiptId: official.receiptId,
            result: official.result,
          },
        });
      return official;
    });
  }
  async fail(claim: FootballClaim, error: string, retryable: boolean) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      const retry = retryable && row.attempts < 5;
      await tx.query(
        "UPDATE runtime_football_outbox SET status=$2,error=$3,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [row.id, retry ? "pending" : "dead", error.slice(0, 1000)],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES($1,$2,$3,$4)",
        [
          retry ? "football.retry" : "football.failed",
          row.agent_id,
          row.job_id,
          JSON.stringify({
            outboxId: row.id,
            error: error.slice(0, 1000),
            retryable: retry,
          }),
        ],
      );
      if (!retry)
        await this.runtime.ingestEventTx(tx, {
          agentId: row.agent_id,
          causalId: "football-failed:" + row.id,
          payload: {
            kind: "football.failed",
            outboxId: row.id,
            commandType: row.command.type,
            error: error.slice(0, 1000),
          },
        });
    });
  }
  async dispatchOne(
    workerId: string,
    options: {
      leaseMs?: number;
      allowedAgentIds?: string[];
      afterExecute?: (receipt: CommandReceipt) => Promise<void>;
    } = {},
  ): Promise<{
    status: "idle" | "delivered" | "failed" | "stale";
    outboxId?: string;
    error?: string;
  }> {
    const claim = await this.claim(
      workerId,
      options.leaseMs,
      options.allowedAgentIds,
    );
    if (!claim) return { status: "idle" };
    try {
      const receipt = await this.execute(claim);
      await options.afterExecute?.(receipt);
      await this.acknowledge(claim, receipt);
      return { status: "delivered", outboxId: claim.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RuntimeError && error.code === "STALE_OUTBOX_CLAIM")
        return { status: "stale", outboxId: claim.id, error: message };
      try {
        await this.fail(
          claim,
          message,
          !(error instanceof LeagueError || error instanceof RuntimeError),
        );
      } catch (failure) {
        if (
          failure instanceof RuntimeError &&
          failure.code === "STALE_OUTBOX_CLAIM"
        )
          return { status: "stale", outboxId: claim.id, error: message };
        throw failure;
      }
      return { status: "failed", outboxId: claim.id, error: message };
    }
  }
}
