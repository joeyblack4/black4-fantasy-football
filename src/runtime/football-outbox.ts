import {
  assertRehearsalClaim,
  assertRehearsalReconciliation,
  rehearsalClaimPredicate,
  tagRehearsalWake,
  tagRehearsalOutcomeWake,
} from "./rehearsal.js";
import { assertOwnerStageAction } from "./owner-stage.js";
import { createHash, randomUUID } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";
import { LeagueService, LeagueError } from "../league/index.js";
import { RuntimeError, type Job, type RuntimeStore } from "./index.js";
import { getFootballHost } from "../league/host.js";
import { loadMflAdapter } from "../mfl/service.js";
import { MflError, type MflReceipt } from "../mfl/contracts.js";
import { MflDraftQueueService } from "../mfl/draft-queue.js";
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
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
    binding.league_id,
  ]);
  const host = await getFootballHost(tx, binding.league_id);
  assert(
    (host.kind === "mfl") ===
      (action.command.type === "mfl" ||
        action.command.type === "mflLocalDraftQueue"),
    "FOOTBALL_COMMAND_HOST_MISMATCH",
  );
  if (
    action.command.type === "mfl" &&
    action.command.action.type === "proposeTrade"
  )
    assert(
      (
        await tx.query(
          "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2",
          [binding.league_id, action.command.action.counterpartyTeamId],
        )
      ).rowCount,
      "FOOTBALL_PEER_SCOPE_FORBIDDEN",
    );
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
    .update(canonical({ binding, host, command: action.command }))
    .digest("hex");
  const existing = await tx.query(
    "SELECT 1 FROM runtime_football_outbox WHERE agent_id=$1 AND causal_id=$2",
    [job.agentId, action.causalId],
  );
  if (!existing.rowCount)
    assert(
      (
        await tx.query(
          "SELECT count(*)::int AS n FROM runtime_football_outbox WHERE agent_id=$1 AND status IN ('pending','running','held')",
          [job.agentId],
        )
      ).rows[0].n < 100,
      "FOOTBALL_BACKLOG_LIMIT",
    );
  const id = randomUUID();
  const inserted = await tx.query(
    "INSERT INTO runtime_football_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,command,host_kind,host_version,host_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(agent_id,causal_id) DO NOTHING RETURNING *",
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
      host.kind,
      host.version,
      JSON.stringify(host.identity),
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
          host: host.kind,
          hostVersion: host.version,
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
  host_kind: "custom" | "mfl";
  host_version: number;
  host_identity: Record<string, unknown>;
};
export type FootballReceipt = {
  receiptId: string;
  result: Record<string, unknown>;
  replayed: boolean;
  eventId?: string;
  mfl?: MflReceipt;
};
function mflReceipt(receipt: MflReceipt): FootballReceipt {
  return {
    receiptId: receipt.id,
    replayed: receipt.replayed ?? false,
    result: {
      host: "mfl",
      state: receipt.state,
      result: receipt.result ?? null,
      reason: receipt.reason ?? null,
      synthetic: receipt.synthetic,
    },
    mfl: receipt,
  };
}
export class FootballOutbox {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
    readonly league = new LeagueService(db),
    readonly mflLoader = loadMflAdapter,
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
      const candidate = (
        await tx.query(
          `SELECT o.id,o.league_id FROM runtime_football_outbox o JOIN runtime_jobs j ON j.id=o.job_id WHERE ($1::text[] IS NULL OR o.agent_id=ANY($1::text[])) AND ${rehearsalClaimPredicate("j")} AND o.status IN ('pending','running') AND o.next_attempt_at<=clock_timestamp() AND (o.status='pending' OR o.lease_until<=clock_timestamp()) ORDER BY o.next_attempt_at,o.id LIMIT 1`,
          [allowedAgentIds ?? null],
        )
      ).rows[0];
      if (!candidate) return null;
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [candidate.league_id],
      );
      const row = (
        await tx.query(
          `SELECT o.* FROM runtime_football_outbox o JOIN runtime_jobs j ON j.id=o.job_id WHERE o.id=$1 AND o.league_id=$2 AND ($3::text[] IS NULL OR o.agent_id=ANY($3::text[])) AND ${rehearsalClaimPredicate("j")} AND o.status IN ('pending','running') AND o.next_attempt_at<=clock_timestamp() AND (o.status='pending' OR o.lease_until<=clock_timestamp()) FOR UPDATE OF o SKIP LOCKED`,
          [candidate.id, candidate.league_id, allowedAgentIds ?? null],
        )
      ).rows[0];
      if (!row) return null;
      if (row.attempts >= 5) {
        await tx.query(
          "UPDATE runtime_football_outbox SET status=$2,error='DISPATCH_ATTEMPTS_EXHAUSTED',lease_until=NULL WHERE id=$1",
          [row.id, row.command.type === "mfl" ? "held" : "dead"],
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
  private async context(claim: FootballClaim, readOnlyReconciliation = false) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      const recovery = readOnlyReconciliation
        ? await assertRehearsalReconciliation(tx, {
            id: row.job_id,
            agentId: row.agent_id,
          })
        : (await assertRehearsalClaim(tx, {
            id: row.job_id,
            agentId: row.agent_id,
          }),
          null);
      const host = await getFootballHost(tx, row.league_id);
      assert(
        host.kind === row.host_kind &&
          host.version === row.host_version &&
          canonical(host.identity) === canonical(row.host_identity ?? {}),
        "FOOTBALL_HOST_CHANGED",
      );
      const binding = (
        await tx.query(
          "SELECT b.*,t.owner_id,t.kind,a.enabled,a.kind AS runtime_kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1",
          [row.agent_id],
        )
      ).rows[0];
      assert(
        binding &&
          (binding.enabled || !!recovery) &&
          binding.kind === "ai" &&
          binding.runtime_kind === "ai" &&
          binding.league_id === row.league_id &&
          binding.team_id === row.team_id &&
          binding.owner_id === row.owner_id,
        "FOOTBALL_AUTHORITY_CHANGED",
      );
      if (!recovery)
        await assertOwnerStageAction(tx, row.agent_id, "football", row.job_id);
      const parsed = FootballActionSchema.parse({
        type: "football",
        causalId: "dispatch",
        command: row.command,
      });
      return {
        host,
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
  }
  /** MFL's durable journal holds uncertain writes; replay never blindly repeats an external POST. */
  async execute(claim: FootballClaim): Promise<FootballReceipt> {
    const context = await this.context(claim);
    if (context.command.type === "mflLocalDraftQueue") {
      assert(context.host.kind === "mfl", "FOOTBALL_COMMAND_HOST_MISMATCH");
      return new MflDraftQueueService(this.db).saveQueue(context.actor, {
        leagueId: context.actor.leagueId,
        idempotencyKey: context.command.idempotencyKey,
        expectedVersion: context.command.expectedVersion,
        playerIds: context.command.playerIds,
      });
    }
    if (context.host.kind === "mfl") {
      assert(context.command.type === "mfl", "FOOTBALL_COMMAND_HOST_MISMATCH");
      const adapter = await this.mflLoader(this.db, context.actor.leagueId);
      return mflReceipt(
        await adapter.execute(
          context.actor,
          context.command.idempotencyKey,
          context.command.action,
        ),
      );
    }
    assert(context.command.type !== "mfl", "FOOTBALL_COMMAND_HOST_MISMATCH");
    return this.league.execute(context.actor, context.command);
  }
  async acknowledge(
    claim: FootballClaim,
    receipt: FootballReceipt,
    readOnlyReconciliation = false,
  ) {
    const context = await this.context(claim, readOnlyReconciliation);
    const adapter =
      context.host.kind === "mfl" && context.command.type === "mfl"
        ? await this.mflLoader(this.db, context.actor.leagueId)
        : null;
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      const host = await getFootballHost(tx, row.league_id);
      assert(
        host.kind === row.host_kind &&
          host.version === row.host_version &&
          canonical(host.identity) === canonical(row.host_identity ?? {}),
        "FOOTBALL_HOST_CHANGED",
      );
      // Validate the receipt against authority storage. The dispatcher cannot invent success.
      let official: FootballReceipt;
      if (row.command.type === "mflLocalDraftQueue") {
        assert(
          !receipt.mfl && host.kind === "mfl",
          "UNVERIFIED_FOOTBALL_RECEIPT",
        );
        official = await new MflDraftQueueService(this.db).verifyReceipt(
          tx,
          context.actor,
          {
            leagueId: row.league_id,
            idempotencyKey: "runtime-football:" + row.id,
            expectedVersion: row.command.expectedVersion,
            playerIds: row.command.playerIds,
          },
          receipt.receiptId,
        );
      } else if (adapter) {
        assert(
          receipt.mfl && row.command.type === "mfl",
          "UNVERIFIED_FOOTBALL_RECEIPT",
        );
        const persisted = await adapter.verifyReceipt(
          tx,
          context.actor,
          "runtime-football:" + row.id,
          receipt.receiptId,
        );
        assert(
          persisted?.state === "verified" &&
            canonical(persisted.action) === canonical(row.command.action),
          "UNVERIFIED_FOOTBALL_RECEIPT",
        );
        official = mflReceipt(persisted);
      } else {
        assert(!receipt.mfl, "UNVERIFIED_FOOTBALL_RECEIPT");
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
        official = persisted.response;
      }
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
            host: row.host_kind,
          }),
        ],
      );
      if (readOnlyReconciliation) return official;
      // The next changed draft turn supplies fresh state. Do not spend another
      // model turn merely acknowledging its own successful trial pick/queue.
      if (
        row.command.type === "mflLocalDraftQueue" ||
        (row.command.type === "mfl" && row.command.action.type === "draft")
      ) {
        const rehearsal = await assertRehearsalClaim(tx, {
          id: row.job_id,
          agentId: row.agent_id,
        });
        if (rehearsal) {
          await tx.query(
            "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('rehearsal.football_success_coalesced',$1,$2,$3)",
            [
              row.agent_id,
              row.job_id,
              {
                leagueId: row.league_id,
                epoch: rehearsal.epoch,
                hostVersion: row.host_version,
                outboxId: row.id,
                receiptId: official.receiptId,
                commandType: row.command.type,
                nextWakeSource: "draft-observer",
                inferenceWakeCreated: false,
              },
            ],
          );
          return official;
        }
      }
      const participants = new Set<string>([row.agent_id]);
      for (const teamId of [
        ...(official.mfl?.affectedTeamIds ?? []),
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
      for (const agentId of [...participants].sort()) {
        const wake = await this.runtime.ingestEventTx(tx, {
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
        await tagRehearsalWake(tx, {
          jobId: wake.id,
          leagueId: row.league_id,
          hostVersion: row.host_version,
          source: "football-receipt",
        });
      }
      return official;
    });
  }
  async fail(
    claim: FootballClaim,
    error: string,
    retryable: boolean,
    suppressWake = false,
  ) {
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
      if (!retry && !suppressWake) {
        const wake = await this.runtime.ingestEventTx(tx, {
          agentId: row.agent_id,
          causalId: "football-failed:" + row.id,
          payload: {
            kind: "football.failed",
            outboxId: row.id,
            commandType: row.command.type,
            error: error.slice(0, 1000),
          },
        });
        await tagRehearsalOutcomeWake(tx, {
          jobId: wake.id,
          outboxId: row.id,
          source: "football-failure",
        });
      }
    });
  }
  async hold(
    claim: FootballClaim,
    reason = "MFL_WRITE_REQUIRES_RECONCILIATION",
    suppressWake = false,
  ) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      await tx.query(
        "UPDATE runtime_football_outbox SET status='held',error=$2,lease_until=NULL WHERE id=$1",
        [row.id, reason],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('football.held',$1,$2,$3)",
        [
          row.agent_id,
          row.job_id,
          {
            outboxId: row.id,
            host: row.host_kind,
            reason,
            automaticRetry: false,
          },
        ],
      );
      if (!suppressWake) {
        const wake = await this.runtime.ingestEventTx(tx, {
          agentId: row.agent_id,
          causalId: "football-held:" + row.id,
          payload: {
            kind: "football.held",
            outboxId: row.id,
            host: row.host_kind,
            commandType:
              row.command.type === "mfl"
                ? row.command.action.type
                : row.command.type,
            requiresOperatorReconciliation: true,
            automaticRetry: false,
          },
        });
        await tagRehearsalOutcomeWake(tx, {
          jobId: wake.id,
          outboxId: row.id,
          source: "football-held",
        });
      }
    });
  }
  /** Explicit operator recovery only. Performs upstream reads, never execute()/POST. */
  async reconcileHeld(
    outboxId: string,
    workerId: string,
  ): Promise<"delivered" | "held" | "failed"> {
    const claim = await transaction(this.db, async (tx) => {
      const candidate = (
        await tx.query(
          "SELECT league_id FROM runtime_football_outbox WHERE id=$1",
          [outboxId],
        )
      ).rows[0];
      assert(candidate, "MFL_HELD_OUTBOX_REQUIRED");
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [candidate.league_id],
      );
      const row = (
        await tx.query(
          "SELECT * FROM runtime_football_outbox WHERE id=$1 FOR UPDATE",
          [outboxId],
        )
      ).rows[0];
      assert(
        row?.status === "held" &&
          row.host_kind === "mfl" &&
          row.command.type === "mfl",
        "MFL_HELD_OUTBOX_REQUIRED",
      );
      assert(
        workerId.length > 0 && workerId.length <= 200,
        "INVALID_OUTBOX_CLAIM",
      );
      return (
        await tx.query(
          "UPDATE runtime_football_outbox SET status='running',worker_id=$2,fence=fence+1,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1 RETURNING *",
          [outboxId, workerId],
        )
      ).rows[0] as FootballClaim;
    });
    try {
      const context = await this.context(claim, true);
      assert(context.host.kind === "mfl", "FOOTBALL_HOST_CHANGED");
      const adapter = await this.mflLoader(this.db, context.actor.leagueId);
      const receipt = await adapter.reconcile(
        context.actor,
        context.command.idempotencyKey,
      );
      if (receipt.state === "verified") {
        await this.acknowledge(claim, mflReceipt(receipt), true);
        return "delivered";
      }
      if (receipt.state === "rejected") {
        await transaction(this.db, async (tx) => {
          const row = await this.check(tx, claim);
          const verified = await adapter.verifyReceipt(
            tx,
            context.actor,
            context.command.idempotencyKey,
            receipt.id,
          );
          assert(
            verified?.state === "rejected" &&
              row.command.type === "mfl" &&
              canonical(verified.action) === canonical(row.command.action),
            "UNVERIFIED_FOOTBALL_RECEIPT",
          );
        });
        await this.fail(claim, "MFL_WRITE_REJECTED", false, true);
        return "failed";
      }
      await this.hold(claim, undefined, true);
      return "held";
    } catch (error) {
      await this.hold(
        claim,
        error instanceof RuntimeError
          ? error.code
          : "MFL_RECONCILIATION_UNCERTAIN",
        true,
      );
      return "held";
    }
  }
  async dispatchOne(
    workerId: string,
    options: {
      leaseMs?: number;
      allowedAgentIds?: string[];
      afterExecute?: (receipt: FootballReceipt) => Promise<void>;
    } = {},
  ): Promise<{
    status: "idle" | "delivered" | "failed" | "stale" | "held";
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
      if (receipt.mfl && receipt.mfl.state !== "verified") {
        if (receipt.mfl.state === "rejected") {
          await this.fail(claim, "MFL_WRITE_REJECTED", false);
          return {
            status: "failed",
            outboxId: claim.id,
            error: "MFL_WRITE_REJECTED",
          };
        }
        await this.hold(claim);
        return { status: "held", outboxId: claim.id };
      }
      await this.acknowledge(claim, receipt);
      return { status: "delivered", outboxId: claim.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RuntimeError && error.code === "STALE_OUTBOX_CLAIM")
        return { status: "stale", outboxId: claim.id, error: message };
      try {
        if (claim.host_kind === "mfl" && claim.command.type === "mfl") {
          await this.hold(
            claim,
            error instanceof RuntimeError
              ? error.code
              : "MFL_DISPATCH_UNCERTAIN",
          );
          return {
            status: "held",
            outboxId: claim.id,
            error: "MFL_DISPATCH_UNCERTAIN",
          };
        }
        await this.fail(
          claim,
          message,
          !(
            error instanceof LeagueError ||
            error instanceof RuntimeError ||
            error instanceof MflError
          ),
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
