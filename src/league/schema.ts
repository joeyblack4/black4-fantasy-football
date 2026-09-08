import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const position = z.enum(["QB", "RB", "WR", "TE", "K", "DST"]);
const ids = z
  .array(id)
  .max(2000)
  .refine((a) => new Set(a).size === a.length, "Duplicate player IDs");
const timestamp = z.iso.datetime({ offset: true });
export const leagueRulesSchema = z
  .object({
    rosterSize: z.number().int().min(1).max(16),
    regularSeasonWeeks: z.number().int().min(1).max(17).default(14),
    scheduleAlgorithm: z
      .literal("circle-repeat-v1")
      .default("circle-repeat-v1"),
    draftOrder: z.enum(["snake", "linear"]),
    draftPickSeconds: z.number().int().min(1).max(600),
    faabBudget: z.number().int().min(0).max(100000),
    tradeDeadlineAt: timestamp.nullable().default(null),
    droppedPlayerHoldHours: z.number().int().min(0).max(168).default(24),
    freeAgentMode: z
      .enum(["waiversOnly", "scheduledFirstCome"])
      .default("waiversOnly"),
    lineupSlots: z
      .array(
        z.object({ id, positions: z.array(position).min(1).max(6) }).strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .refine(
    (r) => r.lineupSlots.length <= r.rosterSize,
    "Lineup cannot exceed roster size",
  )
  .refine(
    (r) =>
      new Set(r.lineupSlots.map((s) => s.id)).size === r.lineupSlots.length,
    "Duplicate slots",
  );
export type LeagueRules = z.infer<typeof leagueRulesSchema>;
const common = { leagueId: id, idempotencyKey: z.string().min(1).max(160) };
export const leagueCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...common,
      type: z.literal("createLeague"),
      name: z.string().min(1).max(200),
      rules: leagueRulesSchema,
      teams: z
        .array(
          z
            .object({
              id,
              name: z.string().min(1).max(120),
              ownerId: id,
              kind: z.enum(["human", "ai"]),
            })
            .strict(),
        )
        .length(12)
        .refine(
          (t) =>
            new Set(t.map((x) => x.id)).size === 12 &&
            new Set(t.map((x) => x.ownerId)).size === 12,
          "Duplicate teams or owners",
        )
        .refine(
          (t) =>
            t.filter((x) => x.kind === "ai").length === 10 &&
            t.filter((x) => x.kind === "human").length === 2,
          "This experiment requires ten AI and two human franchises",
        ),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("importPlayers"),
      players: z
        .array(
          z
            .object({
              id,
              name: z.string().min(1).max(200),
              positions: z.array(position).min(1).max(6),
            })
            .strict(),
        )
        .min(1)
        .max(5000),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("importSchedule"),
      games: z
        .array(
          z
            .object({
              playerId: id,
              week: z.number().int().min(1).max(18),
              kickoffAt: timestamp,
              status: z.enum([
                "scheduled",
                "postponed",
                "cancelled",
                "final",
                "bye",
              ]),
            })
            .strict(),
        )
        .min(1)
        .max(10000),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("ratifyConstitution"),
      proposalId: id.optional(),
      proposalHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      version: id,
      decisionReceipt: z.string().min(1).max(1000),
      rules: leagueRulesSchema.optional(),
    })
    .strict(),
  z.object({ ...common, type: z.literal("startDraft") }).strict(),
  z
    .object({
      ...common,
      type: z.literal("pauseDraft"),
      reason: z.string().min(8).max(1000),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("resumeDraft"),
      reason: z.string().min(8).max(1000),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("draftPick"),
      playerId: id,
      expectedPick: z.number().int().min(0),
      expectedDraftEpoch: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({ ...common, type: z.literal("setDraftQueue"), playerIds: ids })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("autoDraftPick"),
      expectedPick: z.number().int().min(0),
      expectedDraftEpoch: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("setLineup"),
      week: z.number().int().min(1).max(18),
      slots: z.record(id, id),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("advanceWeek"),
      week: z.number().int().min(1).max(18),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("proposeTrade"),
      tradeId: id,
      toTeamId: id,
      givePlayers: ids.refine((x) => x.length > 0),
      receivePlayers: ids.refine((x) => x.length > 0),
      expiresAt: timestamp,
    })
    .strict(),
  z.object({ ...common, type: z.literal("acceptTrade"), tradeId: id }).strict(),
  z.object({ ...common, type: z.literal("cancelTrade"), tradeId: id }).strict(),
  z.object({ ...common, type: z.literal("rejectTrade"), tradeId: id }).strict(),
  z
    .object({
      ...common,
      type: z.literal("openWaivers"),
      periodId: id,
      closesAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("submitClaim"),
      claimId: id,
      periodId: id,
      addPlayerId: id,
      dropPlayerId: id.optional(),
      bid: z.number().int().min(0).max(100000),
      priority: z.number().int().min(0).max(10000),
    })
    .strict(),
  z.object({ ...common, type: z.literal("cancelClaim"), claimId: id }).strict(),
  z
    .object({ ...common, type: z.literal("resolveWaivers"), periodId: id })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("openFreeAgency"),
      windowId: id,
      opensAt: timestamp,
      closesAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("addFreeAgent"),
      windowId: id,
      addPlayerId: id,
      dropPlayerId: id.optional(),
    })
    .strict(),
]);
export type LeagueCommand = z.infer<typeof leagueCommandSchema>;
export type Actor = {
  id: string;
  leagueId: string;
  role: "owner" | "commissioner" | "system";
  teamId?: string;
};
export class LeagueError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LeagueError";
  }
}
