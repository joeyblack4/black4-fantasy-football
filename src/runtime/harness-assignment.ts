import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireCommissioner, requireLeague, type Principal } from "../auth.js";
import { transaction, type Db } from "../db.js";
import { fingerprint } from "../governance/validation.js";
import { HarnessIdSchema } from "../harnesses/catalog.js";
import { RuntimeError } from "./index.js";

export const HarnessSelectionSchema = z
  .object({
    harnessId: HarnessIdSchema,
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type HarnessSelection = z.infer<typeof HarnessSelectionSchema>;

export const StageHarnessAssignmentSchema = HarnessSelectionSchema.extend({
  leagueId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(200),
});

/** Internal SQL only: absence preserves legacy behavior; a requested native
 * harness never inherits the legacy route, and a staged assignment claims nothing. */
export function harnessClaimPredicate(
  alias: string,
  selectorParameter: string,
  digestParameter: string,
) {
  if (
    !/^[a-z_]+$/.test(alias) ||
    !/^\$\d+$/.test(selectorParameter) ||
    !/^\$\d+$/.test(digestParameter)
  )
    throw Error("INVALID_INTERNAL_ALIAS");
  return `((NOT EXISTS(SELECT 1 FROM runtime_harness_assignments ha WHERE ha.agent_id=${alias}.id) AND ${selectorParameter}::text IS NULL AND ${digestParameter}::text IS NULL) OR EXISTS(SELECT 1 FROM runtime_harness_assignments ha JOIN runtime_bindings hb ON hb.agent_id=ha.agent_id AND hb.league_id=ha.league_id WHERE ha.agent_id=${alias}.id AND ha.status='active' AND ha.model=${alias}.model AND ha.harness_id=${selectorParameter}::text AND ha.config_digest=${digestParameter}::text))`;
}

/** Actor must come from the authenticated transport, never an HTTP request body.
 * This service only stages migration; activation requires a future separately
 * verified billing and process-isolation implementation. */
export class HarnessAssignmentService {
  constructor(readonly db: Db) {}

  async stage(
    actor: Principal,
    input: z.input<typeof StageHarnessAssignmentSchema>,
  ) {
    requireCommissioner(actor);
    const request = StageHarnessAssignmentSchema.parse(input);
    requireLeague(actor, request.leagueId);
    const requestHash = fingerprint(request);
    return transaction(this.db, async (tx) => {
      // Same lock/order as claim: assignment staging cannot race a new turn.
      const agent = (
        await tx.query(
          "SELECT a.* FROM runtime_agents a WHERE a.id=$1 FOR NO KEY UPDATE",
          [request.agentId],
        )
      ).rows[0];
      const binding = (
        await tx.query(
          "SELECT b.league_id,t.kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1 FOR SHARE OF b,t",
          [request.agentId],
        )
      ).rows[0];
      if (!agent || !binding || binding.league_id !== request.leagueId)
        throw new RuntimeError("HARNESS_BINDING_MISMATCH");
      if (agent.kind !== "ai" || binding.kind !== "ai")
        throw new RuntimeError("HUMAN_CANNOT_BE_INVOKED");
      if (agent.model !== request.model)
        throw new RuntimeError("MODEL_PIN_VIOLATION");
      // Serialize league idempotency keys across different franchise locks.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7045))",
        [request.leagueId + ":" + request.idempotencyKey],
      );
      const previous = (
        await tx.query(
          "SELECT * FROM runtime_harness_assignments WHERE agent_id=$1 OR (league_id=$2 AND idempotency_key=$3)",
          [request.agentId, request.leagueId, request.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new RuntimeError("IDEMPOTENCY_CONFLICT");
        return previous;
      }
      if (
        (
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND status='running'",
            [request.agentId],
          )
        ).rowCount
      )
        throw new RuntimeError("HARNESS_RUNTIME_BUSY");
      if (
        (
          await tx.query(
            "SELECT 1 FROM runtime_reservations WHERE agent_id=$1 AND status IN ('reserved','uncertain')",
            [request.agentId],
          )
        ).rowCount
      )
        throw new RuntimeError("HARNESS_BILLING_UNRESOLVED");
      const receiptId = randomUUID();
      const assignment = (
        await tx.query(
          "INSERT INTO runtime_harness_assignments(agent_id,league_id,harness_id,model,config_digest,idempotency_key,request_hash,actor_id,receipt_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            request.agentId,
            request.leagueId,
            request.harnessId,
            request.model,
            request.configDigest,
            request.idempotencyKey,
            requestHash,
            actor.id,
            receiptId,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,details) VALUES('harness.assignment_staged',$1,$2)",
        [
          request.agentId,
          {
            ...request,
            receiptId,
            actorId: actor.id,
            status: "staged",
            legacyClaimsBlocked: true,
            productionActivated: false,
          },
        ],
      );
      return assignment;
    });
  }
}
