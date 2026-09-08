import { expect, it } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  BuzzArchiveService,
  nostrEventId,
  type BuzzEvent,
} from "../src/buzz/archive.js";
import {
  BuzzRuntimeOutbound,
  type BuzzOutboundTransportFactory,
} from "../src/buzz/runtime-outbound.js";
import { BuzzChannelService } from "../src/buzz/channel.js";

it("SYNTHETIC ten-owner matrix preserves every sender/receiver, rejects self/outsider mentions and deduplicates all polling", async () => {
  const f = await testDb();
  try {
    const leagueId = "synthetic-ten-owner-routing",
      channelId = "12345678-1234-4234-9234-123456789abc";
    const commissioner = {
      id: "commissioner",
      role: "commissioner" as const,
      leagueId,
    };
    const store = new RuntimeStore(f.db),
      archive = new BuzzArchiveService(f.db);
    const members = Array.from({ length: 10 }, (_, i) => ({
      pubkey: (i + 1).toString(16).padStart(64, "0"),
      agentId: `synthetic-agent-${i}`,
      teamId: `synthetic-team-${i}`,
      ownerId: `synthetic-owner-${i}`,
      kind: "agent" as const,
      ownerPubkey: "c".repeat(64),
    }));
    await f.db.query(
      "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC ten owner fixture','{}')",
      [leagueId],
    );
    for (const [i, m] of members.entries()) {
      await f.db.query(
        "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,'ai',$4,$4,100)",
        [leagueId, m.teamId, m.ownerId, i],
      );
      await store.createAgent({
        id: m.agentId,
        model: "synthetic/model",
        budgetMicros: 10000,
      });
      await f.db.query(
        "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
        [m.agentId, leagueId, m.teamId],
      );
    }
    const communityUrl = "wss://ten-owner.example.test";
    await archive.configure(commissioner, {
      leagueId,
      communityUrl,
      mode: "mock",
      bindingReceiptId: "SYNTHETIC binding",
      archiveConsentReceiptId: "SYNTHETIC consent",
      participants: members,
    });
    await archive.registerChannel(commissioner, {
      leagueId,
      channelId,
      memberPubkeys: members.map((m) => m.pubkey),
      receiptId: "SYNTHETIC private membership",
    });
    for (const m of members)
      await new BuzzRuntimeOutbound(f.db).cutoverToPolling(commissioner, {
        leagueId,
        agentId: m.agentId,
        receiptId: "SYNTHETIC polling cutover",
      });
    const events: BuzzEvent[] = [];
    const transport: BuzzOutboundTransportFactory = async (binding) => ({
      read: async () =>
        members.map((m) => ({ pubkey: m.pubkey, role: "member" })),
      run: async (plan) => {
        const sender = members.find(
          (m) => m.agentId === binding.senderAgentId,
        )!;
        expect(binding.pubkey).toBe(sender.pubkey);
        expect(plan.actorPubkey).toBe(sender.pubkey);
        expect(plan.communityUrl).toBe(communityUrl);
        const mention = plan.args[plan.args.indexOf("--mention") + 1]!;
        const fields = {
          pubkey: sender.pubkey,
          kind: 9,
          content: plan.stdin!,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", channelId],
            ["p", mention],
          ],
        };
        const event = { ...fields, id: nostrEventId(fields) };
        events.push(event);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ accepted: true, event_id: event.id }),
        };
      },
    });
    const service = new BuzzChannelService(f.db, transport);
    const actor = (i: number) => ({
      id: members[i]!.ownerId,
      role: "owner" as const,
      leagueId,
      teamId: members[i]!.teamId,
    });
    for (let a = 0; a < 10; a++)
      for (let b = 0; b < 10; b++) {
        const input = {
          leagueId,
          channelId,
          content: `SYNTHETIC routing ${a} to ${b}; not model-authored dialogue`,
          mentionAgentIds: [members[b]!.agentId],
          operationKey: `matrix-${a}-${b}`,
        };
        if (a === b) {
          await expect(service.send(actor(a), input)).rejects.toThrow(
            "BUZZ_MENTION_NOT_BOUND",
          );
          continue;
        }
        const receipt = await service.send(actor(a), input);
        expect(receipt.synthetic).toBe(true);
        expect(receipt.status).toBe("accepted");
        expect((await service.send(actor(a), input)).replayed).toBe(true);
        await expect(
          service.verifyReceipt(f.db, actor(b), input, receipt.receiptId),
        ).rejects.toThrow("BUZZ_RECEIPT_BINDING_MISMATCH");
      }
    expect(events).toHaveLength(90);
    await expect(
      service.send(actor(0), {
        leagueId,
        channelId,
        content: "SYNTHETIC forbidden",
        mentionAgentIds: ["customer-agent"],
        operationKey: "outsider",
      }),
    ).rejects.toThrow("BUZZ_MENTION_NOT_BOUND");
    expect(
      (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
    ).toBe(0);
    const batch = {
      channelId,
      memberPubkeys: members.map((m) => m.pubkey),
      events,
      complete: true,
    };
    for (const m of members)
      await archive.ingestBatch(
        { leagueId, communityUrl, pubkey: m.pubkey, mode: "mock" },
        batch,
      );
    const rows = (
      await f.db.query(
        `SELECT d.agent_id,e.author_pubkey,e.content,e.mode,e.provenance FROM buzz_inbound_deliveries d JOIN buzz_archive_events e ON e.league_id=d.league_id AND e.event_id=d.event_id WHERE d.league_id=$1`,
        [leagueId],
      )
    ).rows;
    expect(rows).toHaveLength(90);
    for (const [i, m] of members.entries()) {
      const received = rows.filter((r) => r.agent_id === m.agentId);
      expect(received).toHaveLength(9);
      expect(new Set(received.map((r) => r.author_pubkey)).size).toBe(9);
      for (const r of received) {
        expect(r.author_pubkey).not.toBe(m.pubkey);
        expect(r.content).toContain(`to ${i};`);
        expect(r.mode).toBe("mock");
        expect(r.provenance).toBe("synthetic fixture");
      }
    }
    expect(
      (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
    ).toBe(90);
  } finally {
    await f.close();
  }
}, 30000);
