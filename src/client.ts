export class LeagueClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}
export class LeagueClient {
  constructor(
    readonly token: string,
    readonly baseUrl = "http://127.0.0.1:4312",
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("Remote league connections require HTTPS.");
    if (!token) throw new Error("A franchise credential is required.");
  }
  async request(method: string, path: string, input?: unknown) {
    if (!path.startsWith("/v1/")) throw new Error("Invalid API path.");
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: "Bearer " + this.token,
        ...(input === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      // Host requests are globally paced; preserve a queued transaction long enough
      // for several owners to act together, without retrying an uncertain write.
      signal: AbortSignal.timeout(
        path.startsWith("/v1/football/") ? 180000 : 30000,
      ),
      redirect: "error",
    });
    const value = await res.json();
    if (!res.ok)
      throw new LeagueClientError(
        res.status,
        value.error,
        value.message ?? "Invalid request",
        value.details,
      );
    return value;
  }
}
