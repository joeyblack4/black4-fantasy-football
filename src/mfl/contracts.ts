import { z } from "zod";
export const PlayerId = z.string().regex(/^\d{4,5}$/);
const ids = z
  .array(PlayerId)
  .max(100)
  .refine((v) => new Set(v).size === v.length, "Duplicate player IDs");
export const MflConfigSchema = z
  .object({
    leagueId: z.string().min(1).max(100),
    season: z.number().int().min(2026).max(2100),
    host: z.string().regex(/^www\d{2}\.myfantasyleague\.com$/),
    mflLeagueId: z.string().regex(/^\d{4,5}$/),
    mode: z.enum(["real", "synthetic"]),
    userAgent: z.string().regex(/^[A-Za-z0-9 ._\/-]{5,100}$/),
    franchises: z
      .array(
        z
          .object({
            teamId: z.string().min(1).max(150),
            ownerId: z.string().min(1).max(150),
            franchiseId: z.string().regex(/^(?!0000)\d{4}$/),
          })
          .strict(),
      )
      .min(2)
      .max(32),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const key of ["teamId", "ownerId", "franchiseId"] as const)
      if (new Set(v.franchises.map((f) => f[key])).size !== v.franchises.length)
        ctx.addIssue({
          code: "custom",
          message: "Duplicate franchise binding " + key,
        });
  });
export type MflConfig = z.infer<typeof MflConfigSchema>;
export const MflOwnerActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("draft"),
      round: z.number().int().min(1).max(100),
      pick: z.number().int().min(1).max(100),
      playerId: PlayerId,
    })
    .strict(),
  z
    .object({
      type: z.literal("lineup"),
      week: z.number().int().min(1).max(22),
      starters: ids,
    })
    .strict(),
  z
    .object({
      type: z.literal("addDrop"),
      addPlayerId: PlayerId.optional(),
      dropPlayerIds: ids.default([]),
    })
    .strict()
    .refine((v) => !!v.addPlayerId || v.dropPlayerIds.length > 0)
    .refine((v) => !v.addPlayerId || !v.dropPlayerIds.includes(v.addPlayerId)),
  z
    .object({
      type: z.literal("replaceBids"),
      round: z.number().int().min(1).max(100),
      bids: z
        .array(
          z
            .object({
              addPlayerId: PlayerId,
              dropPlayerId: PlayerId.optional(),
              amount: z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/),
            })
            .strict()
            .refine((v) => v.addPlayerId !== v.dropPlayerId),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("proposeTrade"),
      counterpartyTeamId: z.string().min(1).max(150),
      givePlayerIds: ids.min(1),
      receivePlayerIds: ids.min(1),
      expiresAt: z.iso.datetime().optional(),
    })
    .strict()
    .refine(
      (v) => !v.givePlayerIds.some((p) => v.receivePlayerIds.includes(p)),
    ),
  z
    .object({
      type: z.literal("respondTrade"),
      tradeId: z.string().regex(/^\d{1,20}$/),
      response: z.enum(["accept", "reject", "revoke"]),
    })
    .strict(),
]);
export type MflOwnerAction = z.infer<typeof MflOwnerActionSchema>;
export const MflOwnerReadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("roster") }).strict(),
  z.object({ type: z.literal("rosters") }).strict(),
  z.object({ type: z.literal("pendingBids") }).strict(),
  z.object({ type: z.literal("pendingTrades") }).strict(),
  z.object({ type: z.literal("draft") }).strict(),
  z.object({ type: z.literal("rules") }).strict(),
  z.object({ type: z.literal("budget") }).strict(),
  z
    .object({
      type: z.literal("players"),
      position: z.string().max(10).optional(),
      search: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(200).default(100),
      offset: z.number().int().min(0).max(100000).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("lineup"),
      week: z.number().int().min(1).max(22),
    })
    .strict(),
  z
    .object({
      type: z.literal("scores"),
      week: z.number().int().min(1).max(22),
    })
    .strict(),
]);
export type MflOwnerRead = z.infer<typeof MflOwnerReadSchema>;
export type MflReceipt = {
  id: string;
  idempotencyKey: string;
  scope: string;
  leagueId: string;
  teamId: string;
  franchiseId: string;
  actorId: string;
  action: MflOwnerAction;
  actionHash: string;
  state: "prepared" | "submitted" | "verified" | "rejected" | "unknown";
  synthetic: boolean;
  at: string;
  reason?: string;
  responseHash?: string;
  upstreamAccepted?: boolean;
  upstreamRejected?: boolean;
  before?: unknown;
  result?: unknown;
  affectedTeamIds: string[];
  replayed?: boolean;
};
export class MflError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export type MflReadReceipt = {
  id: string;
  at: string;
  synthetic: boolean;
  leagueId: string;
  teamId: string;
  data: unknown;
};
export type MflJournalSession = {
  cached(key: string, maxAgeSeconds: number): Promise<unknown | null>;
  beforeRequest(intervalMs: number): Promise<void>;
  find(key: string): Promise<MflReceipt | null>;
  unresolved(): Promise<MflReceipt[]>;
  append(receipt: Omit<MflReceipt, "at">): Promise<MflReceipt>;
  recordRead(
    data: Record<string, unknown>,
  ): Promise<{ id: string; at: string }>;
};
export interface MflJournal {
  withLock<T>(
    scope: string,
    work: (session: MflJournalSession) => Promise<T>,
  ): Promise<T>;
}
