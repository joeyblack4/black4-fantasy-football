import { z } from "zod";
import { type Db, transaction } from "../db.js";
import { RuntimeStore } from "../runtime/index.js";
import type { Actor } from "../league/schema.js";
const id = z.string().min(1).max(120);
/** Trusted bridge. The runtime's stable causal ID makes crash-before-delivery-receipt replay safe. */
export class DataDispatcher {
  private readonly runtime: RuntimeStore;
  constructor(private readonly db: Db) {
    this.runtime = new RuntimeStore(db);
  }
  async subscribe(
    actor: Actor,
    input: {
      agentId: string;
      feedId: string;
      playerId: string;
      enabled?: boolean;
    },
  ) {
    id.parse(input.agentId);
    id.parse(input.feedId);
    id.parse(input.playerId);
    if (actor.role !== "owner") throw new Error("Owner identity required");
    return transaction(this.db, async (client) => {
      const binding = await client.query(
        "SELECT 1 FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id=$1 AND b.league_id=$2 AND b.team_id=$3 AND t.owner_id=$4",
        [input.agentId, actor.leagueId, actor.teamId, actor.id],
      );
      if (!binding.rowCount)
        throw new Error("Identity does not own subscription agent");
      if (
        !(
          await client.query(
            "SELECT 1 FROM league_players WHERE league_id=$1 AND id=$2",
            [actor.leagueId, input.playerId],
          )
        ).rowCount
      )
        throw new Error("Player is outside this league");
      const result = await client.query(
        "INSERT INTO data_subscriptions(agent_id,league_id,feed_id,player_id,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(agent_id,feed_id,player_id) DO UPDATE SET enabled=EXCLUDED.enabled RETURNING *",
        [
          input.agentId,
          actor.leagueId,
          input.feedId,
          input.playerId,
          input.enabled ?? true,
        ],
      );
      return result.rows[0];
    });
  }
  async dispatchOnce(limit = 100) {
    z.number().int().min(1).max(1000).parse(limit);
    // Per-target receipts mean a disabled subscriber cannot block everyone else. No customer bindings queried.
    const pending = await this.db.query(
      `SELECT e.id AS event_id,e.kind,e.created_at,s.id AS snapshot_id,s.feed_id,s.game_id,s.player_id,s.revision,s.source_at,s.observed_at,s.synthetic,s.game_status,u.agent_id FROM data_events e JOIN data_stat_snapshots s ON s.id=e.snapshot_id JOIN data_subscriptions u ON u.feed_id=s.feed_id AND u.player_id=s.player_id AND u.enabled AND e.created_at>=u.subscribed_at JOIN runtime_agents a ON a.id=u.agent_id AND a.enabled JOIN runtime_bindings b ON b.agent_id=u.agent_id AND b.league_id=u.league_id LEFT JOIN data_deliveries d ON d.event_id=e.id AND d.agent_id=u.agent_id WHERE d.event_id IS NULL ORDER BY e.created_at,e.id,u.agent_id LIMIT $1`,
      [limit],
    );
    let delivered = 0;
    const failed: string[] = [];
    for (const row of pending.rows) {
      try {
        const job = await this.runtime.ingestEvent({
          agentId: row.agent_id,
          causalId: "data-event:" + row.event_id,
          payload: {
            type: row.kind,
            eventId: row.event_id,
            snapshotId: row.snapshot_id,
            feedId: row.feed_id,
            gameId: row.game_id,
            playerId: row.player_id,
            revision: String(row.revision),
            synthetic: row.synthetic,
            gameStatus: row.game_status,
            sourceAt: row.source_at?.toISOString() ?? null,
            observedAt: row.observed_at.toISOString(),
          },
          ...(row.source_at ? { sourceOccurredAt: row.source_at } : {}),
        });
        const receipt = await this.db.query(
          "INSERT INTO data_deliveries(event_id,agent_id,runtime_job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
          [row.event_id, row.agent_id, job.id],
        );
        if (receipt.rowCount) delivered++;
      } catch {
        failed.push(row.event_id + ":" + row.agent_id);
      }
    }
    return { examined: pending.rowCount ?? 0, delivered, failed };
  }
}
