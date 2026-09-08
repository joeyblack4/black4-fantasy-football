import { z } from "zod";
import { createHash } from "node:crypto";
export const ProvisionSchema = z
  .object({
    name: z.string().regex(/^black4-franchise-[a-z0-9-]+$/),
    model: z.string().regex(/^[^\s/]+\/[^\s]+$/),
    providerSlug: z.string().min(1),
    keyRef: z.string().regex(/^B4_LEAGUE_[A-Z0-9_]+$/),
    initialLimitUsd: z.number().positive().max(40).default(40),
  })
  .strict();
export type ProvisionSpec = z.infer<typeof ProvisionSchema>;
export type ProvisionReceipt = {
  phase: string;
  at: string;
  guardrailId?: string;
  keyHash?: string;
  keyFingerprint?: string;
  assignmentVerified?: boolean;
  keyLimitUsd?: number;
};
/** Operator-only. Journal each dispatched mutation durably; uncertain phases are never blindly retried. */
export async function provisionFranchiseKey(
  input: unknown,
  options: {
    managementKey: string;
    fetchImpl?: typeof fetch;
    journal: (value: ProvisionReceipt) => Promise<void>;
    saveSecret: (reference: string, key: string) => Promise<void>;
  },
) {
  const spec = ProvisionSchema.parse(input);
  if (!options.managementKey) throw Error("Management credential required.");
  const call = async (path: string, method: string, payload?: unknown) => {
    const r = await (options.fetchImpl ?? fetch)(
      "https://openrouter.ai/api/v1" + path,
      {
        method,
        headers: {
          authorization: "Bearer " + options.managementKey,
          "content-type": "application/json",
        },
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!r.ok) throw Error("OPENROUTER_ADMIN_HTTP_" + r.status);
    return (await r.json()) as any;
  };
  let guardrailId: string | undefined,
    keyHash: string | undefined,
    keyFingerprint: string | undefined;
  const record = (phase: string, extra: Partial<ProvisionReceipt> = {}) =>
    options.journal({
      phase,
      at: new Date().toISOString(),
      guardrailId,
      keyHash,
      keyFingerprint,
      ...extra,
    });
  await record("guardrail_create_dispatched");
  const guard = await call("/guardrails", "POST", {
    name: spec.name,
    description: "Black4 franchise exact model and serving endpoint",
    allowed_models: [spec.model],
    allowed_providers: [spec.providerSlug],
  });
  guardrailId = z.string().min(1).parse(guard.data?.id);
  await record("guardrail_created");
  // Zero limit until assignment read-back succeeds. Neither this key nor the management key enters an owner prompt.
  await record("key_create_dispatched");
  const created = await call("/keys", "POST", {
    name: spec.name,
    limit: 0,
    limit_reset: null,
    include_byok_in_limit: true,
  });
  keyHash = z.string().min(1).parse(created.data?.hash);
  const key = z.string().min(1).parse(created.key);
  keyFingerprint = createHash("sha256").update(key).digest("hex");
  await options.saveSecret(spec.keyRef, key);
  created.key = undefined;
  await record("key_saved");
  await record("assignment_dispatched");
  await call(
    "/guardrails/" + encodeURIComponent(guardrailId) + "/assignments/keys",
    "POST",
    { key_hashes: [keyHash] },
  );
  const [verified, assignments] = await Promise.all([
    call("/guardrails/" + encodeURIComponent(guardrailId), "GET"),
    call(
      "/guardrails/" + encodeURIComponent(guardrailId) + "/assignments/keys",
      "GET",
    ),
  ]);
  if (
    JSON.stringify(verified.data?.allowed_models) !==
      JSON.stringify([spec.model]) ||
    JSON.stringify(verified.data?.allowed_providers) !==
      JSON.stringify([spec.providerSlug]) ||
    !Array.isArray(assignments.data) ||
    !assignments.data.some(
      (a: any) => a.key_hash === keyHash && a.guardrail_id === guardrailId,
    )
  )
    throw Error("GUARDRAIL_ASSIGNMENT_UNVERIFIED_KEY_REMAINS_ZERO");
  await record("assignment_verified", { assignmentVerified: true });
  await record("key_limit_update_dispatched");
  await call("/keys/" + encodeURIComponent(keyHash), "PATCH", {
    limit: spec.initialLimitUsd,
    limit_reset: null,
    include_byok_in_limit: true,
  });
  const keyInfo = await call("/keys/" + encodeURIComponent(keyHash), "GET");
  if (
    keyInfo.data?.limit !== spec.initialLimitUsd ||
    keyInfo.data?.limit_reset !== null ||
    keyInfo.data?.include_byok_in_limit !== true ||
    keyInfo.data?.disabled === true
  )
    throw Error("KEY_LIMIT_UNVERIFIED");
  const receipt = {
    phase: "restricted_key_ready_for_negative_tests",
    at: new Date().toISOString(),
    guardrailId,
    keyHash,
    keyFingerprint,
    assignmentVerified: true,
    keyLimitUsd: spec.initialLimitUsd,
  };
  await options.journal(receipt);
  return receipt;
}
