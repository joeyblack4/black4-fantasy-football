import { createHash } from "node:crypto";
import { z } from "zod";
import { type Db, transaction } from "../db.js";
import { requireLeague, type Principal } from "../auth.js";
import {
  BuzzReceiptService,
  planSend,
  type CliRunner,
  type LeagueIdentity,
  type Peer,
} from "./index.js";
function assert(v: unknown, message: string): asserts v {
  if (!v) throw new Error(message);
}
export const BuzzSendSchema = z
  .object({
    leagueId: z.string().min(1),
    channelId: z.uuid(),
    recipientPubkey: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().min(1).max(16384),
    replyTo: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    operationKey: z.string().min(1).max(120),
  })
  .strict();
/** Actor is the authenticated owner. Runner belongs to the verified same owner signing identity; use private channels for an unrelated human. */
export class BuzzMessagingService {
  constructor(private db: Db) {}
  async send(
    actor: Principal,
    input: z.input<typeof BuzzSendSchema>,
    runner: CliRunner,
  ) {
    const v = BuzzSendSchema.parse(input);
    requireLeague(actor, v.leagueId);
    assert(actor.role === "owner", "Owner required");
    const b = (
      await this.db.query(
        "SELECT * FROM buzz_league_bindings WHERE league_id=$1",
        [v.leagueId],
      )
    ).rows[0];
    assert(b, "League Buzz binding required");
    const participants = (
      await this.db.query(
        "SELECT p.* FROM buzz_participants p JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id AND t.owner_id=p.owner_id WHERE p.league_id=$1",
        [v.leagueId],
      )
    ).rows;
    const sender = participants.find(
        (p) => p.owner_id === actor.id && p.team_id === actor.teamId,
      ),
      peer = participants.find((p) => p.pubkey === v.recipientPubkey);
    assert(sender && peer, "Owner/peer binding mismatch");
    const c = (
      await this.db.query(
        "SELECT * FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2",
        [v.leagueId, v.channelId],
      )
    ).rows[0];
    assert(c, "Conversation not approved");
    const fresh = (
      await this.db.query(
        `SELECT 1 FROM buzz_inbound_cursors WHERE league_id=$1 AND channel_id=$2 AND listener_pubkey=$3 AND state='healthy' AND last_complete_at>clock_timestamp()-interval '60 seconds'`,
        [v.leagueId, v.channelId, sender.pubkey],
      )
    ).rowCount;
    assert(fresh, "Fresh sender membership observation required");
    if (v.replyTo)
      assert(
        (
          await this.db.query(
            "SELECT 1 FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND event_id=$3",
            [v.leagueId, v.channelId, v.replyTo],
          )
        ).rowCount,
        "Reply target not observed in this conversation",
      );
    const identity: LeagueIdentity = {
      pubkey: sender.pubkey,
      ownerPubkey: sender.owner_pubkey ?? sender.pubkey,
      ownershipVerified: true,
      communityUrl: b.community_url,
      kind: sender.kind,
      allowedPeerPubkeys: c.member_pubkeys,
    };
    const counterpart: Peer = {
      pubkey: peer.pubkey,
      ownerPubkey: peer.owner_pubkey ?? peer.pubkey,
      ownershipVerified: true,
      communityUrl: b.community_url,
      kind: peer.kind,
    };
    const plan = planSend(
      identity,
      counterpart,
      {
        id: v.channelId,
        communityUrl: b.community_url,
        memberPubkeys: c.member_pubkeys,
        kind: c.kind,
      },
      v.content,
      v.replyTo,
    );
    const key = `buzz:${v.leagueId}:${sender.pubkey}:${v.operationKey}`;
    assert(key.length <= 200, "Operation key too long for scoped receipt");
    return new BuzzReceiptService(this.db).execute(key, plan, runner);
  }
  /** Read-only relay evidence reconciliation. An exact known event ID proves observation; content matches without the signed ID remain ambiguous and never permit a resend. */
  async reconcile(
    actor: Principal,
    input: { leagueId: string; operationKey: string },
  ) {
    requireLeague(actor, input.leagueId);
    return transaction(this.db, async (tx) => {
      const row = (
        await tx.query(
          "SELECT r.* FROM buzz_action_receipts r JOIN buzz_league_bindings b ON b.community_url=r.community_url WHERE b.league_id=$1 AND r.operation_key=$2 FOR UPDATE OF r",
          [input.leagueId, input.operationKey],
        )
      ).rows[0];
      assert(row, "Unknown league Buzz operation");
      if (actor.role !== "commissioner")
        assert(
          actor.role === "owner" &&
            (
              await tx.query(
                "SELECT 1 FROM buzz_participants WHERE league_id=$1 AND pubkey=$2 AND owner_id=$3 AND team_id=$4",
                [
                  input.leagueId,
                  row.actor_pubkey,
                  actor.id,
                  actor.teamId ?? null,
                ],
              )
            ).rowCount,
          "Operation owner required",
        );
      const candidates = (
        await tx.query(
          "SELECT event_id,content,tags,source_created_at,observed_at FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND author_pubkey=$3 AND kind IN (9,40002) AND observed_at>=$4 AND source_created_at>=extract(epoch FROM $4::timestamptz)-60 ORDER BY sequence",
          [input.leagueId, row.channel_id, row.actor_pubkey, row.created_at],
        )
      ).rows.filter((e) => {
        const contentHash = createHash("sha256")
          .update(e.content)
          .digest("hex");
        const tags = e.tags as string[][];
        const reply =
          tags.find((t) => t[0] === "e" && t[3] === "reply")?.[1] ??
          tags.filter((t) => t[0] === "e").at(-1)?.[1] ??
          null;
        return (
          contentHash === row.expected_content_hash &&
          reply === row.expected_reply_to
        );
      });
      const exact = row.event_id
        ? candidates.find((e) => e.event_id === row.event_id)
        : undefined;
      const reconciliation = {
        state: exact ? "observed_exact_event" : "unknown",
        candidateEventIds: candidates.map((e) => e.event_id),
        basis: exact
          ? "Known signed event ID observed in authenticated relay history"
          : "Content similarity does not prove which send published; never blind retry",
        checkedBy: actor.id,
      };
      await tx.query(
        "UPDATE buzz_action_receipts SET reconciliation=$2,updated_at=clock_timestamp() WHERE id=$1",
        [row.id, JSON.stringify(reconciliation)],
      );
      return {
        receiptId: row.id,
        status: row.status,
        reconciliation,
        requiresReconciliation: !exact,
        mayRetry: false,
      };
    });
  }
}
