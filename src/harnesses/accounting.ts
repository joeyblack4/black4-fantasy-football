import { z } from "zod";

const identifier = z.string().min(1).max(300);
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const NativeCallIdentitySchema = z
  .object({
    franchiseId: identifier,
    runId: identifier,
    sessionId: identifier,
    callId: identifier,
    model: identifier,
    provider: identifier,
    parentCallId: identifier.nullable(),
    billingMode: z.enum(["subscription", "api"]),
  })
  .strict();
export type NativeCallIdentity = z.infer<typeof NativeCallIdentitySchema>;

/** Disjoint categories: output includes reasoning; cached input is not counted again. */
export const TokenCategoriesSchema = z
  .object({
    uncachedInput: nonnegativeInteger.nullable(),
    cacheRead: nonnegativeInteger.nullable(),
    cacheWrite: nonnegativeInteger.nullable(),
    output: nonnegativeInteger.nullable(),
  })
  .strict();
export type TokenCategories = z.infer<typeof TokenCategoriesSchema>;

export const NativeCallObservationSchema = z
  .object({
    identity: NativeCallIdentitySchema,
    usage: z
      .object({
        source: z.enum(["native-call", "provider-call", "account-wide-delta"]),
        evidenceRef: identifier,
        tokens: TokenCategoriesSchema,
      })
      .strict()
      .nullable(),
    cashEvidenceRef: identifier.nullable(),
  })
  .strict();
export type NativeCallObservation = z.infer<typeof NativeCallObservationSchema>;

export const ReferenceTariffSchema = z
  .object({
    id: identifier,
    version: identifier,
    model: identifier,
    provider: identifier,
    currency: z.literal("USD"),
    microsPerMillionTokens: TokenCategoriesSchema,
  })
  .strict();
export type ReferenceTariff = z.infer<typeof ReferenceTariffSchema>;

const cashRecordBase = z.object({
  identity: NativeCallIdentitySchema,
  evidenceRef: identifier,
});
export const CashEvidenceSchema = z.discriminatedUnion("kind", [
  cashRecordBase
    .extend({
      kind: z.literal("verified-provider-charge"),
      verificationReceiptId: identifier,
      amountMicros: nonnegativeInteger,
    })
    .strict(),
  cashRecordBase
    .extend({
      kind: z.literal("verified-subscription-inclusion"),
      verificationReceiptId: identifier,
      includedUsage: z.literal(true),
      paidOverageDisabled: z.literal(true),
    })
    .strict(),
  cashRecordBase
    .extend({
      kind: z.literal("cli-estimate"),
      amountMicros: nonnegativeInteger,
    })
    .strict(),
]);
export type CashEvidence = z.infer<typeof CashEvidenceSchema>;

type CashResult =
  | {
      status: "verified";
      amountMicros: number;
      evidenceRef: string;
      verificationReceiptId: string;
    }
  | { status: "unknown"; amountMicros: null; reason: string };
type EstimateResult =
  | {
      status: "estimated";
      amountMicros: number;
      tariffId: string;
      tariffVersion: string;
      usageEvidenceRef: string;
    }
  | { status: "unknown"; amountMicros: null; reason: string };

export interface NativeCallAccounting {
  observation: NativeCallObservation;
  actualCash: CashResult;
  /** Reporting only. This estimate is neither a bill nor an execution gate. */
  resourceEstimate: EstimateResult;
}

const categories = [
  "uncachedInput",
  "cacheRead",
  "cacheWrite",
  "output",
] as const;
const unknownCash = (reason: string): CashResult => ({
  status: "unknown",
  amountMicros: null,
  reason,
});
const unknownEstimate = (reason: string): EstimateResult => ({
  status: "unknown",
  amountMicros: null,
  reason,
});

function sameIdentity(
  left: NativeCallIdentity,
  right: NativeCallIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function estimate(
  call: NativeCallObservation,
  rawTariff: ReferenceTariff | null,
): EstimateResult {
  if (!call.usage) return unknownEstimate("USAGE_MISSING");
  if (call.usage.source === "account-wide-delta")
    return unknownEstimate("USAGE_NOT_ATTRIBUTABLE_TO_CALL");
  if (!rawTariff) return unknownEstimate("REFERENCE_TARIFF_MISSING");
  const tariff = ReferenceTariffSchema.parse(rawTariff);
  if (
    tariff.model !== call.identity.model ||
    tariff.provider !== call.identity.provider
  )
    return unknownEstimate("REFERENCE_TARIFF_IDENTITY_MISMATCH");
  let numerator = 0n;
  for (const category of categories) {
    const count = call.usage.tokens[category];
    const rate = tariff.microsPerMillionTokens[category];
    if (count === null) return unknownEstimate("TOKEN_CATEGORY_MISSING");
    if (rate === null) return unknownEstimate("REFERENCE_RATE_MISSING");
    numerator += BigInt(count) * BigInt(rate);
  }
  // Round up once for the complete call, retaining precision before conversion.
  const micros = (numerator + 999_999n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("RESOURCE_ESTIMATE_OVERFLOW");
  return {
    status: "estimated",
    amountMicros: Number(micros),
    tariffId: tariff.id,
    tariffVersion: tariff.version,
    usageEvidenceRef: call.usage.evidenceRef,
  };
}

/**
 * Pure accounting projection; performs no spend admission or wallet mutation.
 * trustedCashEvidence must come from the application's verified receipt store,
 * never from model output or a native CLI's claim that a receipt is verified.
 * Included subscription evidence covers this call and verifies no paid overage.
 * Existing fixed subscription fees belong in account reporting, not this call.
 */
export function accountNativeCall(
  rawCall: NativeCallObservation,
  tariff: ReferenceTariff | null,
  trustedCashEvidence: readonly CashEvidence[] = [],
): NativeCallAccounting {
  const call = NativeCallObservationSchema.parse(rawCall);
  let actualCash = unknownCash("CASH_EVIDENCE_MISSING");
  if (call.cashEvidenceRef !== null) {
    const matches = trustedCashEvidence
      .map((record) => CashEvidenceSchema.parse(record))
      .filter((record) => record.evidenceRef === call.cashEvidenceRef);
    if (matches.length > 1)
      throw new Error("AMBIGUOUS_CASH_EVIDENCE_REFERENCE");
    const record = matches[0];
    if (record && !sameIdentity(record.identity, call.identity)) {
      actualCash = unknownCash("CASH_EVIDENCE_IDENTITY_MISMATCH");
    } else if (record?.kind === "cli-estimate") {
      actualCash = unknownCash("CLI_ESTIMATE_IS_NOT_ACTUAL_CASH");
    } else if (record?.kind === "verified-provider-charge") {
      actualCash = {
        status: "verified",
        amountMicros: record.amountMicros,
        evidenceRef: record.evidenceRef,
        verificationReceiptId: record.verificationReceiptId,
      };
    } else if (record?.kind === "verified-subscription-inclusion") {
      actualCash =
        call.identity.billingMode === "subscription"
          ? {
              status: "verified",
              amountMicros: 0,
              evidenceRef: record.evidenceRef,
              verificationReceiptId: record.verificationReceiptId,
            }
          : unknownCash("SUBSCRIPTION_EVIDENCE_FOR_API_CALL");
    }
  }
  return {
    observation: call,
    actualCash,
    resourceEstimate: estimate(call, tariff),
  };
}
