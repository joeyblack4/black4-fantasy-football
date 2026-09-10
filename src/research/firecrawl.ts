import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import type { Job } from "../runtime/index.js";
import { assertRehearsalBudget } from "../runtime/rehearsal.js";
import { assertOwnerStageResearchBudget } from "../runtime/owner-stage.js";
import {
  FirecrawlClient,
  FirecrawlInputSchema,
  hashValue,
  type FirecrawlInput,
  type FirecrawlResponse,
} from "./firecrawl-client.js";
import { ResearchError } from "./network.js";
export const FirecrawlBudgetSchema = z
  .object({
    keyRef: z.string().regex(/^B4_LEAGUE_[A-Z0-9_]+$/),
    approvalReceiptId: z.string().min(8).max(200),
    costPerCreditMicros: z.number().int().positive().max(1_000_000),
    reservationPerCreditMicros: z.number().int().positive().max(1_000_000),
    maxCreditsPerFranchise: z.number().int().positive().max(100_000),
    maxCredits: z
      .object({
        search: z.number().int().min(1).max(100),
        scrape: z.number().int().min(1).max(100),
      })
      .strict(),
    verifiedAt: z.iso.datetime({ offset: true }),
    maxAgeHours: z.number().int().min(1).max(24).default(24),
  })
  .strict()
  .refine((v) => v.reservationPerCreditMicros >= v.costPerCreditMicros);
export type FirecrawlBudget = z.infer<typeof FirecrawlBudgetSchema>;
export type FirecrawlOptions = {
  client: FirecrawlClient;
  budget: FirecrawlBudget;
  enabled: boolean;
  synthetic?: boolean;
};
const check = (v: unknown, code: string) => {
  if (!v) throw new ResearchError(code);
};
export class FirecrawlResearch {
  private budget: FirecrawlBudget;
  constructor(
    private db: Db,
    private options: FirecrawlOptions,
  ) {
    this.budget = FirecrawlBudgetSchema.parse(options.budget);
  }
  availability() {
    return {
      status: this.options.enabled ? "configured" : "disabled",
      provider: "firecrawl",
      search: true,
      scrape: true,
      scrapeRequiresExplicitReader: "firecrawl",
      scrapeBillingWarning:
        "Scrape credit usage is not guaranteed. Missing credits keep the full reservation held even when content succeeds, blocking further paid work until reconciled. Default page retrieval uses the public reader without a paid API charge.",
      formats: ["plain search descriptions", "markdown"],
      billing:
        "reported credits valued at approved plan tariff; missing credits remain held",
      authenticatedSiteAccess: false,
      otherReasoningModel: false,
      synthetic: this.options.synthetic === true,
      creditAllowancePerFranchise: this.budget.maxCreditsPerFranchise,
      reservationPerCreditMicros: this.budget.reservationPerCreditMicros,
      allocationPerCreditMicros: this.budget.costPerCreditMicros,
    };
  }
  private async scope(tx: Tx, job: Job) {
    const row = (
      await tx.query(
        `SELECT a.*,b.league_id,b.team_id,t.owner_id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN runtime_jobs j ON j.agent_id=a.id WHERE j.id=$1 AND j.fence=$2 AND j.worker_id=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND a.enabled AND a.kind='ai' AND t.kind='ai' AND a.model=$4 AND a.id=$5 FOR NO KEY UPDATE OF a`,
        [job.id, job.fence, job.workerId, job.model, job.agentId],
      )
    ).rows[0];
    check(row, "FIRECRAWL_JOB_AUTHORITY_EXPIRED");
    return row;
  }
  async execute(job: Job, input: FirecrawlInput) {
    check(this.options.enabled, "FIRECRAWL_PAID_CALLS_DISABLED");
    const v = FirecrawlInputSchema.parse(input);
    await transaction(this.db, (tx) => this.scope(tx, job));
    const plan = await this.options.client.plan(v),
      b = this.budget;
    const operationKey =
      v.operationKey ?? `${job.id}:${v.kind}:${plan.requestHash.slice(0, 24)}`;
    const fingerprint = hashValue({
      requestHash: plan.requestHash,
      budget: b,
      synthetic: this.options.synthetic === true,
    });
    const amount = b.maxCredits[v.kind] * b.reservationPerCreditMicros;
    const started = await transaction(this.db, async (tx) => {
      const a = await this.scope(tx, job);
      const prior = (
        await tx.query(
          "SELECT * FROM research_paid_operations WHERE agent_id=$1 AND operation_key=$2",
          [job.agentId, operationKey],
        )
      ).rows[0];
      if (prior) {
        check(
          prior.fingerprint === fingerprint,
          "FIRECRAWL_IDEMPOTENCY_CONFLICT",
        );
        return { prior };
      }
      const fresh = (
        await tx.query(
          "SELECT clock_timestamp() BETWEEN $1::timestamptz AND $1::timestamptz+make_interval(hours=>$2::int) fresh",
          [b.verifiedAt, b.maxAgeHours],
        )
      ).rows[0].fresh;
      check(fresh, "FIRECRAWL_TARIFF_STALE");
      const usedCredits = Number(
        (
          await tx.query(
            "SELECT COALESCE(sum(CASE WHEN status='completed' THEN credits_used ELSE GREATEST(COALESCE(credits_used,0),(tariff->'maxCredits'->>kind)::numeric) END),0) used FROM research_paid_operations WHERE agent_id=$1",
            [job.agentId],
          )
        ).rows[0].used,
      );
      check(
        usedCredits + b.maxCredits[v.kind] <= b.maxCreditsPerFranchise,
        "FIRECRAWL_CREDIT_ALLOWANCE_EXHAUSTED",
      );
      check(
        !(
          await tx.query(
            "SELECT 1 FROM research_paid_operations WHERE agent_id=$1 AND status IN ('reserved','dispatched','unknown') LIMIT 1",
            [job.agentId],
          )
        ).rowCount,
        "FIRECRAWL_UNRESOLVED_OPERATION",
      );
      const rate = (
        await tx.query(
          "SELECT count(*) FILTER(WHERE job_id=$1)::int per_job,count(*)::int per_hour FROM research_receipts WHERE agent_id=$2 AND created_at>clock_timestamp()-interval '1 hour'",
          [job.id, job.agentId],
        )
      ).rows[0];
      check(rate.per_job < 8 && rate.per_hour < 60, "RESEARCH_RATE_LIMIT");
      await assertOwnerStageResearchBudget(
        tx,
        job,
        amount,
        v.kind === "search" ? "research_search" : "research_retrieve",
      );
      await assertRehearsalBudget(tx, job, amount);
      check(
        Number(a.budget_micros) -
          Number(a.spent_micros) -
          Number(a.reserved_micros) >=
          amount,
        "FIRECRAWL_BUDGET_EXHAUSTED",
      );
      const id = randomUUID();
      await tx.query(
        "INSERT INTO research_paid_operations(id,league_id,agent_id,job_id,fence,operation_key,fingerprint,kind,status,reservation_micros,tariff,request,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10,$11,$12)",
        [
          id,
          a.league_id,
          job.agentId,
          job.id,
          job.fence,
          operationKey,
          fingerprint,
          v.kind,
          amount,
          {
            ...b,
            monetaryBasis: "operator_plan_credit_valuation",
            invoiceChargeKnown: false,
            synthetic: this.options.synthetic === true,
          },
          plan.body,
          plan.requestHash,
        ],
      );
      await tx.query(
        "UPDATE runtime_agents SET reserved_micros=reserved_micros+$2 WHERE id=$1",
        [job.agentId, amount],
      );
      await tx.query(
        "INSERT INTO research_receipts(id,league_id,agent_id,job_id,tool,url,source_id,status,details) VALUES($1,$2,$3,$4,$5,$6,'firecrawl','reserved',$7)",
        [
          id,
          a.league_id,
          job.agentId,
          job.id,
          v.kind === "search" ? "research_search" : "research_retrieve",
          v.kind === "scrape" ? v.url : null,
          {
            paidOperationId: id,
            operationKey,
            requestHash: plan.requestHash,
            reservationMicros: amount,
          },
        ],
      );
      return { id };
    });
    if ("prior" in started) return this.result(started.prior, true);
    const id = started.id;
    // Revalidate authority immediately before dispatch. Only this process owns a newly
    // reserved row; a crash leaves it held and a future invocation cannot send again.
    await transaction(this.db, async (tx) => {
      await this.scope(tx, job);
      const r = await tx.query(
        "UPDATE research_paid_operations SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=$1 AND status='reserved' RETURNING id",
        [id],
      );
      check(r.rowCount === 1, "FIRECRAWL_DISPATCH_ALREADY_ATTEMPTED");
    });
    let response: FirecrawlResponse | undefined, errorCode: string | undefined;
    try {
      response = await this.options.client.send(plan);
    } catch (e) {
      errorCode =
        e instanceof ResearchError ? e.code : "FIRECRAWL_NETWORK_UNCERTAIN";
    }
    const row = await transaction(this.db, async (tx) => {
      // A response remains attributable if the owner lease expires during the POST.
      // It may settle its own existing hold but cannot authorize another operation.
      await tx.query(
        "SELECT id FROM runtime_agents WHERE id=$1 FOR NO KEY UPDATE",
        [job.agentId],
      );
      const current = (
        await tx.query(
          "SELECT * FROM research_paid_operations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      check(current.status === "dispatched", "FIRECRAWL_RECEIPT_STATE_CHANGED");
      const credits = response?.creditsUsed ?? null,
        valued =
          credits === null ? null : Math.ceil(credits * b.costPerCreditMicros);
      const settled =
        valued !== null &&
        Number.isSafeInteger(valued) &&
        credits !== null &&
        credits <= b.maxCredits[v.kind] &&
        valued <= amount;
      const result = {
        status: response?.success ? "retrieved" : "unavailable",
        provider: "firecrawl",
        endpoint: "https://api.firecrawl.dev/v2/" + v.kind,
        kind: v.kind,
        providerId: response?.providerId ?? null,
        results: response?.results ?? [],
        code: errorCode ?? response?.code ?? null,
        creditsUsed: credits,
        creditsField: response?.creditsField ?? null,
        creditStatus: credits === null ? "unknown" : "reported",
        monetaryBasis: "operator_plan_credit_valuation",
        invoiceChargeKnown: false,
        untrustedContent: true,
        synthetic: this.options.synthetic === true,
      };
      if (settled)
        await tx.query(
          "UPDATE runtime_agents SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3 WHERE id=$1",
          [job.agentId, amount, valued],
        );
      const updated = (
        await tx.query(
          "UPDATE research_paid_operations SET status=$2,actual_micros=$3,credits_used=$4,result=$5,response_hash=$6,completed_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [
            id,
            settled ? "completed" : "unknown",
            settled ? valued : null,
            credits,
            result,
            response?.responseHash ?? null,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE research_receipts SET status=$2,details=details||$3::jsonb,completed_at=clock_timestamp() WHERE id=$1",
        [
          id,
          settled ? "completed" : "unknown",
          {
            creditsUsed: credits,
            creditsField: response?.creditsField ?? null,
            costMicros: settled ? valued : null,
            billingStatus: settled ? "settled" : "held",
            responseHash: response?.responseHash ?? null,
            error: errorCode ?? null,
          },
        ],
      );
      return updated;
    });
    return this.result(row, false);
  }
  private result(row: any, replayed: boolean) {
    return {
      ...(row.result ?? {
        status: "unknown",
        provider: "firecrawl",
        results: [],
      }),
      receiptId: row.id,
      operationKey: row.operation_key,
      replayed,
      billing: {
        status: row.status === "completed" ? "settled" : "held",
        reservedMicros: Number(row.reservation_micros),
        actualMicros:
          row.actual_micros === null ? null : Number(row.actual_micros),
        creditsUsed:
          row.credits_used === null ? null : Number(row.credits_used),
        invoiceChargeKnown: false,
      },
      retryAllowed: false,
    };
  }
}
