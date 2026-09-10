import { randomUUID } from "node:crypto";
import { buildOwnerRuntimeStatus } from "../src/runtime/owner-status.js";
import { createBuzzChannelReadTools } from "../src/buzz/read-tools.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { RehearsalRuntime, rehearsalUsage } from "../src/runtime/rehearsal.js";
import {
  ConversationRuntime,
  admitConversationDeliveryTx,
} from "../src/runtime/conversation.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import { BuzzArchiveService, nostrEventId } from "../src/buzz/archive.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { FranchiseOutbox } from "../src/franchise/outbox.js";
import { bindHost } from "../src/league/host.js";
import { transaction } from "../src/db.js";
const leagueId = "conversation-fixture",
  channelId = "12345678-1234-4234-9234-123456789abc",
  otherChannel = "22345678-1234-4234-9234-123456789abc",
  epoch = "held-trial";
const actor = { id: "commissioner", role: "commissioner" as const, leagueId };
const agents = Array.from({ length: 10 }, (_, i) => ({
  agentId: "chat-" + i,
  teamId: "team-" + i,
  ownerId: "owner-" + i,
  kind: "agent" as const,
  pubkey: (i + 1).toString(16).padStart(64, "0"),
  ownerPubkey: "e".repeat(64),
}));
const human = {
  teamId: "human",
  ownerId: "joey",
  kind: "human" as const,
  pubkey: "d".repeat(64),
};
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  chat: ConversationRuntime,
  archive: BuzzArchiveService,
  trial: RehearsalRuntime,
  s: any,
  config: any;
const communityUrl = "wss://conversation.example.test",
  members = [...agents, human].map((a) => a.pubkey);
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  chat = new ConversationRuntime(f.db);
  archive = new BuzzArchiveService(f.db);
  trial = new RehearsalRuntime(f.db, store);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC conversation','{}')",
    [leagueId],
  );
  for (const [i, a] of [...agents, human].entries()) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,$4,$5,$5,100)",
      [leagueId, a.teamId, a.ownerId, a.kind === "agent" ? "ai" : "human", i],
    );
    if ("agentId" in a) {
      await store.createAgent({
        id: a.agentId,
        model: "synthetic/" + i,
        budgetMicros: 1000,
      });
      await f.db.query(
        "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
        [a.agentId, leagueId, a.teamId],
      );
    }
  }
  for (const [i, a] of agents.entries())
    await f.db.query(
      "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status,activated_at) VALUES(gen_random_uuid(),$1,$2,1,$3,'synthetic-fingerprint','active',clock_timestamp())",
      [
        leagueId,
        a.agentId,
        {
          agentId: a.agentId,
          leagueId,
          model: "synthetic/" + i,
          developer: "Synthetic",
          providerSlug: "synthetic/provider",
          reportedProviderNames: ["Synthetic"],
          harnessId: "black4-owner-loop",
          harnessVersion: "synthetic-v1",
          toolPermissions: ["remember", "buzz_channel", "buzz_read"],
        },
      ],
    );
  await archive.configure(actor, {
    leagueId,
    communityUrl,
    mode: "mock",
    bindingReceiptId: "synthetic",
    archiveConsentReceiptId: "synthetic",
    participants: [...agents, human],
  });
  for (const c of [channelId, otherChannel])
    await archive.registerChannel(actor, {
      leagueId,
      channelId: c,
      memberPubkeys: members,
      receiptId: "synthetic-channel",
    });
  await archive.configureHumanBroadcast(actor, {
    leagueId,
    channelId,
    enabled: true,
    expectedVersion: 0,
    idempotencyKey: "broadcast",
    reason: "SYNTHETIC human group collaboration",
  });
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  await bindHost(f.db, actor, {
    leagueId,
    expectedVersion: 0,
    host: "mfl",
    config: {
      season: 2026,
      leagueId: "62282",
      configRef: "fixture-production",
    },
    idempotencyKey: "initial",
    reason: "Synthetic production fixture",
  });
  await trial.arm(actor, {
    epoch,
    expectedHostVersion: 1,
    trialConfigRef: "fixture46625",
    capMicros: 100,
    synthetic: true,
    operatorEvidenceRef: "SYNTHETIC paused disposable fixture",
    reason: "Synthetic known quiescent owner fixture",
  });
  config = {
    epoch,
    expectedHostVersion: 2,
    channelIds: [channelId],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    maxTurnsPerOwner: 4,
    maxSpendMicrosPerOwner: 60,
    idempotencyKey: "chat-session",
    reason: "Synthetic bounded conversation while draft held",
  };
});
afterEach(async () => f?.close());
async function open() {
  s = await chat.open(actor, config);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
  ).toBe(0);
  return s;
}
async function incoming(
  text = "Collaborate on our brand",
  opts: {
    channel?: string;
    created?: number;
    sender?: string;
    tags?: string[][];
  } = {},
) {
  const room = opts.channel ?? channelId,
    fields = {
      pubkey: opts.sender ?? human.pubkey,
      kind: 9,
      content: "SYNTHETIC " + text,
      tags: opts.tags ?? [["h", room]],
      created_at: opts.created ?? Math.ceil(Date.now() / 1000),
    };
  const event = { ...fields, id: nostrEventId(fields) };
  const result = await archive.ingestBatch(
    { leagueId, communityUrl, pubkey: agents[0]!.pubkey, mode: "mock" },
    {
      channelId: room,
      memberPubkeys: members,
      events: [event],
      complete: true,
    },
  );
  return { event, result };
}
async function run(
  i = 0,
  actions: any[] = [],
  costMicros = 2,
  reservation = 10,
) {
  return runOne(
    store,
    new TestDriver("synthetic/" + i, (job) => ({
      actions,
      summary: "SYNTHETIC same owner response " + job.agentId,
      costMicros,
    })),
    "chat-worker",
    {
      allowedAgentIds: [agents[i]!.agentId],
      conversationSessionId: s.id,
      maxCostMicros: reservation,
    },
  );
}
it("admits one canonical human event to ten pinned owners and persists their own isolated memories", async () => {
  await open();
  const e = await incoming();
  expect(e.result.delivered).toBe(10);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM runtime_jobs WHERE execution_mode='conversation'",
      )
    ).rows[0].n,
  ).toBe(10);
  expect(await store.claim("ordinary", 30000)).toBeNull();
  for (let i = 0; i < 10; i++)
    expect(
      (
        await run(i, [
          { type: "remember", key: "chat-memory", content: "owner " + i },
        ])
      ).status,
    ).toBe("completed");
  const rows = (
    await f.db.query(
      "SELECT agent_id,content FROM runtime_memory ORDER BY agent_id",
    )
  ).rows;
  expect(rows).toEqual(
    agents.map((a, i) => ({ agent_id: a.agentId, content: "owner " + i })),
  );
  expect(
    (await rehearsalUsage(f.db, leagueId, epoch, "chat-0")).committed_micros,
  ).toBe("2");
  expect(
    (await incoming(undefined, { created: e.event.created_at })).result
      .delivered,
  ).toBe(0);
  const fresh = await incoming("Use the memory next");
  expect(fresh.result.delivered).toBe(10);
  const job = await store.claim(
    "readback",
    30000,
    "synthetic/0",
    ["chat-0"],
    undefined,
    s.id,
  );
  expect(job?.memory).toEqual([
    { key: "chat-memory", content: "owner 0", version: 1 },
  ]);
  expect((await chat.context(job!)).activePermissions).toEqual([
    "buzz_read",
    "remember",
    "buzz_channel",
  ]);
});
it("preserves native unknown and charges conversation to existing held epoch/season wallet", async () => {
  await open();
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('mfl_operation',$1)",
    [
      {
        leagueId,
        scope: "synthetic-native",
        idempotencyKey: "unknown-native",
        state: "unknown",
      },
    ],
  );
  const before = (
    await f.db.query(
      "SELECT details FROM runtime_receipts WHERE type='mfl_operation'",
    )
  ).rows;
  await incoming();
  expect((await run()).status).toBe("completed");
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='mfl_operation'",
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await f.db.query(
        "SELECT budget_micros,spent_micros,reserved_micros FROM runtime_agents WHERE id='chat-0'",
      )
    ).rows[0],
  ).toEqual({ budget_micros: "1000", spent_micros: "2", reserved_micros: "0" });
});
for (const action of [
  {
    type: "schedule",
    causalId: "later",
    dueAt: new Date(Date.now() + 600000).toISOString(),
    payload: { task: "draft" },
  },
  {
    type: "football",
    causalId: "pick",
    command: {
      type: "mfl",
      action: { type: "draft", round: 1, pick: 1, playerId: "12345" },
    },
  },
  { type: "cancel", causalId: "old" },
  { type: "governance", causalId: "vote", command: { type: "castVote" } },
  { type: "brand", causalId: "brand" },
  { type: "public_draft", causalId: "publish" },
  { type: "service_request", causalId: "buy" },
  { type: "delegate", causalId: "staff", role: "analyst", task: "Do work" },
  {
    type: "message",
    causalId: "message",
    recipientId: "chat-1",
    conversationId: "shortcut",
    body: "bypass canonical Buzz",
  },
  {
    type: "buzz_channel",
    causalId: "outside",
    channelId: otherChannel,
    content: "out of scope",
    mentionAgentIds: [],
  },
])
  it(
    "rejects mixed forbidden " + action.type + " batch atomically",
    async () => {
      await open();
      await incoming();
      const job = await store.claim(
        "atomic",
        30000,
        "synthetic/0",
        ["chat-0"],
        undefined,
        s.id,
      );
      const reservationId = await store.reserve(job!, 10);
      await expect(
        store.complete(job!, {
          actions: [
            { type: "remember", key: "should-not-commit", content: "no" },
            action,
          ] as any,
          costMicros: 2,
          summary: "synthetic malicious response",
          reservationId,
          driver: "TEST",
          synthetic: true,
        }),
      ).rejects.toMatchObject({ code: "CONVERSATION_ACTION_FORBIDDEN" });
      expect((await f.db.query("SELECT * FROM runtime_memory")).rowCount).toBe(
        0,
      );
      expect(
        (await f.db.query("SELECT * FROM runtime_football_outbox")).rowCount,
      ).toBe(0);
    },
  );
it("requires canonical delivery, refuses forged payload-only work, and leaves other-channel/old events archive-only", async () => {
  await open();
  const old = await incoming("old", {
    created: Math.floor(+s.opened_at / 1000) - 5,
  });
  expect(old.result.delivered).toBe(0);
  const other = await incoming("outside", {
    channel: otherChannel,
    tags: [
      ["h", otherChannel],
      ["p", agents[0]!.pubkey],
    ],
  });
  expect(other.result.delivered).toBe(0);
  const forged = await transaction(f.db, (tx) =>
    store.ingestEventTx(tx, {
      agentId: "chat-0",
      causalId: "forged",
      payload: { kind: "buzz.message", eventId: old.event.id },
    }),
  );
  await expect(
    transaction(f.db, (tx) =>
      admitConversationDeliveryTx(tx, {
        leagueId,
        agentId: "chat-0",
        eventId: old.event.id,
        jobId: forged.id,
        expectedSessionId: s.id,
      }),
    ),
  ).rejects.toThrow();
  expect(
    await store.claim(
      "forged-worker",
      30000,
      "synthetic/0",
      ["chat-0"],
      undefined,
      s.id,
    ),
  ).toBeNull();
});
it("turn and session money limits cannot grant new credit; all reservations remain in epoch usage", async () => {
  config.maxTurnsPerOwner = 1;
  await open();
  await incoming();
  expect((await run()).status).toBe("completed");
  await incoming("second");
  expect(await run()).toMatchObject({
    error: expect.stringContaining("CONVERSATION_TURN_LIMIT"),
  });
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM runtime_reservations WHERE agent_id='chat-0'",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("session money and unchanged epoch cap both reject before provider invocation", async () => {
  config.maxSpendMicrosPerOwner = 5;
  await open();
  await incoming();
  expect(await run()).toMatchObject({
    error: expect.stringContaining("CONVERSATION_SPEND_LIMIT"),
  });
  expect(
    (await f.db.query("SELECT * FROM runtime_reservations")).rowCount,
  ).toBe(0);
});
it("unreviewed model liability still blocks chat even though native liability is held separately", async () => {
  await open();
  await incoming();
  const job = await store.claim(
    "first",
    30000,
    "synthetic/0",
    ["chat-0"],
    undefined,
    s.id,
  );
  await store.reserve(job!, 10);
  await f.db.query(
    "UPDATE runtime_jobs SET status='dead',lease_until=NULL WHERE id=$1",
    [job!.id],
  );
  await f.db.query(
    "UPDATE runtime_reservations SET status='uncertain' WHERE job_id=$1",
    [job!.id],
  );
  await incoming("after unknown");
  expect(await run()).toMatchObject({
    error: expect.stringContaining("REHEARSAL_COST_UNRESOLVED"),
  });
  expect(
    (await rehearsalUsage(f.db, leagueId, epoch, "chat-0")).unresolved,
  ).toBe(1);
});
it("expiry and close cannot resume old draft jobs or old outboxes, and close disables owners", async () => {
  const old = await trial.wakeOwner(actor, {
    epoch,
    agentId: "chat-0",
    causalId: "old-draft",
    reason: "Synthetic older pending draft",
  });
  await open();
  await incoming();
  await f.db.query(
    "UPDATE runtime_conversation_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [s.id],
  );
  expect(await store.claim("ordinary")).toBeNull();
  expect(
    await store.claim("expired", 30000, undefined, undefined, undefined, s.id),
  ).toBeNull();
  expect(await new FootballOutbox(f.db, store).claim("football")).toBeNull();
  await chat.close(actor, {
    sessionId: s.id,
    reason: "Synthetic explicit safe close",
  });
  expect(await store.claim("after-close")).toBeNull();
  expect(
    (await f.db.query("SELECT status FROM runtime_jobs WHERE id=$1", [old.id]))
      .rows[0].status,
  ).toBe("pending");
  expect(
    (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
  ).toBe(0);
});
it("stale owner/host changes fail closed and close refuses running owner work", async () => {
  await open();
  await incoming();
  const job = await store.claim(
    "running",
    30000,
    "synthetic/0",
    ["chat-0"],
    undefined,
    s.id,
  );
  await expect(
    chat.close(actor, { sessionId: s.id, reason: "Cannot close in flight" }),
  ).rejects.toThrow("CONVERSATION_WORK_IN_FLIGHT");
  await f.db.query(
    "UPDATE runtime_agents SET model='changed' WHERE id='chat-0'",
  );
  await expect(chat.context(job!)).rejects.toThrow("CONVERSATION_OWNER_DRIFT");
});
it("operator opening is idempotent, cannot expand cap, and never enables owners or creates jobs", async () => {
  await expect(
    chat.open({ ...actor, role: "owner", teamId: "team-0" }, config),
  ).rejects.toThrow("COMMISSIONER");
  await expect(
    chat.open(actor, { ...config, maxSpendMicrosPerOwner: 101 }),
  ).rejects.toThrow("CAP_CANNOT_EXPAND");
  const one = await chat.open(actor, config);
  expect((await chat.open(actor, config)).id).toBe(one.id);
  await expect(
    chat.open(actor, { ...config, maxTurnsPerOwner: 2 }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(0);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
  ).toBe(0);
});

it("old native and franchise intents remain unclaimable; only newly authorized Buzz outbox can be claimed", async () => {
  const old = await trial.wakeOwner(actor, {
    epoch,
    agentId: "chat-0",
    causalId: "old-native",
    reason: "Synthetic original draft intent",
  });
  await f.db.query(
    "INSERT INTO runtime_football_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,command) VALUES(gen_random_uuid(),'chat-0',$1,'old','fixture',1,$2,'team-0','owner-0',$3)",
    [
      old.id,
      leagueId,
      {
        type: "mfl",
        action: { type: "draft", round: 1, pick: 1, playerId: "12345" },
      },
    ],
  );
  await f.db.query(
    "INSERT INTO runtime_franchise_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,action) VALUES(gen_random_uuid(),'chat-0',$1,'old-brand','fixture',1,$2,'team-0','owner-0',$3)",
    [old.id, leagueId, { type: "brand", causalId: "old-brand" }],
  );
  await open();
  expect(
    await new FootballOutbox(f.db, store).claim("old-football"),
  ).toBeNull();
  expect(
    await new FranchiseOutbox(f.db, store).claim("old-franchise"),
  ).toBeNull();
  await incoming();
  expect(
    (
      await run(0, [
        {
          type: "buzz_channel",
          causalId: "new-chat",
          channelId,
          content: "SYNTHETIC actual owner answer",
          mentionAgentIds: [],
        },
      ])
    ).status,
  ).toBe("completed");
  const claimed = await new FranchiseOutbox(f.db, store).claim("chat-outbox");
  expect(claimed?.action.type).toBe("buzz_channel");
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_franchise_outbox WHERE causal_id='old-brand'",
      )
    ).rows[0].status,
  ).toBe("pending");
});
it("closed admission token cannot downgrade canonical chat back to ordinary work", async () => {
  await open();
  const e = await incoming();
  const id = (
    await f.db.query("SELECT id FROM runtime_jobs WHERE agent_id='chat-0'")
  ).rows[0].id;
  await chat.close(actor, {
    sessionId: s.id,
    reason: "SYNTHETIC close before stale admission",
  });
  await expect(
    transaction(f.db, (tx) =>
      admitConversationDeliveryTx(tx, {
        leagueId,
        agentId: "chat-0",
        eventId: e.event.id,
        jobId: id,
        expectedSessionId: s.id,
      }),
    ),
  ).rejects.toThrow("CONVERSATION_ADMISSION_AUTHORITY_CHANGED");
  expect(
    (
      await f.db.query("SELECT execution_mode FROM runtime_jobs WHERE id=$1", [
        id,
      ])
    ).rows[0].execution_mode,
  ).toBe("conversation");
});
it("stopped exact trial can host conversation without reopening its draft epoch", async () => {
  await f.db.query(
    "UPDATE runtime_rehearsals SET status='stopped' WHERE league_id=$1",
    [leagueId],
  );
  await open();
  await incoming();
  expect((await run()).status).toBe("completed");
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_rehearsals WHERE league_id=$1",
        [leagueId],
      )
    ).rows[0].status,
  ).toBe("stopped");
});

it("disabled owner reads Buzz and its manifest-backed status, persists memory, sends exactly once through fake native transport and remains disabled", async () => {
  await open();
  await incoming();
  let sends = 0;
  const manifestId = (
    await f.db.query(
      "SELECT id FROM provider_manifests WHERE agent_id='chat-0'",
    )
  ).rows[0].id;
  const result = await runOne(
    store,
    new TestDriver("synthetic/0", async (job) => {
      const status = await buildOwnerRuntimeStatus(f.db, job, {
        manifestId,
        maxOutputTokens: 1000,
        maxCallsPerTurn: 6,
        requestTimeoutMs: 300000,
        turnReservationMicros: 10,
        reasoningEffort: null,
        firecrawlConfigured: false,
        serverSearchEnabled: false,
        mflWritesEnabled: false,
      });
      expect(status.scope.agentId).toBe("chat-0");
      expect(status.identity.model).toBe("synthetic/0");
      const tools = createBuzzChannelReadTools(f.db);
      const read = await tools[0]!.execute(job, {
        type: "messages",
        channelId,
      });
      expect(JSON.stringify(read)).toContain("Collaborate on our brand");
      return {
        actions: [
          {
            type: "remember",
            key: "disabled-owner-chat",
            content: "I read and answered Joey",
          },
          {
            type: "buzz_channel",
            causalId: "actual-disabled-answer",
            channelId,
            content: "SYNTHETIC owner-authored answer",
            mentionAgentIds: [],
          },
        ],
        summary: "Synthetic complete disabled path",
        costMicros: 2,
      };
    }),
    "disabled-path",
    {
      allowedAgentIds: ["chat-0"],
      conversationSessionId: s.id,
      maxCostMicros: 10,
    },
  );
  expect(result.status).toBe("completed");
  const buzz = new BuzzChannelService(f.db, async () => ({
    read: async () => members.map((pubkey) => ({ pubkey, role: "member" })),
    run: async () => {
      sends++;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ accepted: true, event_id: "f".repeat(64) }),
      };
    },
  }));
  const outbox = new FranchiseOutbox(f.db, store, undefined, undefined, buzz);
  expect(
    (
      await outbox.dispatchOne("disabled-sender", {
        allowedAgentIds: ["chat-0"],
      })
    ).status,
  ).toBe("delivered");
  expect(
    (
      await outbox.dispatchOne("disabled-sender", {
        allowedAgentIds: ["chat-0"],
      })
    ).status,
  ).toBe("idle");
  expect(sends).toBe(1);
  expect(
    (
      await f.db.query(
        "SELECT content FROM runtime_memory WHERE agent_id='chat-0' AND key='disabled-owner-chat'",
      )
    ).rows[0].content,
  ).toContain("answered");
  expect(
    (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
  ).toBe(0);
  expect(await store.claim("ordinary-must-stay-paused")).toBeNull();
});
it("conversation authorization never overrides an observed billing overrun freeze", async () => {
  await open();
  await incoming("first");
  await incoming("second pending");
  const result = await run(0, [], 11, 10);
  expect(result).toMatchObject({
    status: "failed",
    error: expect.stringContaining("COST_OVERRUN"),
  });
  expect(
    await store.claim(
      "financial-freeze",
      30000,
      "synthetic/0",
      ["chat-0"],
      undefined,
      s.id,
    ),
  ).toBeNull();
  expect((await incoming("after financial freeze")).result.delivered).toBe(9);
  expect(
    (
      await f.db.query(
        "SELECT enabled,spent_micros,reserved_micros FROM runtime_agents WHERE id='chat-0'",
      )
    ).rows[0],
  ).toEqual({ enabled: false, spent_micros: "11", reserved_micros: "0" });
});
it("a reconciled charge exceeding its reservation also preserves the financial stop while the owner was already disabled", async () => {
  await open();
  await incoming();
  const job = await store.claim(
    "unknown",
    30000,
    "synthetic/0",
    ["chat-0"],
    undefined,
    s.id,
  );
  const id = await store.reserve(job!, 10);
  await f.db.query(
    "UPDATE runtime_jobs SET status='dead',lease_until=NULL WHERE id=$1",
    [job!.id],
  );
  await f.db.query(
    "UPDATE runtime_reservations SET status='uncertain' WHERE id=$1",
    [id],
  );
  await store.reconcileReservation(
    id,
    11,
    "Synthetic exact verified provider cost for the isolated test",
  );
  expect((await incoming("after reconciled overrun")).result.delivered).toBe(9);
  expect(
    await store.claim(
      "reconciled-freeze",
      30000,
      "synthetic/0",
      ["chat-0"],
      undefined,
      s.id,
    ),
  ).toBeNull();
});

it("canonical settled expense invoice overrun blocks conversation without treating the disabled flag as permission", async () => {
  await open();
  await incoming("pending before historic invoice readback");
  const receiptId = randomUUID(),
    requestId = randomUUID();
  // Isolated stored-invoice fixture; no purchase or live invoice is issued.
  await f.db.query(
    "INSERT INTO franchise_receipts(id,league_id,agent_id,actor_id,idempotency_key,fingerprint,type,result) VALUES($1,$2,'chat-0','owner-0','synthetic-invoice','synthetic','service_request','{}')",
    [receiptId, leagueId],
  );
  await f.db.query(
    "INSERT INTO franchise_service_requests(id,league_id,team_id,agent_id,service,purpose,max_cost_micros,status,receipt_id) VALUES($1,$2,'team-0','chat-0','Synthetic invoice','No real purchase',10,'approved',$3)",
    [requestId, leagueId, receiptId],
  );
  await f.db.query(
    "INSERT INTO franchise_expenses(id,league_id,request_id,agent_id,team_id,reserved_micros,actual_micros,status,invoice_reference,evidence,begun_by) VALUES(gen_random_uuid(),$1,$2,'chat-0','team-0',10,11,'settled','SYNTHETIC/INVOICE','Synthetic immutable settled history','commissioner')",
    [leagueId, requestId],
  );
  expect(
    await store.claim(
      "expense-freeze",
      30000,
      "synthetic/0",
      ["chat-0"],
      undefined,
      s.id,
    ),
  ).toBeNull();
  expect(
    (await incoming("new message after settled expense")).result.delivered,
  ).toBe(9);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
  ).toBe(0);
});
