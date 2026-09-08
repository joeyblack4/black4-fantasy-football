import { z } from "zod";
import { transaction, type Db, type Tx } from "../db.js";
import { getFootballHost } from "../league/host.js";
import type { OwnerReadTool } from "../providers/openrouter.js";
import { RuntimeError, type Job } from "./index.js";

/** Values from the running worker's parsed configuration; no filesystem or secret references. */
export const OwnerStatusConfigSchema = z
  .object({
    manifestId: z.uuid(),
    maxOutputTokens: z.number().int().positive(),
    maxCallsPerTurn: z.number().int().positive(),
    requestTimeoutMs: z.number().int().positive(),
    turnReservationMicros: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    reasoningEffort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable(),
    firecrawlConfigured: z.boolean(),
    serverSearchEnabled: z.boolean(),
    mflWritesEnabled: z.boolean(),
    patchReceiptId: z.uuid().optional(),
  })
  .strict();
export type OwnerStatusConfig = z.infer<typeof OwnerStatusConfigSchema>;
const empty = z.object({}).strict();
const sum = (rows: any[], statuses: string[], field: string) =>
  rows
    .filter((r) => statuses.includes(r.status))
    .reduce((s, r) => s + Number(r[field] ?? 0), 0);
const walletRows = (rows: any[], heldStatuses: string[]) => ({
  settledMicros: sum(rows, ["settled", "completed"], "actual"),
  heldMicros: sum(rows, heldStatuses, "reserved"),
  byStatus: rows.map((r) => ({
    status: r.status,
    count: Number(r.count),
    reservationMicros: Number(r.reserved),
    knownSettledMicros: Number(r.actual),
  })),
});
async function scoped(tx: Tx, job: Job, config: OwnerStatusConfig) {
  const row = (
    await tx.query(
      `SELECT b.league_id,b.team_id,t.owner_id,a.budget_micros,a.spent_micros,a.reserved_micros,m.id manifest_id,m.version manifest_version,m.document,m.activated_at
 FROM runtime_jobs j JOIN runtime_agents a ON a.id=j.agent_id JOIN runtime_bindings b ON b.agent_id=a.id
 JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id
 JOIN provider_manifests m ON m.agent_id=a.id AND m.league_id=b.league_id AND m.status='active'
 WHERE j.id=$1 AND j.agent_id=$2 AND j.fence=$3 AND j.worker_id=$4 AND j.status='running' AND j.lease_until>clock_timestamp()
 AND j.execution_mode='owner' AND a.enabled AND a.kind='ai' AND t.kind='ai' AND a.model=$5 AND m.id=$6
 AND m.document->>'model'=a.model AND m.document->>'agentId'=a.id AND m.document->>'leagueId'=b.league_id
 FOR SHARE OF j,a,b,t,m`,
      [
        job.id,
        job.agentId,
        job.fence,
        job.workerId,
        job.model,
        config.manifestId,
      ],
    )
  ).rows[0];
  if (!row) throw new RuntimeError("OWNER_STATUS_JOB_AUTHORITY_EXPIRED");
  return row;
}

/** Fresh scoped DB snapshot plus the actual calling worker's safe configuration. No network or writes. */
export async function buildOwnerRuntimeStatus(
  db: Db,
  job: Job,
  input: OwnerStatusConfig,
) {
  const config = OwnerStatusConfigSchema.parse(input);
  return transaction(db, async (tx) => {
    const row = await scoped(tx, job, config),
      d = row.document;
    const observedAt = (await tx.query("SELECT clock_timestamp() now")).rows[0]
      .now;
    const modelRows = (
      await tx.query(
        "SELECT status,count(*) count,COALESCE(sum(amount_micros),0) reserved,COALESCE(sum(actual_micros),0) actual FROM runtime_reservations WHERE agent_id=$1 GROUP BY status",
        [job.agentId],
      )
    ).rows;
    const researchRows = (
      await tx.query(
        "SELECT status,count(*) count,COALESCE(sum(reservation_micros),0) reserved,COALESCE(sum(actual_micros),0) actual FROM research_paid_operations WHERE agent_id=$1 AND league_id=$2 GROUP BY status",
        [job.agentId, row.league_id],
      )
    ).rows;
    const expenseRows = (
      await tx.query(
        "SELECT status,count(*) count,COALESCE(sum(reserved_micros),0) reserved,COALESCE(sum(actual_micros),0) actual FROM franchise_expenses WHERE agent_id=$1 AND league_id=$2 GROUP BY status",
        [job.agentId, row.league_id],
      )
    ).rows;
    const host = await getFootballHost(tx, row.league_id);
    const stage =
      (
        await tx.query(
          "SELECT id,status FROM runtime_owner_stages WHERE league_id=$1 ORDER BY configured_at DESC LIMIT 1",
          [row.league_id],
        )
      ).rows[0] ?? null;
    const patch = config.patchReceiptId
      ? (
          await tx.query(
            "SELECT seq,created_at,details FROM runtime_receipts WHERE type='operator.harness_patch_deployed' AND details->>'receiptId'=$1 AND details->>'manifestHarness'=$2 ORDER BY seq DESC LIMIT 1",
            [config.patchReceiptId, d.harnessVersion],
          )
        ).rows[0]
      : null;
    const policy = (
      await tx.query(
        "SELECT seq,created_at,details FROM runtime_receipts WHERE type='operator.reasoning_policy_configured' AND EXISTS(SELECT 1 FROM jsonb_array_elements(details->'settings') s WHERE s->>'agentId'=$1 AND s->>'model'=$2 AND s->>'provider'=$3) ORDER BY seq DESC LIMIT 1",
        [job.agentId, d.model, d.providerSlug],
      )
    ).rows[0];
    const policySetting = policy?.details?.settings?.find(
      (s: any) =>
        s.agentId === job.agentId &&
        s.model === d.model &&
        s.provider === d.providerSlug,
    );
    const model = walletRows(modelRows, ["reserved", "uncertain"]),
      research = walletRows(researchRows, [
        "reserved",
        "dispatched",
        "unknown",
      ]),
      expenses = walletRows(expenseRows, ["reserved", "uncertain"]);
    const spent = Number(row.spent_micros),
      held = Number(row.reserved_micros),
      budget = Number(row.budget_micros);
    const after = await scoped(tx, job, config);
    if (
      after.league_id !== row.league_id ||
      after.team_id !== row.team_id ||
      after.owner_id !== row.owner_id
    )
      throw new RuntimeError("OWNER_STATUS_BINDING_CHANGED");
    return {
      observedAt,
      scope: {
        leagueId: row.league_id,
        teamId: row.team_id,
        agentId: job.agentId,
      },
      identity: {
        manifestId: row.manifest_id,
        manifestVersion: row.manifest_version,
        activatedAt: row.activated_at,
        developer: d.developer,
        model: d.model,
        canonicalModel: d.canonicalModel ?? null,
        servingProvider: d.providerSlug,
        acceptedReportedProviderNames: d.reportedProviderNames,
        quantization: d.quantization ?? null,
        openWeight: d.openWeight ?? null,
        harnessId: d.harnessId,
        harnessVersion: d.harnessVersion,
        buzzBridgeVersion: d.buzzBridgeVersion,
      },
      runtime: {
        stage,
        configured: {
          maxOutputTokens: config.maxOutputTokens,
          maxCallsPerTurn: config.maxCallsPerTurn,
          requestTimeoutMs: config.requestTimeoutMs,
          turnReservationMicros: config.turnReservationMicros,
          reasoningEffort: config.reasoningEffort,
          firecrawlConfigured: config.firecrawlConfigured,
          serverSearchEnabled: config.serverSearchEnabled,
          defaultPageReader: "secure-public",
          paidScrapeRequiresExplicitChoice: true,
        },
        reasoningPolicy: policySetting
          ? {
              receiptSeq: policy.seq,
              observedAt: policy.created_at,
              effort: policySetting.effort,
              matchesRunningConfiguration:
                policySetting.effort === config.reasoningEffort,
            }
          : null,
        patch: patch
          ? {
              receiptSeq: patch.seq,
              receiptId: config.patchReceiptId,
              recordedAt: patch.created_at,
              patch:
                typeof patch.details.patch === "string"
                  ? patch.details.patch
                  : null,
              sourceHash:
                typeof patch.details.sourceHash === "string"
                  ? patch.details.sourceHash
                  : null,
              status: "operator-recorded-deployment",
            }
          : {
              status: "unknown",
              reason: "No matching deployment receipt was bound to this worker",
            },
      },
      wallet: {
        unit: "USD micros",
        budgetMicros: budget,
        spentMicros: spent,
        heldMicros: held,
        availableMicros: budget - spent - held,
        breakdown: {
          modelJobs: model,
          research,
          approvedExpenses: expenses,
          unclassifiedSpentMicros:
            spent -
            model.settledMicros -
            research.settledMicros -
            expenses.settledMicros,
          unclassifiedHeldMicros:
            held - model.heldMicros - research.heldMicros - expenses.heldMicros,
        },
        note: "Holds are unavailable budget, not confirmed spending. Model jobs include canaries and guardrail checks. Research credits use internal plan allocation, not a proven cash invoice.",
      },
      football: {
        host: host.kind,
        hostVersion: host.version,
        identity:
          host.kind === "mfl"
            ? {
                season: host.identity.season,
                mflLeagueId: host.identity.leagueId,
              }
            : null,
        writesEnabled: config.mflWritesEnabled,
        nativeSettings: {
          status: "unknown",
          reason:
            "No fresh native settings read is performed by runtime_status; use mfl_read for host state and rules. Host binding alone does not prove native configuration or ratification.",
        },
      },
      permissions: {
        manifestTools: d.toolPermissions,
        note: "The active stage and action handlers may further restrict these permissions. Status disclosure does not grant actions.",
      },
    };
  });
}

/** Optional registration: root must authorize this tool or use the context builder without a new tool. */
export function createOwnerRuntimeStatusTools(
  db: Db,
  config: OwnerStatusConfig,
): OwnerReadTool[] {
  return [
    {
      name: "runtime_status",
      description:
        "Read your current assigned model/provider/harness, this worker's configured reasoning and call limits, your own canonical wallet breakdown and football host binding. No account credentials, other-owner wallets, network calls or mutation. Unknown native settings remain unknown.",
      parameters: z.toJSONSchema(empty),
      execute: async (job, input) => {
        empty.parse(input);
        return buildOwnerRuntimeStatus(db, job, config);
      },
    },
  ];
}
