import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore, type AgentDriver } from "../src/runtime/index.js";
import { HarnessAssignmentService } from "../src/runtime/harness-assignment.js";
import { runOne, TestDriver } from "../src/runtime/worker.js";
import { NativeHarnessDriver } from "../src/harnesses/driver.js";
import type { RuntimeConfig } from "../src/harnesses/catalog.js";

const leagueId = "harness-fixture";
const actor = { id: "commissioner", role: "commissioner" as const, leagueId };
const model = "openai/fixture";
const request = {
  leagueId,
  agentId: "owner-a",
  model,
  harnessId: "codex" as const,
  configDigest: "a".repeat(64),
  idempotencyKey: "stage-owner-a",
};
let fixture: Awaited<ReturnType<typeof testDb>>;
let store: RuntimeStore;
let service: HarnessAssignmentService;
beforeEach(async () => {
  fixture = await testDb();
  store = new RuntimeStore(fixture.db);
  service = new HarnessAssignmentService(fixture.db);
  for (const league of [leagueId, "other-league"])
    await fixture.db.query(
      "INSERT INTO leagues(id,name,rules) VALUES($1,$1,'{}')",
      [league],
    );
  for (const [i, id] of ["owner-a", "owner-b", "foreign-owner"].entries()) {
    const league = id === "foreign-owner" ? "other-league" : leagueId;
    await store.createAgent({ id, model, budgetMicros: 1000 });
    await fixture.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$2,'ai',$3,$3,100)",
      [league, id, i],
    );
    await fixture.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$1)",
      [id, league],
    );
    await store.scheduleSelf(id, {
      causalId: "ready",
      dueAt: "2020-01-01T00:00:00Z",
      payload: {},
    });
  }
});
afterEach(async () => {
  await fixture.close();
});

it("stages one immutable assignment and receipt under concurrent replay without changing the model", async () => {
  const [a, b] = await Promise.all([
    service.stage(actor, request),
    service.stage(actor, request),
  ]);
  expect(a.receipt_id).toBe(b.receipt_id);
  expect(a.status).toBe("staged");
  expect(a.activated_at).toBeNull();
  expect(
    (
      await fixture.db.query("SELECT model FROM runtime_agents WHERE id=$1", [
        request.agentId,
      ])
    ).rows[0].model,
  ).toBe(model);
  expect(
    (
      await fixture.db.query(
        "SELECT * FROM runtime_receipts WHERE type='harness.assignment_staged'",
      )
    ).rowCount,
  ).toBe(1);
  await expect(
    service.stage(actor, { ...request, configDigest: "b".repeat(64) }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    service.stage(actor, { ...request, agentId: "owner-b" }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});

it("requires commissioner authority, actual franchise league binding and exact assigned model", async () => {
  await expect(
    service.stage({ ...actor, role: "owner", teamId: "owner-a" }, request),
  ).rejects.toThrow("Commissioner access");
  await expect(
    service.stage({ ...actor, leagueId: "other-league" }, request),
  ).rejects.toThrow("Credential does not belong");
  await expect(
    service.stage(actor, { ...request, agentId: "foreign-owner" }),
  ).rejects.toThrow("HARNESS_BINDING_MISMATCH");
  await expect(
    service.stage(actor, { ...request, model: "anthropic/fixture" }),
  ).rejects.toThrow("MODEL_PIN_VIOLATION");
  await expect(
    service.stage(actor, { ...request, harnessId: "unknown" as "codex" }),
  ).rejects.toThrow();
  await expect(
    service.stage(actor, { ...request, status: "active" } as typeof request),
  ).rejects.toThrow();
  expect(
    (await fixture.db.query("SELECT * FROM runtime_harness_assignments"))
      .rowCount,
  ).toBe(0);
});

it("staging fences legacy and native drivers before claiming, spending, or changing job attempts", async () => {
  await service.stage(actor, request);
  const run = vi.fn(async () => ({
    actions: [],
    costMicros: 0,
    summary: "fixture",
  }));
  for (const driver of [
    { name: "legacy", model, synthetic: true, run },
    {
      name: "native",
      model,
      synthetic: true,
      harnessId: "codex",
      configDigest: request.configDigest,
      run,
    },
  ])
    expect(
      await runOne(store, driver, "worker", { allowedAgentIds: ["owner-a"] }),
    ).toEqual({ status: "idle" });
  expect(run).not.toHaveBeenCalled();
  const snapshot = await store.agentSnapshot("owner-a");
  expect(snapshot.jobs[0]).toMatchObject({
    status: "pending",
    attempts: 0,
    fence: 0,
    worker_id: null,
  });
  expect(snapshot.reservations).toHaveLength(0);
  expect(
    snapshot.receipts.filter((r) => r.type === "job.claimed"),
  ).toHaveLength(0);
  // Another franchise using the same canonical model retains legacy behavior.
  expect(
    (
      await runOne(store, new TestDriver(model), "legacy", {
        allowedAgentIds: ["owner-b"],
        heartbeat: false,
      })
    ).status,
  ).toBe("completed");
});

it("unknown, incomplete, or unassigned native selectors never fall back to legacy", async () => {
  const driver: AgentDriver = {
    name: "native",
    model,
    synthetic: true,
    harnessId: "unknown",
    configDigest: request.configDigest,
    run: vi.fn(),
  };
  await expect(
    runOne(store, driver, "worker", { allowedAgentIds: ["owner-a"] }),
  ).rejects.toThrow();
  await expect(
    runOne(
      store,
      { ...driver, harnessId: "codex", configDigest: undefined },
      "worker",
    ),
  ).rejects.toThrow();
  expect(
    await runOne(store, { ...driver, harnessId: "codex" }, "worker", {
      allowedAgentIds: ["owner-a"],
    }),
  ).toEqual({ status: "idle" });
  expect((await store.agentSnapshot("owner-a")).jobs[0].attempts).toBe(0);
});

it("requires exact harness, config digest, model and current league binding for future active records", async () => {
  await service.stage(actor, request);
  // Future-state fixture only: production code exposes no activation operation.
  await fixture.db.query(
    "UPDATE runtime_harness_assignments SET status='active',activated_at=clock_timestamp() WHERE agent_id=$1",
    [request.agentId],
  );
  for (const selector of [
    undefined,
    { harnessId: "claude-code" as const, configDigest: request.configDigest },
    { harnessId: "codex" as const, configDigest: "b".repeat(64) },
  ])
    expect(
      await store.claim(
        "worker",
        30000,
        model,
        ["owner-a"],
        undefined,
        undefined,
        selector,
      ),
    ).toBeNull();
  expect(
    await store.claim(
      "worker",
      30000,
      "wrong/model",
      ["owner-a"],
      undefined,
      undefined,
      { harnessId: request.harnessId, configDigest: request.configDigest },
    ),
  ).toBeNull();
  await fixture.db.query(
    "UPDATE runtime_harness_assignments SET league_id='other-league' WHERE agent_id=$1",
    [request.agentId],
  );
  expect(
    await store.claim(
      "worker",
      30000,
      model,
      ["owner-a"],
      undefined,
      undefined,
      {
        harnessId: request.harnessId,
        configDigest: request.configDigest,
      },
    ),
  ).toBeNull();
  await fixture.db.query(
    "UPDATE runtime_harness_assignments SET league_id=$2 WHERE agent_id=$1",
    [request.agentId, leagueId],
  );
  const claim = await store.claim(
    "worker",
    30000,
    model,
    ["owner-a"],
    undefined,
    undefined,
    { harnessId: request.harnessId, configDigest: request.configDigest },
  );
  expect(claim?.agentId).toBe("owner-a");
});

it("serializes staging against a competing legacy claim", async () => {
  const [staged, claimed] = await Promise.allSettled([
    service.stage(actor, request),
    store.claim("legacy-race", 30000, model, ["owner-a"]),
  ]);
  expect(claimed.status).toBe("fulfilled");
  if (staged.status === "fulfilled") {
    expect(claimed.status === "fulfilled" && claimed.value).toBeNull();
    expect((await store.agentSnapshot("owner-a")).jobs[0].attempts).toBe(0);
  } else {
    expect(staged.reason.message).toBe("HARNESS_RUNTIME_BUSY");
    expect(claimed.status === "fulfilled" && claimed.value?.agentId).toBe(
      "owner-a",
    );
  }
});

it("refuses staging while a claimed turn could still spend", async () => {
  const claim = await store.claim("legacy", 30000, model, ["owner-a"]);
  expect(claim).not.toBeNull();
  await expect(service.stage(actor, request)).rejects.toThrow(
    "HARNESS_RUNTIME_BUSY",
  );
  expect(
    (await fixture.db.query("SELECT * FROM runtime_harness_assignments"))
      .rowCount,
  ).toBe(0);
});

it("refuses staging after a failed turn leaves uncertain provider spend", async () => {
  const claim = (await store.claim("legacy", 30000, model, ["owner-a"]))!;
  const reservationId = await store.reserve(claim, 100);
  await store.fail(claim, "fixture timeout", {
    retryable: false,
    chargeKnownZero: false,
    reservationId,
  });
  await expect(service.stage(actor, request)).rejects.toThrow(
    "HARNESS_BILLING_UNRESOLVED",
  );
});

it("integrates the native driver with Black4 accounting and memory while paid execution stays held", async () => {
  const config: RuntimeConfig = {
    version: 1,
    leagueId,
    agentId: request.agentId,
    teamId: request.agentId,
    developer: "OpenAI",
    assignedModel: model,
    canonicalModel: model,
    harnessId: "codex",
    harnessVersion: "synthetic-fixture",
    providerModel: null,
    credentialRef: "B4_LEAGUE_SYNTHETIC",
    status: "staged",
    productionActions: false,
    exceptionReason: null,
  };
  const execute = vi.fn(async () => ({
    decision: {
      actions: [
        {
          type: "remember",
          key: "fixture",
          content: "Synthetic harness memory",
        },
      ],
      summary: "Synthetic integration fixture",
    },
    charge: {
      state: "verified" as const,
      costMicros: 7,
      evidenceId: "synthetic-charge-fixture",
    },
  }));
  const driver = new NativeHarnessDriver(config, { synthetic: true, execute });
  await service.stage(actor, { ...request, configDigest: driver.configDigest });
  expect(
    await runOne(store, driver, "staged", {
      allowedAgentIds: [request.agentId],
    }),
  ).toEqual({ status: "idle" });
  expect(execute).not.toHaveBeenCalled();
  // Isolated schema only: exercise the future integration without adding an activation API.
  await fixture.db.query(
    "UPDATE runtime_harness_assignments SET status='active',activated_at=clock_timestamp() WHERE agent_id=$1",
    [request.agentId],
  );
  expect(
    (
      await runOne(store, driver, "native-fixture", {
        allowedAgentIds: [request.agentId],
        maxCostMicros: 10,
        heartbeat: false,
      })
    ).status,
  ).toBe("completed");
  expect(execute).toHaveBeenCalledOnce();
  const snapshot = await store.agentSnapshot(request.agentId);
  expect(snapshot.memory[0].content).toBe("Synthetic harness memory");
  expect(Number(snapshot.agent.spent_micros)).toBe(7);
  expect(
    snapshot.receipts.find((r) => r.type === "budget.cost_observed")?.details
      .generationId,
  ).toBe("synthetic-charge-fixture");
  expect(
    snapshot.receipts.find((r) => r.type === "job.completed")?.details.driver,
  ).toBe("native-harness:codex");
  await store.scheduleSelf(request.agentId, {
    causalId: "paid-still-held",
    dueAt: "2020-01-01T00:00:00Z",
    payload: {},
  });
  const paidExecute = vi.fn();
  const paidDriver = new NativeHarnessDriver(config, {
    synthetic: false,
    execute: paidExecute,
  });
  const paid = await runOne(store, paidDriver, "paid-held", {
    allowedAgentIds: [request.agentId],
    maxCostMicros: 10,
    heartbeat: false,
  });
  expect(paid).toMatchObject({
    status: "failed",
    error: "NATIVE_HARNESS_LIVE_ADMISSION_NOT_IMPLEMENTED",
  });
  expect(paidExecute).not.toHaveBeenCalled();
  expect(
    Number((await store.agentSnapshot(request.agentId)).agent.spent_micros),
  ).toBe(7);
});

it("resumes a synthetic native appointment with durable memory after replacing the driver instance", async () => {
  const config: RuntimeConfig = {
    version: 1,
    leagueId,
    agentId: request.agentId,
    teamId: request.agentId,
    developer: "OpenAI",
    assignedModel: model,
    canonicalModel: model,
    harnessId: "codex",
    harnessVersion: "synthetic-fixture",
    providerModel: null,
    credentialRef: "B4_LEAGUE_SYNTHETIC_RESTART",
    status: "staged",
    productionActions: false,
    exceptionReason: null,
  };
  const initial = new NativeHarnessDriver(config, {
    synthetic: true,
    execute: async () => ({
      decision: {
        summary: "Synthetic preparation before restart",
        actions: [
          {
            type: "remember",
            key: "restart-proof",
            content: "Synthetic durable memory",
          },
          {
            type: "schedule",
            causalId: "synthetic-after-restart",
            dueAt: "2020-01-01T00:00:00Z",
            payload: { synthetic: true, purpose: "restart" },
          },
        ],
      },
      charge: {
        state: "verified",
        costMicros: 0,
        evidenceId: "synthetic-before-restart",
      },
    }),
  });
  await service.stage(actor, {
    ...request,
    configDigest: initial.configDigest,
  });
  // Future-state fixture in the isolated schema; this is not a live activation path.
  await fixture.db.query(
    "UPDATE runtime_harness_assignments SET status='active',activated_at=clock_timestamp() WHERE agent_id=$1",
    [request.agentId],
  );
  expect(
    (
      await runOne(store, initial, "synthetic-before-restart", {
        allowedAgentIds: [request.agentId],
        heartbeat: false,
      })
    ).status,
  ).toBe("completed");
  const execute = vi.fn(async () => ({
    decision: {
      actions: [],
      summary: "Synthetic restart resumed durable appointment",
    },
    charge: {
      state: "verified" as const,
      costMicros: 0,
      evidenceId: "synthetic-after-restart",
    },
  }));
  const restarted = new NativeHarnessDriver(config, {
    synthetic: true,
    execute,
  });
  expect(restarted).not.toBe(initial);
  expect(restarted.configDigest).toBe(initial.configDigest);
  expect(
    (
      await runOne(
        new RuntimeStore(fixture.db),
        restarted,
        "synthetic-after-restart",
        { allowedAgentIds: [request.agentId], heartbeat: false },
      )
    ).status,
  ).toBe("completed");
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        franchise: {
          leagueId,
          agentId: request.agentId,
          teamId: request.agentId,
        },
        event: expect.objectContaining({
          causalId: "synthetic-after-restart",
          kind: "appointment",
          payload: { synthetic: true, purpose: "restart" },
        }),
        state: expect.objectContaining({
          memory: [
            {
              key: "restart-proof",
              content: "Synthetic durable memory",
              version: 1,
            },
          ],
        }),
      }),
    }),
  );
  const snapshot = await store.agentSnapshot(request.agentId);
  expect(snapshot.jobs.filter((j) => j.status === "completed")).toHaveLength(2);
  expect(
    snapshot.receipts
      .filter((r) => r.type === "driver.execution")
      .every((r) => r.details.synthetic === true),
  ).toBe(true);
});
