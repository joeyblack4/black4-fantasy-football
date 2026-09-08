import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const common = { leagueId: id, idempotencyKey: z.string().min(1).max(160) };
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T extends { id: string }>(items: T[]) =>
  new Set(items.map((x) => x.id)).size === items.length;
export const MflMenuSchema = z
  .object({
    menuId: id,
    title: z.string().min(1).max(200),
    questions: z
      .array(
        z
          .object({
            id,
            label: z.string().min(1).max(200),
            options: z
              .array(
                z
                  .object({
                    id,
                    label: z.string().min(1).max(200),
                    content: z.string().min(1).max(12000),
                    evidenceRefs: z
                      .array(z.string().min(1).max(1000))
                      .min(1)
                      .max(20),
                  })
                  .strict(),
              )
              .min(1)
              .max(12)
              .refine(unique, "Option IDs must be unique"),
          })
          .strict(),
      )
      .min(1)
      .max(30)
      .refine(unique, "Question IDs must be unique"),
    applicationSections: z
      .array(z.object({ id, label: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(30)
      .refine(unique, "Section IDs must be unique"),
    sourceNote: z.string().min(1).max(8000),
  })
  .strict();
export const mflGovernanceCommands = [
  z
    .object({
      ...common,
      type: z.literal("registerMflMenu"),
      ...MflMenuSchema.shape,
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("submitMflProposal"),
      meetingId: id,
      proposalId: id,
      replacesProposalId: id.optional(),
      version: id,
      title: z.string().min(1).max(200),
      rationale: z.string().min(1).max(8000),
      menuId: id,
      selections: z.record(id, id),
      teamOrder: z
        .array(id)
        .length(12)
        .refine((x) => new Set(x).size === 12),
      leaguePolicies: z.string().max(8000).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("approveMflConstitution"),
      revalidationReceiptId: z.uuid().optional(),
      decisionId: z.uuid(),
      proposalId: id,
      proposalHash: sha,
      version: id,
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal("recordMflApplication"),
      approvalId: z.uuid(),
      proposalHash: sha,
      hostVersion: z.number().int().positive(),
      evidence: z
        .array(
          z
            .object({
              sectionId: id,
              nativeScope: z
                .object({
                  host: z.string().regex(/^www\d{2}\.myfantasyleague\.com$/),
                  season: z.number().int().min(2026).max(2100),
                  leagueId: z.string().regex(/^\d{4,5}$/),
                })
                .strict()
                .optional(),
              source: z.enum(["mfl-native-ui", "mfl-api"]),
              reference: z.string().min(1).max(1000),
              observedHash: sha,
              summary: z.string().min(1).max(8000),
              observedAt: z.iso.datetime({ offset: true }),
            })
            .strict(),
        )
        .min(1)
        .max(30),
      attestation: z.literal("matches-approved-constitution"),
    })
    .strict(),
] as const;
export type MflMenu = z.infer<typeof MflMenuSchema>;

/** Operator-only nonsecret configuration evidence. Never sent to an owner tool. */
export const MflProductionMappingSchema = z
  .object({
    host: z.literal("www43.myfantasyleague.com"),
    season: z.literal(2026),
    mflLeagueId: z.literal("62282"),
    configRef: id,
    franchises: z
      .array(
        z
          .object({
            teamId: id,
            ownerId: id,
            franchiseId: z.string().regex(/^(?!0000)\d{4}$/),
          })
          .strict(),
      )
      .length(12),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ["teamId", "ownerId", "franchiseId"] as const)
      if (new Set(value.franchises.map((x) => x[key])).size !== 12)
        ctx.addIssue({
          code: "custom",
          message: "Twelve unique " + key + " mappings required",
        });
  });
const revalidationCommon = {
  ...common,
  expectedHostVersion: z.number().int().positive(),
  mapping: MflProductionMappingSchema,
  reason: z.string().trim().min(10).max(2000),
  evidenceRef: z.string().trim().min(8).max(2000),
};
export const PrepareMflReturnAnchorSchema = z
  .object({
    ...revalidationCommon,
    decisionId: z.uuid(),
    proposalId: id,
    proposalHash: sha,
    menuHash: sha,
  })
  .strict();
export const RevalidateMflReturnSchema = z
  .object({
    ...revalidationCommon,
    anchorReceiptId: z.uuid(),
    rehearsalEpoch: id,
  })
  .strict();
