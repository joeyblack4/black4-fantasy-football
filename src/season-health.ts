import type { Db } from "./db.js";
import { NativeSchedules } from "./runtime/native-schedules.js";
import { SEASON_INTERFACE_VERSION } from "./mfl/season.js";

/** Infrastructure metadata only. No private tasks, bid amounts, or player choices. */
export async function seasonInfrastructureHealth(db: Db, leagueId: string) {
  const teams = (
    await db.query(
      `SELECT t.id AS team_id,t.name,b.agent_id FROM league_teams t
    LEFT JOIN runtime_bindings b ON b.league_id=t.league_id AND b.team_id=t.id
    WHERE t.league_id=$1 ORDER BY t.id`,
      [leagueId],
    )
  ).rows;
  const reads = (
    await db.query(
      `SELECT DISTINCT ON(details->>'teamId')
    details->>'teamId' AS team_id, created_at AS last_read_at, details->>'id' AS receipt_id,
    details->'request'->>'type' AS read_type
    FROM runtime_receipts WHERE type='mfl_read' AND details->>'leagueId'=$1
      AND details ? 'teamId' AND details ? 'request'
    ORDER BY details->>'teamId',seq DESC`,
      [leagueId],
    )
  ).rows;
  const writes = (
    await db.query(
      `SELECT details->>'teamId' AS team_id,details->>'state' AS state,count(*)::int AS count
    FROM (SELECT DISTINCT ON(details->>'scope',details->>'idempotencyKey') details
      FROM runtime_receipts WHERE type='mfl_operation' AND details->>'leagueId'=$1
      ORDER BY details->>'scope',details->>'idempotencyKey',seq DESC) latest
    GROUP BY details->>'teamId',details->>'state'`,
      [leagueId],
    )
  ).rows;
  const feeds = (
    await db.query(
      `SELECT source,status,observed_at,last_success_at,error_code,
      EXTRACT(EPOCH FROM clock_timestamp()-last_success_at)::int AS seconds_since_success
      FROM runtime_native_schedule_feeds WHERE league_id=$1 ORDER BY source`,
      [leagueId],
    )
  ).rows;
  return {
    leagueId,
    interfaceVersion: SEASON_INTERFACE_VERSION,
    observedAt: new Date().toISOString(),
    evidenceBoundary:
      "Read receipts establish authenticated access, not owner competence or native execution. Historical operation counts include the draft. No team advice or private strategy is included.",
    owners: teams.map((team) => ({
      ...team,
      latestRead: reads.find((r) => r.team_id === team.team_id) ?? null,
      transactionStates: writes
        .filter((w) => w.team_id === team.team_id)
        .map(({ state, count }) => ({ state, count })),
    })),
    feeds,
    scheduling: await new NativeSchedules(db).health(leagueId),
  };
}
