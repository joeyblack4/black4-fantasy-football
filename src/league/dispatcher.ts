import { z } from "zod";
import { transaction, type Db } from "../db.js";
import { RuntimeStore } from "../runtime/index.js";
import { LeagueError, type Actor } from "./schema.js";
const inputSchema = z
  .object({
    leagueId: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
// Routine imports, private ranking queues and claim submissions do not wake every owner.
export const leagueWakeEventTypes = [
  "startDraft",
  "draftPick",
  "autoDraftPick",
  "draftPaused",
  "pauseDraft",
  "resumeDraft",
  "proposeTrade",
  "acceptTrade",
  "cancelTrade",
  "rejectTrade",
  "openWaivers",
  "resolveWaivers",
  "openFreeAgency",
  "addFreeAgent",
  "advanceWeek",
] as const;
/** Transactional committed-event -> scoped owner inbox bridge; transport never chooses recipients. */
export class LeagueEventDispatcher {
  private readonly runtime: RuntimeStore;
  constructor(private readonly db: Db) {
    this.runtime = new RuntimeStore(db);
  }
  async dispatchOnce(
    actor: Actor,
    input: { leagueId: string; limit?: number },
  ) {
    const config = inputSchema.parse(input);
    if (
      !actor.id ||
      actor.leagueId !== config.leagueId ||
      !["commissioner", "system"].includes(actor.role)
    )
      throw new LeagueError(
        "FORBIDDEN",
        "League event dispatch requires a scoped system or commissioner",
      );
    const pending = (
      await this.db.query(
        `SELECT e.id AS event_id,b.agent_id FROM league_events e
    JOIN runtime_bindings b ON b.league_id=e.league_id
    JOIN runtime_agents a ON a.id=b.agent_id AND a.enabled
    LEFT JOIN league_event_deliveries d ON d.event_id=e.id AND d.agent_id=b.agent_id
    WHERE e.league_id=$1 AND e.type=ANY($2::text[]) AND d.event_id IS NULL
      AND (e.visibility='public' OR b.team_id=ANY(e.participant_team_ids))
    ORDER BY e.id,b.agent_id LIMIT $3`,
        [config.leagueId, leagueWakeEventTypes, config.limit],
      )
    ).rows;
    let delivered = 0,
      replayed = 0;
    const failed: { eventId: string; agentId: string; code: string }[] = [];
    for (const candidate of pending) {
      try {
        const result = await transaction(this.db, async (tx) => {
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 1515))",
            [`${candidate.event_id}:${candidate.agent_id}`],
          );
          const existing = await tx.query(
            "SELECT 1 FROM league_event_deliveries WHERE event_id=$1 AND agent_id=$2",
            [candidate.event_id, candidate.agent_id],
          );
          if (existing.rowCount) return "replayed";
          const row = (
            await tx.query(
              `SELECT e.*,b.team_id FROM league_events e JOIN runtime_bindings b ON b.league_id=e.league_id AND b.agent_id=$2
       JOIN runtime_agents a ON a.id=b.agent_id AND a.enabled WHERE e.id=$1 AND e.league_id=$3
       AND (e.visibility='public' OR b.team_id=ANY(e.participant_team_ids))`,
              [candidate.event_id, candidate.agent_id, config.leagueId],
            )
          ).rows[0];
          if (!row)
            throw new LeagueError(
              "RECIPIENT_UNAVAILABLE",
              "Event recipient is unavailable or no longer authorized",
            );
          const wake = {
            agentId: candidate.agent_id,
            causalId: `league-event:${config.leagueId}:${row.id}`,
            sourceOccurredAt: row.created_at,
            priority: ([
              "startDraft",
              "draftPick",
              "autoDraftPick",
              "resumeDraft",
              "draftPaused",
              "pauseDraft",
            ].includes(row.type)
              ? "urgent"
              : "normal") as "urgent" | "normal",
            payload: {
              type: "league.event",
              leagueId: config.leagueId,
              eventId: String(row.id),
              eventType: row.type,
              receiptId: row.receipt_id,
              occurredAt: row.created_at.toISOString(),
              visibility: row.visibility,
              details: row.payload,
            },
          };
          const job = await this.runtime.ingestEventTx(tx, wake);
          await tx.query(
            "INSERT INTO league_event_deliveries(event_id,agent_id,runtime_job_id) VALUES($1,$2,$3)",
            [row.id, candidate.agent_id, job.id],
          );
          return "delivered";
        });
        if (result === "delivered") delivered++;
        else replayed++;
      } catch (error) {
        failed.push({
          eventId: String(candidate.event_id),
          agentId: candidate.agent_id,
          code: error instanceof LeagueError ? error.code : "DELIVERY_FAILED",
        });
      }
    }
    return {
      leagueId: config.leagueId,
      examined: pending.length,
      delivered,
      replayed,
      failed,
    };
  }
}
