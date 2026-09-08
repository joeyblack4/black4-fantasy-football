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
const leagueId = "synthetic-mirror",
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
  communityUrl: "wss://synthetic-mirror.example.test",
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
async function message(body = "SYNTHETIC owner negotiation", causalId = "one") {
  return store.sendMessage("agent-0", {
    recipientId: "agent-1",
    causalId,
    body,
  });
}
function fake(
  options: { unknown?: boolean; onSend?: (e: BuzzEvent) => void } = {},
) {
  let opened = false,
    opens = 0,
    sends = 0;
  const history: BuzzEvent[] = [];
  const factory: BuzzOutboundTransportFactory = async () => ({
    read: async (request) =>
      request.command === "dms"
        ? opened
          ? [{ dm_id: room, participants: pubkeys, created_at: 1 }]
          : []
        : request.command === "members"
          ? pubkeys.map((pubkey) => ({ pubkey, role: "member" }))
          : history,
    run: async (plan) => {
      if (plan.command === "open-dm") {
        opened = true;
        opens++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            accepted: true,
            event_id: "d".repeat(64),
            dm_id: room,
          }),
        };
      }
      sends++;
      const e = event(plan.stdin!);
      history.push(e);
      options.onSend?.(e);
      if (options.unknown) throw new Error("SYNTHETIC lost response");
      return {
        exitCode: 0,
        stdout: JSON.stringify({ accepted: true, event_id: e.id }),
      };
    },
  });
  return {
    factory,
    history,
    get opens() {
      return opens;
    },
    get sends() {
      return sends;
    },
  };
}
it("opens a supported DM, publishes under sender identity and archives without an extra model wakeup", async () => {
  const m = await message();
  let echo: Promise<unknown> | undefined;
  const io = fake({
      onSend: (e) => {
        echo = archive.ingestBatch(listener, {
          channelId: room,
          memberPubkeys: pubkeys,
          events: [e],
          complete: true,
        });
      },
    }),
    service = new BuzzRuntimeOutbound(f.db, io.factory);
  await service.enqueueCommitted(leagueId);
  const result = await service.dispatchMessage(leagueId, m.id);
  expect(result.status).toBe("accepted");
  await echo;
  expect(io.opens).toBe(1);
  expect(io.sends).toBe(1);
  expect(result.event_id).toBe(io.history[0]!.id);
  expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(1);
  expect((await f.db.query("SELECT * FROM buzz_archive_events")).rowCount).toBe(
    1,
  );
  await service.dispatchMessage(leagueId, m.id);
  expect(io.sends).toBe(1);
  const receipts = (
    await f.db.query(
      "SELECT * FROM runtime_receipts WHERE type='buzz.message.accepted'",
    )
  ).rows;
  expect(receipts).toHaveLength(1);
  expect(receipts[0].details.runtimeMessageId).toBe(m.id);
});
it("holds uncertain pairs, never re-sends and archives incoming messages without echoing", async () => {
  const m = await message(),
    io = fake({ unknown: true }),
    service = new BuzzRuntimeOutbound(f.db, io.factory);
  await service.enqueueCommitted(leagueId);
  expect((await service.dispatchMessage(leagueId, m.id)).status).toBe(
    "unknown",
  );
  expect((await service.dispatchMessage(leagueId, m.id)).status).toBe("held");
  expect(io.sends).toBe(1);
  const extra = event(
    "SYNTHETIC unrelated new incoming while pair held",
    pubkeys[1],
  );
  const ingested = await archive.ingestBatch(listener, {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [io.history[0], extra],
    complete: true,
  });
  expect(ingested.mirrorHold).toBe(true);
  expect(ingested.delivered).toBe(0);
  expect(ingested.complete).toBe(false);
  expect(
    (await f.db.query("SELECT * FROM buzz_archive_held_events")).rowCount,
  ).toBe(2);
  const next = await message("SYNTHETIC later message", "two");
  await service.enqueueCommitted(leagueId);
  expect((await service.dispatchMessage(leagueId, next.id)).status).toBe(
    "held",
  );
  expect(io.sends).toBe(1);
  const reconciliation = await service.reconcile(commissioner, {
    leagueId,
    messageId: m.id,
  });
  expect(reconciliation.status).toBe("unknown");
  expect(reconciliation.mayRetry).toBe(false);
});
it("recovers a crash after committed relay acceptance and replays only held genuine incoming events", async () => {
  const m = await message(),
    io = fake(),
    service = new BuzzRuntimeOutbound(f.db, io.factory);
  await service.enqueueCommitted(leagueId);
  await service.dispatchMessage(leagueId, m.id);
  await f.db.query(
    "UPDATE buzz_runtime_outbound SET status='prepared',event_id=NULL,send_receipt_id=NULL WHERE runtime_message_id=$1",
    [m.id],
  );
  const extra = event("SYNTHETIC new reply", pubkeys[1]);
  await archive.ingestBatch(listener, {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [io.history[0], extra],
    complete: true,
  });
  expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(1);
  expect(
    (await service.reconcile(commissioner, { leagueId, messageId: m.id }))
      .status,
  ).toBe("accepted");
  await archive.ingestBatch(listener, {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [io.history[0], extra],
    complete: true,
  });
  expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(2);
  expect(
    (await f.db.query("SELECT * FROM buzz_archive_held_events")).rowCount,
  ).toBe(0);
  expect(io.sends).toBe(1);
});
it("refuses another league and missing polling cutover without contacting transport", async () => {
  const m = await message();
  let contacted = 0;
  const service = new BuzzRuntimeOutbound(f.db, async () => {
    contacted++;
    throw new Error("must not call");
  });
  await service.enqueueCommitted(leagueId);
  await expect(service.dispatchMessage("other", m.id)).rejects.toThrow(
    "UNKNOWN",
  );
  await f.db.query(
    "UPDATE buzz_ingress_modes SET mode='managed_acp' WHERE agent_id='agent-1'",
  );
  const result = await service.dispatchMessage(leagueId, m.id);
  expect(result.status).toBe("blocked");
  expect(result.last_error).toBe("BUZZ_POLLING_CUTOVER_REQUIRED");
  expect(contacted).toBe(0);
  await expect(
    service.status(
      { id: "outsider", leagueId, role: "owner", teamId: "other" },
      { leagueId },
    ),
  ).resolves.toEqual([]);
});
