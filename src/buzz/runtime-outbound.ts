import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "../db.js";
import { requireCommissioner, requireLeague, type Principal } from "../auth.js";
import { BuzzArchiveService, type BuzzListener } from "./archive.js";
import {
  BuzzReceiptService,
  createCliRunner,
  planDmOpen,
  type CliRunner,
  type LeagueIdentity,
  type Peer,
} from "./index.js";
import { BuzzMessagingService } from "./messaging.js";
import { createBuzzReader, type BuzzReader } from "./listener.js";
import { loadManagedCredential, LEAGUE_COMMUNITY } from "./managed-acp.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function assert(v: unknown, error: string): asserts v {
  if (!v) throw new Error(error);
}
const membersSchema = z
  .array(
    z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/), role: z.string() }),
  )
  .max(12);
const dmsSchema = z
  .array(
    z.object({
      dm_id: z.uuid(),
      participants: z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .min(2)
        .max(9),
      created_at: z.number().int().nonnegative(),
    }),
  )
  .max(200);
const same = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export type BuzzOutboundTransport = { read: BuzzReader; run: CliRunner };
export type BuzzOutboundTransportFactory = (input: {
  leagueId: string;
  senderAgentId: string;
  pubkey: string;
  communityUrl: string;
  mode: "mock" | "real";
}) => Promise<BuzzOutboundTransport>;
export function managedOutboundTransport(
  db: Db,
  options: { executable: string; allowExternalSends: boolean },
): BuzzOutboundTransportFactory {
  assert(options.allowExternalSends, "BUZZ_EXTERNAL_SENDS_DISABLED");
  return async (input) => {
    assert(
      input.mode === "real" && input.communityUrl === LEAGUE_COMMUNITY,
      "BUZZ_LIVE_COMMUNITY_MISMATCH",
    );
    const identity = await loadManagedCredential(
      db,
      input.leagueId,
      input.senderAgentId,
    );
    assert(identity.pubkey === input.pubkey, "BUZZ_MANAGED_KEY_MISMATCH");
    const environment: Record<string, string> = {
      BUZZ_RELAY_URL: identity.communityUrl,
      BUZZ_PRIVATE_KEY: identity.privateKey,
    };
    if (identity.authTag) environment.BUZZ_AUTH_TAG = identity.authTag;
    return {
      read: createBuzzReader({
        executable: options.executable,
        listener: {
          leagueId: input.leagueId,
          pubkey: identity.pubkey,
          communityUrl: identity.communityUrl,
          mode: "real",
        },
        environment,
        allowNetwork: true,
      }),
      run: createCliRunner({
        executable: options.executable,
        environment,
        allowExternalSends: true,
      }),
    };
  };
}
/** Mirrors already-committed runtime messages. It never creates another model job. Unknown sends hold the whole conversation until explicit reconciliation. */
export class BuzzRuntimeOutbound {
  constructor(
    private db: Db,
    private transport?: BuzzOutboundTransportFactory,
  ) {}
  async enqueueCommitted(leagueId: string) {
    const rows = (
      await this.db.query(
        `SELECT m.*,s.league_id FROM runtime_messages m JOIN runtime_bindings s ON s.agent_id=m.sender_id JOIN runtime_bindings r ON r.agent_id=m.recipient_id AND r.league_id=s.league_id WHERE s.league_id=$1 ORDER BY m.created_at,m.id`,
        [leagueId],
      )
    ).rows;
    let inserted = 0;
    for (const m of rows)
      inserted +=
        (
          await this.db.query(
            "INSERT INTO buzz_runtime_outbound(runtime_message_id,league_id,sender_agent_id,recipient_agent_id,content_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [m.id, leagueId, m.sender_id, m.recipient_id, hash(m.body)],
          )
        ).rowCount ?? 0;
    return { inserted };
  }
  private async update(
    id: string,
    status: string,
    values: {
      error?: string;
      channelId?: string;
      senderPubkey?: string;
      recipientPubkey?: string;
      openReceiptId?: string;
      sendReceiptId?: string;
      eventId?: string;
    } = {},
  ) {
    return transaction(this.db, async (tx) => {
      const previous = (
        await tx.query(
          "SELECT * FROM buzz_runtime_outbound WHERE runtime_message_id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      const row = (
        await tx.query(
          "UPDATE buzz_runtime_outbound SET status=$2,last_error=$3,channel_id=COALESCE($4,channel_id),sender_pubkey=COALESCE($5,sender_pubkey),recipient_pubkey=COALESCE($6,recipient_pubkey),open_receipt_id=COALESCE($7,open_receipt_id),send_receipt_id=COALESCE($8,send_receipt_id),event_id=COALESCE($9,event_id),updated_at=clock_timestamp() WHERE runtime_message_id=$1 RETURNING *",
          [
            id,
            status,
            values.error ?? null,
            values.channelId ?? null,
            values.senderPubkey ?? null,
            values.recipientPubkey ?? null,
            values.openReceiptId ?? null,
            values.sendReceiptId ?? null,
            values.eventId ?? null,
          ],
        )
      ).rows[0];
      if (previous.status !== status || previous.last_error !== row.last_error)
        await tx.query(
          "INSERT INTO runtime_receipts(type,agent_id,details) VALUES($1,$2,$3)",
          [
            `buzz.message.${status}`,
            row.sender_agent_id,
            {
              runtimeMessageId: id,
              channelId: row.channel_id,
              eventId: row.event_id,
              receiptId: row.send_receipt_id,
              error: row.last_error,
              relayAcceptance: status === "accepted",
              peerWakeup: "already handled by original runtime message",
            },
          ],
        );
      return row;
    });
  }
  async dispatchOne(leagueId: string) {
    await this.enqueueCommitted(leagueId);
    const pending = (
      await this.db.query(
        "SELECT runtime_message_id FROM buzz_runtime_outbound WHERE league_id=$1 AND status IN ('pending','blocked','prepared','unknown') ORDER BY created_at,runtime_message_id LIMIT 100",
        [leagueId],
      )
    ).rows;
    let lastBlocked: unknown;
    for (const p of pending) {
      const result = await this.dispatchMessage(leagueId, p.runtime_message_id);
      if (result.status === "blocked") {
        lastBlocked = result;
        continue;
      }
      if (result.status !== "busy" && result.status !== "held") return result;
    }
    return { status: lastBlocked ? "blocked" : "idle" };
  }
  async dispatchMessage(leagueId: string, messageId: string) {
    z.uuid().parse(messageId);
    const row = (
      await this.db.query(
        "SELECT o.*,m.body,m.reply_to,m.created_at AS message_created_at FROM buzz_runtime_outbound o JOIN runtime_messages m ON m.id=o.runtime_message_id WHERE o.league_id=$1 AND o.runtime_message_id=$2",
        [leagueId, messageId],
      )
    ).rows[0];
    assert(row, "BUZZ_RUNTIME_MESSAGE_UNKNOWN");
    if (["accepted", "rejected"].includes(row.status)) return row;
    const pair = [row.sender_agent_id, row.recipient_agent_id].sort().join(":");
    const lease = await this.db.connect();
    let locked = false;
    try {
      locked = (
        await lease.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,200)) AS locked",
          [`${leagueId}:${pair}`],
        )
      ).rows[0].locked;
      if (!locked) return { status: "busy" };
      const current = (
        await this.db.query(
          "SELECT * FROM buzz_runtime_outbound WHERE runtime_message_id=$1",
          [messageId],
        )
      ).rows[0];
      if (["accepted", "rejected"].includes(current.status)) return current;
      if (["prepared", "unknown"].includes(current.status))
        return {
          status: "held",
          runtimeMessageId: messageId,
          reason: "BUZZ_ACCEPTANCE_RECONCILIATION_REQUIRED",
        };
      const otherHold = (
        await this.db.query(
          "SELECT 1 FROM buzz_runtime_outbound o LEFT JOIN buzz_action_receipts r ON r.id=o.open_receipt_id WHERE o.league_id=$1 AND (o.status IN ('prepared','unknown') OR o.channel_id IS NULL AND r.status IN ('prepared','unknown') AND o.runtime_message_id<>$4) AND (o.sender_agent_id=$2 AND o.recipient_agent_id=$3 OR o.sender_agent_id=$3 AND o.recipient_agent_id=$2)",
          [leagueId, row.sender_agent_id, row.recipient_agent_id, messageId],
        )
      ).rowCount;
      if (otherHold)
        return {
          status: "held",
          runtimeMessageId: messageId,
          reason: "BUZZ_PAIR_HELD",
        };
      const binding = (
        await this.db.query(
          "SELECT * FROM buzz_league_bindings WHERE league_id=$1",
          [leagueId],
        )
      ).rows[0];
      assert(binding, "BUZZ_LEAGUE_NOT_CONFIGURED");
      const participants = (
        await this.db.query(
          `SELECT p.*,b.agent_id AS runtime_id,a.kind AS runtime_kind,m.pubkey AS managed_pubkey,m.community_url AS managed_community FROM buzz_participants p JOIN runtime_bindings b ON b.league_id=p.league_id AND b.team_id=p.team_id JOIN league_teams t ON t.league_id=p.league_id AND t.id=p.team_id AND t.owner_id=p.owner_id JOIN runtime_agents a ON a.id=b.agent_id LEFT JOIN buzz_managed_identities m ON m.league_id=p.league_id AND m.agent_id=b.agent_id AND m.pubkey=p.pubkey WHERE p.league_id=$1 AND b.agent_id=ANY($2::text[])`,
          [leagueId, [row.sender_agent_id, row.recipient_agent_id]],
        )
      ).rows;
      const sender = participants.find(
          (p) => p.runtime_id === row.sender_agent_id,
        ),
        recipient = participants.find(
          (p) => p.runtime_id === row.recipient_agent_id,
        );
      assert(sender && recipient, "BUZZ_PARTICIPANT_BINDING_MISSING");
      assert(
        sender.kind === "agent",
        "BUZZ_HUMAN_SENDER_MANAGED_IDENTITY_REQUIRED",
      );
      assert(
        hash(row.body) === row.content_hash,
        "BUZZ_RUNTIME_MESSAGE_CHANGED",
      );
      assert(
        row.body.trim() && Buffer.byteLength(row.body) <= 16384,
        "BUZZ_MESSAGE_SIZE_INVALID",
      );
      if (binding.mode === "real")
        assert(
          sender.managed_pubkey === sender.pubkey &&
            sender.managed_community === binding.community_url &&
            (recipient.kind === "human" ||
              (recipient.managed_pubkey === recipient.pubkey &&
                recipient.managed_community === binding.community_url)),
          "BUZZ_MANAGED_IDENTITY_MISSING",
        );
      for (const p of participants.filter((p) => p.kind === "agent"))
        assert(
          (
            await this.db.query(
              "SELECT 1 FROM buzz_ingress_modes WHERE league_id=$1 AND agent_id=$2 AND mode='poll'",
              [leagueId, p.runtime_id],
            )
          ).rowCount,
          "BUZZ_POLLING_CUTOVER_REQUIRED",
        );
      assert(this.transport, "BUZZ_TRANSPORT_NOT_CONFIGURED");
      const io = await this.transport({
        leagueId,
        senderAgentId: row.sender_agent_id,
        pubkey: sender.pubkey,
        communityUrl: binding.community_url,
        mode: binding.mode,
      });
      const listener: BuzzListener = {
        leagueId,
        communityUrl: binding.community_url,
        pubkey: sender.pubkey,
        mode: binding.mode,
      };
      const archive = new BuzzArchiveService(this.db),
        expected = [sender.pubkey, recipient.pubkey];
      let channel: any;
      if (recipient.kind === "human") {
        channel = (await archive.channels(listener)).find(
          (c) =>
            c.kind === "private-channel" && same(c.member_pubkeys, expected),
        );
        assert(channel, "BUZZ_HUMAN_PRIVATE_CHANNEL_REQUIRED");
      } else {
        assert(
          sender.owner_pubkey && sender.owner_pubkey === recipient.owner_pubkey,
          "BUZZ_SAME_OWNER_DM_REQUIRED",
        );
        const dms = dmsSchema.parse(await io.read({ command: "dms" }));
        assert(dms.length < 200, "BUZZ_DM_DISCOVERY_SATURATED");
        let matches = dms.filter((dm) => same(dm.participants, expected));
        assert(matches.length <= 1, "BUZZ_DM_AMBIGUOUS");
        if (!matches.length) {
          const identity: LeagueIdentity = {
            pubkey: sender.pubkey,
            ownerPubkey: sender.owner_pubkey,
            ownershipVerified: true,
            communityUrl: binding.community_url,
            kind: "agent",
            allowedPeerPubkeys: [recipient.pubkey],
          };
          const peer: Peer = {
            pubkey: recipient.pubkey,
            ownerPubkey: recipient.owner_pubkey,
            ownershipVerified: true,
            communityUrl: binding.community_url,
            kind: "agent",
          };
          const opened = await new BuzzReceiptService(this.db).execute(
            `runtime-dm:${messageId}`,
            planDmOpen(identity, [peer]),
            io.run,
          );
          await this.update(messageId, "pending", { openReceiptId: opened.id });
          // Whether open was accepted or uncertain, only an independent membership read makes a DM usable.
          const after = dmsSchema.parse(await io.read({ command: "dms" }));
          assert(after.length < 200, "BUZZ_DM_DISCOVERY_SATURATED");
          matches = after.filter((dm) => same(dm.participants, expected));
          if (matches.length !== 1)
            return this.update(messageId, "blocked", {
              error:
                opened.status === "rejected"
                  ? "BUZZ_DM_OPEN_REJECTED"
                  : "BUZZ_DM_OPEN_RECONCILIATION_REQUIRED",
              openReceiptId: opened.id,
            });
        }
        channel = await archive.discoverDm(listener, {
          channelId: matches[0]!.dm_id,
          memberPubkeys: expected,
          receiptId: `runtime-dm-read:${messageId}`,
        });
      }
      const members = membersSchema
        .parse(
          await io.read({ command: "members", channelId: channel.channel_id }),
        )
        .map((p) => p.pubkey);
      assert(same(members, expected), "BUZZ_DM_MEMBERSHIP_CHANGED");
      // Membership and messages are read before claiming the send. This establishes the sender's fresh scoped observation.
      const history = z
        .array(z.unknown())
        .max(200)
        .parse(
          await io.read({
            command: "messages",
            channelId: channel.channel_id,
            since: Number(
              (await archive.channels(listener)).find(
                (c) => c.channel_id === channel.channel_id,
              )?.since_seconds ?? 0,
            ),
          }),
        );
      assert(history.length < 200, "BUZZ_HISTORY_BACKFILL_REQUIRED");
      await archive.ingestBatch(listener, {
        channelId: channel.channel_id,
        memberPubkeys: members,
        events: history,
        complete: true,
      });
      let replyTo: string | undefined;
      if (row.reply_to) {
        const previous = (
          await this.db.query(
            "SELECT event_id,channel_id,status FROM buzz_runtime_outbound WHERE runtime_message_id=$1 AND league_id=$2",
            [row.reply_to, leagueId],
          )
        ).rows[0];
        assert(
          previous?.status === "accepted" &&
            previous.channel_id === channel.channel_id &&
            previous.event_id,
          "BUZZ_REPLY_DELIVERY_PENDING",
        );
        replyTo = previous.event_id;
      }
      // Commit prepared before any send; a crash after this point holds the pair. Archive ingestion shares this channel lock.
      await this.update(messageId, "prepared", {
        channelId: channel.channel_id,
        senderPubkey: sender.pubkey,
        recipientPubkey: recipient.pubkey,
      });
      const serialized = await this.db.connect();
      try {
        await serialized.query("BEGIN");
        await serialized.query(
          "SELECT 1 FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2 FOR UPDATE",
          [leagueId, channel.channel_id],
        );
        const receipt = await new BuzzMessagingService(this.db).send(
          {
            id: sender.owner_id,
            role: "owner",
            leagueId,
            teamId: sender.team_id,
          },
          {
            leagueId,
            channelId: channel.channel_id,
            recipientPubkey: recipient.pubkey,
            content: row.body,
            replyTo,
            operationKey: `runtime-message:${messageId}`,
          },
          io.run,
        );
        const status =
          receipt.status === "accepted"
            ? "accepted"
            : receipt.status === "rejected"
              ? "rejected"
              : "unknown";
        const delivered = await this.update(messageId, status, {
          sendReceiptId: receipt.id,
          eventId: receipt.event_id ?? undefined,
          error:
            status === "unknown"
              ? "BUZZ_ACCEPTANCE_RECONCILIATION_REQUIRED"
              : status === "rejected"
                ? "BUZZ_RELAY_REJECTED"
                : undefined,
        });
        await serialized.query("COMMIT");
        return delivered;
      } catch {
        await serialized.query("ROLLBACK");
        return this.update(messageId, "unknown", {
          error: "BUZZ_ACCEPTANCE_RECONCILIATION_REQUIRED",
        });
      } finally {
        serialized.release();
      }
    } catch (error) {
      const code =
        error instanceof Error && /^BUZZ_[A-Z_]+$/.test(error.message)
          ? error.message
          : "BUZZ_TRANSPORT_OR_BINDING_UNAVAILABLE";
      const latest = (
        await this.db.query(
          "SELECT status FROM buzz_runtime_outbound WHERE runtime_message_id=$1",
          [messageId],
        )
      ).rows[0];
      return this.update(
        messageId,
        latest && ["prepared", "unknown"].includes(latest.status)
          ? "unknown"
          : "blocked",
        { error: code },
      );
    } finally {
      if (locked)
        await lease.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,200))",
          [`${leagueId}:${pair}`],
        );
      lease.release();
    }
  }
  async reconcile(
    actor: Principal,
    input: { leagueId: string; messageId: string },
  ) {
    requireLeague(actor, input.leagueId);
    requireCommissioner(actor);
    z.uuid().parse(input.messageId);
    const row = (
      await this.db.query(
        "SELECT * FROM buzz_runtime_outbound WHERE league_id=$1 AND runtime_message_id=$2",
        [input.leagueId, input.messageId],
      )
    ).rows[0];
    assert(row, "BUZZ_RUNTIME_MESSAGE_UNKNOWN");
    if (row.status === "accepted") return row;
    const operationKey = `buzz:${input.leagueId}:${row.sender_pubkey}:runtime-message:${input.messageId}`;
    const receipt = (
      await this.db.query(
        "SELECT * FROM buzz_action_receipts WHERE operation_key=$1",
        [operationKey],
      )
    ).rows[0];
    // Recover the crash between an independently committed relay receipt and updating the mirror map.
    if (
      receipt?.status === "accepted" &&
      receipt.event_id &&
      receipt.channel_id === row.channel_id &&
      receipt.actor_pubkey === row.sender_pubkey &&
      receipt.expected_content_hash === row.content_hash
    ) {
      const connection = await this.db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT 1 FROM buzz_conversations WHERE league_id=$1 AND channel_id=$2 FOR UPDATE",
          [input.leagueId, row.channel_id],
        );
        const fixed = await this.update(input.messageId, "accepted", {
          sendReceiptId: receipt.id,
          eventId: receipt.event_id,
        });
        await connection.query("COMMIT");
        return fixed;
      } catch (e) {
        await connection.query("ROLLBACK");
        throw e;
      } finally {
        connection.release();
      }
    }
    if (receipt?.status === "rejected")
      return this.update(input.messageId, "rejected", {
        sendReceiptId: receipt.id,
        error: "BUZZ_RELAY_REJECTED",
      });
    const candidates = (
      await this.db.query(
        "SELECT a.event_id,a.source_created_at,a.observed_at FROM buzz_archive_events a JOIN runtime_messages m ON m.id=$1 WHERE a.league_id=$2 AND a.channel_id=$3 AND a.author_pubkey=$4 AND a.content=m.body ORDER BY a.sequence",
        [input.messageId, input.leagueId, row.channel_id, row.sender_pubkey],
      )
    ).rows;
    return {
      status: "unknown",
      runtimeMessageId: input.messageId,
      candidates,
      mayRetry: false,
      reason:
        "No authoritative acceptance/rejection receipt. Keep pair held; matching content alone cannot resolve this send.",
    };
  }
  async status(actor: Principal, input: { leagueId: string; limit?: number }) {
    requireLeague(actor, input.leagueId);
    assert(
      ["owner", "commissioner"].includes(actor.role),
      "BUZZ_STATUS_FORBIDDEN",
    );
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 50);
    return (
      await this.db.query(
        `SELECT o.* FROM buzz_runtime_outbound o WHERE o.league_id=$1 AND ($2='commissioner' OR EXISTS(SELECT 1 FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.league_id=o.league_id AND b.agent_id IN (o.sender_agent_id,o.recipient_agent_id) AND t.owner_id=$3 AND t.id=$4)) ORDER BY o.created_at DESC LIMIT $5`,
        [input.leagueId, actor.role, actor.id, actor.teamId ?? null, limit],
      )
    ).rows;
  }
  /** Explicit pre-launch cutover. No prompts may be in flight/pending; managed bridge becomes bootstrap-only. */
  async cutoverToPolling(
    actor: Principal,
    input: { leagueId: string; agentId: string; receiptId: string },
  ) {
    requireLeague(actor, input.leagueId);
    requireCommissioner(actor);
    assert(
      input.receiptId.length > 0 && input.receiptId.length <= 200,
      "BUZZ_CUTOVER_RECEIPT_REQUIRED",
    );
    return transaction(this.db, async (tx) => {
      assert(
        (
          await tx.query(
            "SELECT 1 FROM runtime_bindings WHERE league_id=$1 AND agent_id=$2 FOR UPDATE",
            [input.leagueId, input.agentId],
          )
        ).rowCount,
        "BUZZ_AGENT_BINDING_MISSING",
      );
      assert(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_jobs WHERE agent_id=$1 AND (status='running' OR payload->>'kind'='buzz.acp_delivery' AND status='pending')",
            [input.agentId],
          )
        ).rowCount,
        "BUZZ_CUTOVER_PENDING_WORK",
      );
      assert(
        !(
          await tx.query(
            "SELECT 1 FROM buzz_acp_deliveries WHERE league_id=$1 AND agent_id=$2 LIMIT 1",
            [input.leagueId, input.agentId],
          )
        ).rowCount,
        "BUZZ_CUTOVER_HISTORY_RECONCILIATION_REQUIRED",
      );
      const old = (
        await tx.query(
          "SELECT mode FROM buzz_ingress_modes WHERE league_id=$1 AND agent_id=$2 FOR UPDATE",
          [input.leagueId, input.agentId],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO buzz_ingress_modes(league_id,agent_id,mode) VALUES($1,$2,'poll') ON CONFLICT(league_id,agent_id) DO UPDATE SET mode='poll',selected_at=clock_timestamp()",
        [input.leagueId, input.agentId],
      );
      const id = randomUUID();
      await tx.query(
        "INSERT INTO buzz_ingress_cutovers(id,league_id,agent_id,actor_id,receipt_id,previous_mode) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          input.leagueId,
          input.agentId,
          actor.id,
          input.receiptId,
          old?.mode ?? null,
        ],
      );
      return { id, mode: "poll", agentId: input.agentId };
    });
  }
}
