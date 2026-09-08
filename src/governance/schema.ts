import { z } from "zod";
import { leagueRulesSchema } from "../league/schema.js";
import { leagueCapabilityVersion } from "../league/capabilities.js";
import { ScoringRulesSchema } from "../data/index.js";
import { mflGovernanceCommands } from "./mfl-schema.js";
export * from "./mfl-schema.js";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const common = { leagueId: id, idempotencyKey: z.string().min(1).max(160) };
export const governanceCommandSchema = z.discriminatedUnion("type", [
  ...mflGovernanceCommands,
  z
    .object({
      ...common,
      type: z.literal("openMeeting"),
      meetingId: id,
      menuId: id.optional(),
      discussionOpensAt: z.iso.datetime({ offset: true }).optional(),
      proposalDeadline: z.iso.datetime({ offset: true }),
      voteDeadline: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("submitProposal"),
      meetingId: id,
      proposalId: id,
      version: id,
      title: z.string().min(1).max(200),
      rationale: z.string().min(1).max(8000),
      rules: leagueRulesSchema,
      scoringRules: ScoringRulesSchema,
      capabilityVersion: z
        .literal(leagueCapabilityVersion)
        .default(leagueCapabilityVersion),
      teamOrder: z
        .array(id)
        .length(12)
        .refine(
          (x) => new Set(x).size === 12,
          "Draft order must contain twelve distinct teams",
        ),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("castVote"),
      proposalId: id,
      choice: z.enum(["yes", "no"]),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("prepareRatification"),
      proposalId: id,
    })
    .strict(),
]);
export type GovernanceCommand = z.infer<typeof governanceCommandSchema>;
