/** Private evidence from the fixed OpenRouter HTTP transport, never model/body fields.
 * A generation ID is only a reconciliation locator, not identity or billing proof.
 * https://openrouter.ai/docs/guides/features/router-metadata
 */
export function providerErrorHeaders(headers: Headers, secret: string) {
  const rejectedHeaders: string[] = [];
  const safe = (name: string, pattern: RegExp): string | undefined => {
    const value = headers.get(name);
    if (value === null) return undefined;
    if (
      !pattern.test(value) ||
      (secret.length > 0 && value.includes(secret)) ||
      /sk-(?:or-v1-)?|bearer/i.test(value)
    ) {
      rejectedHeaders.push(name);
      return undefined;
    }
    return value;
  };
  // Comma-joined duplicate values, URLs, controls, whitespace and credentials fail closed.
  const generationId = safe(
    "x-generation-id",
    /^gen-[A-Za-z0-9][A-Za-z0-9_-]{2,195}$/,
  );
  const requestIds = Object.fromEntries(
    ["x-request-id", "x-openrouter-request-id"].flatMap((name) => {
      const value = safe(name, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
      return value === undefined ? [] : [[name, value]];
    }),
  );
  // Preserve the header names: IDs at different HTTP layers need not be equal.
  const requestId =
    requestIds["x-openrouter-request-id"] ?? requestIds["x-request-id"];
  const rawRetry = headers.get("retry-after");
  let retryAfter: { kind: "seconds" | "http-date"; value: string } | undefined;
  if (rawRetry !== null) {
    if (secret.length > 0 && rawRetry.includes(secret)) {
      rejectedHeaders.push("retry-after");
    } else if (/^\d{1,10}$/.test(rawRetry)) {
      retryAfter = { kind: "seconds", value: rawRetry };
    } else if (
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
        rawRetry,
      ) &&
      Number.isFinite(Date.parse(rawRetry)) &&
      new Date(rawRetry).toUTCString() === rawRetry
    ) {
      retryAfter = { kind: "http-date", value: rawRetry };
    } else rejectedHeaders.push("retry-after");
  }
  return {
    ...(generationId ? { generationId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    requestIds,
    rejectedHeaders,
    source: "openrouter-http-response-headers" as const,
    retryAuthorized: false as const,
  };
}
