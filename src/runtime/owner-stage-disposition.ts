import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "../db.js";
import type { Actor } from "../league/schema.js";
import { fingerprint } from "../governance/validation.js";

const Identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export const ReplacementIntroSchema = z
  .object({
    agentId: Identifier,
    stageId: Identifier,
    priorOutboxId: z.uuid(),
    replacementCausalId: Identifier,
    reason: z.string().trim().min(10).max(4000),
    evidenceRef: z.string().trim().min(1).max(1000),
  })
  .strict();
export const INTRO_UNCERTAINTY_DISCLOSURE =
  "An earlier introduction attempt has an unconfirmed delivery outcome.";
const check = (value: unknown, code: string) => {
  if (!value) throw new Error(code);
};

export async function ownerStageIntroDisposition(
  tx: Pick<Db, "query">,
  input: {
    leagueId: string;
    stageId: string;
    agentId: string;
    defaultCausalId: string;
  },
) {
  const row = (
    await tx.query(
      "SELECT * FROM runtime_owner_intro_dispositions WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
      [input.leagueId, input.stageId, input.agentId],
    )
  ).rows[0];
  return {
    causalId: row?.replacement_causal_id ?? input.defaultCausalId,
    priorOutboxIds: row ? [row.prior_outbox_id as string] : [],
    receiptId: (row?.receipt_id ?? null) as string | null,
    predecessorUncertainty: row?.evidence ?? null,
    instruction: row
      ? `The commissioner permits a new introduction while the earlier attempt remains unconfirmed. Never resend or claim completion of the earlier attempt. Use this designated new causal ID and include the exact disclosure: ${INTRO_UNCERTAINTY_DISCLOSURE} Write genuinely new introductory content after the disclosure; do not copy the earlier introduction. Only independently observed canonical delivery of this replacement can satisfy the introduction checkpoint.`
      : null,
  };
}

/** Call at proposal validation and outbox execution; this does not send anything. */
export async function assertOwnerStageIntroReplacement(
  tx: Pick<Db, "query">,
  input: {
    leagueId: string;
    stageId: string;
    agentId: string;
    action: { causalId: string; channelId: string; content: string };
  },
) {
  const row = (
    await tx.query(
      "SELECT d.replacement_causal_id,o.causal_id AS prior_causal_id,o.action->>'content' AS prior_content,o.action->>'channelId' AS prior_channel_id FROM runtime_owner_intro_dispositions d JOIN runtime_franchise_outbox o ON o.id=d.prior_outbox_id WHERE d.league_id=$1 AND d.stage_id=$2 AND d.agent_id=$3",
      [input.leagueId, input.stageId, input.agentId],
    )
  ).rows[0];
  if (!row) return;
  check(
    input.action.causalId !== row.prior_causal_id,
    "OWNER_STAGE_PRIOR_INTRO_REMAINS_UNCERTAIN",
  );
  if (input.action.causalId !== row.replacement_causal_id) return;
  check(
    input.action.channelId === row.prior_channel_id,
    "OWNER_STAGE_REPLACEMENT_CHANNEL_MISMATCH",
  );
  check(
    input.action.content.includes(INTRO_UNCERTAINTY_DISCLOSURE),
    "OWNER_STAGE_REPLACEMENT_DISCLOSURE_REQUIRED",
  );
  const normalize = (text: string) =>
    text.replace(/\s+/g, " ").trim().toLowerCase();
  const fresh = normalize(
    input.action.content.replace(INTRO_UNCERTAINTY_DISCLOSURE, ""),
  );
  const prior = normalize(row.prior_content);
  check(
    fresh.length >= 80 && fresh !== prior && !fresh.includes(prior),
    "OWNER_STAGE_NEW_INTRO_REQUIRED",
  );
}

/** A disposition permits independent work; it cannot turn an uncertain send into a receipt. */
export class OwnerStageDispositionService {
  constructor(private db: Db) {}
  async authorizeReplacementIntro(
    actor: Actor,
    input: z.input<typeof ReplacementIntroSchema>,
  ) {
    check(
      actor.role === "commissioner" && actor.leagueId,
      "OWNER_STAGE_COMMISSIONER_REQUIRED",
    );
    const request = ReplacementIntroSchema.parse(input);
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7044,hashtext($1))", [
        actor.leagueId,
      ]);
      await tx.query("SELECT id FROM runtime_agents WHERE id=$1 FOR UPDATE", [
        request.agentId,
      ]);
      const stage = (
        await tx.query(
          "SELECT s.* FROM runtime_owner_stages s JOIN runtime_bindings b ON b.league_id=s.league_id WHERE s.league_id=$1 AND s.id=$2 AND b.agent_id=$3 AND s.status IN ('active','paused') FOR UPDATE OF s",
          [actor.leagueId, request.stageId, request.agentId],
        )
      ).rows[0];
      check(stage, "OWNER_STAGE_SCOPE");
      const requestHash = fingerprint(request);
      const old = (
        await tx.query(
          "SELECT * FROM runtime_owner_intro_dispositions WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
          [actor.leagueId, request.stageId, request.agentId],
        )
      ).rows[0];
      if (old) {
        check(
          old.request_hash === requestHash,
          "OWNER_STAGE_INTRO_DISPOSITION_CONFLICT",
        );
        return { ...old.evidence, replayed: true };
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
            "SELECT 1 FROM runtime_owner_stage_reviews WHERE league_id=$1 AND stage_id=$2 AND agent_id=$3",
            [actor.leagueId, request.stageId, request.agentId],
          )
        ).rowCount,
        "OWNER_STAGE_ALREADY_REVIEWED",
      );
      const outbox = (
        await tx.query(
          `SELECT o.*,p.pubkey,l.community_url FROM runtime_franchise_outbox o
         JOIN runtime_owner_stage_turns t ON t.job_id=o.job_id AND t.fence=o.origin_fence AND t.agent_id=o.agent_id AND t.league_id=o.league_id
         JOIN runtime_bindings b ON b.agent_id=o.agent_id AND b.league_id=o.league_id AND b.team_id=o.team_id
         JOIN league_teams team ON team.league_id=o.league_id AND team.id=o.team_id AND team.owner_id=o.owner_id
         JOIN buzz_participants p ON p.agent_id=o.agent_id AND p.league_id=o.league_id AND p.owner_id=o.owner_id AND p.team_id=o.team_id
         JOIN buzz_league_bindings l ON l.league_id=o.league_id
         WHERE o.id=$1 AND o.agent_id=$2 AND o.league_id=$3 AND t.stage_id=$4 FOR UPDATE OF o`,
          [
            request.priorOutboxId,
            request.agentId,
            actor.leagueId,
            request.stageId,
          ],
        )
      ).rows[0];
      const originalCausalId = `onboarding:${request.stageId}:intro`;
      check(
        outbox &&
          outbox.status === "held" &&
          outbox.action.type === "buzz_channel" &&
          outbox.causal_id === originalCausalId &&
          outbox.action.causalId === originalCausalId &&
          outbox.action.channelId === stage.configuration.introChannelId,
        "OWNER_STAGE_HELD_INTRO_REQUIRED",
      );
      check(
        request.replacementCausalId.startsWith(
          originalCausalId + ":replacement:",
        ),
        "OWNER_STAGE_NEW_INTRO_CAUSAL_ID_REQUIRED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_franchise_outbox WHERE agent_id=$1 AND causal_id=$2",
            [request.agentId, request.replacementCausalId],
          )
        ).rowCount,
        "OWNER_STAGE_REPLACEMENT_ALREADY_EXISTS",
      );
      const contentHash = createHash("sha256")
        .update(outbox.action.content)
        .digest("hex");
      const buzz = (
        await tx.query(
          "SELECT * FROM buzz_action_receipts WHERE operation_key=$1 AND actor_pubkey=$2 AND community_url=$3 AND channel_id=$4 AND expected_content_hash=$5 AND status='unknown' FOR UPDATE",
          [
            `channel:${actor.leagueId}:${outbox.pubkey}:runtime-franchise:${outbox.id}`,
            outbox.pubkey,
            outbox.community_url,
            stage.configuration.introChannelId,
            contentHash,
          ],
        )
      ).rows[0];
      check(buzz, "OWNER_STAGE_UNKNOWN_BUZZ_RECEIPT_REQUIRED");
      const evidence = {
        receiptId: randomUUID(),
        leagueId: actor.leagueId,
        stageId: request.stageId,
        agentId: request.agentId,
        priorOutboxId: outbox.id,
        priorOutboxStatus: "held",
        priorCausalId: originalCausalId,
        priorBuzzReceiptId: buzz.id,
        priorBuzzStatus: "unknown",
        priorEventId: buzz.event_id,
        priorContentHash: contentHash,
        replacementCausalId: request.replacementCausalId,
        reason: request.reason,
        evidenceRef: request.evidenceRef,
        reviewedBy: actor.id,
        disposition: "permit-new-introduction-with-prior-delivery-unconfirmed",
        priorIntroductionComplete: false,
        externalRetryAuthorized: false,
      };
      await tx.query(
        "INSERT INTO runtime_owner_intro_dispositions(league_id,stage_id,agent_id,prior_outbox_id,prior_buzz_receipt_id,replacement_causal_id,receipt_id,request_hash,evidence,reviewed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          actor.leagueId,
          request.stageId,
          request.agentId,
          outbox.id,
          buzz.id,
          request.replacementCausalId,
          evidence.receiptId,
          requestHash,
          JSON.stringify(evidence),
          actor.id,
        ],
      );
      await tx.query(
        "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.intro_disposition',$1,$2,$3)",
        [request.agentId, outbox.job_id, JSON.stringify(evidence)],
      );
      return { ...evidence, replayed: false };
    });
  }
}
