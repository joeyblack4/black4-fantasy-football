import { z } from "zod";
import {
  governanceCommandSchema,
  type GovernanceCommand,
} from "../governance/schema.js";
const causalId = z.string().min(1).max(200);
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const ownerTypes = ["submitProposal", "submitMflProposal", "castVote"];
const options = governanceCommandSchema.options
  .filter((s) => ownerTypes.includes(s.shape.type.value))
  .map((s) =>
    (s as z.ZodObject<any>).omit({ leagueId: true, idempotencyKey: true }),
  );
if (options.length !== ownerTypes.length)
  throw new Error("Governance owner schema changed");
export type OwnerGovernanceCommand = GovernanceCommand extends infer C
  ? C extends { type: "submitProposal" | "submitMflProposal" | "castVote" }
    ? Omit<C, "leagueId" | "idempotencyKey">
    : never
  : never;
export const OwnerGovernanceCommandSchema = z.discriminatedUnion(
  "type",
  options as any,
) as unknown as z.ZodType<OwnerGovernanceCommand>;
export const GovernanceActionSchema = z
  .object({
    type: z.literal("governance"),
    causalId,
    command: OwnerGovernanceCommandSchema,
  })
  .strict();
export const BuzzChannelActionSchema = z
  .object({
    type: z.literal("buzz_channel"),
    causalId,
    channelId: z.uuid(),
    content: z.string().trim().min(1).max(4000),
    mentionAgentIds: z.array(z.string().min(1).max(200)).max(11).default([]),
    replyTo: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const BrandActionSchema = z
  .object({
    type: z.literal("brand"),
    causalId,
    name: z.string().min(1).max(120),
    tagline: z.string().max(240),
    description: z.string().min(1).max(8000),
    colors: z
      .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
      .min(1)
      .max(8),
    audience: z.string().max(4000).optional(),
    strategy: z.string().max(12000).optional(),
    budgetPlan: z.string().max(8000).optional(),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            kind: z.enum(["svg", "html"]),
            source: z.string().min(1).max(50000),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export const ServiceRequestActionSchema = z
  .object({
    type: z.literal("service_request"),
    causalId,
    service: z.string().min(1).max(200),
    purpose: z.string().min(1).max(8000),
    maxCostMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const PublicDraftActionSchema = z
  .object({
    type: z.literal("public_draft"),
    causalId,
    draftId: id,
    title: z.string().min(1).max(240),
    body: z.string().min(1).max(20000),
    channel: z.enum(["x", "website", "newsletter"]),
  })
  .strict();
export const FranchiseActionSchema = z.discriminatedUnion("type", [
  BuzzChannelActionSchema,
  GovernanceActionSchema,
  BrandActionSchema,
  ServiceRequestActionSchema,
  PublicDraftActionSchema,
]);
export type FranchiseAction = z.infer<typeof FranchiseActionSchema>;
export type LocalFranchiseAction = Exclude<
  FranchiseAction,
  { type: "governance" | "buzz_channel" }
>;
export const BatchItemSchema = z
  .object({
    teamId: id,
    draftId: id,
    version: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const PrepareBatchSchema = z
  .object({ items: z.array(BatchItemSchema).min(1).max(50) })
  .strict();
export const ApproveBatchSchema = z
  .object({
    batchId: z.uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const ReviewServiceSchema = z
  .object({
    requestId: z.uuid(),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().min(1).max(4000),
  })
  .strict();
