import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  runOne,
  TestDriver,
  RetryableUnknownCostError,
  ObservedCostError,
} from "../src/runtime/worker.js";
let fixture: Awaited<ReturnType<typeof testDb>>;
let store: RuntimeStore;
beforeEach(async () => {
  fixture = await testDb();
  store = new RuntimeStore(fixture.db);
  for (const id of ["a", "b", "c"])
    await store.createAgent({ id, model: "test/model", budgetMicros: 10000 });
});
afterEach(async () => {
  await fixture?.close();
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function event(agentId = "a", causalId = "event:1") {
  return store.ingestEvent({
    agentId,
    causalId,
    payload: { kind: "injury", playerId: "synthetic-player" },
  });
}
describe("durable runtime", () => {
  it("deduplicates source events with payload conflict detection and server clock", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => event()));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    await expect(
      store.ingestEvent({
        agentId: "a",
        causalId: "event:1",
        payload: { different: true },
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect((await store.snapshot()).jobs).toHaveLength(1);
  });
  it("serializes owner turns across competing workers but runs different owners", async () => {
    await event();
    await event("a", "event:2");
    await event("b");
    const claims = (
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.claim("w" + i)),
      )
    ).filter(Boolean);
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((c) => c!.agentId)).size).toBe(2);
  });
  it("owner sends message, recipient wakes and responds without human, then self appointment fires", async () => {
    await event();
    const driver = new TestDriver("test/model", (job) => ({
      costMicros: 4,
      summary: "Synthetic collaboration fixture; not model reasoning.",
      actions:
        job.kind === "event"
          ? [
              {
                type: "remember",
                key: "strategy",
                content: "SYNTHETIC: review roster after response",
              },
              {
                type: "message",
                recipientId: "b",
                causalId: "ask",
                body: "SYNTHETIC trade inquiry",
              },
            ]
          : job.agentId === "b"
            ? [
                {
                  type: "message",
                  recipientId: "a",
                  causalId: "reply",
                  body: "SYNTHETIC trade response",
                  conversationId: String(job.payload.conversationId),
                  replyTo: String(job.payload.messageId),
                },
              ]
            : job.kind === "message"
              ? [
                  {
                    type: "schedule",
                    causalId: "followup",
                    dueAt: new Date(Date.now() + 60).toISOString(),
                    payload: { review: true },
                  },
                ]
              : [],
    }));
    for (let i = 0; i < 3; i++)
      expect(
        (await runOne(store, driver, "worker", { maxCostMicros: 10 })).status,
      ).toBe("completed");
    await pause(90);
    const followup = await store.claim("new-process");
    expect(followup?.kind).toBe("appointment");
    expect(followup?.memory[0].content).toContain("SYNTHETIC");
    expect(followup?.recentMessages).toHaveLength(2);
    const snapshot = await store.snapshot();
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].responded_at).not.toBeNull();
    expect(snapshot.messages.every((m) => m.delivered_at)).toBe(true);
    expect((await store.agentSnapshot("c")).messages).toEqual([]);
    expect((await store.agentSnapshot("c")).memory).toEqual([]);
  });
  it("reclaims expired leases, fences old writes, and keeps unknown billing reserved", async () => {
    await event();
    const old = (await store.claim("crashed", 25))!;
    const reservation = await store.reserve(old, 7000);
    await pause(45);
    const fresh = (await store.claim("replacement", 5000))!;
    expect(fresh.fence).toBe(old.fence + 1);
    await expect(
      store.complete(old, {
        actions: [],
        summary: "stale",
        costMicros: 1,
        reservationId: reservation,
        driver: "test",
        synthetic: true,
      }),
    ).rejects.toThrow("STALE_CLAIM");
    await expect(store.reserve(fresh, 4000)).rejects.toThrow(
      "BUDGET_EXHAUSTED",
    );
    const snap = await store.snapshot();
    expect(snap.reservations[0].status).toBe("uncertain");
    expect(Number(snap.agents[0].reserved_micros)).toBe(7000);
    await store.reconcileReservation(
      reservation,
      123,
      "Synthetic provider receipt verifies final cost",
    );
    expect(Number((await store.agentSnapshot("a")).agent.spent_micros)).toBe(
      123,
    );
    await store.reserve(fresh, 4000);
  });
  it("settles money once and rolls back outgoing action if a later action violates permissions", async () => {
    await event();
    const claim = (await store.claim("w"))!;
    const reservationId = await store.reserve(claim, 100);
    const result = {
      actions: [
        {
          type: "message" as const,
          recipientId: "b",
          causalId: "send",
          body: "SYNTHETIC",
        },
        {
          type: "message" as const,
          recipientId: "absent",
          causalId: "bad",
          body: "SYNTHETIC",
        },
      ],
      summary: "test",
      costMicros: 20,
      reservationId,
      driver: "test",
      synthetic: true,
    };
    await expect(store.complete(claim, result)).rejects.toThrow(
      "RECIPIENT_UNAVAILABLE",
    );
    expect((await store.snapshot()).messages).toHaveLength(0);
    await store.complete(claim, {
      ...result,
      actions: result.actions.slice(0, 1),
    });
    await expect(
      store.complete(claim, { ...result, actions: [] }),
    ).rejects.toThrow("STALE_CLAIM");
    const a = (await store.agentSnapshot("a")).agent;
    expect(Number(a.spent_micros)).toBe(20);
    expect(Number(a.reserved_micros)).toBe(0);
  });
  it("deduplicates outgoing messages and prevents third party conversations", async () => {
    const msg = await store.sendMessage("a", {
      recipientId: "b",
      causalId: "ask",
      body: "test",
    });
    expect(
      (
        await store.sendMessage("a", {
          recipientId: "b",
          causalId: "ask",
          body: "test",
        })
      ).id,
    ).toBe(msg.id);
    await expect(
      store.sendMessage("c", {
        recipientId: "b",
        causalId: "snoop",
        body: "test",
        conversationId: msg.conversation_id,
      }),
    ).rejects.toThrow("CONVERSATION_FORBIDDEN");
    await expect(
      store.sendMessage("a", {
        recipientId: "b",
        causalId: "ask",
        body: "changed",
      }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("prevents infinite conversation reply loops with a hard cap", async () => {
    const first = await store.sendMessage("a", {
      recipientId: "b",
      causalId: "m0",
      body: "test",
    });
    for (let i = 1; i < 24; i++)
      await store.sendMessage(i % 2 ? "b" : "a", {
        recipientId: i % 2 ? "a" : "b",
        causalId: "m" + i,
        body: "test",
        conversationId: first.conversation_id,
      });
    await expect(
      store.sendMessage("a", {
        recipientId: "b",
        causalId: "m24",
        body: "test",
        conversationId: first.conversation_id,
      }),
    ).rejects.toThrow("CONVERSATION_LIMIT");
  });
  it("retries known-zero failures and deadletters after three attempts", async () => {
    await event();
    for (let i = 0; i < 3; i++) {
      const job = (await store.claim("w"))!;
      const reservationId = await store.reserve(job, 100);
      await store.fail(job, "unavailable", {
        retryable: true,
        chargeKnownZero: true,
        reservationId,
        retryDelayMs: 0,
      });
    }
    expect(await store.claim("w")).toBeNull();
    const snap = await store.snapshot();
    expect(snap.jobs[0].status).toBe("dead");
    expect(Number(snap.agents[0].reserved_micros)).toBe(0);
  });
  it("rejects driver model mismatch without dispatching the wrong model", async () => {
    await event();
    let invoked = false;
    const driver = new TestDriver("other/model", () => {
      invoked = true;
      return { actions: [], summary: "no", costMicros: 0 };
    });
    expect((await runOne(store, driver, "w")).status).toBe("idle");
    expect(invoked).toBe(false);
    await expect(
      store.createAgent({ id: "a", model: "replacement", budgetMicros: 10000 }),
    ).rejects.toThrow("AGENT_CONFIG_CONFLICT");
  });
  it("worker records known provider overrun and freezes owner without executing actions", async () => {
    await event();
    const driver = new TestDriver("test/model", () => ({
      actions: [],
      costMicros: 10001,
      summary: "overspend",
    }));
    expect(
      (await runOne(store, driver, "w", { maxCostMicros: 500 })).status,
    ).toBe("failed");
    const snap = await store.snapshot();
    expect(snap.reservations[0].status).toBe("settled");
    expect(Number(snap.agents[0].reserved_micros)).toBe(0);
    expect(Number(snap.agents[0].spent_micros)).toBe(10001);
    expect(snap.agents[0].enabled).toBe(false);
    expect(snap.jobs[0].status).toBe("dead");
    expect(snap.receipts.some((r) => r.type === "budget.overrun")).toBe(true);
  });
  it("simultaneous cross-owner DMs do not deadlock", async () => {
    await Promise.all([
      store.sendMessage("a", {
        recipientId: "b",
        causalId: "ab",
        body: "test",
      }),
      store.sendMessage("b", {
        recipientId: "a",
        causalId: "ba",
        body: "test",
      }),
    ]);
    expect((await store.snapshot()).messages).toHaveLength(2);
  });
  it("cancelled appointments never wake and cancellation cannot touch another owner", async () => {
    await store.scheduleSelf("a", {
      causalId: "review",
      dueAt: new Date(Date.now() + 20),
      payload: { synthetic: true },
    });
    await expect(store.cancelSelf("b", "review")).rejects.toThrow(
      "APPOINTMENT_NOT_FOUND",
    );
    expect((await store.cancelSelf("a", "review")).status).toBe("cancelled");
    expect((await store.cancelSelf("a", "review")).status).toBe("cancelled");
    await pause(30);
    expect(await store.claim("w")).toBeNull();
  });
  it("expired last attempt deadletters and cannot commit a late reply", async () => {
    await event();
    let last;
    for (let i = 0; i < 3; i++) {
      last = (await store.claim("lost-" + i, 10))!;
      await pause(15);
    }
    expect(await store.claim("replacement")).toBeNull();
    expect((await store.snapshot()).jobs[0].status).toBe("dead");
    await expect(store.heartbeat(last!)).rejects.toThrow("STALE_CLAIM");
  });
  it("records monotonic execution time separately from synthetic narrative", async () => {
    await event();
    const driver = new TestDriver("test/model", async () => {
      await pause(10);
      return {
        actions: [],
        costMicros: 0,
        summary: "SYNTHETIC fixture content",
      };
    });
    await runOne(store, driver, "w");
    const execution = (await store.snapshot()).receipts.find(
      (r) => r.type === "driver.execution",
    );
    expect(execution.details.durationMs).toBeGreaterThanOrEqual(5);
    expect(execution.details.synthetic).toBe(true);
    expect(execution.details.measurement).toBe("monotonic_wall_clock");
  });
  it("late provider usage is observed without allowing stale actions", async () => {
    await event();
    const old = (await store.claim("old", 10))!;
    const reservation = await store.reserve(old, 100);
    await pause(20);
    await store.claim("new");
    await store.observeCost(old, reservation, 12);
    const r = (await store.snapshot()).reservations[0];
    expect(Number(r.observed_micros)).toBe(12);
    expect(r.status).toBe("uncertain");
    await expect(
      store.complete(old, {
        actions: [],
        summary: "late",
        costMicros: 12,
        reservationId: reservation,
        driver: "test",
        synthetic: true,
      }),
    ).rejects.toThrow("STALE_CLAIM");
  });

  it("keeps uncertain reservation while retrying explicitly transient provider failure", async () => {
    await event();
    const driver = new TestDriver("test/model", () => {
      throw new RetryableUnknownCostError("Synthetic connection timeout");
    });
    expect(
      (await runOne(store, driver, "w", { maxCostMicros: 100 })).status,
    ).toBe("failed");
    const snap = await store.snapshot();
    expect(snap.jobs[0].status).toBe("pending");
    expect(snap.reservations[0].status).toBe("uncertain");
    expect(Number(snap.agents[0].reserved_micros)).toBe(100);
  });

  it("enforces league peer boundaries for direct calls and model-returned actions", async () => {
    await fixture.db.query(
      "INSERT INTO leagues(id,name,rules) VALUES ('one','One','{}'),('two','Two','{}')",
    );
    await fixture.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES ('one','a','A','a','ai',0,0,0),('one','b','B','b','ai',1,1,0),('two','c','C','c','ai',0,0,0)",
    );
    await fixture.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES ('a','one','a'),('b','one','b'),('c','two','c')",
    );
    await expect(
      store.sendMessage("a", {
        recipientId: "c",
        causalId: "cross",
        body: "no",
      }),
    ).rejects.toThrow("PEER_SCOPE_FORBIDDEN");
    await store.createAgent({
      id: "unbound",
      model: "test/model",
      budgetMicros: 0,
    });
    await expect(
      store.sendMessage("a", {
        recipientId: "unbound",
        causalId: "escape",
        body: "no",
      }),
    ).rejects.toThrow("PEER_SCOPE_FORBIDDEN");
    await event();
    const job = (await store.claim("w"))!;
    const reservationId = await store.reserve(job, 0);
    await expect(
      store.complete(job, {
        actions: [
          {
            type: "message",
            recipientId: "c",
            causalId: "model-cross",
            body: "no",
          },
        ],
        costMicros: 0,
        summary: "synthetic",
        reservationId,
        driver: "test",
        synthetic: true,
      }),
    ).rejects.toThrow("PEER_SCOPE_FORBIDDEN");
    await store.sendMessage("a", {
      recipientId: "b",
      causalId: "allowed",
      body: "yes",
    });
    expect((await store.snapshot()).messages).toHaveLength(1);
  });
  it("bounded recipient inbox prevents new-conversation bypass under concurrent sends", async () => {
    for (let i = 0; i < 199; i++)
      await store.sendMessage("a", {
        recipientId: "b",
        causalId: "flood-" + i,
        body: "synthetic backlog fixture",
      });
    const results = await Promise.allSettled([
      store.sendMessage("a", {
        recipientId: "b",
        causalId: "last-a",
        body: "synthetic",
      }),
      store.sendMessage("c", {
        recipientId: "b",
        causalId: "last-c",
        body: "synthetic",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.agentSnapshot("b")).jobs).toHaveLength(200);
  });
  it("accounts provider-reported charge when invalid model content throws a typed error", async () => {
    await event();
    const driver = new TestDriver("test/model", () => {
      throw new ObservedCostError(
        "Synthetic invalid output after charged request",
        17,
      );
    });
    expect(
      (await runOne(store, driver, "w", { maxCostMicros: 100 })).status,
    ).toBe("failed");
    const snap = await store.snapshot();
    expect(snap.reservations[0].status).toBe("settled");
    expect(Number(snap.agents[0].spent_micros)).toBe(17);
    expect(Number(snap.agents[0].reserved_micros)).toBe(0);
  });

  it("a human receives private messages and replies manually without any model impersonation", async () => {
    await store.createAgent({
      id: "human",
      kind: "human",
      model: "test/model",
      budgetMicros: 0,
    });
    const message = await store.sendMessage("a", {
      recipientId: "human",
      causalId: "ask-human",
      body: "SYNTHETIC trade proposal for human",
    });
    expect((await store.agentSnapshot("human")).jobs[0].status).toBe(
      "awaiting_human",
    );
    expect(await store.claim("worker")).toBeNull();
    const reply = await store.sendMessage("human", {
      recipientId: "a",
      causalId: "human-answer",
      body: "SYNTHETIC manual human reply",
      conversationId: message.conversation_id,
      replyTo: message.id,
    });
    expect(reply.sender_id).toBe("human");
    const job = (await store.claim("worker"))!;
    expect(job.agentId).toBe("a");
    const human = await store.agentSnapshot("human");
    expect(human.jobs[0].status).toBe("completed");
    expect(human.receipts.some((r) => r.type === "human.replied")).toBe(true);
    expect(human.receipts.some((r) => r.type === "job.claimed")).toBe(false);
    await expect(
      store.createAgent({
        id: "human",
        kind: "ai",
        model: "test/model",
        budgetMicros: 0,
      }),
    ).rejects.toThrow("AGENT_CONFIG_CONFLICT");
  });

  it("worker franchise scope cannot claim another same-model owner", async () => {
    await event("a");
    await event("b");
    const driver = new TestDriver("test/model");
    const allowed = await runOne(store, driver, "scoped", {
      allowedAgentIds: ["b"],
    });
    expect(allowed.status).toBe("completed");
    expect((await store.agentSnapshot("a")).jobs[0].status).toBe("pending");
    expect(
      (await runOne(store, driver, "scoped", { allowedAgentIds: ["b"] }))
        .status,
    ).toBe("idle");
    expect(
      (await runOne(store, driver, "empty-scope", { allowedAgentIds: [] }))
        .status,
    ).toBe("idle");
  });
});
