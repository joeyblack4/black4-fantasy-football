import { beforeEach, afterEach, it, expect } from "vitest";
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
import {
  buildBuzzOwnerContext,
  createBuzzChannelReadTools,
} from "../src/buzz/read-tools.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
const leagueId = "synthetic-channel",
  room = "12345678-1234-4234-9234-123456789abc",
  pubkeys = ["a".repeat(64), "b".repeat(64)];
const commissioner = {
  id: "commissioner",
  leagueId,
  role: "commissioner" as const,
};
const listener = {
  leagueId,
  pubkey: pubkeys[0]!,
  communityUrl: "wss://synthetic-channel.example.test",
  mode: "mock" as const,
};
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  archive: BuzzArchiveService;
function event(body: string, author = pubkeys[0]!): BuzzEvent {
  const fields = {
    pubkey: author,
    content: body,
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", room],
      ["p", author === pubkeys[0] ? pubkeys[1]! : pubkeys[0]!],
    ],
  };
  return { ...fields, id: nostrEventId(fields) };
}
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  archive = new BuzzArchiveService(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC OUTBOUND','{}')",
    [leagueId],
  );
  for (let i = 0; i < 2; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$3,$4,'ai',$5,$5,100)",
      [leagueId, `team-${i}`, `SYNTHETIC ${i}`, `owner-${i}`, i],
    );
    await store.createAgent({
      id: `agent-${i}`,
      model: "synthetic/model",
      budgetMicros: 10000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`agent-${i}`, leagueId, `team-${i}`],
    );
  }
  await archive.configure(commissioner, {
    leagueId,
    communityUrl: listener.communityUrl,
    mode: "mock",
    bindingReceiptId: "SYNTHETIC configured",
    archiveConsentReceiptId: "SYNTHETIC consent",
    participants: pubkeys.map((pubkey, i) => ({
      pubkey,
      teamId: `team-${i}`,
      ownerId: `owner-${i}`,
      agentId: `agent-${i}`,
      kind: "agent",
      ownerPubkey: "c".repeat(64),
    })),
  });
  const service = new BuzzRuntimeOutbound(f.db);
  for (let i = 0; i < 2; i++)
    await service.cutoverToPolling(commissioner, {
      leagueId,
      agentId: `agent-${i}`,
      receiptId: "SYNTHETIC prelaunch cutover",
    });
});
afterEach(async () => f?.close());
const actor = {
  id: "owner-0",
  role: "owner" as const,
  leagueId,
  teamId: "team-0",
};
const input = {
  leagueId,
  channelId: room,
  content: "SYNTHETIC channel proposal",
  mentionAgentIds: ["agent-1"],
  operationKey: "one",
};
async function setupChannel(unknown = false, extra = false) {
  await archive.registerChannel(commissioner, {
    leagueId,
    channelId: room,
    memberPubkeys: pubkeys,
    receiptId: "SYNTHETIC private membership",
  });
  let calls = 0;
  const transport: BuzzOutboundTransportFactory = async () => ({
    read: async () =>
      [...pubkeys, ...(extra ? ["d".repeat(64)] : [])].map((pubkey) => ({
        pubkey,
        role: "member",
      })),
    run: async (plan) => {
      calls++;
      expect(plan.args).not.toContain("--broadcast");
      return {
        exitCode: 0,
        stdout: unknown
          ? "{}"
          : JSON.stringify({
              accepted: true,
              event_id: event(input.content).id,
            }),
      };
    },
  });
  return {
    service: new BuzzChannelService(f.db, transport),
    calls: () => calls,
  };
}
it("native group send is attributed, durable, has no direct wake, and polling wakes once", async () => {
  const { service, calls } = await setupChannel();
  const r = await service.send(actor, input);
  expect(r.status).toBe("accepted");
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
  ).toBe(0);
  expect((await service.send(actor, input)).replayed).toBe(true);
  expect(calls()).toBe(1);
  expect(
    (await service.verifyReceipt(f.db, actor, input, r.receiptId)).status,
  ).toBe("accepted");
  const batch = {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [event(input.content)],
    complete: true,
  };
  await archive.ingestBatch(listener, batch);
  await archive.ingestBatch(listener, batch);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
  ).toBe(1);
  await expect(
    service.verifyReceipt(
      f.db,
      actor,
      { ...input, content: "tampered" },
      r.receiptId,
    ),
  ).rejects.toThrow("BUZZ_RECEIPT_BINDING_MISMATCH");
});
it("unknown native send is never retried and holds duplicate content under new operation keys", async () => {
  const { service, calls } = await setupChannel(true);
  expect((await service.send(actor, input)).status).toBe("unknown");
  expect((await service.send(actor, input)).replayed).toBe(true);
  expect(calls()).toBe(1);
  await expect(
    service.send(actor, { ...input, operationKey: "two" }),
  ).rejects.toThrow("BUZZ_CHANNEL_UNCERTAIN_SEND_HELD");
});
it("an uncertain sender cannot freeze another owner or its own independently authored content", async () => {
  const { service, calls } = await setupChannel(true);
  const first = await service.send(actor, input);
  const peer = { ...actor, id: "owner-1", teamId: "team-1" };
  expect(
    (
      await service.send(peer, {
        ...input,
        operationKey: "peer-intro",
        content: "SYNTHETIC independent peer introduction",
        mentionAgentIds: ["agent-0"],
      })
    ).status,
  ).toBe("unknown");
  expect(
    (
      await service.send(actor, {
        ...input,
        operationKey: "independent",
        content: "SYNTHETIC different later question",
      })
    ).status,
  ).toBe("unknown");
  expect(calls()).toBe(3);
  const receipts = (
    await f.db.query("SELECT id,status FROM buzz_action_receipts")
  ).rows;
  expect(receipts.find((r) => r.id === first.receiptId).status).toBe("unknown");
  expect(receipts).toHaveLength(3);
  await expect(
    service.send(actor, {
      ...input,
      operationKey: "attempt-duplicate",
      mentionAgentIds: [],
    }),
  ).rejects.toThrow("BUZZ_CHANNEL_UNCERTAIN_SEND_HELD");
  expect((await service.send(actor, input)).replayed).toBe(true);
  expect(calls()).toBe(3);
});
it("concurrent duplicate causal keys cannot dispatch the same uncertain message twice", async () => {
  const { service, calls } = await setupChannel(true);
  const results = await Promise.allSettled([
    service.send(actor, input),
    service.send(actor, { ...input, operationKey: "racing-key" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(calls()).toBe(1);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM buzz_action_receipts"))
      .rows[0].n,
  ).toBe(1);
});
it("legacy uncertain receipts without a content hash hold only their own sender", async () => {
  const { service, calls } = await setupChannel(true);
  const first = await service.send(actor, input);
  await f.db.query(
    "UPDATE buzz_action_receipts SET expected_content_hash=NULL WHERE id=$1",
    [first.receiptId],
  );
  await expect(
    service.send(actor, {
      ...input,
      operationKey: "different",
      content: "SYNTHETIC different body",
    }),
  ).rejects.toThrow("BUZZ_CHANNEL_UNCERTAIN_SEND_HELD");
  await service.send(
    { ...actor, id: "owner-1", teamId: "team-1" },
    { ...input, operationKey: "peer", mentionAgentIds: ["agent-0"] },
  );
  expect(calls()).toBe(2);
});
it("cross owner, unregistered mention, changed membership and fake reply fail before send", async () => {
  const { service, calls } = await setupChannel(false, true);
  await expect(
    service.send({ ...actor, leagueId: "other" }, input),
  ).rejects.toThrow();
  await expect(
    service.send(actor, { ...input, mentionAgentIds: ["customer-agent"] }),
  ).rejects.toThrow("BUZZ_MENTION_NOT_BOUND");
  await expect(
    service.send(actor, { ...input, replyTo: "f".repeat(64) }),
  ).rejects.toThrow("BUZZ_REPLY_NOT_OBSERVED");
  await expect(service.send(actor, input)).rejects.toThrow(
    "BUZZ_MEMBERSHIP_CHANGED",
  );
  expect(calls()).toBe(0);
});

it("group read tool exposes only registered channels and rejects a stale lease/model", async () => {
  await setupChannel();
  await store.ingestEvent({
    agentId: "agent-0",
    causalId: "channel-read",
    payload: { kind: "synthetic" },
  });
  const job = (await store.claim("reader"))!;
  const tool = createBuzzChannelReadTools(f.db)[0]!;
  expect((tool.parameters as any).type).toBe("object");
  expect((tool.parameters as any).oneOf).toBeUndefined();
  await expect(tool.execute(job, { type: "messages" })).rejects.toThrow();
  const result = (await tool.execute(job, { type: "channels" })) as any;
  expect(result.channels[0].channelId).toBe(room);
  expect(
    result.channels[0].participants.map((p: any) => p.agentId).sort(),
  ).toEqual(["agent-0", "agent-1"]);
  await expect(
    tool.execute(job, {
      type: "messages",
      channelId: "12345678-1234-4234-9234-123456789aaa",
    }),
  ).rejects.toThrow("Unknown league conversation");
  await f.db.query(
    "UPDATE runtime_agents SET model='synthetic/changed' WHERE id='agent-0'",
  );
  await expect(tool.execute(job, { type: "channels" })).rejects.toThrow(
    "BUZZ_READ_JOB_AUTHORITY_EXPIRED",
  );
});

it("initial context exposes scoped private channels without leaking absent membership or credentials", async () => {
  await setupChannel();
  const context = await buildBuzzOwnerContext(f.db, "agent-0");
  expect(context.channels.map((c) => c.channelId)).toEqual([room]);
  expect(context).toMatchObject({
    status: "bound",
    synthetic: true,
    archiveIsPublic: false,
    publicationRequiresCommissionerApproval: true,
  });
  expect(JSON.stringify(context)).not.toContain(pubkeys[0]);
  await f.db.query(
    "UPDATE buzz_conversations SET member_pubkeys=$1::jsonb WHERE league_id=$2",
    [JSON.stringify([pubkeys[1]]), leagueId],
  );
  expect((await buildBuzzOwnerContext(f.db, "agent-0")).channels).toEqual([]);
  await f.db.query(
    "UPDATE league_teams SET owner_id='new-owner' WHERE league_id=$1 AND id='team-0'",
    [leagueId],
  );
  expect(await buildBuzzOwnerContext(f.db, "agent-0")).toEqual({
    status: "unbound",
    channels: [],
  });
});

it("direct event tool uses the current owner lease and returns a bounded oversized-original receipt", async () => {
  await setupChannel();
  const original = event("SYNTHETIC exact peer message", pubkeys[1]);
  const oversized = event("SYNTHETIC " + "é".repeat(15000), pubkeys[1]);
  oversized.tags = [["h", room]]; // Archive-only fixture; no oversized runtime wake payload.
  oversized.id = nostrEventId(oversized);
  await archive.ingestBatch(listener, {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [original, oversized],
    complete: true,
  });
  const job = (await store.claim("event-reader"))!;
  expect(job.agentId).toBe("agent-0");
  const tool = createBuzzChannelReadTools(f.db)[0]!;
  const result = (await tool.execute(job, {
    type: "event",
    channelId: room,
    eventId: original.id,
  })) as any;
  expect(result).toMatchObject({
    status: "found",
    event: { content: original.content, event_id: original.id },
    author: { agent_id: "agent-1" },
  });
  const large = (await tool.execute(job, {
    type: "event",
    channelId: room,
    eventId: oversized.id,
  })) as any;
  expect(large.status).toBe("tooLarge");
  expect(large.event.event_id).toBe(oversized.id);
  expect(large.event.content).toBeUndefined();
  expect(large.event.tags).toBeUndefined();
  expect(large.contentReturned).toBe(false);
  expect(large.originalContentBytes).toBe(Buffer.byteLength(oversized.content));
  expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(24000);
  await expect(
    tool.execute(job, { type: "event", channelId: room }),
  ).rejects.toThrow();
  await f.db.query("UPDATE runtime_jobs SET fence=fence+1 WHERE id=$1", [
    job.id,
  ]);
  await expect(
    tool.execute(job, { type: "event", channelId: room, eventId: original.id }),
  ).rejects.toThrow("BUZZ_READ_JOB_AUTHORITY_EXPIRED");
});
