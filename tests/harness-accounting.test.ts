import { describe, expect, it } from "vitest";
import {
  accountNativeCall,
  type NativeCallObservation,
  type ReferenceTariff,
  type CashEvidence,
} from "../src/harnesses/accounting.js";

const call: NativeCallObservation = {
  identity: {
    franchiseId: "test-owner",
    runId: "run-1",
    sessionId: "session-1",
    callId: "call-1",
    model: "synthetic-lead",
    provider: "synthetic-provider",
    parentCallId: null,
    billingMode: "subscription",
  },
  usage: {
    source: "native-call",
    evidenceRef: "usage-1",
    tokens: { uncachedInput: 1000, cacheRead: 500, cacheWrite: 0, output: 200 },
  },
  cashEvidenceRef: "cash-1",
};
const tariff: ReferenceTariff = {
  id: "synthetic-reference",
  version: "v1",
  model: call.identity.model,
  provider: call.identity.provider,
  currency: "USD",
  microsPerMillionTokens: {
    uncachedInput: 2_000_000,
    cacheRead: 500_000,
    cacheWrite: 2_000_000,
    output: 10_000_000,
  },
};
const inclusion: CashEvidence = {
  kind: "verified-subscription-inclusion",
  identity: call.identity,
  evidenceRef: "cash-1",
  verificationReceiptId: "trusted-verification-1",
  includedUsage: true,
  paidOverageDisabled: true,
};

describe("native accounting evidence", () => {
  it("reports included subscription zero cash independently from nonzero usage estimate", () => {
    const result = accountNativeCall(call, tariff, [inclusion]);
    expect(result.actualCash).toMatchObject({
      status: "verified",
      amountMicros: 0,
    });
    expect(result.resourceEstimate).toMatchObject({
      status: "estimated",
      amountMicros: 4250,
      tariffId: tariff.id,
      tariffVersion: "v1",
    });
  });
  it("never settles a CLI dollar estimate as actual cash", () => {
    const result = accountNativeCall(call, tariff, [
      {
        kind: "cli-estimate",
        identity: call.identity,
        evidenceRef: "cash-1",
        amountMicros: 4250,
      },
    ]);
    expect(result.actualCash).toMatchObject({
      status: "unknown",
      amountMicros: null,
    });
    expect(accountNativeCall(call, tariff).actualCash.amountMicros).toBeNull();
  });
  it("requires trusted verified inclusion with overage disabled and matching call identity", () => {
    expect(() =>
      accountNativeCall(call, tariff, [
        { ...inclusion, paidOverageDisabled: false } as never,
      ]),
    ).toThrow();
    const mismatch = {
      ...inclusion,
      identity: { ...call.identity, callId: "other" },
    };
    expect(accountNativeCall(call, tariff, [mismatch]).actualCash.status).toBe(
      "unknown",
    );
    const api = {
      ...call,
      identity: { ...call.identity, billingMode: "api" as const },
    };
    expect(
      accountNativeCall(api, tariff, [{ ...inclusion, identity: api.identity }])
        .actualCash.status,
    ).toBe("unknown");
  });
  it("records real API charges independently of reference pricing", () => {
    const api = {
      ...call,
      identity: { ...call.identity, billingMode: "api" as const },
    };
    const result = accountNativeCall(api, tariff, [
      {
        kind: "verified-provider-charge",
        identity: api.identity,
        evidenceRef: "cash-1",
        verificationReceiptId: "invoice-1",
        amountMicros: 3000,
      },
    ]);
    expect(result.actualCash.amountMicros).toBe(3000);
    expect(result.resourceEstimate.amountMicros).toBe(4250);
  });
  it("preserves missing usage, missing rates and shared-account deltas as unknown", () => {
    expect(
      accountNativeCall({ ...call, usage: null }, tariff, [inclusion])
        .resourceEstimate.amountMicros,
    ).toBeNull();
    expect(
      accountNativeCall(call, null).resourceEstimate.amountMicros,
    ).toBeNull();
    expect(
      accountNativeCall(call, {
        ...tariff,
        microsPerMillionTokens: {
          ...tariff.microsPerMillionTokens,
          cacheWrite: null,
        },
      }).resourceEstimate.amountMicros,
    ).toBeNull();
    expect(
      accountNativeCall(
        { ...call, usage: { ...call.usage!, source: "account-wide-delta" } },
        tariff,
      ).resourceEstimate.amountMicros,
    ).toBeNull();
    expect(
      accountNativeCall(
        {
          ...call,
          usage: {
            ...call.usage!,
            tokens: { ...call.usage!.tokens, output: null },
          },
        },
        tariff,
      ).resourceEstimate.amountMicros,
    ).toBeNull();
  });
  it("keeps helpers as observed provenance without introducing an allowlist", () => {
    const helper = {
      ...call,
      identity: {
        ...call.identity,
        model: "synthetic-helper",
        parentCallId: "lead-call",
      },
    };
    const result = accountNativeCall(helper, {
      ...tariff,
      model: helper.identity.model,
    });
    expect(result.observation.identity.parentCallId).toBe("lead-call");
    expect(result.resourceEstimate.status).toBe("estimated");
  });
  it("rounds once using exact integer arithmetic and rejects overflow or invalid counts", () => {
    const tiny = {
      ...call,
      usage: {
        ...call.usage!,
        tokens: { uncachedInput: 1, cacheRead: 1, cacheWrite: 0, output: 0 },
      },
    };
    const tinyTariff = {
      ...tariff,
      microsPerMillionTokens: {
        uncachedInput: 1,
        cacheRead: 1,
        cacheWrite: 0,
        output: 0,
      },
    };
    expect(
      accountNativeCall(tiny, tinyTariff).resourceEstimate.amountMicros,
    ).toBe(1);
    expect(() =>
      accountNativeCall(
        {
          ...tiny,
          usage: {
            ...tiny.usage,
            tokens: { ...tiny.usage.tokens, output: -1 },
          },
        },
        tariff,
      ),
    ).toThrow();
    expect(() =>
      accountNativeCall(
        {
          ...tiny,
          usage: {
            ...tiny.usage,
            tokens: { ...tiny.usage.tokens, output: 1.5 },
          },
        },
        tariff,
      ),
    ).toThrow();
    expect(() =>
      accountNativeCall(
        {
          ...tiny,
          usage: {
            ...tiny.usage,
            tokens: { ...tiny.usage.tokens, output: Number.MAX_SAFE_INTEGER },
          },
        },
        tariff,
      ),
    ).toThrow("OVERFLOW");
  });
  it("rejects ambiguous receipt references instead of selecting a convenient cash result", () => {
    expect(() =>
      accountNativeCall(call, tariff, [inclusion, inclusion]),
    ).toThrow("AMBIGUOUS");
  });
});
