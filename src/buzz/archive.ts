import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import {
  ApiError,
  requireCommissioner,
  requireLeague,
  type Principal,
} from "../auth.js";
import { RuntimeStore } from "../runtime/index.js";
import {
  conversationDeliveryEligibleTx,
  admitConversationDeliveryTx,
} from "../runtime/conversation.js";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(200);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const BuzzConfigurationSchema = z
  .object({
    leagueId: key,
    communityUrl: z.url(),
    mode: z.enum(["mock", "real"]),
    bindingReceiptId: key,
    archiveConsentReceiptId: key,
    participants: z
      .array(
        z
          .object({
            pubkey: hex,
            ownerId: key,
            teamId: key,
            agentId: key.optional(),
            kind: z.enum(["human", "agent"]),
            ownerPubkey: hex.optional(),
          })
          .strict(),
      )
      .min(2)
      .max(12),
  })
  .strict();
export const BuzzHumanBroadcastSchema = z
  .object({
    leagueId: key,
    channelId: z.uuid(),
    enabled: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: key,
    reason: z.string().trim().min(8).max(2000),
  })
  .strict();
export const BuzzEventSchema = z
  .object({
    id: hex,
    pubkey: hex,
    kind: z
      .number()
      .int()
      .refine((v) => [9, 40002, 40003, 9005, 5].includes(v)),
    content: z.string().max(65536),
    created_at: z.number().int().nonnegative(),
    tags: z.array(z.array(z.string().max(65536)).max(20)).max(200),
  })
  .strict();
export type BuzzEvent = z.infer<typeof BuzzEventSchema>;
export type BuzzListener = {
  leagueId: string;
  communityUrl: string;
  pubkey: string;
  mode: "mock" | "real";
};
export const BuzzArchiveQuerySchema = z
  .object({
    leagueId: key,
    channelId: z.uuid(),
    afterSequence: z.string().regex(/^\d+$/).default("0"),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const BuzzArchiveEventQuerySchema = z
  .object({
    leagueId: key,
    channelId: z.uuid(),
    eventId: hex,
  })
  .strict();
function tag(event: BuzzEvent, name: string) {
  return event.tags
    .filter((t) => t[0] === name)
    .map((t) => t[1])
    .filter((v): v is string => !!v);
}
export function nostrEventId(event: Omit<BuzzEvent, "id">) {
  return hash([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** Private, consented archive. All method callers are trusted transports; listener identities cannot come from model tool bodies. CLI provenance is relay-authenticated, not locally signature verified. */
export class BuzzArchiveService {
  private runtime: RuntimeStore;
  constructor(private db: Db) {
    this.runtime = new RuntimeStore(db);
  }
  async configure(
    actor: Principal,
    input: z.input<typeof BuzzConfigurationSchema>,
  ) {
    const v = BuzzConfigurationSchema.parse(input);
    requireLeague(actor, v.leagueId);
    requireCommissioner(actor);
    const u = new URL(v.communityUrl);
    assert(
      u.protocol === "wss:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/",
      "Invalid community URL",
    );
    assert(
      u.hostname !== "black4.communities.buzz.xyz",
      "Existing customer community forbidden",
    );
    if (v.mode === "mock")
      assert(u.hostname.endsWith(".test"), "Mock community must use .test");
    else
      assert(
        !u.hostname.endsWith(".test"),
        "Real community cannot be synthetic",
      );
    assert(
      new Set(v.participants.map((p) => p.pubkey)).size ===
        v.participants.length,
      "Duplicate participant",
    );
    const canonical = {
      ...v,
      participants: [...v.participants].sort((a, b) =>
        a.pubkey.localeCompare(b.pubkey),
      ),
    };
    return transaction(this.db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,14))", [
        v.leagueId,
      ]);
      const prior = (
        await tx.query(
          "SELECT * FROM buzz_league_bindings WHERE league_id=$1",
          [v.leagueId],
        )
      ).rows[0];
      if (prior) {
        assert(
          prior.configuration_hash === hash(canonical),
          "Buzz binding is immutable",
        );
        return prior;
      }
      for (const p of v.participants) {
        const team = (
          await tx.query(
            "SELECT * FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
            [v.leagueId, p.teamId, p.ownerId],
          )
        ).rows[0];
        assert(
          team && team.kind === (p.kind === "agent" ? "ai" : "human"),
          "Participant owner/team mismatch",
        );
        if (p.kind === "agent") {
          assert(
            p.agentId && p.ownerPubkey,
            "Agent runtime and verified owner required",
          );
          assert(
            (
              await tx.query(
                "SELECT 1 FROM runtime_bindings b JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1 AND b.league_id=$2 AND b.team_id=$3 AND a.kind='ai'",
                [p.agentId, v.leagueId, p.teamId],
              )
            ).rowCount,
            "Runtime binding mismatch",
          );
        } else assert(!p.agentId, "Human has no model listener recipient");
      }
      const row = (
        await tx.query(
          "INSERT INTO buzz_league_bindings(league_id,community_url,mode,binding_receipt_id,archive_consent_receipt_id,configuration_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            v.leagueId,
            v.communityUrl,
            v.mode,
            v.bindingReceiptId,
            v.archiveConsentReceiptId,
            hash(canonical),
          ],
        )
      ).rows[0];
      for (const p of v.participants)
        await tx.query(
          "INSERT INTO buzz_participants(league_id,pubkey,owner_id,team_id,agent_id,kind,owner_pubkey) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            v.leagueId,
            p.pubkey,
            p.ownerId,
            p.teamId,
            p.agentId ?? null,
            p.kind,
            p.ownerPubkey ?? null,
          ],
        );
      return row;
    });
  }
  /** Trusted authenticated commissioner transport only. This changes routing, never starts a worker or grants model authority. */
  async configureHumanBroadcast(
    actor: Principal,
    input: z.input<typeof BuzzHumanBroadcastSchema>,
  ) {
    const v = BuzzHumanBroadcastSchema.parse(input);
    requireLeague(actor, v.leagueId);
    requireCommissioner(actor);
    return transaction(this.db, async (tx) => {
      // Same conversation lock as canonical ingest serializes the policy boundary.
      const channel = (
        await tx.query(
          "SELECT kind FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2 FOR UPDATE",
          [v.leagueId, v.channelId],
        )
      ).rows[0];
      assert(
        channel?.kind === "private-channel",
        "Human broadcast requires a registered private channel",
      );
      const priorReceipt = (
        await tx.query(
          "SELECT * FROM buzz_human_broadcast_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [v.leagueId, actor.id, v.idempotencyKey],
        )
      ).rows[0];
      if (priorReceipt) {
        assert(
          priorReceipt.payload_hash === hash(v),
          "Human broadcast idempotency conflict",
        );
        return {
          receiptId: priorReceipt.id,
          policy: priorReceipt.after_policy,
          replayed: true,
        };
      }
      const before =
        (
          await tx.query(
            "SELECT * FROM buzz_human_broadcast_policies WHERE league_id=$1 AND channel_id=$2",
            [v.leagueId, v.channelId],
          )
        ).rows[0] ?? null;
      assert(
        (before?.version ?? 0) === v.expectedVersion,
        "Human broadcast policy version conflict",
      );
      const after = (
        await tx.query(
          `INSERT INTO buzz_human_broadcast_policies(league_id,channel_id,enabled,version,effective_after_seconds,changed_by)
         VALUES($1,$2,$3,$4,CEIL(EXTRACT(EPOCH FROM clock_timestamp()))::bigint,$5)
         ON CONFLICT(league_id,channel_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,
         effective_after_seconds=EXCLUDED.effective_after_seconds,changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()
         RETURNING *`,
          [v.leagueId, v.channelId, v.enabled, v.expectedVersion + 1, actor.id],
        )
      ).rows[0];
      const receiptId = randomUUID();
      await tx.query(
        `INSERT INTO buzz_human_broadcast_receipts(id,league_id,channel_id,actor_id,idempotency_key,payload_hash,before_policy,after_policy,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          receiptId,
          v.leagueId,
          v.channelId,
          actor.id,
          v.idempotencyKey,
          hash(v),
          before,
          after,
          v.reason,
        ],
      );
      return { receiptId, policy: after, replayed: false };
    });
  }
  private async listener(tx: Tx, listener: BuzzListener) {
    const row = (
      await tx.query(
        "SELECT b.*,p.pubkey FROM buzz_league_bindings b JOIN buzz_participants p ON p.league_id=b.league_id WHERE b.league_id=$1 AND p.pubkey=$2",
        [listener.leagueId, listener.pubkey],
      )
    ).rows[0];
    assert(
      row &&
        row.community_url === listener.communityUrl &&
        row.mode === listener.mode,
      "Listener binding mismatch",
    );
    return row;
  }
  /** Private-channel registration is commissioner controlled. Discovery accepts only actual DM membership read by a participant, entirely within this league. */
  async registerChannel(
    actor: Principal,
    input: {
      leagueId: string;
      channelId: string;
      memberPubkeys: string[];
      receiptId: string;
    },
  ) {
    requireLeague(actor, input.leagueId);
    requireCommissioner(actor);
    return transaction(this.db, (tx) =>
      this.channel(
        tx,
        input.leagueId,
        input.channelId,
        "private-channel",
        input.memberPubkeys,
        input.receiptId,
      ),
    );
  }
  private async channel(
    tx: Tx,
    leagueId: string,
    channelId: string,
    kind: "dm" | "private-channel",
    members: string[],
    receiptId: string,
  ) {
    z.uuid().parse(channelId);
    key.parse(receiptId);
    z.array(hex).min(2).max(12).parse(members);
    assert(new Set(members).size === members.length, "Duplicate membership");
    const participants = (
      await tx.query(
        "SELECT * FROM buzz_participants WHERE league_id=$1 AND pubkey=ANY($2::text[])",
        [leagueId, members],
      )
    ).rows;
    assert(participants.length === members.length, "Non-league member refused");
    if (kind === "dm") {
      assert(members.length <= 9, "DM participant limit");
      const agents = participants.filter((p) => p.kind === "agent");
      if (agents.length)
        assert(
          agents.every((p) => p.owner_pubkey === agents[0].owner_pubkey) &&
            participants
              .filter((p) => p.kind === "human")
              .every((p) => p.pubkey === agents[0].owner_pubkey),
          "Unrelated human must use private channel",
        );
    }
    await tx.query(
      "INSERT INTO buzz_conversations(league_id,channel_id,kind,member_pubkeys,discovery_receipt_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        leagueId,
        channelId,
        kind,
        JSON.stringify([...members].sort()),
        receiptId,
      ],
    );
    const row = (
      await tx.query(
        "SELECT * FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2 FOR UPDATE",
        [leagueId, channelId],
      )
    ).rows[0];
    assert(
      row.kind === kind && same(row.member_pubkeys, members),
      "Conversation membership changed; reauthorization required",
    );
    return row;
  }
  async discoverDm(
    listener: BuzzListener,
    input: { channelId: string; memberPubkeys: string[]; receiptId: string },
  ) {
    return transaction(this.db, async (tx) => {
      await this.listener(tx, listener);
      assert(
        input.memberPubkeys.includes(listener.pubkey),
        "Listener not in DM",
      );
      return this.channel(
        tx,
        listener.leagueId,
        input.channelId,
        "dm",
        input.memberPubkeys,
        input.receiptId,
      );
    });
  }
  async channels(listener: BuzzListener) {
    return transaction(this.db, async (tx) => {
      await this.listener(tx, listener);
      return (
        await tx.query(
          "SELECT c.*,COALESCE(i.since_seconds,0)::text AS since_seconds,i.state FROM buzz_conversations c LEFT JOIN buzz_inbound_cursors i ON i.league_id=c.league_id AND i.channel_id=c.channel_id AND i.listener_pubkey=$2 WHERE c.league_id=$1 AND c.member_pubkeys ? $2 ORDER BY c.channel_id",
          [listener.leagueId, listener.pubkey],
        )
      ).rows;
    });
  }
  async ingestBatch(
    listener: BuzzListener,
    input: {
      channelId: string;
      memberPubkeys: string[];
      events: unknown[];
      complete: boolean;
    },
  ) {
    z.uuid().parse(input.channelId);
    assert(input.events.length <= 200, "Batch too large");
    const events = input.events
      .map((e) => BuzzEventSchema.parse(e))
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    return transaction(this.db, async (tx) => {
      await this.listener(tx, listener);
      const c = (
        await tx.query(
          "SELECT * FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2 FOR UPDATE",
          [listener.leagueId, input.channelId],
        )
      ).rows[0];
      assert(
        c &&
          c.member_pubkeys.includes(listener.pubkey) &&
          same(c.member_pubkeys, input.memberPubkeys),
        "Membership changed or listener unauthorized",
      );
      const now = Number(
        (
          await tx.query(
            "SELECT extract(epoch FROM clock_timestamp()) AS epoch",
          )
        ).rows[0].epoch,
      );
      const mirrorHold = !!(
        await tx.query(
          "SELECT 1 FROM buzz_runtime_outbound WHERE league_id=$1 AND channel_id=$2 AND status IN ('prepared','unknown') LIMIT 1",
          [listener.leagueId, input.channelId],
        )
      ).rowCount;
      let inserted = 0,
        delivered = 0,
        quarantined = 0,
        maxTime = 0;
      for (const e of events) {
        assert(nostrEventId(e) === e.id, "Event content hash mismatch");
        assert(
          c.member_pubkeys.includes(e.pubkey),
          "Unauthorized event author",
        );
        assert(e.created_at <= now + 60, "Future event timestamp rejected");
        assert(Buffer.byteLength(e.content) <= 65536, "Oversized message");
        // NIP-09 deletion events returned by a scoped channel read can omit h.
        // Scope is derived only from an already canonical, same-author target;
        // never add a tag to the original event or treat it as a chat message.
        if (e.kind === 5 && tag(e, "h").length === 0) {
          const targets = tag(e, "e");
          const original =
            targets.length === 1
              ? (
                  await tx.query(
                    "SELECT channel_id,author_pubkey,kind FROM buzz_archive_events WHERE league_id=$1 AND event_id=$2",
                    [listener.leagueId, targets[0]],
                  )
                ).rows[0]
              : null;
          const reason =
            targets.length !== 1
              ? "single_deletion_target_required"
              : !original
                ? "deletion_target_not_canonical"
                : original.channel_id !== input.channelId
                  ? "deletion_target_outside_observed_channel"
                  : original.author_pubkey !== e.pubkey
                    ? "deletion_author_mismatch"
                    : ![9, 40002].includes(original.kind)
                      ? "deletion_target_not_message"
                      : null;
          if (reason) {
            const saved = await tx.query(
              `INSERT INTO buzz_deletion_quarantine(league_id,observed_channel_id,event_id,listener_pubkey,raw_event,payload_hash,reason,mode,provenance)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(league_id,observed_channel_id,event_id) DO NOTHING`,
              [
                listener.leagueId,
                input.channelId,
                e.id,
                listener.pubkey,
                JSON.stringify(e),
                hash(e),
                reason,
                listener.mode,
                listener.mode === "mock"
                  ? "synthetic fixture"
                  : "authenticated scoped Buzz CLI read; signature stripped; channel membership of deletion unconfirmed",
              ],
            );
            quarantined += saved.rowCount ?? 0;
            maxTime = Math.max(maxTime, e.created_at);
            continue;
          }
        } else {
          assert(
            tag(e, "h").length === 1 && tag(e, "h")[0] === input.channelId,
            "Cross-channel event rejected",
          );
        }
        const isChange = [40003, 9005, 5].includes(e.kind),
          target = isChange ? (tag(e, "e")[0] ?? null) : null;
        if (isChange)
          assert(
            target && /^[a-f0-9]{64}$/.test(target),
            "Missing change target",
          );
        const old = (
          await tx.query(
            "SELECT payload_hash FROM buzz_archive_events WHERE league_id=$1 AND event_id=$2",
            [listener.leagueId, e.id],
          )
        ).rows[0];
        if (old) {
          assert(
            old.payload_hash === hash(e),
            "Archived event payload conflict",
          );
          maxTime = Math.max(maxTime, e.created_at);
          if (
            !(
              await tx.query(
                "SELECT 1 FROM buzz_archive_held_events WHERE league_id=$1 AND event_id=$2",
                [listener.leagueId, e.id],
              )
            ).rowCount
          )
            continue;
        }
        if (!old)
          await tx.query(
            "INSERT INTO buzz_archive_events(league_id,channel_id,event_id,author_pubkey,kind,content,tags,source_created_at,payload_hash,target_event_id,relation_status,mode,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
            [
              listener.leagueId,
              input.channelId,
              e.id,
              e.pubkey,
              e.kind,
              e.content,
              JSON.stringify(e.tags),
              e.created_at,
              hash(e),
              target,
              isChange ? "pending" : "none",
              listener.mode,
              listener.mode === "mock"
                ? "synthetic fixture"
                : "authenticated Buzz CLI; signature stripped",
            ],
          );
        if (!old) inserted++;
        maxTime = Math.max(maxTime, e.created_at);
        // Keep edit/delete history; never rewrite original authored content. Moderator deletions remain pending unless separately verified.
        await tx.query(
          `UPDATE buzz_archive_events change SET relation_status=CASE WHEN original.author_pubkey=change.author_pubkey AND original.kind IN (9,40002) THEN 'valid' ELSE 'invalid' END FROM buzz_archive_events original WHERE change.league_id=$1 AND change.target_event_id=original.event_id AND original.league_id=change.league_id AND original.channel_id=change.channel_id AND change.relation_status='pending'`,
          [listener.leagueId],
        );
        if (isChange) continue;
        const mirror = (
          await tx.query(
            "SELECT 1 FROM buzz_runtime_outbound WHERE league_id=$1 AND channel_id=$2 AND event_id=$3 AND status='accepted'",
            [listener.leagueId, input.channelId, e.id],
          )
        ).rowCount;
        if (mirror) {
          await tx.query(
            "DELETE FROM buzz_archive_held_events WHERE league_id=$1 AND event_id=$2",
            [listener.leagueId, e.id],
          );
          continue;
        }
        if (mirrorHold) {
          await tx.query(
            "INSERT INTO buzz_archive_held_events(league_id,event_id,reason) VALUES($1,$2,'outbound_acceptance_uncertain') ON CONFLICT DO NOTHING",
            [listener.leagueId, e.id],
          );
          continue;
        }
        const replyTo =
          e.tags.find((t) => t[0] === "e" && t[3] === "reply")?.[1] ??
          tag(e, "e").at(-1) ??
          null;
        const parent = replyTo
          ? (
              await tx.query(
                "SELECT author_pubkey FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND event_id=$3",
                [listener.leagueId, input.channelId, replyTo],
              )
            ).rows[0]
          : null;
        // No implicit broadcast for a reply (even to an unknown event) or any mention
        // tag (even malformed/outside the channel). Agent posts never enter this path.
        const broadcast =
          c.kind === "private-channel" &&
          e.kind === 9 &&
          !e.tags.some((t) => t[0] === "p" || t[0] === "e") &&
          !!(
            await tx.query(
              `SELECT 1 FROM buzz_human_broadcast_policies policy
             JOIN buzz_participants author ON author.league_id=policy.league_id AND author.pubkey=$3 AND author.kind='human' AND author.agent_id IS NULL
             JOIN league_teams team ON team.league_id=author.league_id AND team.id=author.team_id AND team.owner_id=author.owner_id AND team.kind='human'
             WHERE policy.league_id=$1 AND policy.channel_id=$2 AND policy.enabled AND $4::bigint >= policy.effective_after_seconds`,
              [listener.leagueId, input.channelId, e.pubkey, e.created_at],
            )
          ).rowCount;
        const recipients = (
          await tx.query(
            `SELECT p.* FROM buzz_participants p JOIN runtime_bindings b ON b.agent_id=p.agent_id AND b.league_id=p.league_id AND b.team_id=p.team_id JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id AND t.owner_id=p.owner_id JOIN runtime_agents a ON a.id=p.agent_id AND a.kind='ai'
             WHERE p.kind='agent' AND p.league_id=$1 AND p.pubkey=ANY($2::text[]) AND p.pubkey<>$3
             AND (a.enabled OR EXISTS (
               SELECT 1 FROM runtime_conversation_sessions session
               JOIN runtime_conversation_owners owner ON owner.session_id=session.id AND owner.agent_id=a.id
               WHERE session.league_id=p.league_id AND session.status='active'
               AND session.expires_at>clock_timestamp() AND session.configuration->'channelIds' ? $4::text
             )) ORDER BY p.agent_id`,
            [listener.leagueId, c.member_pubkeys, e.pubkey, input.channelId],
          )
        ).rows;
        for (const r of recipients) {
          if (
            c.kind !== "dm" &&
            !broadcast &&
            !tag(e, "p").includes(r.pubkey) &&
            parent?.author_pubkey !== r.pubkey
          )
            continue;
          await tx.query(
            "INSERT INTO buzz_ingress_modes(league_id,agent_id,mode) VALUES($1,$2,'poll') ON CONFLICT DO NOTHING",
            [listener.leagueId, r.agent_id],
          );
          const ingress = (
            await tx.query(
              "SELECT mode FROM buzz_ingress_modes WHERE league_id=$1 AND agent_id=$2",
              [listener.leagueId, r.agent_id],
            )
          ).rows[0];
          if (ingress.mode !== "poll") continue; // ACP owns wakeups; canonical relay events may still be archived.
          const eligibility = await conversationDeliveryEligibleTx(tx, {
            leagueId: listener.leagueId,
            agentId: r.agent_id,
            eventId: e.id,
          });
          if (!eligibility.eligible) continue;
          const job = await this.runtime.ingestEventTx(tx, {
            agentId: r.agent_id,
            causalId: `buzz:${listener.leagueId}:${e.id}`,
            payload: {
              kind: "buzz.message",
              leagueId: listener.leagueId,
              channelId: input.channelId,
              eventId: e.id,
              senderPubkey: e.pubkey,
              recipientPubkey: r.pubkey,
              body: e.content,
              replyTo,
              conversationId: input.channelId,
              synthetic: listener.mode === "mock",
              sourceCreatedAt: e.created_at,
              contentTrust: "untrusted participant message",
              routing: broadcast
                ? "human-channel-broadcast"
                : c.kind === "dm"
                  ? "direct-message"
                  : "targeted-channel",
            },
          });
          await tx.query(
            "INSERT INTO buzz_inbound_deliveries(league_id,event_id,agent_id,inbox_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [listener.leagueId, e.id, r.agent_id, job.id],
          );
          await admitConversationDeliveryTx(tx, {
            leagueId: listener.leagueId,
            agentId: r.agent_id,
            eventId: e.id,
            jobId: job.id,
            expectedSessionId: eligibility.sessionId,
          });
          delivered++;
        }
        await tx.query(
          "DELETE FROM buzz_archive_held_events WHERE league_id=$1 AND event_id=$2",
          [listener.leagueId, e.id],
        );
      }
      await tx.query(
        `INSERT INTO buzz_inbound_cursors(league_id,listener_pubkey,channel_id,since_seconds,last_poll_at,last_complete_at,state) VALUES($1,$2,$3,$4,clock_timestamp(),CASE WHEN $5 THEN clock_timestamp() END,$6) ON CONFLICT(league_id,listener_pubkey,channel_id) DO UPDATE SET since_seconds=CASE WHEN $5 THEN GREATEST(buzz_inbound_cursors.since_seconds,$4) ELSE buzz_inbound_cursors.since_seconds END,last_poll_at=clock_timestamp(),last_complete_at=CASE WHEN $5 THEN clock_timestamp() ELSE buzz_inbound_cursors.last_complete_at END,state=$6`,
        [
          listener.leagueId,
          listener.pubkey,
          input.channelId,
          input.complete && !mirrorHold ? Math.max(0, maxTime - 120) : 0,
          input.complete && !mirrorHold,
          input.complete && !mirrorHold ? "healthy" : "gap",
        ],
      );
      return {
        inserted,
        delivered,
        quarantined,
        complete: input.complete && !mirrorHold,
        mirrorHold,
        synthetic: listener.mode === "mock",
      };
    });
  }
  async recordFailure(listener: BuzzListener, channelId: string) {
    return transaction(this.db, async (tx) => {
      await this.listener(tx, listener);
      await tx.query(
        "UPDATE buzz_inbound_cursors SET state='error',last_poll_at=clock_timestamp() WHERE league_id=$1 AND channel_id=$2 AND listener_pubkey=$3",
        [listener.leagueId, channelId, listener.pubkey],
      );
    });
  }
  /** Operator-only evidence, never an owner chat line or proof of channel membership. */
  async deletionQuarantine(
    actor: Principal,
    input: z.input<typeof BuzzArchiveQuerySchema>,
  ) {
    const v = BuzzArchiveQuerySchema.parse(input);
    requireLeague(actor, v.leagueId);
    requireCommissioner(actor);
    const events = (
      await this.db.query(
        "SELECT * FROM buzz_deletion_quarantine WHERE league_id=$1 AND observed_channel_id=$2 AND sequence>$3::bigint ORDER BY sequence LIMIT $4",
        [v.leagueId, v.channelId, v.afterSequence, v.limit],
      )
    ).rows;
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? v.afterSequence,
      archiveIsPublic: false,
    };
  }
  async list(actor: Principal, leagueId: string) {
    requireLeague(actor, leagueId);
    if (actor.role === "commissioner")
      return (
        await this.db.query(
          "SELECT * FROM buzz_conversations WHERE league_id=$1 ORDER BY created_at,channel_id",
          [leagueId],
        )
      ).rows;
    if (actor.role !== "owner")
      throw new ApiError(
        403,
        "BUZZ_ARCHIVE_FORBIDDEN",
        "Participant or commissioner required",
      );
    return (
      await this.db.query(
        "SELECT c.* FROM buzz_conversations c JOIN buzz_participants p ON p.league_id=c.league_id AND c.member_pubkeys ? p.pubkey JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id AND t.owner_id=p.owner_id WHERE c.league_id=$1 AND p.owner_id=$2 AND p.team_id=$3 ORDER BY c.created_at,c.channel_id",
        [leagueId, actor.id, actor.teamId ?? null],
      )
    ).rows;
  }
  private async authorizedChannel(
    actor: Principal,
    v: { leagueId: string; channelId: string },
  ) {
    requireLeague(actor, v.leagueId);
    const c = (
      await this.db.query(
        "SELECT * FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2",
        [v.leagueId, v.channelId],
      )
    ).rows[0];
    if (!c)
      throw new ApiError(
        404,
        "BUZZ_CHANNEL_UNKNOWN",
        "Unknown league conversation",
      );
    if (actor.role !== "commissioner") {
      const p = (
        await this.db.query(
          "SELECT p.pubkey FROM buzz_participants p JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id AND t.owner_id=p.owner_id WHERE p.league_id=$1 AND p.owner_id=$2 AND p.team_id=$3",
          [v.leagueId, actor.id, actor.teamId ?? null],
        )
      ).rows[0];
      if (actor.role !== "owner" || !p || !c.member_pubkeys.includes(p.pubkey))
        throw new ApiError(
          403,
          "BUZZ_ARCHIVE_FORBIDDEN",
          "Archive is limited to participants and the consented commissioner",
        );
    }
    return c;
  }
  /** Fetch an original canonical event, never synthesized text or a merged edit. */
  async event(
    actor: Principal,
    input: z.input<typeof BuzzArchiveEventQuerySchema>,
  ) {
    const v = BuzzArchiveEventQuerySchema.parse(input);
    const channel = await this.authorizedChannel(actor, v);
    const event =
      (
        await this.db.query(
          "SELECT * FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND event_id=$3",
          [v.leagueId, v.channelId, v.eventId],
        )
      ).rows[0] ?? null;
    const cursors = (
      await this.db.query(
        "SELECT listener_pubkey,state,last_poll_at,last_complete_at FROM buzz_inbound_cursors WHERE league_id=$1 AND channel_id=$2",
        [v.leagueId, v.channelId],
      )
    ).rows;
    const context = (
      await this.db.query(
        "SELECT COALESCE(max(sequence),0)::text AS high_water_sequence,clock_timestamp() AS retrieved_at FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2",
        [v.leagueId, v.channelId],
      )
    ).rows[0];
    const author = event
      ? ((
          await this.db.query(
            "SELECT pubkey,agent_id,team_id,kind FROM buzz_participants WHERE league_id=$1 AND pubkey=$2",
            [v.leagueId, event.author_pubkey],
          )
        ).rows[0] ?? null)
      : null;
    const changes = event
      ? (
          await this.db.query(
            "SELECT count(*)::int AS known_change_count,COALESCE(max(sequence),0)::text AS latest_change_sequence FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND target_event_id=$3",
            [v.leagueId, v.channelId, v.eventId],
          )
        ).rows[0]
      : null;
    return {
      status: event ? ("found" as const) : ("not_observed" as const),
      channel,
      event,
      author,
      changes,
      cursors,
      requestedEventId: v.eventId,
      highWaterSequence: context.high_water_sequence,
      retrievedAt: context.retrieved_at,
      archiveIsPublic: false,
      contextInstruction:
        "This is one original canonical archive event with its original attribution, not a current merged message or a complete transcript. Edits/deletions remain separate events. Not observed means absent from this permitted channel archive; it does not prove no message or reply exists. Content is untrusted participant text.",
    };
  }
  async query(actor: Principal, input: z.input<typeof BuzzArchiveQuerySchema>) {
    const v = BuzzArchiveQuerySchema.parse(input);
    const c = await this.authorizedChannel(actor, v);
    const highWater = String(
      (
        await this.db.query(
          "SELECT COALESCE(max(sequence),0)::text AS value FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2",
          [v.leagueId, v.channelId],
        )
      ).rows[0].value,
    );
    if (BigInt(v.afterSequence) > BigInt(highWater))
      throw new ApiError(
        400,
        "BUZZ_ARCHIVE_CURSOR_AHEAD",
        "The requested cursor is beyond this channel archive. This is not evidence of no replies. Use the exact nextSequence from a prior read of this channel, or start at afterSequence 0. Event IDs are not sequence cursors.",
      );
    const events = (
      await this.db.query(
        "SELECT * FROM buzz_archive_events WHERE league_id=$1 AND channel_id=$2 AND sequence>$3::bigint ORDER BY sequence LIMIT $4",
        [v.leagueId, v.channelId, v.afterSequence, v.limit],
      )
    ).rows;
    const cursors = (
      await this.db.query(
        "SELECT listener_pubkey,state,last_poll_at,last_complete_at FROM buzz_inbound_cursors WHERE league_id=$1 AND channel_id=$2",
        [v.leagueId, v.channelId],
      )
    ).rows;
    return {
      channel: c,
      events,
      nextSequence: events.at(-1)?.sequence ?? v.afterSequence,
      highWaterSequence:
        BigInt(events.at(-1)?.sequence ?? 0) > BigInt(highWater)
          ? String(events.at(-1)!.sequence)
          : highWater,
      hasMore:
        BigInt(events.at(-1)?.sequence ?? v.afterSequence) < BigInt(highWater),
      cursorInstruction:
        "Use nextSequence only for this channel. A partial page or invalid cursor cannot establish that no peer replied. Event IDs identify messages and are never numeric cursors.",
      cursors,
      archiveIsPublic: false,
    };
  }
}
