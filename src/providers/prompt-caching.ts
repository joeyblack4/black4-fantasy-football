/** Documented provider capability, not a discount assumption or routing override.
 * https://openrouter.ai/docs/guides/best-practices/prompt-caching
 * Reviewed 2026-09-08: exact Anthropic endpoint advertises $12.50/M five-minute
 * writes against $10/M uncached input. Actual reported cost remains authoritative.
 */
export const PROMPT_CACHE_POLICY_VERSION = "anthropic-5m-v1-2026-09-08";
export type PromptCachingMode = "disabled" | "anthropic-5m";
export function promptCachePolicy(
  model: string,
  provider: string,
  canary: boolean,
  explicit?: PromptCachingMode,
) {
  if (
    explicit !== undefined &&
    !["disabled", "anthropic-5m"].includes(explicit)
  )
    throw Error("PROMPT_CACHE_POLICY_INVALID");
  const supported = model.startsWith("anthropic/") && provider === "anthropic";
  if (explicit === "anthropic-5m" && !supported)
    throw Error("PROMPT_CACHE_CAPABILITY_MISMATCH");
  const enabled =
    supported &&
    explicit !== "disabled" &&
    (!canary || explicit === "anthropic-5m");
  return {
    version: PROMPT_CACHE_POLICY_VERSION,
    mode: enabled ? ("anthropic-5m" as const) : ("disabled" as const),
    inputCacheWriteFactor: enabled ? 1.25 : 1,
    request: enabled ? { type: "ephemeral" as const } : undefined,
  };
}
export function cacheUsageDiagnostic(usage: any) {
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const cachedTokens = count(usage?.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = count(
    usage?.prompt_tokens_details?.cache_write_tokens,
  );
  return {
    cachedTokens,
    cacheWriteTokens,
    usageStatus:
      cachedTokens === null || cacheWriteTokens === null
        ? "unknown"
        : "reported",
    discountAssumed: false,
  };
}
