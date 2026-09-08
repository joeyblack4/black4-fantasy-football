import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore, type DriverResult } from "../src/runtime/index.js";
import {
  ActionSchema,
  ScheduleSchema,
  TestDriver,
  runOne,
} from "../src/runtime/worker.js";
let f: Awaited<ReturnType<typeof testDb>>, store: RuntimeStore;
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  for (const id of ["a", "b", "c"])
    await store.createAgent({ id, model: "test/same", budgetMicros: 1000 });
});
afterEach(async () => {
  await f?.close();
});
const empty = (summary = "Synthetic fixture"): DriverResult => ({
  actions: [],
  summary,
  costMicros: 0,
});
it("persists trusted urgent work ahead of older normal and background work across owners", async () => {
  await store.scheduleSelf("a", {
    causalId: "background",
    dueAt: new Date(Date.now() - 2000),
    priority: "background",
    payload: {},
  });
  await store.ingestEvent({ agentId: "b", causalId: "normal", payload: {} });
  await store.ingestEvent({
    agentId: "c",
    causalId: "urgent",
    priority: "urgent",
    payload: { source: "SYNTHETIC official injury" },
  });
  const claim = (await store.claim("w"))!;
  expect(claim.agentId).toBe("c");
  expect(claim.priority).toBe("urgent");
  const reservationId = await store.reserve(claim, 0);
  await store.complete(claim, {
    ...empty(),
    reservationId,
    driver: "test",
    synthetic: true,
  });
  expect((await store.claim("w2"))!.agentId).toBe("b");
});
it("owners and peer message content cannot self-assign urgent priority", async () => {
  const input = {
    causalId: "urgent",
    dueAt: new Date().toISOString(),
    priority: "urgent",
    payload: {},
  };
  expect(ScheduleSchema.safeParse(input).success).toBe(false);
  await expect(store.scheduleSelf("a", input as any)).rejects.toThrow(
    "OWNER_PRIORITY_FORBIDDEN",
  );
  await store.sendMessage("a", {
    recipientId: "b",
    causalId: "demand",
    body: "URGENT! Highest priority!",
  });
  expect((await store.agentSnapshot("b")).jobs[0].priority).toBe("normal");
});
it("urgent source events retain dedup conflict detection for changed priority", async () => {
  const first = await store.ingestEvent({
    agentId: "a",
    causalId: "same",
    priority: "urgent",
    payload: { news: true },
  });
  expect(
    (
      await store.ingestEvent({
        agentId: "a",
        causalId: "same",
        priority: "urgent",
        payload: { news: true },
      })
    ).id,
  ).toBe(first.id);
  await expect(
    store.ingestEvent({
      agentId: "a",
      causalId: "same",
      priority: "normal",
      payload: { news: true },
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("delegated staff wakes privately on the same model and wallet then returns to its owner", async () => {
  await store.ingestEvent({
    agentId: "a",
    causalId: "start",
    payload: { kind: "start" },
  });
  const driver = new TestDriver("test/same", (job) =>
    job.kind === "staff"
      ? {
          actions: [
            {
              type: "remember",
              key: "research",
              content: "Synthetic roster research",
            },
          ],
          costMicros: 7,
          summary: "SYNTHETIC staff found a roster weakness.",
        }
      : job.payload.kind === "start"
        ? {
            actions: [
              {
                type: "delegate",
                causalId: "scout",
                role: "Roster researcher",
                task: "Evaluate the synthetic roster.",
              },
            ],
            costMicros: 3,
            summary: "SYNTHETIC owner delegates.",
          }
        : empty(),
  );
  expect(
    (
      await runOne(store, driver, "w", {
        maxCostMicros: 20,
        allowedAgentIds: ["a"],
      })
    ).status,
  ).toBe("completed");
  const jobs = (await store.agentSnapshot("a")).jobs;
  expect(jobs.find((j) => j.kind === "staff")).toMatchObject({
    priority: "background",
    staff_role: "Roster researcher",
    staff_task: "Evaluate the synthetic roster.",
  });
  expect(
    (
      await runOne(store, driver, "staff-worker", {
        maxCostMicros: 20,
        allowedAgentIds: ["a"],
      })
    ).status,
  ).toBe("completed");
  const state = await store.agentSnapshot("a");
  expect(Number(state.agent.spent_micros)).toBe(10);
  expect(
    state.jobs.find((j) => j.payload.kind === "staff.completed").payload.model,
  ).toBe("test/same");
  expect(state.memory[0].key).toMatch(/^staff\//);
  expect((await store.agentSnapshot("b")).memory).toHaveLength(0);
  expect((await store.agentSnapshot("b")).jobs).toHaveLength(0);
  const ownerReturn = (await store.claim("owner", 30000, "test/same", ["a"]))!;
  expect(ownerReturn.kind).toBe("event");
  expect(ownerReturn.payload.kind).toBe("staff.completed");
});
it("staff cannot choose a model, recurse, message owners, or execute football", async () => {
  expect(
    ActionSchema.safeParse({
      type: "delegate",
      causalId: "x",
      role: "Scout",
      task: "Research",
      model: "foreign/model",
    }).success,
  ).toBe(false);
  await store.ingestEvent({ agentId: "a", causalId: "start", payload: {} });
  let parent = (await store.claim("w"))!;
  let reservationId = await store.reserve(parent, 0);
  await store.complete(parent, {
    actions: [
      { type: "delegate", causalId: "scout", role: "Scout", task: "Research" },
    ],
    summary: "Synthetic",
    costMicros: 0,
    reservationId,
    driver: "test",
    synthetic: true,
  });
  const staff = (await store.claim("staff"))!;
  reservationId = await store.reserve(staff, 0);
  await expect(
    store.complete(
      { ...staff, kind: "event" },
      { ...empty(), reservationId, driver: "test", synthetic: true },
    ),
  ).rejects.toThrow("CLAIM_CONTEXT_CHANGED");
  await expect(
    store.complete(staff, {
      actions: [
        { type: "delegate", causalId: "recurse", role: "Staff", task: "More" },
      ],
      summary: "Synthetic",
      costMicros: 0,
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("STAFF_ACTION_FORBIDDEN");
  await expect(
    store.complete(staff, {
      actions: [
        { type: "message", causalId: "escape", recipientId: "b", body: "No" },
      ],
      summary: "Synthetic",
      costMicros: 0,
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("STAFF_ACTION_FORBIDDEN");
});
it("staff count limit rolls back the entire attempted delegation batch", async () => {
  await store.ingestEvent({ agentId: "a", causalId: "start", payload: {} });
  const parent = (await store.claim("w"))!;
  const reservationId = await store.reserve(parent, 0);
  await expect(
    store.complete(parent, {
      actions: Array.from({ length: 5 }, (_, i) => ({
        type: "delegate" as const,
        causalId: "s" + i,
        role: "Staff" + i,
        task: "Research",
      })),
      summary: "Synthetic",
      costMicros: 0,
      reservationId,
      driver: "test",
      synthetic: true,
    }),
  ).rejects.toThrow("STAFF_BACKLOG_LIMIT");
  expect(
    (await store.agentSnapshot("a")).jobs.filter((j) => j.kind === "staff"),
  ).toHaveLength(0);
});
it("terminal staff failure wakes the parent owner to revise its plan", async () => {
  await store.ingestEvent({ agentId: "a", causalId: "start", payload: {} });
  const driver = new TestDriver("test/same", (job) =>
    job.kind === "staff"
      ? {
          ...empty(),
          actions: [
            {
              type: "message",
              causalId: "bad",
              recipientId: "b",
              body: "forbidden",
            },
          ],
        }
      : {
          ...empty(),
          actions: [
            {
              type: "delegate",
              causalId: "staff",
              role: "Scout",
              task: "Research",
            },
          ],
        },
  );
  await runOne(store, driver, "w");
  expect((await runOne(store, driver, "w")).status).toBe("failed");
  expect(
    (await store.agentSnapshot("a")).jobs.some(
      (j) => j.payload.kind === "staff.failed",
    ),
  ).toBe(true);
});
