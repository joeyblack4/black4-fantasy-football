import { z } from "zod";
import { leagueCommandSchema, type LeagueCommand } from "../league/schema.js";
import { MflLocalDraftQueueCommandSchema } from "../mfl/draft-queue.js";
import { MflOwnerActionSchema } from "../mfl/contracts.js";
const ownerTypes = [
  "draftPick",
  "setDraftQueue",
  "setLineup",
  "proposeTrade",
  "acceptTrade",
  "cancelTrade",
  "rejectTrade",
  "submitClaim",
  "cancelClaim",
  "addFreeAgent",
] as const;
export type OwnerFootballCommand = LeagueCommand extends infer C
  ? C extends { type: (typeof ownerTypes)[number] }
    ? Omit<C, "leagueId" | "idempotencyKey">
    : never
  : never;
// Reuse the authoritative command field validators, stripping all transport/actor authority.
const ownerSchemas = leagueCommandSchema.options
  .filter((schema) =>
    (ownerTypes as readonly string[]).includes(schema.shape.type.value),
  )
  .map((schema) =>
    (schema as z.ZodObject<any>).omit({ leagueId: true, idempotencyKey: true }),
  );
if (ownerSchemas.length !== ownerTypes.length)
  throw new Error("Owner command schema coverage changed");
export const OwnerFootballCommandSchema = z.discriminatedUnion(
  "type",
  ownerSchemas as any,
) as unknown as z.ZodType<OwnerFootballCommand>;
export const FootballActionSchema = z
  .object({
    type: z.literal("football"),
    causalId: z.string().min(1).max(200),
    command: z.union([
      OwnerFootballCommandSchema,
      MflLocalDraftQueueCommandSchema,
      z
        .object({ type: z.literal("mfl"), action: MflOwnerActionSchema })
        .strict(),
    ]),
  })
  .strict();
export type FootballAction = z.infer<typeof FootballActionSchema>;
