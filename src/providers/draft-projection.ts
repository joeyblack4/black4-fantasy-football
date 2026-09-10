import { z } from "zod";
import { FootballActionSchema } from "../runtime/football-schema.js";
import { MflOwnerActionSchema } from "../mfl/contracts.js";
import { MflLocalDraftQueueCommandSchema } from "../mfl/draft-queue.js";

/** A presentation scope, never an authority grant or a replacement runtime validator. */
export function isDraftRehearsalContext(context: any): boolean {
  const r = context?.rehearsal;
  return (
    r?.status === "armed" &&
    r.disposableFootball === true &&
    r.host?.host === "mfl" &&
    r.host.config?.leagueId === "46625"
  );
}

/** Lossless slot/order projection. Full native snapshots and receipts remain untouched. */
export function projectDraftForModel(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const state = input as Record<string, any>;
  if (
    !Array.isArray(state.picks) ||
    !Number.isInteger(state.round) ||
    !Number.isInteger(state.pick)
  )
    return input;
  // Unknown/extended row schemas stay verbatim rather than silently dropping fields.
  if (
    state.picks.some(
      (p: any) =>
        !p ||
        typeof p !== "object" ||
        Array.isArray(p) ||
        Object.keys(p).some(
          (k) => !["round", "pick", "franchiseId", "playerId"].includes(k),
        ) ||
        !Number.isInteger(p.round) ||
        !Number.isInteger(p.pick) ||
        typeof p.franchiseId !== "string" ||
        !(p.playerId === null || typeof p.playerId === "string"),
    )
  )
    return input;
  const future = (p: any) =>
    p.playerId === null &&
    (p.round > state.round || (p.round === state.round && p.pick > state.pick));
  const slots = state.picks.filter(future);
  if (!slots.length) return input;
  return {
    ...state,
    picks: state.picks.filter((p: any) => !future(p)),
    emptyFutureSlots: {
      encoding: "[sourceIndex,round,pick,franchiseId]; playerId is null",
      slots: state.picks.flatMap((p: any, i: number) =>
        future(p) ? [[i, p.round, p.pick, p.franchiseId]] : [],
      ),
      instruction:
        "These are exact unfilled future slots from the same native snapshot, not completed picks. All completed, current and prior slots remain in picks. Native authority and journal retain the complete original objects.",
    },
  };
}
const draft = MflOwnerActionSchema.options.find(
  (s) => s.shape.type.value === "draft",
)!;
/** Narrow only the advertised response branch; the authoritative action parser stays unchanged. */
export function draftFootballResponseContract(): Record<string, any> {
  return z.toJSONSchema(
    FootballActionSchema.extend({
      command: z.union([
        MflLocalDraftQueueCommandSchema,
        z.object({ type: z.literal("mfl"), action: draft }).strict(),
      ]),
    }),
  );
}
