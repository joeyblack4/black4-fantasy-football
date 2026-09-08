import { roundRobin, regularSeasonSchedule } from "../league/schedule.js";
export { roundRobin, regularSeasonSchedule } from "../league/schedule.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "../db.js";
import {
  scoreStats,
  ScoringRulesSchema,
  type ScoringRules,
} from "../data/index.js";
import type { Actor, LeagueRules } from "../league/schema.js";
const id = z.string().min(1).max(120);
const rulesSchema = ScoringRulesSchema;
const configSchema = z
  .object({
    leagueId: id,
    week: z.number().int().min(1).max(18),
    feedId: id,
    rules: rulesSchema,
    matchups: z
      .array(z.object({ homeTeamId: id, awayTeamId: id }).strict())
      .min(1),
    playerGames: z
      .array(z.object({ playerId: id, gameId: id }).strict())
      .max(10000),
  })
  .strict();
export type ScoreboardConfiguration = z.infer<typeof configSchema>;
const mappingSchema = z
  .object({
    leagueId: id,
    week: z.number().int().min(1).max(18),
    playerId: id,
    gameId: id,
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.string().min(1).max(160),
    reason: z.string().min(8).max(1000),
  })
  .strict();
export type PlayerGameMappingCommand = z.infer<typeof mappingSchema>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export class ScoreboardService {
  constructor(private readonly db: Db) {}
  async configure(actor: Actor, input: ScoreboardConfiguration) {
    const config = configSchema.parse(input);
    if (
      actor.role !== "commissioner" ||
      !actor.id ||
      actor.leagueId !== config.leagueId
    )
      throw new Error("Scoped commissioner required");
    // Validate the rules even with no available stats. This rejects ambiguous tiers.
    scoreStats({}, config.rules);
    if (
      !Object.values(config.rules.milliPointsPerUnit).some((v) => v !== 0) &&
      !config.rules.defensePointsAllowed
    )
      throw new Error("Scoring needs a nonzero rule");
    if (
      new Set(config.playerGames.map((p) => p.playerId)).size !==
      config.playerGames.length
    )
      throw new Error("Duplicate player mapping");
    const configHash = hash(config),
      rulesHash = hash(config.rules);
    return transaction(this.db, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [config.leagueId],
      );
      const previous = await client.query(
        "SELECT config_hash FROM scoring_configs WHERE league_id=$1 AND week=$2",
        [config.leagueId, config.week],
      );
      const league = await client.query(
        "SELECT status,current_week,constitution_version,ratified_scoring_rules,rules FROM leagues WHERE id=$1 FOR UPDATE",
        [config.leagueId],
      );
      if (!league.rowCount) throw new Error("League is unavailable");
      if (!league.rows[0].constitution_version)
        throw new Error(
          "Constitution must be ratified before scoring configuration",
        );
      if (
        !league.rows[0].ratified_scoring_rules ||
        hash(league.rows[0].ratified_scoring_rules) !== rulesHash
      )
        throw new Error(
          "Scoring rules do not match the owner-voted constitution",
        );
      if (previous.rowCount) {
        if (previous.rows[0].config_hash !== configHash)
          throw new Error("Scoring configuration is immutable");
        return { configHash, replayed: true };
      }
      const existingRules = await client.query(
        "SELECT rules_hash,feed_id FROM scoring_configs WHERE league_id=$1 LIMIT 1",
        [config.leagueId],
      );
      if (
        existingRules.rowCount &&
        (existingRules.rows[0].rules_hash !== rulesHash ||
          existingRules.rows[0].feed_id !== config.feedId)
      )
        throw new Error("Season scoring rules and feed are immutable");
      if (league.rows[0].status !== "setup") {
        if (
          league.rows[0].status !== "active" ||
          config.week <= league.rows[0].current_week ||
          !existingRules.rowCount
        )
          throw new Error(
            "Only an upcoming week with frozen season scoring can be configured after drafting",
          );
        const missing = await client.query(
          "SELECT r.player_id FROM league_rosters r LEFT JOIN league_player_games g ON g.league_id=r.league_id AND g.player_id=r.player_id AND g.week=$2 WHERE r.league_id=$1 AND (g.player_id IS NULL OR g.status NOT IN ('scheduled','bye') OR (g.status='scheduled' AND g.kickoff_at<=clock_timestamp())) LIMIT 1",
          [config.leagueId, config.week],
        );
        if (missing.rowCount)
          throw new Error(
            "Upcoming roster schedule must be verified and unstarted",
          );
        for (const mapping of config.playerGames)
          await this.verifyUnscoredFuture(
            client,
            config.leagueId,
            config.week,
            config.feedId,
            mapping.playerId,
            [mapping.gameId],
          );
      }
      const teams = (
        await client.query(
          "SELECT id FROM league_teams WHERE league_id=$1 ORDER BY draft_position",
          [config.leagueId],
        )
      ).rows.map((row) => row.id as string);
      const schedule = regularSeasonSchedule(
        teams,
        league.rows[0].rules.regularSeasonWeeks ?? 14,
      );
      const planned = schedule.find((w) => w.week === config.week);
      if (!planned)
        throw new Error(
          "Week is outside the ratified regular season; playoff mechanics are not implemented",
        );
      const ordered = (matches: { homeTeamId: string; awayTeamId: string }[]) =>
        [...matches].sort((a, b) => a.homeTeamId.localeCompare(b.homeTeamId));
      const matched = config.matchups.flatMap((m) => [
        m.homeTeamId,
        m.awayTeamId,
      ]);
      if (
        matched.length !== teams.length ||
        new Set(matched).size !== teams.length ||
        matched.some((t) => !teams.includes(t))
      )
        throw new Error("Every team must appear in exactly one matchup");
      if (hash(ordered(planned.matchups)) !== hash(ordered(config.matchups)))
        throw new Error(
          "Matchups differ from the ratified deterministic schedule",
        );

      const players = await client.query(
        "SELECT id FROM league_players WHERE league_id=$1 AND id=ANY($2::text[])",
        [config.leagueId, config.playerGames.map((p) => p.playerId)],
      );
      if (players.rowCount !== config.playerGames.length)
        throw new Error("Unknown canonical player mapping");
      await client.query(
        "INSERT INTO scoring_configs(league_id,week,feed_id,rules,config_hash,rules_hash,configured_by,constitution_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          config.leagueId,
          config.week,
          config.feedId,
          config.rules,
          configHash,
          rulesHash,
          actor.id,
          league.rows[0].constitution_version,
        ],
      );
      for (const matchup of config.matchups)
        await client.query(
          "INSERT INTO scoring_matchups(league_id,week,home_team_id,away_team_id) VALUES($1,$2,$3,$4)",
          [
            config.leagueId,
            config.week,
            matchup.homeTeamId,
            matchup.awayTeamId,
          ],
        );
      for (const mapping of config.playerGames)
        await client.query(
          "INSERT INTO scoring_player_games(league_id,week,player_id,game_id) VALUES($1,$2,$3,$4)",
          [config.leagueId, config.week, mapping.playerId, mapping.gameId],
        );
      return { configHash, replayed: false };
    });
  }
  async addPlayerGameMapping(actor: Actor, input: PlayerGameMappingCommand) {
    const command = mappingSchema.parse(input);
    if (
      actor.role !== "commissioner" ||
      !actor.id ||
      actor.leagueId !== command.leagueId
    )
      throw new Error("Scoped commissioner required");
    const payloadHash = hash(command);
    return transaction(this.db, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [command.leagueId],
      );
      const replay = await client.query(
        "SELECT * FROM scoring_mapping_events WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [command.leagueId, actor.id, command.idempotencyKey],
      );
      if (replay.rowCount) {
        if (replay.rows[0].payload_hash !== payloadHash)
          throw new Error("Mapping idempotency conflict");
        return { ...replay.rows[0], replayed: true };
      }
      const config = await client.query(
        "SELECT c.feed_id,l.current_week FROM scoring_configs c JOIN leagues l ON l.id=c.league_id WHERE c.league_id=$1 AND c.week=$2 FOR UPDATE OF l",
        [command.leagueId, command.week],
      );
      if (!config.rowCount || command.week < config.rows[0].current_week)
        throw new Error("Historical or missing scoring configuration");
      const previous = await client.query(
        "SELECT game_id,version FROM scoring_player_games WHERE league_id=$1 AND week=$2 AND player_id=$3",
        [command.leagueId, command.week, command.playerId],
      );
      const version = previous.rows[0]?.version ?? 0;
      if (version !== command.expectedVersion)
        throw new Error("Stale mapping version");
      if (previous.rows[0]?.game_id === command.gameId)
        throw new Error("Player already has that game mapping");
      await this.verifyUnscoredFuture(
        client,
        command.leagueId,
        command.week,
        config.rows[0].feed_id,
        command.playerId,
        [previous.rows[0]?.game_id, command.gameId].filter(
          (x): x is string => !!x,
        ),
      );
      await client.query(
        "INSERT INTO scoring_player_games(league_id,week,player_id,game_id,version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(league_id,week,player_id) DO UPDATE SET game_id=EXCLUDED.game_id,version=EXCLUDED.version",
        [
          command.leagueId,
          command.week,
          command.playerId,
          command.gameId,
          version + 1,
        ],
      );
      const event = await client.query(
        "INSERT INTO scoring_mapping_events(id,league_id,week,player_id,actor_id,idempotency_key,payload_hash,previous_game_id,game_id,version,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
        [
          randomUUID(),
          command.leagueId,
          command.week,
          command.playerId,
          actor.id,
          command.idempotencyKey,
          payloadHash,
          previous.rows[0]?.game_id ?? null,
          command.gameId,
          version + 1,
          command.reason,
        ],
      );
      return { ...event.rows[0], replayed: false };
    });
  }
  private async verifyUnscoredFuture(
    client: import("../db.js").Tx,
    leagueId: string,
    week: number,
    feedId: string,
    playerId: string,
    gameIds: string[],
  ) {
    // Match ingestion's stream lock: a concurrent first observation cannot race the unscored check.
    for (const gameId of [...new Set(gameIds)].sort())
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify([feedId, gameId, playerId])],
      );
    const schedule = await client.query(
      "SELECT status,kickoff_at>clock_timestamp() AS future FROM league_player_games WHERE league_id=$1 AND week=$2 AND player_id=$3",
      [leagueId, week, playerId],
    );
    if (
      !schedule.rowCount ||
      schedule.rows[0].status !== "scheduled" ||
      !schedule.rows[0].future
    )
      throw new Error(
        "Mapping requires a verified unstarted scheduled player game",
      );
    if (
      (
        await client.query(
          "SELECT 1 FROM data_stat_snapshots WHERE feed_id=$1 AND player_id=$2 AND game_id=ANY($3::text[]) LIMIT 1",
          [feedId, playerId, gameIds],
        )
      ).rowCount
    )
      throw new Error("Observed or scored game mapping cannot change");
  }
  async schedule(leagueId: string) {
    id.parse(leagueId);
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const league = (
        await tx.query(
          "SELECT rules,constitution_version FROM leagues WHERE id=$1",
          [leagueId],
        )
      ).rows[0];
      if (!league || !league.constitution_version)
        throw new Error("Ratified league schedule is unavailable");
      const teams = (
        await tx.query(
          "SELECT id FROM league_teams WHERE league_id=$1 ORDER BY draft_position",
          [leagueId],
        )
      ).rows.map((r) => r.id);
      const configs = (
        await tx.query(
          "SELECT week,feed_id FROM scoring_configs WHERE league_id=$1 ORDER BY week",
          [leagueId],
        )
      ).rows;
      const weeks = regularSeasonSchedule(
        teams,
        league.rules.regularSeasonWeeks ?? 14,
      ).map((w) => {
        const c = configs.find((c) => c.week === w.week);
        return {
          ...w,
          configurationStatus: c ? "configured" : "missing",
          feedId: c?.feed_id ?? null,
        };
      });
      return {
        leagueId,
        constitutionVersion: league.constitution_version,
        algorithm: "circle-repeat-v1",
        regularSeasonWeeks: weeks.length,
        weeks,
        postseason: "not-implemented",
      };
    });
  }
  async snapshot(leagueId: string, week: number) {
    id.parse(leagueId);
    z.number().int().min(1).max(18).parse(week);
    return transaction(this.db, async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const configResult = await client.query(
        "SELECT c.*,l.rules AS league_rules,l.ratified_scoring_rules,transaction_timestamp() AS checked_at FROM scoring_configs c JOIN leagues l ON l.id=c.league_id WHERE c.league_id=$1 AND c.week=$2",
        [leagueId, week],
      );
      if (!configResult.rowCount)
        throw new Error("Scoring configuration is unavailable");
      const config = configResult.rows[0];
      const rules = config.rules as ScoringRules;
      if (
        !config.ratified_scoring_rules ||
        hash(config.ratified_scoring_rules) !== hash(rules)
      )
        throw new Error(
          "Scoring configuration lacks matching owner-voted rules",
        );
      const slots = (config.league_rules as LeagueRules).lineupSlots;
      const rows = await client.query(
        "SELECT t.id AS team_id,t.name AS team_name,l.slot_id,l.player_id,g.game_id,g.version AS mapping_version,s.id AS snapshot_id,s.revision,s.stats,s.source_at,s.observed_at,s.game_status,s.synthetic FROM league_teams t LEFT JOIN league_lineups l ON l.league_id=t.league_id AND l.team_id=t.id AND l.week=$2 LEFT JOIN scoring_player_games g ON g.league_id=t.league_id AND g.week=$2 AND g.player_id=l.player_id LEFT JOIN data_latest_stats p ON p.feed_id=$3 AND p.game_id=g.game_id AND p.player_id=l.player_id LEFT JOIN data_stat_snapshots s ON s.id=p.snapshot_id WHERE t.league_id=$1 ORDER BY t.draft_position,l.slot_id",
        [leagueId, week, config.feed_id],
      );
      const teamIds = [...new Set(rows.rows.map((r) => r.team_id as string))];
      const teams = teamIds.map((teamId) => {
        const teamRows = rows.rows.filter((r) => r.team_id === teamId);
        const starters = slots.map((slot) => {
          const row = teamRows.find((r) => r.slot_id === slot.id);
          if (!row?.player_id)
            return {
              slotId: slot.id,
              playerId: null,
              milliPoints: null,
              status: "empty" as const,
              missing: ["lineup"],
              synthetic: null,
              provenance: null,
            };
          if (!row.snapshot_id)
            return {
              slotId: slot.id,
              playerId: row.player_id as string,
              milliPoints: null,
              status: "unknown" as const,
              missing: [row.game_id ? "stats" : "game mapping"],
              synthetic: null,
              provenance: null,
            };
          const score = scoreStats(row.stats, rules);
          const ageMs =
            row.source_at === null
              ? null
              : Math.max(
                  0,
                  new Date(config.checked_at).getTime() -
                    new Date(row.source_at).getTime(),
                );
          const status =
            score.milliPoints === null
              ? "partial"
              : ["cancelled", "postponed"].includes(row.game_status)
                ? row.game_status
                : ageMs === null
                  ? "unknown-freshness"
                  : row.game_status === "final"
                    ? "final"
                    : ageMs > 120000
                      ? "stale"
                      : "provisional";
          return {
            slotId: slot.id,
            playerId: row.player_id as string,
            milliPoints: ["cancelled", "postponed"].includes(row.game_status)
              ? null
              : score.milliPoints,
            status: status as string,
            missing: score.missing,
            synthetic: row.synthetic as boolean,
            provenance: {
              snapshotId: row.snapshot_id as string,
              revision: String(row.revision),
              gameId: row.game_id as string,
              mappingVersion: row.mapping_version as number,
              sourceAt: row.source_at as Date | null,
              observedAt: row.observed_at as Date,
              ageMs,
            },
            breakdown: score.breakdown,
          };
        });
        const syntheticValues = new Set(
          starters.filter((p) => p.synthetic !== null).map((p) => p.synthetic),
        );
        const complete =
          starters.every((p) => p.milliPoints !== null) &&
          syntheticValues.size <= 1;
        const final = complete && starters.every((p) => p.status === "final");
        const subtotal = starters.reduce(
          (sum, p) => sum + (p.milliPoints ?? 0),
          0,
        );
        return {
          teamId,
          name: teamRows[0]!.team_name as string,
          milliPoints: complete ? subtotal : null,
          knownSubtotalMilliPoints: subtotal,
          status: final
            ? "final"
            : !complete
              ? "incomplete"
              : starters.some((p) => p.status === "stale")
                ? "stale"
                : "provisional",
          synthetic:
            syntheticValues.size > 1
              ? "mixed"
              : syntheticValues.size === 0
                ? "unknown"
                : syntheticValues.has(true)
                  ? "synthetic"
                  : "real",
          starters,
        };
      });
      const matchupRows = await client.query(
        "SELECT home_team_id,away_team_id FROM scoring_matchups WHERE league_id=$1 AND week=$2 ORDER BY home_team_id",
        [leagueId, week],
      );
      const matchups = matchupRows.rows.map((row) => {
        const home = teams.find((t) => t.teamId === row.home_team_id)!,
          away = teams.find((t) => t.teamId === row.away_team_id)!;
        const final =
          home.status === "final" &&
          away.status === "final" &&
          home.synthetic === away.synthetic;
        return {
          homeTeamId: home.teamId,
          awayTeamId: away.teamId,
          homeMilliPoints: home.milliPoints,
          awayMilliPoints: away.milliPoints,
          status: final ? "final" : "provisional",
          winnerTeamId: final
            ? home.milliPoints === away.milliPoints
              ? null
              : home.milliPoints! > away.milliPoints!
                ? home.teamId
                : away.teamId
            : null,
          tied: final ? home.milliPoints === away.milliPoints : null,
        };
      });
      const mappingHistory = (
        await client.query(
          "SELECT id,player_id,previous_game_id,game_id,version,reason,created_at FROM scoring_mapping_events WHERE league_id=$1 AND week=$2 ORDER BY created_at,id",
          [leagueId, week],
        )
      ).rows;
      return {
        leagueId,
        week,
        mappingHistory,
        feedId: config.feed_id as string,
        configHash: config.config_hash as string,
        rulesVersion: rules.version,
        constitutionVersion: config.constitution_version as string,
        computedAt: config.checked_at as Date,
        teams,
        matchups,
      };
    });
  }
}
