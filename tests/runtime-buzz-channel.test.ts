import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { runOne, TestDriver, ActionSchema } from "../src/runtime/worker.js";
import { FranchiseOutbox } from "../src/franchise/outbox.js";
import { BuzzArchiveService } from "../src/buzz/archive.js";
import { BuzzRuntimeOutbound } from "../src/buzz/runtime-outbound.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  outbox: FranchiseOutbox,
  calls: number,
  uncertain: boolean;
const leagueId = "runtime-group",
  room = "12345678-1234-4234-9234-123456789abc",
  pubkeys = ["a".repeat(64), "b".repeat(64)];
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  calls = 0;
  uncertain = false;
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC group','{}')",
    [leagueId],
  );
  for (let i = 0; i < 2; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,'ai',$4,$4,100)",
      [leagueId, `team${i}`, `owner${i}`, i],
    );
    await store.createAgent({
      id: `agent${i}`,
      model: "synthetic/group",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`agent${i}`, leagueId, `team${i}`],
    );
  }
  const commissioner = {
      id: "commissioner",
      role: "commissioner" as const,
      leagueId,
    },
    archive = new BuzzArchiveService(f.db);
  await archive.configure(commissioner, {
    leagueId,
    communityUrl: "wss://synthetic-group.example.test",
    mode: "mock",
    bindingReceiptId: "SYNTHETIC binding",
    archiveConsentReceiptId: "SYNTHETIC consent",
    participants: pubkeys.map((pubkey, i) => ({
      pubkey,
      teamId: `team${i}`,
      ownerId: `owner${i}`,
      agentId: `agent${i}`,
      kind: "agent",
      ownerPubkey: "c".repeat(64),
    })),
  });
  for (let i = 0; i < 2; i++)
    await new BuzzRuntimeOutbound(f.db).cutoverToPolling(commissioner, {
      leagueId,
      agentId: `agent${i}`,
      receiptId: "SYNTHETIC cutover",
    });
  await archive.registerChannel(commissioner, {
    leagueId,
    channelId: room,
    memberPubkeys: pubkeys,
    receiptId: "SYNTHETIC membership",
  });
  const channel = new BuzzChannelService(f.db, async () => ({
    read: async () => pubkeys.map((pubkey) => ({ pubkey, role: "member" })),
    run: async () => {
      calls++;
      return {
        exitCode: 0,
        stdout: uncertain
          ? "{}"
          : JSON.stringify({ accepted: true, event_id: "d".repeat(64) }),
      };
    },
  }));
  outbox = new FranchiseOutbox(f.db, store, undefined, undefined, channel);
});
afterEach(async () => {
  await f?.close();
});
async function queue() {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "founding-turn",
    payload: { synthetic: true },
  });
  const driver = new TestDriver("synthetic/group", () => ({
    actions: [
      {
        type: "buzz_channel",
        causalId: "group-intent",
        channelId: room,
        content: "SYNTHETIC proposal discussion",
        mentionAgentIds: ["agent1"],
      },
    ],
    costMicros: 0,
    summary: "Synthetic native-group fixture",
  }));
  expect((await runOne(store, driver, "owner")).status).toBe("completed");
}
it("owner group action verifies native receipt without creating duplicate recipient wakes", async () => {
  await queue();
  const claim = (await outbox.claim("sender"))!;
  await expect(
    outbox.acknowledge(claim, {
      receiptId: "forged",
      result: {},
      replayed: false,
    }),
  ).rejects.toThrow();
  const receipt = await outbox.execute(claim);
  expect(receipt.result.status).toBe("accepted");
  await outbox.acknowledge(claim, receipt);
  expect(calls).toBe(1);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_jobs WHERE agent_id='agent1'"))
      .rowCount,
  ).toBe(0);
  expect((await f.db.query("SELECT 1 FROM runtime_messages")).rowCount).toBe(0);
});
it("uncertain native group send is held and is never blindly retried", async () => {
  uncertain = true;
  await queue();
  expect((await outbox.dispatchOne("sender")).status).toBe("held");
  expect((await outbox.dispatchOne("retry")).status).toBe("idle");
  expect(calls).toBe(1);
  expect(
    (await f.db.query("SELECT status FROM runtime_franchise_outbox")).rows[0]
      .status,
  ).toBe("held");
});
it("group action cannot inject actor, league or transport authority", () => {
  for (const extra of [
    { actor: { role: "commissioner" } },
    { leagueId: "other" },
    { operationKey: "owned-by-model" },
  ])
    expect(
      ActionSchema.safeParse({
        type: "buzz_channel",
        causalId: "bad",
        channelId: room,
        content: "Synthetic",
        mentionAgentIds: [],
        ...extra,
      }).success,
    ).toBe(false);
});
