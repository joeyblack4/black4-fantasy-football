import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { FranchiseService } from "../src/franchise/service.js";
import { FranchiseExpenses } from "../src/franchise/expenses.js";
let f: Awaited<ReturnType<typeof testDb>>,
  service: FranchiseService,
  expenses: FranchiseExpenses,
  store: RuntimeStore;
const leagueId = "synthetic-expenses";
const commissioner: Actor = {
  id: "commissioner",
  role: "commissioner",
  leagueId,
};
const owner: Actor = { id: "owner0", role: "owner", leagueId, teamId: "team0" };
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  service = new FranchiseService(f.db);
  expenses = new FranchiseExpenses(f.db);
  await new LeagueService(f.db).execute(commissioner, {
    leagueId,
    idempotencyKey: "create",
    type: "createLeague",
    name: "Synthetic expenses",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: "team" + i,
      ownerId: "owner" + i,
      name: "Fixture " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  for (const i of [0, 1, 10]) {
    await store.createAgent({
      id: "agent" + i,
      model: "test/expenses",
      kind: i === 10 ? "human" : "ai",
      budgetMicros: i === 10 ? 0 : 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent" + i, leagueId, "team" + i],
    );
  }
});
afterEach(async () => {
  await f?.close();
});
async function request(maxCostMicros = 800, approve = true, i = 0) {
  const saved = await service.execute(
    { ...owner, id: "owner" + i, teamId: "team" + i },
    {
      agentId: "agent" + i,
      idempotencyKey: randomUUID(),
      action: {
        type: "service_request",
        causalId: randomUUID(),
        service: "Synthetic subscription",
        purpose: "Synthetic no-purchase test",
        maxCostMicros,
      },
    },
  );
  const requestId = saved.result.requestId as string;
  if (approve)
    await service.reviewService(commissioner, {
      requestId,
      decision: "approved",
      note: "Synthetic operator approval only",
    });
  return requestId;
}
async function begin(reserveMicros = 600, i = 0) {
  return expenses.beginExpense(commissioner, {
    requestId: await request(800, true, i),
    idempotencyKey: randomUUID(),
    reserveMicros,
  });
}
async function wallet(i = 0) {
  return (
    await f.db.query("SELECT * FROM runtime_agents WHERE id=$1", ["agent" + i])
  ).rows[0];
}
const invoice = (expenseId: unknown, actualMicros = 500) => ({
  expenseId,
  idempotencyKey: randomUUID(),
  actualMicros,
  invoiceReference: "synthetic/vendor/account/invoice-" + randomUUID(),
  evidence: "Synthetic invoice receipt; no external purchase",
});
it("approval alone does not reserve; begin is scoped, capped and idempotent", async () => {
  const requestId = await request();
  expect((await wallet()).reserved_micros).toBe("0");
  await expect(
    expenses.beginExpense(owner, {
      requestId,
      idempotencyKey: "owner",
      reserveMicros: 500,
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    expenses.beginExpense(
      { ...commissioner, leagueId: "other" },
      { requestId, idempotencyKey: "other", reserveMicros: 500 },
    ),
  ).rejects.toThrow("EXPENSE_FORBIDDEN");
  await expect(
    expenses.beginExpense(commissioner, {
      requestId,
      idempotencyKey: "too-much",
      reserveMicros: 801,
    }),
  ).rejects.toThrow("APPROVED_LIMIT_EXCEEDED");
  const input = { requestId, idempotencyKey: "begin", reserveMicros: 600 };
  const results = await Promise.all([
    expenses.beginExpense(commissioner, input),
    expenses.beginExpense(commissioner, input),
  ]);
  expect(results[0].receiptId).toBe(results[1].receiptId);
  expect(results.filter((r) => r.replayed)).toHaveLength(1);
  expect((await wallet()).reserved_micros).toBe("600");
  await expect(
    expenses.beginExpense(commissioner, { ...input, reserveMicros: 601 }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    expenses.beginExpense(commissioner, {
      ...input,
      idempotencyKey: "new-key",
    }),
  ).rejects.toThrow("EXPENSE_ALREADY_EXISTS");
  expect(
    (await f.db.query("SELECT * FROM franchise_expense_receipts")).rows,
  ).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "SELECT * FROM runtime_jobs WHERE payload->>'kind'='expense.begin'",
      )
    ).rows,
  ).toHaveLength(1);
});
it("requires actual approval metadata and rejects zero-funded human purchases", async () => {
  const requestId = await request(800, false);
  await expect(
    expenses.beginExpense(commissioner, {
      requestId,
      idempotencyKey: "no",
      reserveMicros: 100,
    }),
  ).rejects.toThrow("SERVICE_NOT_APPROVED");
  const human = await request(800, true, 10);
  await expect(
    expenses.beginExpense(commissioner, {
      requestId: human,
      idempotencyKey: "human",
      reserveMicros: 1,
    }),
  ).rejects.toThrow("BUDGET_EXHAUSTED");
  await expect(
    expenses.beginExpense(commissioner, {
      requestId: human,
      idempotencyKey: "zero",
      reserveMicros: 0,
    }),
  ).rejects.toThrow();
  expect((await wallet(10)).reserved_micros).toBe("0");
});
it("concurrent subscriptions cannot spend the same remaining wallet twice", async () => {
  const a = await request(),
    b = await request();
  const result = await Promise.allSettled([
    expenses.beginExpense(commissioner, {
      requestId: a,
      idempotencyKey: "a",
      reserveMicros: 700,
    }),
    expenses.beginExpense(commissioner, {
      requestId: b,
      idempotencyKey: "b",
      reserveMicros: 700,
    }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await wallet()).reserved_micros).toBe("700");
});
it("inference and subscription reservations compete atomically for the shared season budget", async () => {
  const requestId = await request();
  const event = await store.ingestEvent({
    agentId: "agent0",
    causalId: "compute",
    payload: { kind: "synthetic" },
  });
  const job = (await store.claim("synthetic-worker", 30000, "test/expenses", [
    "agent0",
  ]))!;
  expect(job).toBeTruthy();
  const result = await Promise.allSettled([
    store.reserve(job, 700),
    expenses.beginExpense(commissioner, {
      requestId,
      idempotencyKey: "expense",
      reserveMicros: 700,
    }),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await wallet()).reserved_micros).toBe("700");
});
it("settles an actual invoice once, releasing only its reservation and retaining inference reservations", async () => {
  const event = await store.ingestEvent({
    agentId: "agent0",
    causalId: "compute",
    payload: { kind: "synthetic" },
  });
  const job = (await store.claim("synthetic-worker", 30000, "test/expenses", [
    "agent0",
  ]))!;
  await store.reserve(job, 300);
  const expense = await begin(600);
  const input = invoice(expense.result.expenseId, 500);
  const results = await Promise.all([
    expenses.settleExpense(commissioner, input),
    expenses.settleExpense(commissioner, input),
  ]);
  expect(results.filter((r) => r.replayed)).toHaveLength(1);
  expect(await wallet()).toMatchObject({
    reserved_micros: "300",
    spent_micros: "500",
    enabled: true,
  });
  await expect(
    expenses.settleExpense(commissioner, { ...input, actualMicros: 501 }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect((await expenses.snapshot(owner))[0]).toMatchObject({
    status: "settled",
    actual_micros: "500",
    invoice_reference: input.invoiceReference,
  });
});
it("unknown outcomes hold the full reservation until an evidenced settlement", async () => {
  const expense = await begin(600);
  const input = {
    expenseId: expense.result.expenseId,
    idempotencyKey: "unknown",
    evidence: "Checkout connection lost; charge is unknown",
  };
  const uncertain = await expenses.markUncertain(commissioner, input);
  expect(uncertain.result.actualMicros).toBeNull();
  expect(await wallet()).toMatchObject({
    reserved_micros: "600",
    spent_micros: "0",
  });
  expect((await expenses.markUncertain(commissioner, input)).replayed).toBe(
    true,
  );
  const next = await request();
  await expect(
    expenses.beginExpense(commissioner, {
      requestId: next,
      idempotencyKey: "next",
      reserveMicros: 500,
    }),
  ).rejects.toThrow("BUDGET_EXHAUSTED");
  await expenses.settleExpense(
    commissioner,
    invoice(expense.result.expenseId, 550),
  );
  expect(await wallet()).toMatchObject({
    reserved_micros: "0",
    spent_micros: "550",
  });
});
it("records the full invoice overrun and freezes the wallet without discarding charge evidence", async () => {
  const expense = await begin(600);
  const settled = await expenses.settleExpense(
    commissioner,
    invoice(expense.result.expenseId, 1100),
  );
  expect(settled.result).toMatchObject({
    actualMicros: 1100,
    exceedsReservation: true,
    agentFrozen: true,
  });
  expect(await wallet()).toMatchObject({
    spent_micros: "1100",
    reserved_micros: "0",
    enabled: false,
  });
  const next = await request();
  await expect(
    expenses.beginExpense(commissioner, {
      requestId: next,
      idempotencyKey: "next",
      reserveMicros: 1,
    }),
  ).rejects.toThrow("WALLET_FROZEN");
  expect(
    (
      await f.db.query(
        "SELECT priority FROM runtime_jobs WHERE payload->>'kind'='expense.settle'",
      )
    ).rows[0].priority,
  ).toBe("urgent");
});
it("cancellation requires affirmative known-zero evidence and cannot race settlement into a double release", async () => {
  const expense = await begin(600);
  const input = {
    expenseId: expense.result.expenseId,
    idempotencyKey: "cancel",
    evidence: "Vendor confirms no order and no charge",
  };
  await expect(expenses.cancelExpense(commissioner, input)).rejects.toThrow();
  await expect(
    expenses.cancelExpense(commissioner, { ...input, chargeKnownZero: false }),
  ).rejects.toThrow();
  const results = await Promise.allSettled([
    expenses.cancelExpense(commissioner, { ...input, chargeKnownZero: true }),
    expenses.settleExpense(
      commissioner,
      invoice(expense.result.expenseId, 500),
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await wallet()).reserved_micros).toBe("0");
  expect(["0", "500"]).toContain((await wallet()).spent_micros);
});
it("rejects duplicate invoice references across franchises and all owner settlement authority", async () => {
  const first = await begin(600, 0),
    second = await begin(600, 1);
  const settled = invoice(first.result.expenseId, 500);
  await expenses.settleExpense(commissioner, settled);
  await expect(
    expenses.settleExpense(commissioner, {
      ...settled,
      expenseId: second.result.expenseId,
      idempotencyKey: "other",
    }),
  ).rejects.toThrow("INVOICE_ALREADY_ACCOUNTED");
  await expect(
    expenses.settleExpense(owner, invoice(second.result.expenseId, 500)),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    expenses.settleExpense(
      { ...commissioner, leagueId: "other" },
      invoice(second.result.expenseId, 500),
    ),
  ).rejects.toThrow("EXPENSE_FORBIDDEN");
  expect(await expenses.snapshot(owner)).toHaveLength(1);
  expect(await expenses.snapshot(commissioner)).toHaveLength(2);
  expect((await wallet(1)).reserved_micros).toBe("600");
});
it("rolls back the reservation and receipt if the atomic owner wake cannot be persisted", async () => {
  const requestId = await request();
  await f.db.query(
    `CREATE FUNCTION reject_expense_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'kind' LIKE 'expense.%' THEN RAISE EXCEPTION 'synthetic wake failure'; END IF; RETURN NEW; END $$`,
  );
  await f.db.query(
    "CREATE TRIGGER reject_expense_wake BEFORE INSERT ON runtime_jobs FOR EACH ROW EXECUTE FUNCTION reject_expense_wake()",
  );
  await expect(
    expenses.beginExpense(commissioner, {
      requestId,
      idempotencyKey: "begin",
      reserveMicros: 600,
    }),
  ).rejects.toThrow("synthetic wake failure");
  expect((await wallet()).reserved_micros).toBe("0");
  expect(
    (await f.db.query("SELECT * FROM franchise_expenses")).rows,
  ).toHaveLength(0);
  expect(
    (await f.db.query("SELECT * FROM franchise_expense_receipts")).rows,
  ).toHaveLength(0);
});

it("retains uncertain evidence in an immutable receipt when known-zero cancellation releases the hold", async () => {
  const expense = await begin(600);
  const uncertain = await expenses.markUncertain(commissioner, {
    expenseId: expense.result.expenseId,
    idempotencyKey: "unknown",
    evidence: "Synthetic interrupted checkout evidence",
  });
  const input = {
    expenseId: expense.result.expenseId,
    idempotencyKey: "cancel",
    chargeKnownZero: true,
    evidence: "Synthetic vendor confirms zero charge",
  };
  await expenses.cancelExpense(commissioner, input);
  expect((await expenses.cancelExpense(commissioner, input)).replayed).toBe(
    true,
  );
  expect(await wallet()).toMatchObject({
    reserved_micros: "0",
    spent_micros: "0",
  });
  const receipt = (
    await f.db.query(
      "SELECT result FROM franchise_expense_receipts WHERE id=$1",
      [uncertain.receiptId],
    )
  ).rows[0];
  expect(receipt.result.evidence).toBe(
    "Synthetic interrupted checkout evidence",
  );
  expect((await expenses.snapshot(owner))[0]).toMatchObject({
    status: "cancelled",
    actual_micros: "0",
    evidence: input.evidence,
  });
});
