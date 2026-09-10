import { afterEach, expect, it, vi } from "vitest";
import {
  RuntimeError,
  type AgentDriver,
  type DriverResult,
  type Job,
  type RuntimeStore,
} from "../src/runtime/index.js";
import {
  KnownZeroCostError,
  ObservedCostError,
  runOne,
} from "../src/runtime/worker.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const job = {
  id: "synthetic-job",
  agentId: "synthetic-owner",
  model: "synthetic/model",
  kind: "event",
  fence: 1,
  workerId: "fixture",
  payload: {},
} as Job;
function fixture(run: AgentDriver["run"]) {
  const calls = {
    claim: vi.fn().mockResolvedValue(job),
    requireLiveBinding: vi.fn(),
    reserve: vi.fn().mockResolvedValue("synthetic-reservation"),
    heartbeat: vi.fn(),
    recordExecution: vi.fn(),
    observeCost: vi.fn(),
    settleOverrun: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  };
  return {
    calls,
    store: calls as unknown as RuntimeStore,
    driver: {
      model: job.model,
      name: "synthetic-cancellable",
      synthetic: true,
      run,
    } satisfies AgentDriver,
  };
}
const result: DriverResult = {
  actions: [
    {
      type: "remember",
      key: "held",
      content: "must not commit after cancellation",
    },
  ],
  summary: "synthetic",
  costMicros: 7,
  costEvidenceId: "synthetic-receipt",
};
afterEach(() => {
  vi.useRealTimers();
});

it("does not claim an already aborted caller's job", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const f = fixture(vi.fn());
  expect(
    await runOne(f.store, f.driver, "fixture", { signal: cancellation.signal }),
  ).toEqual({ status: "idle" });
  expect(f.calls.claim).not.toHaveBeenCalled();
});

it("does not invoke or reserve if caller cancellation arrives during claim", async () => {
  const cancellation = new AbortController();
  const run = vi.fn();
  const f = fixture(run);
  f.calls.claim.mockImplementation(async () => {
    cancellation.abort();
    return job;
  });
  expect(
    await runOne(f.store, f.driver, "fixture", { signal: cancellation.signal }),
  ).toMatchObject({ status: "failed", error: "WORKER_ABORTED" });
  expect(run).not.toHaveBeenCalled();
  expect(f.calls.reserve).not.toHaveBeenCalled();
  expect(f.calls.fail).toHaveBeenCalledWith(
    job,
    "WORKER_ABORTED",
    expect.objectContaining({ chargeKnownZero: true, retryable: false }),
  );
});

it("cancels an invoked driver without treating its abort error as zero spend or retryable", async () => {
  const cancellation = new AbortController();
  const entered = deferred<void>();
  const f = fixture(async (_job, context) => {
    entered.resolve();
    return new Promise((_resolve, reject) =>
      context!.signal.addEventListener(
        "abort",
        () => reject(new KnownZeroCostError("abort is not a provider receipt")),
        { once: true },
      ),
    );
  });
  const turn = runOne(f.store, f.driver, "fixture", {
    signal: cancellation.signal,
    heartbeat: false,
    maxCostMicros: 10,
  });
  await entered.promise;
  cancellation.abort();
  expect(await turn).toMatchObject({
    status: "failed",
    error: "WORKER_ABORTED",
  });
  expect(f.calls.fail).toHaveBeenCalledWith(
    job,
    "WORKER_ABORTED",
    expect.objectContaining({
      chargeKnownZero: false,
      retryable: false,
      reservationId: "synthetic-reservation",
    }),
  );
  expect(f.calls.complete).not.toHaveBeenCalled();
});

it("waits for a late cost receipt after abort and records it without committing actions", async () => {
  const cancellation = new AbortController();
  const entered = deferred<void>();
  const returned = deferred<DriverResult>();
  const f = fixture(async () => {
    entered.resolve();
    return returned.promise;
  });
  let finished = false;
  const turn = runOne(f.store, f.driver, "fixture", {
    signal: cancellation.signal,
    heartbeat: false,
    maxCostMicros: 10,
  }).finally(() => {
    finished = true;
  });
  await entered.promise;
  cancellation.abort();
  await Promise.resolve();
  expect(finished).toBe(false);
  returned.resolve(result);
  expect(await turn).toMatchObject({
    status: "failed",
    error: "WORKER_ABORTED",
  });
  expect(f.calls.observeCost).toHaveBeenCalledWith(
    job,
    "synthetic-reservation",
    7,
    "synthetic-receipt",
  );
  expect(f.calls.fail).toHaveBeenCalledWith(
    job,
    "WORKER_ABORTED",
    expect.objectContaining({ observedCostMicros: 7, chargeKnownZero: false }),
  );
  expect(f.calls.complete).not.toHaveBeenCalled();
});

it("propagates lease loss to the driver and preserves a partial charge before returning stale", async () => {
  vi.useFakeTimers();
  const entered = deferred<void>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (_job, context) => {
    signal = context!.signal;
    entered.resolve();
    return new Promise((_resolve, reject) =>
      signal!.addEventListener(
        "abort",
        () =>
          reject(
            new ObservedCostError(
              "synthetic partial work",
              7,
              "partial-receipt",
            ),
          ),
        { once: true },
      ),
    );
  });
  f.calls.heartbeat.mockRejectedValue(new RuntimeError("STALE_CLAIM"));
  const turn = runOne(f.store, f.driver, "fixture", {
    leaseMs: 30,
    maxCostMicros: 10,
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10);
  expect(await turn).toMatchObject({ status: "stale", error: "STALE_CLAIM" });
  expect(signal?.aborted).toBe(true);
  expect(f.calls.observeCost).toHaveBeenCalledWith(
    job,
    "synthetic-reservation",
    7,
    "partial-receipt",
  );
  expect(f.calls.fail).not.toHaveBeenCalled();
  expect(f.calls.complete).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains unknown spend on lease loss and removes the caller listener on completion", async () => {
  vi.useFakeTimers();
  const entered = deferred<void>();
  const cancellation = new AbortController();
  const remove = vi.spyOn(cancellation.signal, "removeEventListener");
  const f = fixture(async (_job, context) => {
    entered.resolve();
    return new Promise((_resolve, reject) =>
      context!.signal.addEventListener(
        "abort",
        () => reject(new Error("synthetic terminated without billing result")),
        { once: true },
      ),
    );
  });
  f.calls.heartbeat.mockRejectedValue(new Error("heartbeat unavailable"));
  const turn = runOne(f.store, f.driver, "fixture", {
    leaseMs: 30,
    signal: cancellation.signal,
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10);
  expect(await turn).toMatchObject({ status: "stale" });
  expect(f.calls.observeCost).not.toHaveBeenCalled();
  expect(f.calls.fail).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});
