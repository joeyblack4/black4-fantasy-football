/** Request contract verified against the vendor's official public REST reference on 2026-09-07.
 * This returns unnormalized evidence: NFL field mapping MUST be established from an authenticated payload.
 */
export class RollingInsightsClient {
  private readonly token: string;
  constructor(
    token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!token.trim() || token.length > 8192)
      throw new Error("RSC token required");
    this.token = token;
  }
  async getNfl(
    resource: "live" | "schedule" | "player-info" | "injuries" | "depth-charts",
    date?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !["live", "schedule", "player-info", "injuries", "depth-charts"].includes(
        resource,
      )
    )
      throw new Error("Unsupported NFL resource");
    if (
      (resource === "live" || resource === "schedule") &&
      (!date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      throw new Error("Valid YYYY-MM-DD date required");
    const path =
      resource === "live" || resource === "schedule"
        ? `${resource}/${date}/NFL`
        : `${resource}/NFL`;
    const url = new URL(
      "https://rest.datafeeds.rolling-insights.com/api/v1/" + path,
    );
    url.searchParams.set("RSC_token", this.token);
    if (resource === "live") url.searchParams.set("_", String(Date.now()));
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache" },
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(
        "Rolling Insights transport failed; request details redacted",
      );
    }
    if (!response.ok)
      throw new Error(`Rolling Insights HTTP ${response.status}`);
    try {
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("data" in payload))
        throw new Error("Invalid wrapper");
      return payload;
    } catch {
      throw new Error(
        "Rolling Insights payload is not the documented JSON wrapper",
      );
    }
  }
}
