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
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    const value = await res.json();
    if (!res.ok)
      throw new Error(
        `${res.status} ${value.error}: ${value.message ?? "Invalid request"}`,
      );
    return value;
  }
}
