import { assertOwnerStageAction } from "../runtime/owner-stage.js";
import { assertOwnerStageIntroReplacement } from "../runtime/owner-stage-disposition.js";
import { RuntimeError } from "../runtime/index.js";
import { randomUUID } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";
import type { Job, RuntimeStore } from "../runtime/index.js";
import { GovernanceService } from "../governance/index.js";
import { LeagueError } from "../league/schema.js";
import { z } from "zod";
import type { BuzzChannelService } from "../buzz/channel.js";
import { FranchiseActionSchema, type FranchiseAction } from "./schema.js";
import {
  FranchiseService,
  FranchiseError,
  guard,
  fingerprint,
  type FranchiseReceipt,
} from "./service.js";
export async function enqueueFranchise(
  tx: Tx,
  job: Job,
  input: FranchiseAction,
) {
  const action = FranchiseActionSchema.parse(input);
  guard(
    Buffer.byteLength(JSON.stringify(action)) <= 250000,
    "FRANCHISE_ACTION_TOO_LARGE",
  );
  const binding = (
    await tx.query(
      "SELECT b.*,t.owner_id,t.kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1",
      [job.agentId],
    )
  ).rows[0];
  guard(binding && binding.kind === "ai", "FRANCHISE_BINDING_REQUIRED");
  if (action.type === "buzz_channel") {
    const stage = (
      await tx.query(
        "SELECT id FROM runtime_owner_stages WHERE league_id=$1 AND status IN ('active','paused') ORDER BY configured_at DESC LIMIT 1",
        [binding.league_id],
      )
    ).rows[0];
    if (stage)
      await assertOwnerStageIntroReplacement(tx, {
        leagueId: binding.league_id,
        stageId: stage.id,
        agentId: job.agentId,
        action,
      });
  }
  const hash = fingerprint({
    leagueId: binding.league_id,
    teamId: binding.team_id,
    ownerId: binding.owner_id,
    action,
  });
  const old = (
    await tx.query(
      "SELECT * FROM runtime_franchise_outbox WHERE agent_id=$1 AND causal_id=$2",
      [job.agentId, action.causalId],
    )
  ).rows[0];
  if (old) {
    guard(old.fingerprint === hash, "IDEMPOTENCY_CONFLICT");
    return old;
  }
  guard(
    (
      await tx.query(
        "SELECT count(*)::int AS n FROM runtime_franchise_outbox WHERE agent_id=$1 AND status IN ('pending','running','held')",
        [job.agentId],
      )
    ).rows[0].n < 100,
    "FRANCHISE_BACKLOG_LIMIT",
  );
  const row = (
    await tx.query(
      "INSERT INTO runtime_franchise_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,action) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
      [
        randomUUID(),
        job.agentId,
        job.id,
        action.causalId,
        hash,
        job.fence,
        binding.league_id,
        binding.team_id,
        binding.owner_id,
        JSON.stringify(action),
      ],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.queued',$1,$2,$3)",
    [
      job.agentId,
      job.id,
      JSON.stringify({ outboxId: row.id, actionType: action.type }),
    ],
  );
  return row;
}
export type FranchiseClaim = {
  id: string;
  agent_id: string;
  job_id: string;
  league_id: string;
  team_id: string;
  owner_id: string;
  action: FranchiseAction;
  worker_id: string;
  fence: number;
  attempts: number;
};
export class FranchiseOutbox {
  constructor(
    readonly db: Db,
    readonly runtime: RuntimeStore,
    readonly service = new FranchiseService(db),
    readonly governance = new GovernanceService(db),
    readonly buzzChannel?: BuzzChannelService,
  ) {}
  async claim(
    workerId: string,
    leaseMs = 30000,
    allowedAgentIds?: string[],
  ): Promise<FranchiseClaim | null> {
    guard(
      workerId.length > 0 &&
        workerId.length <= 200 &&
        Number.isSafeInteger(leaseMs) &&
        leaseMs >= 10 &&
        leaseMs <= 600000,
      "INVALID_CLAIM",
    );
    guard(
      allowedAgentIds === undefined ||
        (allowedAgentIds.length <= 100 &&
          allowedAgentIds.every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
          )),
      "INVALID_SCOPE",
    );
    return transaction(this.db, async (tx) => {
      const row = (
        await tx.query(
          "SELECT * FROM runtime_franchise_outbox WHERE ($1::text[] IS NULL OR agent_id=ANY($1::text[])) AND status IN ('pending','running') AND next_attempt_at<=clock_timestamp() AND (status='pending' OR lease_until<=clock_timestamp()) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
          [allowedAgentIds ?? null],
        )
      ).rows[0];
      if (!row) return null;
      if (row.attempts >= 5) {
        await tx.query(
          "UPDATE runtime_franchise_outbox SET status=$2,error='DISPATCH_ATTEMPTS_EXHAUSTED',lease_until=NULL WHERE id=$1",
          [row.id, row.action.type === "buzz_channel" ? "held" : "dead"],
        );
        if (row.action.type !== "buzz_channel")
          await this.failedWake(tx, row, "DISPATCH_ATTEMPTS_EXHAUSTED");
        else
          await tx.query(
            "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.held',$1,$2,$3)",
            [
              row.agent_id,
              row.job_id,
              {
                outboxId: row.id,
                actionType: "buzz_channel",
                automaticRetry: false,
                reason: "DISPATCH_ATTEMPTS_EXHAUSTED",
              },
            ],
          );
        return null;
      }
      return (
        await tx.query(
          "UPDATE runtime_franchise_outbox SET status='running',worker_id=$2,fence=fence+1,attempts=attempts+1,lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 RETURNING *",
          [row.id, workerId, leaseMs],
        )
      ).rows[0];
    });
  }
  private async check(tx: Tx, claim: FranchiseClaim) {
    const row = (
      await tx.query(
        "SELECT *,lease_until>clock_timestamp() AS live FROM runtime_franchise_outbox WHERE id=$1 FOR UPDATE",
        [claim.id],
      )
    ).rows[0];
    guard(
      row &&
        row.status === "running" &&
        row.fence === claim.fence &&
        row.worker_id === claim.worker_id &&
        row.live,
      "STALE_FRANCHISE_CLAIM",
    );
    return row;
  }
  async execute(claim: FranchiseClaim): Promise<FranchiseReceipt> {
    const context = await transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      const binding = (
        await tx.query(
          "SELECT b.*,t.owner_id,t.kind,a.enabled,a.kind AS runtime_kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1",
          [row.agent_id],
        )
      ).rows[0];
      guard(
        binding &&
          binding.enabled &&
          binding.kind === "ai" &&
          binding.runtime_kind === "ai" &&
          binding.league_id === row.league_id &&
          binding.team_id === row.team_id &&
          binding.owner_id === row.owner_id,
        "FRANCHISE_AUTHORITY_CHANGED",
      );
      await assertOwnerStageAction(
        tx,
        row.agent_id,
        row.action.type,
        row.job_id,
      );
      if (row.action.type === "buzz_channel") {
        const stage = (
          await tx.query(
            "SELECT id FROM runtime_owner_stages WHERE league_id=$1 AND status IN ('active','paused') ORDER BY configured_at DESC LIMIT 1",
            [row.league_id],
          )
        ).rows[0];
        if (stage)
          await assertOwnerStageIntroReplacement(tx, {
            leagueId: row.league_id,
            stageId: stage.id,
            agentId: row.agent_id,
            action: row.action,
          });
      }
      return {
        actor: {
          id: binding.owner_id,
          role: "owner" as const,
          teamId: binding.team_id,
          leagueId: binding.league_id,
        },
        agentId: row.agent_id,
        action: FranchiseActionSchema.parse(row.action),
        key: "runtime-franchise:" + row.id,
      };
    });
    if (context.action.type === "governance")
      return this.governance.execute(context.actor, {
        ...context.action.command,
        leagueId: context.actor.leagueId,
        idempotencyKey: context.key,
      });
    if (context.action.type === "buzz_channel") {
      guard(this.buzzChannel, "BUZZ_CHANNEL_NOT_CONFIGURED");
      const response = await this.buzzChannel.send(context.actor, {
        leagueId: context.actor.leagueId,
        channelId: context.action.channelId,
        content: context.action.content,
        mentionAgentIds: context.action.mentionAgentIds,
        replyTo: context.action.replyTo,
        operationKey: context.key,
      });
      return {
        receiptId: response.receiptId,
        replayed: response.replayed,
        result: response,
      };
    }
    return this.service.execute(context.actor, {
      agentId: context.agentId,
      idempotencyKey: context.key,
      action: context.action,
    });
  }
  async acknowledge(claim: FranchiseClaim, receipt: FranchiseReceipt) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      let official: FranchiseReceipt;
      if (row.action.type === "buzz_channel") {
        guard(this.buzzChannel, "BUZZ_CHANNEL_NOT_CONFIGURED");
        const response = await this.buzzChannel.verifyReceipt(
          tx,
          {
            id: row.owner_id,
            role: "owner",
            leagueId: row.league_id,
            teamId: row.team_id,
          },
          {
            leagueId: row.league_id,
            channelId: row.action.channelId,
            content: row.action.content,
            mentionAgentIds: row.action.mentionAgentIds,
            replyTo: row.action.replyTo,
            operationKey: "runtime-franchise:" + row.id,
          },
          receipt.receiptId,
        );
        guard(response.status === "accepted", "UNVERIFIED_FRANCHISE_RECEIPT");
        official = {
          receiptId: response.receiptId,
          replayed: receipt.replayed,
          result: response,
        };
      } else if (row.action.type === "governance") {
        const stored = (
          await tx.query(
            "SELECT response FROM governance_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
            [row.league_id, row.owner_id, "runtime-franchise:" + row.id],
          )
        ).rows[0];
        guard(
          stored?.response?.receiptId === receipt.receiptId,
          "UNVERIFIED_FRANCHISE_RECEIPT",
        );
        official = stored.response;
      } else {
        const stored = (
          await tx.query(
            "SELECT id,result FROM franchise_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
            [row.league_id, row.owner_id, "runtime-franchise:" + row.id],
          )
        ).rows[0];
        guard(stored?.id === receipt.receiptId, "UNVERIFIED_FRANCHISE_RECEIPT");
        official = {
          receiptId: stored.id,
          result: stored.result,
          replayed: false,
        };
      }
      await tx.query(
        "UPDATE runtime_franchise_outbox SET status='delivered',service_receipt=$2,delivered_at=clock_timestamp(),lease_until=NULL WHERE id=$1",
        [row.id, JSON.stringify(official)],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.executed',$1,$2,$3)",
        [
          row.agent_id,
          row.job_id,
          JSON.stringify({
            outboxId: row.id,
            actionType: row.action.type,
            receiptId: official.receiptId,
            replayed: receipt.replayed,
          }),
        ],
      );
      if (
        (
          await tx.query(
            "SELECT 1 FROM runtime_owner_stages WHERE league_id=$1 AND status='active'",
            [row.league_id],
          )
        ).rowCount
      )
        return official; // Stage readiness reads durable outcomes without reply storms.
      if (row.action.type === "buzz_channel") return official; // Only canonical Buzz polling delivers native messages.
      if (
        row.action.type === "governance" &&
        (
          await tx.query(
            "SELECT 1 FROM runtime_conventions WHERE league_id=$1 AND status='active'",
            [row.league_id],
          )
        ).rowCount
      )
        return official;
      let targets = [row.agent_id];
      if (
        row.action.type === "governance" &&
        row.action.command.type === "submitProposal"
      )
        targets = (
          await tx.query(
            "SELECT agent_id FROM runtime_bindings WHERE league_id=$1 ORDER BY agent_id",
            [row.league_id],
          )
        ).rows.map((r) => r.agent_id);
      for (const agentId of targets)
        await this.runtime.ingestEventTx(tx, {
          agentId,
          causalId: "franchise-result:" + row.id,
          payload: {
            kind: "franchise.result",
            actionType: row.action.type,
            initiatedBy: row.agent_id,
            commandType: row.action.command?.type ?? null,
            receiptId: official.receiptId,
            result: official.result,
          },
        });
      return official;
    });
  }
  private async failedWake(tx: Tx, row: any, error: string) {
    await tx.query(
      "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.failed',$1,$2,$3)",
      [row.agent_id, row.job_id, JSON.stringify({ outboxId: row.id, error })],
    );
    await this.runtime.ingestEventTx(tx, {
      agentId: row.agent_id,
      causalId: "franchise-failed:" + row.id,
      payload: { kind: "franchise.failed", actionType: row.action.type, error },
    });
  }
  async fail(claim: FranchiseClaim, error: string, retryable: boolean) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      const retry = retryable && row.attempts < 5;
      await tx.query(
        "UPDATE runtime_franchise_outbox SET status=$2,error=$3,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [row.id, retry ? "pending" : "dead", error.slice(0, 1000)],
      );
      if (!retry) await this.failedWake(tx, row, error.slice(0, 1000));
      else
        await tx.query(
          "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.retry',$1,$2,$3)",
          [
            row.agent_id,
            row.job_id,
            JSON.stringify({ outboxId: row.id, error: error.slice(0, 1000) }),
          ],
        );
    });
  }
  async dispatchOne(
    workerId: string,
    options: {
      leaseMs?: number;
      allowedAgentIds?: string[];
      afterExecute?: (receipt: FranchiseReceipt) => Promise<void>;
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
      if (
        claim.action.type === "buzz_channel" &&
        receipt.result.status !== "accepted"
      ) {
        if (receipt.result.status === "rejected") {
          await this.fail(claim, "BUZZ_CHANNEL_SEND_REJECTED", false);
          return { status: "failed", outboxId: claim.id };
        }
        await this.holdChannel(claim);
        return { status: "held", outboxId: claim.id };
      }
      await this.acknowledge(claim, receipt);
      return { status: "delivered", outboxId: claim.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof FranchiseError &&
        error.code === "STALE_FRANCHISE_CLAIM"
      )
        return { status: "stale", outboxId: claim.id, error: message };
      try {
        if (
          error instanceof RuntimeError &&
          error.code.startsWith("OWNER_STAGE_")
        ) {
          await transaction(this.db, async (tx) => {
            const row = await this.check(tx, claim);
            await tx.query(
              "UPDATE runtime_franchise_outbox SET status='held',error=$2,lease_until=NULL WHERE id=$1",
              [row.id, error.code],
            );
            await tx.query(
              "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.held',$1,$2,$3)",
              [
                row.agent_id,
                row.job_id,
                { outboxId: row.id, reason: error.code, automaticRetry: false },
              ],
            );
          });
          return { status: "held", outboxId: claim.id, error: error.code };
        }
        if (claim.action.type === "buzz_channel") {
          await this.holdChannel(claim);
          return {
            status: "held",
            outboxId: claim.id,
            error: "BUZZ_CHANNEL_SEND_UNCERTAIN",
          };
        }
        await this.fail(
          claim,
          message,
          !(
            error instanceof FranchiseError ||
            error instanceof LeagueError ||
            error instanceof z.ZodError
          ),
        );
      } catch (failure) {
        if (
          failure instanceof FranchiseError &&
          failure.code === "STALE_FRANCHISE_CLAIM"
        )
          return { status: "stale", outboxId: claim.id, error: message };
        throw failure;
      }
      return { status: "failed", outboxId: claim.id, error: message };
    }
  }
  private async holdChannel(claim: FranchiseClaim) {
    return transaction(this.db, async (tx) => {
      const row = await this.check(tx, claim);
      await tx.query(
        "UPDATE runtime_franchise_outbox SET status='held',error='BUZZ_CHANNEL_SEND_REQUIRES_RECONCILIATION',lease_until=NULL WHERE id=$1",
        [row.id],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('franchise.held',$1,$2,$3)",
        [
          row.agent_id,
          row.job_id,
          {
            outboxId: row.id,
            actionType: "buzz_channel",
            automaticRetry: false,
          },
        ],
      );
    });
  }
}
