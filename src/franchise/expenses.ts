import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { RuntimeStore } from "../runtime/index.js";
import { fingerprint } from "./service.js";
const key = z.string().min(1).max(200),
  money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const evidence = z.string().trim().min(8).max(2000);
export const BeginExpenseSchema = z
  .object({
    requestId: z.uuid(),
    idempotencyKey: key,
    reserveMicros: money.min(1),
  })
  .strict();
export const SettleExpenseSchema = z
  .object({
    expenseId: z.uuid(),
    idempotencyKey: key,
    actualMicros: money,
    invoiceReference: z.string().trim().min(8).max(500),
    evidence,
  })
  .strict();
export const UncertainExpenseSchema = z
  .object({ expenseId: z.uuid(), idempotencyKey: key, evidence })
  .strict();
export const CancelExpenseSchema = z
  .object({
    expenseId: z.uuid(),
    idempotencyKey: key,
    chargeKnownZero: z.literal(true),
    evidence,
  })
  .strict();
export class ExpenseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ExpenseError(code);
}
export type ExpenseReceipt = {
  receiptId: string;
  result: Record<string, unknown>;
  replayed: boolean;
};
/** Local accounting only. Approval is not purchase, provisioned access, or a paid-service receipt.
 * Each approved request authorizes at most one reservation and one final invoice. A renewal
 * requires another approved request. Unknown outcomes keep the entire amount reserved.
 */
export class FranchiseExpenses {
  constructor(readonly db: Db) {}
  private commissioner(actor: Actor) {
    check(actor.role === "commissioner", "FORBIDDEN");
  }
  private async replay(
    tx: Tx,
    actor: Actor,
    operation: string,
    input: { idempotencyKey: string },
  ) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7133))", [
      actor.leagueId + ":" + actor.id + ":" + input.idempotencyKey,
    ]);
    const hash = fingerprint({ actor, operation, input });
    const old = (
      await tx.query(
        "SELECT * FROM franchise_expense_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [actor.leagueId, actor.id, input.idempotencyKey],
      )
    ).rows[0];
    if (old) {
      check(old.fingerprint === hash, "IDEMPOTENCY_CONFLICT");
      return {
        hash,
        receipt: {
          receiptId: old.id,
          result: old.result,
          replayed: true,
        } satisfies ExpenseReceipt,
      };
    }
    return { hash, receipt: null };
  }
  private async wallet(
    tx: Tx,
    actor: Actor,
    request: any,
    allowDisabled = false,
  ) {
    check(request && request.league_id === actor.leagueId, "EXPENSE_FORBIDDEN");
    // Match RuntimeStore's row and lock mode so inference and subscriptions cannot double-spend.
    const wallet = (
      await tx.query(
        "SELECT * FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
        [request.agent_id],
      )
    ).rows[0];
    const binding = (
      await tx.query("SELECT * FROM runtime_bindings WHERE agent_id=$1", [
        request.agent_id,
      ])
    ).rows[0];
    check(
      wallet &&
        binding &&
        binding.league_id === actor.leagueId &&
        binding.team_id === request.team_id,
      "EXPENSE_FORBIDDEN",
    );
    check(allowDisabled || wallet.enabled, "WALLET_FROZEN");
    return wallet;
  }
  private async record(
    tx: Tx,
    actor: Actor,
    operation: string,
    input: { idempotencyKey: string },
    hash: string,
    expense: any,
    wallet: any,
    extra: Record<string, unknown> = {},
  ): Promise<ExpenseReceipt> {
    const receiptId = randomUUID();
    const result = {
      kind: "expense." + operation,
      expenseId: expense.id,
      requestId: expense.request_id,
      teamId: expense.team_id,
      status: expense.status,
      reservedMicros: Number(expense.reserved_micros),
      actualMicros:
        expense.actual_micros === null ? null : Number(expense.actual_micros),
      wallet: {
        budgetMicros: Number(wallet.budget_micros),
        spentMicros: Number(wallet.spent_micros),
        reservedMicros: Number(wallet.reserved_micros),
        enabled: wallet.enabled,
      },
      purchaseExecuted: false,
      evidence: "evidence" in input ? input.evidence : null,
      ...extra,
    };
    await tx.query(
      "INSERT INTO franchise_expense_receipts(id,league_id,expense_id,actor_id,idempotency_key,fingerprint,operation,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        receiptId,
        actor.leagueId,
        expense.id,
        actor.id,
        input.idempotencyKey,
        hash,
        operation,
        JSON.stringify(result),
      ],
    );
    await new RuntimeStore(this.db).ingestEventTx(tx, {
      agentId: expense.agent_id,
      causalId: "expense:" + receiptId,
      payload: { ...result, receiptId },
      priority: extra.agentFrozen ? "urgent" : "normal",
    });
    return { receiptId, result, replayed: false };
  }
  async beginExpense(actor: Actor, input: unknown): Promise<ExpenseReceipt> {
    this.commissioner(actor);
    const request = BeginExpenseSchema.parse(input);
    return transaction(this.db, async (tx) => {
      const replay = await this.replay(tx, actor, "begin", request);
      if (replay.receipt) return replay.receipt;
      const lookup = (
        await tx.query(
          "SELECT * FROM franchise_service_requests WHERE id=$1 AND league_id=$2",
          [request.requestId, actor.leagueId],
        )
      ).rows[0];
      const wallet = await this.wallet(tx, actor, lookup);
      const approved = (
        await tx.query(
          "SELECT * FROM franchise_service_requests WHERE id=$1 FOR UPDATE",
          [request.requestId],
        )
      ).rows[0];
      check(
        approved.status === "approved" &&
          approved.reviewed_by &&
          approved.reviewed_at,
        "SERVICE_NOT_APPROVED",
      );
      check(
        BigInt(request.reserveMicros) <= BigInt(approved.max_cost_micros),
        "APPROVED_LIMIT_EXCEEDED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM franchise_expenses WHERE request_id=$1",
            [request.requestId],
          )
        ).rowCount,
        "EXPENSE_ALREADY_EXISTS",
      );
      check(
        BigInt(wallet.budget_micros) -
          BigInt(wallet.spent_micros) -
          BigInt(wallet.reserved_micros) >=
          BigInt(request.reserveMicros),
        "BUDGET_EXHAUSTED",
      );
      const expense = (
        await tx.query(
          `INSERT INTO franchise_expenses(id,league_id,request_id,agent_id,team_id,reserved_micros,status,begun_by) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7) RETURNING *`,
          [
            randomUUID(),
            actor.leagueId,
            request.requestId,
            approved.agent_id,
            approved.team_id,
            request.reserveMicros,
            actor.id,
          ],
        )
      ).rows[0];
      const updated = (
        await tx.query(
          "UPDATE runtime_agents SET reserved_micros=reserved_micros+$2 WHERE id=$1 RETURNING *",
          [approved.agent_id, request.reserveMicros],
        )
      ).rows[0];
      return this.record(
        tx,
        actor,
        "begin",
        request,
        replay.hash,
        expense,
        updated,
      );
    });
  }
  private async existing(tx: Tx, actor: Actor, expenseId: string) {
    const lookup = (
      await tx.query(
        "SELECT * FROM franchise_expenses WHERE id=$1 AND league_id=$2",
        [expenseId, actor.leagueId],
      )
    ).rows[0];
    const wallet = await this.wallet(tx, actor, lookup, true);
    const expense = (
      await tx.query(
        "SELECT * FROM franchise_expenses WHERE id=$1 FOR UPDATE",
        [expenseId],
      )
    ).rows[0];
    check(
      ["reserved", "uncertain"].includes(expense.status),
      "EXPENSE_ALREADY_FINAL",
    );
    check(
      BigInt(wallet.reserved_micros) >= BigInt(expense.reserved_micros),
      "WALLET_RESERVATION_INTEGRITY_FAILURE",
    );
    return { expense, wallet };
  }
  async settleExpense(actor: Actor, input: unknown): Promise<ExpenseReceipt> {
    this.commissioner(actor);
    const request = SettleExpenseSchema.parse(input);
    return transaction(this.db, async (tx) => {
      const replay = await this.replay(tx, actor, "settle", request);
      if (replay.receipt) return replay.receipt;
      const { expense, wallet } = await this.existing(
        tx,
        actor,
        request.expenseId,
      );
      // Invoice references must be qualified by vendor/account, not a generic local invoice number.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7134))",
        [actor.leagueId + ":" + request.invoiceReference],
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM franchise_expenses WHERE league_id=$1 AND invoice_reference=$2",
            [actor.leagueId, request.invoiceReference],
          )
        ).rowCount,
        "INVOICE_ALREADY_ACCOUNTED",
      );
      check(
        BigInt(wallet.spent_micros) + BigInt(request.actualMicros) <=
          BigInt(Number.MAX_SAFE_INTEGER),
        "WALLET_NUMERIC_LIMIT",
      );
      const overrun =
        BigInt(request.actualMicros) > BigInt(expense.reserved_micros);
      const updated = (
        await tx.query(
          `UPDATE runtime_agents SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3,
    enabled=CASE WHEN $4 THEN false ELSE enabled END WHERE id=$1 RETURNING *`,
          [
            expense.agent_id,
            expense.reserved_micros,
            request.actualMicros,
            overrun,
          ],
        )
      ).rows[0];
      const settled = (
        await tx.query(
          `UPDATE franchise_expenses SET status='settled',actual_micros=$2,invoice_reference=$3,evidence=$4,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [
            expense.id,
            request.actualMicros,
            request.invoiceReference,
            request.evidence,
          ],
        )
      ).rows[0];
      return this.record(
        tx,
        actor,
        "settle",
        request,
        replay.hash,
        settled,
        updated,
        {
          invoiceReference: request.invoiceReference,
          exceedsReservation: overrun,
          agentFrozen: !updated.enabled,
        },
      );
    });
  }
  async markUncertain(actor: Actor, input: unknown): Promise<ExpenseReceipt> {
    this.commissioner(actor);
    const request = UncertainExpenseSchema.parse(input);
    return transaction(this.db, async (tx) => {
      const replay = await this.replay(tx, actor, "uncertain", request);
      if (replay.receipt) return replay.receipt;
      const { expense, wallet } = await this.existing(
        tx,
        actor,
        request.expenseId,
      );
      check(expense.status === "reserved", "EXPENSE_ALREADY_UNCERTAIN");
      const uncertain = (
        await tx.query(
          "UPDATE franchise_expenses SET status='uncertain',evidence=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [expense.id, request.evidence],
        )
      ).rows[0];
      return this.record(
        tx,
        actor,
        "uncertain",
        request,
        replay.hash,
        uncertain,
        wallet,
        { chargeKnown: false },
      );
    });
  }
  async cancelExpense(actor: Actor, input: unknown): Promise<ExpenseReceipt> {
    this.commissioner(actor);
    const request = CancelExpenseSchema.parse(input);
    return transaction(this.db, async (tx) => {
      const replay = await this.replay(tx, actor, "cancel", request);
      if (replay.receipt) return replay.receipt;
      const { expense } = await this.existing(tx, actor, request.expenseId);
      const wallet = (
        await tx.query(
          "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2 WHERE id=$1 RETURNING *",
          [expense.agent_id, expense.reserved_micros],
        )
      ).rows[0];
      const cancelled = (
        await tx.query(
          "UPDATE franchise_expenses SET status='cancelled',actual_micros=0,evidence=$2,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [expense.id, request.evidence],
        )
      ).rows[0];
      return this.record(
        tx,
        actor,
        "cancel",
        request,
        replay.hash,
        cancelled,
        wallet,
        { chargeKnownZero: true },
      );
    });
  }
  async snapshot(actor: Actor) {
    check(actor.role === "owner" || actor.role === "commissioner", "FORBIDDEN");
    if (actor.role === "owner")
      check(
        (
          await this.db.query(
            "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
            [actor.leagueId, actor.teamId, actor.id],
          )
        ).rowCount,
        "FORBIDDEN",
      );
    return (
      await this.db.query(
        "SELECT * FROM franchise_expenses WHERE league_id=$1 AND ($2::text IS NULL OR team_id=$2) ORDER BY begun_at",
        [actor.leagueId, actor.role === "owner" ? actor.teamId : null],
      )
    ).rows;
  }
}
