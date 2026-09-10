import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { testDb } from "./helpers.js";
import {
  ManifestRegistry,
  type Manifest,
  type ManifestDocument,
} from "../src/providers/manifests.js";
import { RuntimeStore, type Job } from "../src/runtime/index.js";
import { BillingReconciler } from "../src/providers/reconcile.js";
import { providerErrorHeaders } from "../src/providers/error-headers.js";
let f: Awaited<ReturnType<typeof testDb>>,
  registry: ManifestRegistry,
  runtime: RuntimeStore,
  manifest: Manifest;
const actor = {
  id: "operator",
  role: "commissioner" as const,
  leagueId: "billing-test",
};
const secret = "synthetic-fixture-only";
const doc: ManifestDocument = {
  leagueId: actor.leagueId,
  agentId: "a",
  developer: "OpenAI",
  model: "synthetic/model",
  providerSlug: "fixture-endpoint",
  reportedProviderNames: ["Fixture Endpoint"],
  quantization: null,
  modelVersion: null,
  openWeight: null,
  license: null,
  keyRef: "B4_LEAGUE_TEST",
  upstreamKeyHash: "fixture",
  guardrailId: "fixture",
  harnessId: "black4-owner-loop",
  buzzBridgeVersion: "fixture",
  harnessVersion: "fixture",
  toolPermissions: [],
  walletId: "a",
};
beforeEach(async () => {
  f = await testDb();
  registry = new ManifestRegistry(f.db);
  runtime = new RuntimeStore(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'Synthetic billing fixture','{}')",
    [actor.leagueId],
  );
  await f.db.query(
    "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,'team','Fixture','owner','ai',0,0,100)",
    [actor.leagueId],
  );
  await runtime.createAgent({ id: "a", model: doc.model, budgetMicros: 1000 });
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES('a',$1,'team')",
    [actor.leagueId],
  );
  manifest = await registry.stage(actor, doc, secret);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});
async function fixture(generations: (string | null)[], known?: number) {
  await runtime.scheduleSelf("a", {
    causalId: "turn",
    dueAt: new Date(),
    payload: {},
  });
  const job = (await runtime.claim("fixture-worker", 30000, doc.model))!;
  const reservationId = await runtime.reserve(job, 100),
    callIds: string[] = [];
  for (const id of generations) {
    const callId = await registry.begin(manifest, job, false);
    callIds.push(callId);
    if (id)
      await registry.observe(callId, {
        status: "cost_unknown",
        generationId: id,
      });
  }
  await runtime.fail(job, "synthetic fixture provider timeout", {
    retryable: false,
    chargeKnownZero: false,
    reservationId,
    observedCostMicros: known,
  });
  return { job, reservationId, callIds };
}
function metadata(id: string, cost = 0.00002, extra = {}) {
  return {
    id,
    model: doc.model,
    provider_name: "Fixture Endpoint",
    total_cost: cost,
    native_tokens_prompt: 5,
    ...extra,
  };
}
function responder(fn: (id: string) => unknown) {
  return vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify({
          data: fn(new URL(String(url)).searchParams.get("id")!),
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
}
const execute = (fetchImpl: typeof fetch) =>
  new BillingReconciler(f.db, fetchImpl).reconcile(actor, {
    manifestId: manifest.id,
    secret,
  });
async function wallet() {
  return (
    await f.db.query(
      "SELECT spent_micros,reserved_micros,enabled FROM runtime_agents WHERE id='a'",
    )
  ).rows[0];
}
it("keeps a future error-header locator unpaid until independently verified generation metadata settles it", async () => {
  const turn = await fixture([null]);
  const header = providerErrorHeaders(
    new Headers({
      "x-generation-id": "gen-error-header123",
      "x-request-id": "request-123",
      "retry-after": "30",
    }),
    secret,
  );
  await registry.observe(turn.callIds[0], {
    status: "http_429_cost_uncertain",
    generationId: header.generationId,
    requestId: header.requestId,
  });
  expect(
    (
      await f.db.query(
        "SELECT generation_id,request_id,reported_model,reported_provider,cost_micros,reconciliation_status FROM provider_calls WHERE id=$1",
        [turn.callIds[0]],
      )
    ).rows[0],
  ).toEqual({
    generation_id: "gen-error-header123",
    request_id: "request-123",
    reported_model: null,
    reported_provider: null,
    cost_micros: null,
    reconciliation_status: "pending",
  });
  expect(await wallet()).toMatchObject({
    spent_micros: "0",
    reserved_micros: "100",
  });
  const incomplete = await execute(responder((id) => ({ id })));
  expect(incomplete.calls[0].status).toBe("pending_metadata_incomplete");
  expect(await wallet()).toMatchObject({
    spent_micros: "0",
    reserved_micros: "100",
  });
  const result = await execute(responder((id) => metadata(id)));
  expect(result.reservations[0]).toEqual({
    id: turn.reservationId,
    status: "settled",
    actualMicros: 20,
  });
  expect(await wallet()).toMatchObject({
    spent_micros: "20",
    reserved_micros: "0",
  });
});
it("settles only after every exact job/fence call verifies, and replay never double charges", async () => {
  const turn = await fixture(["gen-a", "gen-b"]);
  const first = await execute(
    responder((id) => (id === "gen-a" ? metadata(id) : { id })),
  );
  expect(first.reservations[0].status).toBe("RECONCILE_CALLS_UNRESOLVED");
  expect(await wallet()).toMatchObject({
    spent_micros: "0",
    reserved_micros: "100",
  });
  const second = await execute(responder((id) => metadata(id)));
  expect(second.reservations[0]).toEqual({
    id: turn.reservationId,
    status: "settled",
    actualMicros: 40,
  });
  expect(await wallet()).toMatchObject({
    spent_micros: "40",
    reserved_micros: "0",
  });
  const noNetwork = vi.fn();
  await execute(noNetwork as unknown as typeof fetch);
  expect(noNetwork).not.toHaveBeenCalled();
  expect(await wallet()).toMatchObject({
    spent_micros: "40",
    reserved_micros: "0",
  });
  expect((await registry.get(manifest.id)).status).toBe("staged");
});
it("rejects another key or league before metadata access", async () => {
  await fixture(["gen"]);
  const fetchImpl = vi.fn();
  const reconciler = new BillingReconciler(
    f.db,
    fetchImpl as unknown as typeof fetch,
  );
  await expect(
    reconciler.reconcile(actor, { manifestId: manifest.id, secret: "wrong" }),
  ).rejects.toThrow("KEY_MISMATCH");
  await expect(
    reconciler.reconcile(
      { ...actor, leagueId: "other" },
      { manifestId: manifest.id, secret },
    ),
  ).rejects.toThrow("OPERATOR_FORBIDDEN");
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([
  { id: "other" },
  { model: "synthetic/substitute" },
  { provider_name: "Other Endpoint" },
])(
  "flags mismatched generation identity and holds the reserve: %j",
  async (extra) => {
    await fixture(["gen"]);
    const result = await execute(
      responder((id) => metadata(id, 0.00002, extra)),
    );
    expect(result.calls[0].status).toBe("mismatch");
    expect(result.reservations[0].status).toBe("RECONCILE_CALLS_UNRESOLVED");
    expect(await wallet()).toMatchObject({
      spent_micros: "0",
      reserved_micros: "100",
    });
    expect(
      (
        await f.db.query(
          "SELECT count(*) FROM runtime_receipts WHERE type='billing.discrepancy'",
        )
      ).rows[0].count,
    ).toBe("1");
  },
);
it("retains unknown holds for an unidentifiable call and for zero or missing costs", async () => {
  await fixture(["gen", null]);
  let result = await execute(responder((id) => metadata(id, 0)));
  expect(result.calls.map((c) => c.status)).toContain("pending_unidentifiable");
  expect(result.calls.map((c) => c.status)).toContain(
    "pending_metadata_incomplete",
  );
  result = await execute(responder((id) => metadata(id)));
  expect(result.reservations[0].status).toBe("RECONCILE_CALLS_UNRESOLVED");
  expect((await wallet()).reserved_micros).toBe("100");
});
it("refuses active jobs both before reading and under the atomic settlement hook", async () => {
  await fixture(["gen"]);
  await execute(responder((id) => ({ id })));
  await runtime.scheduleSelf("a", {
    causalId: "next",
    dueAt: new Date(),
    payload: {},
  });
  const next = (await runtime.claim("next-worker", 30000, doc.model))!;
  const fetchImpl = vi.fn();
  const skipped = await execute(fetchImpl as unknown as typeof fetch);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(skipped.calls[0].status).toBe("pending_active_job");
  await runtime.fail(next, "synthetic done", {
    retryable: false,
    chargeKnownZero: true,
  });
  const original = RuntimeStore.prototype.reconcileReservation;
  vi.spyOn(RuntimeStore.prototype, "reconcileReservation").mockImplementation(
    async function (this: RuntimeStore, id, cost, evidence, verify) {
      await runtime.scheduleSelf("a", {
        causalId: "race",
        dueAt: new Date(),
        payload: {},
      });
      await runtime.claim("racing-worker", 30000, doc.model);
      return original.call(this, id, cost, evidence, verify);
    },
  );
  const result = await execute(responder((id) => metadata(id)));
  expect(result.reservations[0].status).toBe("RECONCILE_ACTIVE_JOB");
  expect((await wallet()).reserved_micros).toBe("100");
});
it("records settled cost discrepancies once without charging an adjustment", async () => {
  await fixture(["gen"], 10);
  const first = await execute(responder((id) => metadata(id)));
  const second = await execute(responder((id) => metadata(id)));
  expect(first.reservations[0].status).toBe("discrepancy_no_additional_charge");
  expect(second.reservations[0].status).toBe(
    "discrepancy_no_additional_charge",
  );
  expect(await wallet()).toMatchObject({
    spent_micros: "10",
    reserved_micros: "0",
  });
  expect(
    (
      await f.db.query(
        "SELECT count(*) FROM runtime_receipts WHERE type='billing.discrepancy'",
      )
    ).rows[0].count,
  ).toBe("1");
});
it("does not count one generation twice", async () => {
  await fixture(["same", "same"]);
  const result = await execute(responder((id) => metadata(id)));
  expect(result.calls.every((c) => c.status === "mismatch")).toBe(true);
  expect((await wallet()).reserved_micros).toBe("100");
});
it("records a known overrun and freezes the owner rather than releasing the evidence", async () => {
  await fixture(["gen"]);
  const result = await execute(responder((id) => metadata(id, 0.0002)));
  expect(result.reservations[0]).toMatchObject({
    status: "settled",
    actualMicros: 200,
  });
  expect(await wallet()).toMatchObject({
    spent_micros: "200",
    reserved_micros: "0",
    enabled: false,
  });
});

it("accepts authoritative zero cost with explicit native usage without guessing missing cost", async () => {
  await fixture(["zero"]);
  const result = await execute(
    responder((id) =>
      metadata(id, 0, { native_tokens_prompt: 0, native_tokens_completion: 0 }),
    ),
  );
  expect(result.reservations[0]).toMatchObject({
    status: "settled",
    actualMicros: 0,
  });
  expect(await wallet()).toMatchObject({
    spent_micros: "0",
    reserved_micros: "0",
  });
});
it("keeps a reservation with no identifiable provider call unresolved", async () => {
  await fixture([]);
  const noNetwork = vi.fn();
  const result = await execute(noNetwork as unknown as typeof fetch);
  expect(noNetwork).not.toHaveBeenCalled();
  expect(result.reservations[0].status).toBe("RECONCILE_CALLS_UNRESOLVED");
  expect((await wallet()).reserved_micros).toBe("100");
});

it.each([20, 80, 120])(
  "preserves unresolved server-search aggregate charge and reservation when generation cost is %i",
  async (generationCostMicros) => {
    const turn = await fixture(["search-gen"]);
    await registry.observe(turn.callIds[0], {
      status: "server_search_billing_unresolved",
      generationId: "search-gen",
      costMicros: 80,
    });
    const fetchImpl = responder((id) =>
      metadata(id, generationCostMicros / 1_000_000),
    );
    const first = await execute(fetchImpl);
    await execute(fetchImpl);
    expect(first.calls[0].status).toBe(
      generationCostMicros === 80
        ? "pending_aggregate_billing_review"
        : "pending_aggregate_cost_discrepancy",
    );
    expect(first.reservations[0].status).toBe("RECONCILE_CALLS_UNRESOLVED");
    const call = (
      await f.db.query(
        "SELECT status,cost_micros,reconciliation_status FROM provider_calls WHERE id=$1",
        [turn.callIds[0]],
      )
    ).rows[0];
    expect(call).toEqual({
      status: "server_search_billing_unresolved",
      cost_micros: "80",
      reconciliation_status: "pending",
    });
    expect(await wallet()).toMatchObject({
      spent_micros: "0",
      reserved_micros: "100",
    });
    expect(
      (
        await f.db.query(
          "SELECT count(*) FROM runtime_receipts WHERE type='billing.discrepancy'",
        )
      ).rows[0].count,
    ).toBe("1");
  },
);
it("holds missing aggregate cost instead of replacing it with generation cost", async () => {
  const turn = await fixture(["search-gen"]);
  await registry.observe(turn.callIds[0], {
    status: "server_search_billing_unresolved",
  });
  const report = await execute(responder((id) => metadata(id)));
  expect(report.calls[0].status).toBe("pending_aggregate_billing_review");
  expect(
    (
      await f.db.query("SELECT cost_micros FROM provider_calls WHERE id=$1", [
        turn.callIds[0],
      ])
    ).rows[0].cost_micros,
  ).toBeNull();
  expect((await wallet()).reserved_micros).toBe("100");
});
it("uses persistent aggregate diagnostics even when transient call status changed", async () => {
  const turn = await fixture(["search-gen"]);
  await registry.observe(turn.callIds[0], {
    status: "response_received",
    costMicros: 80,
  });
  await registry.diagnostic(turn.callIds[0], {
    kind: "aggregate_billing",
    aggregateCostMicros: 80,
  });
  const report = await execute(responder((id) => metadata(id)));
  expect(report.calls[0].status).toBe("pending_aggregate_cost_discrepancy");
  expect(
    (
      await f.db.query(
        "SELECT cost_micros,reconciliation_status FROM provider_calls WHERE id=$1",
        [turn.callIds[0]],
      )
    ).rows[0],
  ).toEqual({ cost_micros: "80", reconciliation_status: "pending" });
  expect((await wallet()).reserved_micros).toBe("100");
});
it("rechecks aggregate diagnostics in the atomic reservation settlement hook", async () => {
  const turn = await fixture(["search-gen"]);
  const original = RuntimeStore.prototype.reconcileReservation;
  vi.spyOn(RuntimeStore.prototype, "reconcileReservation").mockImplementation(
    async function (this: RuntimeStore, id, cost, evidence, verify) {
      // Simulate aggregate evidence arriving after metadata verification but before settlement.
      await registry.diagnostic(turn.callIds[0], {
        kind: "server_search_billing",
        aggregateCostMicros: 80,
      });
      return original.call(this, id, cost, evidence, verify);
    },
  );
  const result = await execute(responder((id) => metadata(id)));
  expect(result.reservations[0].status).toBe(
    "RECONCILE_AGGREGATE_BILLING_UNRESOLVED",
  );
  expect(await wallet()).toMatchObject({
    spent_micros: "0",
    reserved_micros: "100",
  });
});
