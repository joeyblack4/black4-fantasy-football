import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type Db } from "../db.js";

export const statNames = [
  "passingYards",
  "passingTouchdowns",
  "interceptionsThrown",
  "rushingYards",
  "rushingTouchdowns",
  "receivingYards",
  "receivingTouchdowns",
  "receptions",
  "fumblesLost",
  "passingTwoPoint",
  "rushingTwoPoint",
  "receivingTwoPoint",
  "extraPointsMade",
  "fieldGoals0to39",
  "fieldGoals40to49",
  "fieldGoals50Plus",
  "defenseSacks",
  "defenseInterceptions",
  "defenseFumbleRecoveries",
  "defenseTouchdowns",
  "defenseSafeties",
  "defenseBlockedKicks",
  "defensePointsAllowed",
] as const;
export type StatName = (typeof statNames)[number];
const signedYards = new Set<string>([
  "passingYards",
  "rushingYards",
  "receivingYards",
]);
export const StatsSchema = z
  .partialRecord(
    z.enum(statNames),
    z.number().int().min(-10000).max(100000).nullable(),
  )
  .superRefine((stats, ctx) => {
    for (const [key, value] of Object.entries(stats))
      if (value !== null && value! < 0 && !signedYards.has(key))
        ctx.addIssue({ code: "custom", message: `negative count: ${key}` });
  });
export type Stats = z.infer<typeof StatsSchema>;
export const SnapshotSchema = z
  .object({
    feedId: z.string().min(1).max(100),
    gameId: z.string().min(1).max(100),
    playerId: z.string().min(1).max(100),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sourceAt: z.iso.datetime().nullable(),
    gameStatus: z.enum([
      "scheduled",
      "live",
      "final",
      "postponed",
      "cancelled",
    ]),
    synthetic: z.boolean(),
    stats: StatsSchema,
  })
  .strict();
export type StatSnapshot = z.infer<typeof SnapshotSchema>;
export interface FeedAdapter {
  readonly id: string;
  readonly synthetic: boolean;
  fetchSnapshots(date: string, signal?: AbortSignal): Promise<StatSnapshot[]>;
}
export const ScoringRulesSchema = z
  .object({
    version: z.string().min(1).max(120),
    milliPointsPerUnit: z.partialRecord(
      z.enum(statNames),
      z.number().int().min(-1000000).max(1000000),
    ),
    defensePointsAllowed: z
      .array(
        z
          .object({
            max: z.number().int().nonnegative().nullable(),
            milliPoints: z.number().int(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((rules, ctx) => {
    if (
      !Object.values(rules.milliPointsPerUnit).some((v) => v !== 0) &&
      !rules.defensePointsAllowed
    )
      ctx.addIssue({ code: "custom", message: "Scoring needs a nonzero rule" });
    const tiers = rules.defensePointsAllowed;
    if (
      tiers &&
      (!tiers.length ||
        tiers.at(-1)!.max !== null ||
        tiers
          .slice(0, -1)
          .some(
            (t, i) => t.max === null || (i > 0 && t.max <= tiers[i - 1]!.max!),
          ) ||
        !!rules.milliPointsPerUnit.defensePointsAllowed)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid or ambiguous points-allowed tiers",
      });
  });
export type ScoringRules = z.infer<typeof ScoringRulesSchema>;
export const halfPprRules: ScoringRules = {
  version: "proposal-half-ppr-v1",
  milliPointsPerUnit: {
    passingYards: 40,
    passingTouchdowns: 4000,
    interceptionsThrown: -2000,
    rushingYards: 100,
    rushingTouchdowns: 6000,
    receivingYards: 100,
    receivingTouchdowns: 6000,
    receptions: 500,
    fumblesLost: -2000,
    passingTwoPoint: 2000,
    rushingTwoPoint: 2000,
    receivingTwoPoint: 2000,
  },
};
export function scoreStats(input: Stats, rules: ScoringRules) {
  const stats = StatsSchema.parse(input);
  const missing: string[] = [];
  const breakdown: Record<string, number> = {};
  if (!rules.version) throw new Error("Scoring rules need a version");
  for (const [key, coefficient] of Object.entries(rules.milliPointsPerUnit)) {
    if (
      !statNames.includes(key as StatName) ||
      !Number.isSafeInteger(coefficient)
    )
      throw new Error("Invalid scoring coefficient");
    if (coefficient === 0) continue;
    const value = stats[key as StatName];
    if (value === null || value === undefined) missing.push(key);
    else breakdown[key] = value * coefficient!;
  }
  if (rules.defensePointsAllowed) {
    const tiers = rules.defensePointsAllowed;
    if (
      !tiers.length ||
      tiers.at(-1)!.max !== null ||
      tiers
        .slice(0, -1)
        .some(
          (t, i) =>
            t.max === null ||
            !Number.isSafeInteger(t.max) ||
            t.max < 0 ||
            (i > 0 && t.max <= tiers[i - 1]!.max!),
        ) ||
      tiers.some((t) => !Number.isSafeInteger(t.milliPoints))
    )
      throw new Error("Invalid points-allowed tiers");
    if (rules.milliPointsPerUnit.defensePointsAllowed)
      throw new Error("Points allowed cannot use both linear and tier scoring");
    const value = stats.defensePointsAllowed;
    if (value == null) missing.push("defensePointsAllowed");
    else
      breakdown.defensePointsAllowed = tiers.find(
        (t) => t.max === null || value <= t.max,
      )!.milliPoints;
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Scoring overflow");
  return {
    milliPoints: missing.length ? null : total,
    missing,
    breakdown,
    rulesVersion: rules.version,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class StatsService {
  constructor(private readonly db: Db) {}
  async ingest(input: StatSnapshot) {
    const value = SnapshotSchema.parse(input);
    const hash = createHash("sha256").update(canonical(value)).digest("hex");
    return transaction(this.db, async (client) => {
      // Serialize this stream, including the first insert; no global scoring lock.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify([value.feedId, value.gameId, value.playerId])],
      );
      const clock = await client.query("SELECT clock_timestamp() AS now");
      if (
        value.sourceAt !== null &&
        Date.parse(value.sourceAt) >
          new Date(clock.rows[0].now).getTime() + 60_000
      )
        throw new Error("Source timestamp is in the future");
      const same = await client.query(
        "SELECT id,payload_hash FROM data_stat_snapshots WHERE feed_id=$1 AND game_id=$2 AND player_id=$3 AND revision=$4",
        [value.feedId, value.gameId, value.playerId, value.revision],
      );
      if (same.rowCount) {
        if (same.rows[0].payload_hash !== hash)
          throw new Error("Source revision payload conflict");
        return {
          status: "duplicate" as const,
          snapshotId: same.rows[0].id as string,
        };
      }
      const previous = await client.query(
        "SELECT s.revision,s.synthetic,s.source_at,s.stats,s.game_status FROM data_latest_stats l JOIN data_stat_snapshots s ON s.id=l.snapshot_id WHERE l.feed_id=$1 AND l.game_id=$2 AND l.player_id=$3",
        [value.feedId, value.gameId, value.playerId],
      );
      if (previous.rowCount && previous.rows[0].synthetic !== value.synthetic)
        throw new Error("Cannot mix synthetic and real stats in one stream");
      if (
        previous.rowCount &&
        value.sourceAt !== null &&
        previous.rows[0].source_at !== null &&
        Number(previous.rows[0].revision) < value.revision &&
        Date.parse(value.sourceAt) <
          new Date(previous.rows[0].source_at).getTime()
      )
        throw new Error("New revision has older source time");
      const id = randomUUID();
      await client.query(
        "INSERT INTO data_stat_snapshots(id,feed_id,game_id,player_id,revision,source_at,game_status,synthetic,stats,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          value.feedId,
          value.gameId,
          value.playerId,
          value.revision,
          value.sourceAt,
          value.gameStatus,
          value.synthetic,
          value.stats,
          hash,
        ],
      );
      if (
        previous.rowCount &&
        Number(previous.rows[0].revision) > value.revision
      )
        return { status: "superseded" as const, snapshotId: id };
      await client.query(
        "INSERT INTO data_latest_stats(feed_id,game_id,player_id,snapshot_id) VALUES($1,$2,$3,$4) ON CONFLICT(feed_id,game_id,player_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id",
        [value.feedId, value.gameId, value.playerId, id],
      );
      const changed =
        !previous.rowCount ||
        canonical(previous.rows[0].stats) !== canonical(value.stats) ||
        previous.rows[0].game_status !== value.gameStatus;
      if (changed)
        await client.query(
          "INSERT INTO data_events(id,snapshot_id,kind) VALUES($1,$2,$3)",
          [
            randomUUID(),
            id,
            previous.rowCount ? "stats.revised" : "stats.first_observed",
          ],
        );
      return { status: "applied" as const, snapshotId: id };
    });
  }
  async latest(
    feedId: string,
    gameId: string,
    playerId: string,
    staleAfterMs = 120_000,
  ) {
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0)
      throw new Error("Invalid freshness threshold");
    const result = await this.db.query(
      "SELECT s.*,clock_timestamp() AS checked_at FROM data_latest_stats l JOIN data_stat_snapshots s ON s.id=l.snapshot_id WHERE l.feed_id=$1 AND l.game_id=$2 AND l.player_id=$3",
      [feedId, gameId, playerId],
    );
    if (!result.rowCount)
      return { availability: "unknown" as const, snapshot: null };
    const row = result.rows[0];
    if (row.source_at === null)
      return {
        availability: "unknown" as const,
        ageMs: null,
        snapshot: row,
        reason: "source timestamp unavailable",
      };
    const ageMs = Math.max(
      0,
      new Date(row.checked_at).getTime() - new Date(row.source_at).getTime(),
    );
    return {
      availability: (row.game_status === "cancelled"
        ? "cancelled"
        : row.game_status === "postponed"
          ? "postponed"
          : row.game_status === "final"
            ? "final"
            : ageMs > staleAfterMs
              ? "stale"
              : "fresh") as
        "cancelled" | "postponed" | "final" | "stale" | "fresh",
      ageMs,
      snapshot: row,
    };
  }
}
