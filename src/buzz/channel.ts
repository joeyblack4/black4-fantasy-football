import { z } from "zod";
import { createHash } from "node:crypto";
import { type Db } from "../db.js";
import { requireLeague, type Principal } from "../auth.js";
import { BuzzReceiptService, type BuzzPlan } from "./index.js";
import { type BuzzOutboundTransportFactory } from "./runtime-outbound.js";
import { BuzzArchiveService } from "./archive.js";

export const BuzzChannelSendSchema = z
  .object({
    leagueId: z.string().min(1),
    channelId: z.uuid(),
    content: z.string().min(1).max(16384),
    mentionAgentIds: z.array(z.string().min(1)).max(11).default([]),
    replyTo: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    operationKey: z.string().min(1).max(80),
  })
  .strict();
function assert(v: unknown, message: string): asserts v {
  if (!v) throw Error(message);
}

/** Native channel messages are delivered to models ONLY by canonical polling.
 * No runtime_messages mirror or direct inbox write occurs here. */
export class BuzzChannelService {
  constructor(
    private db: Db,
    private transport: BuzzOutboundTransportFactory,
  ) {}
  async send(actor: Principal, input: z.input<typeof BuzzChannelSendSchema>) {
    const v = BuzzChannelSendSchema.parse(input);
    requireLeague(actor, v.leagueId);
    assert(actor.role === "owner", "BUZZ_OWNER_REQUIRED");
    assert(
      v.content.trim() &&
        !v.content.includes("\0") &&
        Buffer.byteLength(v.content) <= 16384,
      "BUZZ_CONTENT_INVALID",
    );
    assert(
      new Set(v.mentionAgentIds).size === v.mentionAgentIds.length,
      "BUZZ_DUPLICATE_MENTION",
    );
    const b = (
      await this.db.query(
        "SELECT * FROM buzz_league_bindings WHERE league_id=$1",
        [v.leagueId],
      )
    ).rows[0];
    assert(b, "BUZZ_BINDING_REQUIRED");
    const members = (
      await this.db.query(
        `SELECT p.*,i.mode ingress_mode FROM buzz_participants p JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id AND t.owner_id=p.owner_id LEFT JOIN buzz_ingress_modes i ON i.league_id=p.league_id AND i.agent_id=p.agent_id WHERE p.league_id=$1`,
        [v.leagueId],
      )
    ).rows;
    const sender = members.find(
      (p) => p.owner_id === actor.id && p.team_id === actor.teamId,
    );
    assert(
      sender?.kind === "agent" &&
        sender.agent_id &&
        sender.ingress_mode === "poll",
      "BUZZ_MANAGED_POLL_SENDER_REQUIRED",
    );
    const c = (
      await this.db.query(
        "SELECT * FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2",
        [v.leagueId, v.channelId],
      )
    ).rows[0];
    assert(
      c?.kind === "private-channel" && c.member_pubkeys.includes(sender.pubkey),
      "BUZZ_PRIVATE_CHANNEL_REQUIRED",
    );
    const mentioned = v.mentionAgentIds
      .map((id) => {
        const p = members.find(
          (p) => p.agent_id === id && p.pubkey !== sender.pubkey,
        );
        assert(
          p && c.member_pubkeys.includes(p.pubkey) && p.ingress_mode === "poll",
          "BUZZ_MENTION_NOT_BOUND",
        );
        return p.pubkey as string;
      })
      .sort();
    if (v.replyTo)
      assert(
        (
          await this.db.query(
            "SELECT 1 FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND event_id=$3",
            [v.leagueId, v.channelId, v.replyTo],
          )
        ).rowCount,
        "BUZZ_REPLY_NOT_OBSERVED",
      );
    const transport = await this.transport({
      leagueId: v.leagueId,
      senderAgentId: sender.agent_id,
      pubkey: sender.pubkey,
      communityUrl: b.community_url,
      mode: b.mode,
    });
    const observed = z
      .array(
        z.object({
          pubkey: z.string().regex(/^[a-f0-9]{64}$/),
          role: z.string(),
        }),
      )
      .max(12)
      .parse(
        await transport.read({ command: "members", channelId: v.channelId }),
      );
    assert(
      JSON.stringify(observed.map((p) => p.pubkey).sort()) ===
        JSON.stringify([...c.member_pubkeys].sort()),
      "BUZZ_MEMBERSHIP_CHANGED",
    );
    const key = `channel:${v.leagueId}:${sender.pubkey}:${v.operationKey}`;
    const plan: BuzzPlan = {
      actorPubkey: sender.pubkey,
      communityUrl: b.community_url,
      command: "send",
      channelId: v.channelId,
      stdin: v.content,
      args: [
        "messages",
        "send",
        "--channel",
        v.channelId,
        "--content",
        "-",
        ...mentioned.flatMap((p) => ["--mention", p]),
        ...(v.replyTo ? ["--reply-to", v.replyTo] : []),
      ],
    };
    const lock = await this.db.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,142))", [
        `${v.leagueId}:${v.channelId}`,
      ]);
      assert(
        !(
          await this.db.query(
            // An uncertain write blocks a duplicate under a new causal key,
            // not independent conversation by the rest of the league. Keep
            // legacy receipts without a content hash conservative per sender.
            "SELECT 1 FROM buzz_action_receipts WHERE community_url=$1 AND channel_id=$2 AND status IN ('prepared','unknown') AND operation_key<>$3 AND actor_pubkey=$4 AND (expected_content_hash=$5 OR expected_content_hash IS NULL)",
            [
              b.community_url,
              v.channelId,
              key,
              sender.pubkey,
              createHash("sha256").update(v.content).digest("hex"),
            ],
          )
        ).rowCount,
        "BUZZ_CHANNEL_UNCERTAIN_SEND_HELD",
      );
      const receipt = await new BuzzReceiptService(this.db).execute(
        key,
        plan,
        transport.run,
      );
      return {
        receiptId: receipt.id,
        status: receipt.status,
        eventId: receipt.event_id,
        replayed: receipt.replayed,
        requiresReconciliation: receipt.requiresReconciliation,
        modelWakeup: "canonical_poll_pending",
        synthetic: b.mode === "mock",
      };
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,142))", [
        `${v.leagueId}:${v.channelId}`,
      ]);
      lock.release();
    }
  }
  async read(
    actor: Principal,
    input: {
      leagueId: string;
      channelId: string;
      afterSequence?: string;
      limit?: number;
    },
  ) {
    return new BuzzArchiveService(this.db).query(actor, input);
  }
  async verifyReceipt(
    tx: Pick<Db, "query">,
    actor: Principal,
    input: z.input<typeof BuzzChannelSendSchema>,
    receiptId: string,
  ) {
    const v = BuzzChannelSendSchema.parse(input);
    requireLeague(actor, v.leagueId);
    assert(actor.role === "owner", "BUZZ_OWNER_REQUIRED");
    const sender = (
      await tx.query(
        "SELECT p.*,b.community_url,b.mode FROM buzz_participants p JOIN buzz_league_bindings b USING(league_id) WHERE p.league_id=$1 AND p.owner_id=$2 AND p.team_id=$3 AND p.kind='agent'",
        [v.leagueId, actor.id, actor.teamId],
      )
    ).rows[0];
    assert(sender, "BUZZ_OWNER_BINDING_REQUIRED");
    const peers = (
      await tx.query(
        "SELECT agent_id,pubkey FROM buzz_participants WHERE league_id=$1 AND agent_id=ANY($2::text[])",
        [v.leagueId, v.mentionAgentIds],
      )
    ).rows;
    assert(peers.length === v.mentionAgentIds.length, "BUZZ_MENTION_NOT_BOUND");
    const plan: BuzzPlan = {
      actorPubkey: sender.pubkey,
      communityUrl: sender.community_url,
      command: "send",
      channelId: v.channelId,
      stdin: v.content,
      args: [
        "messages",
        "send",
        "--channel",
        v.channelId,
        "--content",
        "-",
        ...peers
          .map((p) => String(p.pubkey))
          .sort()
          .flatMap((p) => ["--mention", p]),
        ...(v.replyTo ? ["--reply-to", v.replyTo] : []),
      ],
    };
    const planHash = createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    const row = (
      await tx.query(
        "SELECT * FROM buzz_action_receipts WHERE id=$1 AND operation_key=$2 AND actor_pubkey=$3 AND community_url=$4 AND plan_hash=$5",
        [
          receiptId,
          `channel:${v.leagueId}:${sender.pubkey}:${v.operationKey}`,
          sender.pubkey,
          sender.community_url,
          planHash,
        ],
      )
    ).rows[0];
    assert(row, "BUZZ_RECEIPT_BINDING_MISMATCH");
    return {
      receiptId: row.id,
      status: row.status,
      eventId: row.event_id,
      requiresReconciliation: ["prepared", "unknown"].includes(row.status),
      synthetic: sender.mode === "mock",
    };
  }
}
