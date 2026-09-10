import { describe, expect, it } from "vitest";
import { providerErrorHeaders } from "../src/providers/error-headers.js";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import type { Job } from "../src/runtime/index.js";

const secret = "synthetic-private-secret";
describe("allowlisted error headers (synthetic transport only)", () => {
  it("retains attributed IDs and a retry hint without authorizing a retry", () => {
    expect(
      providerErrorHeaders(
        new Headers({
          "X-Generation-Id": "gen-synthetic123",
          "X-Request-Id": "edge-request-123",
          "X-OpenRouter-Request-Id": "router-request-456",
          "Retry-After": "120",
          authorization: secret,
          "set-cookie": "private-cookie",
          "x-api-key": secret,
        }),
        secret,
      ),
    ).toEqual({
      generationId: "gen-synthetic123",
      requestId: "router-request-456",
      requestIds: {
        "x-request-id": "edge-request-123",
        "x-openrouter-request-id": "router-request-456",
      },
      retryAfter: { kind: "seconds", value: "120" },
      rejectedHeaders: [],
      source: "openrouter-http-response-headers",
      retryAuthorized: false,
    });
  });
  it("represents missing headers as missing evidence, never zero or immediate retry", () => {
    expect(providerErrorHeaders(new Headers(), secret)).toEqual({
      requestIds: {},
      rejectedHeaders: [],
      source: "openrouter-http-response-headers",
      retryAuthorized: false,
    });
  });
  it.each([
    "gen-one, gen-two",
    "https://example.com/gen-one",
    "gen-one?token=foo",
    "gen-synthetic-private-secret",
    "gen-sk-or-v1-1234567890",
    "gen-" + "x".repeat(200),
  ])(
    "rejects malformed, duplicated or credential-bearing generation ID %s",
    (value) => {
      const result = providerErrorHeaders(
        new Headers({ "x-generation-id": value }),
        secret,
      );
      expect(result).not.toHaveProperty("generationId");
      expect(result.rejectedHeaders).toEqual(["x-generation-id"]);
      expect(JSON.stringify(result)).not.toContain(value);
    },
  );
  it("rejects duplicate native Headers values and secret-bearing request IDs", () => {
    const headers = new Headers({ "x-request-id": secret });
    headers.append("x-generation-id", "gen-first123");
    headers.append("x-generation-id", "gen-second456");
    expect(providerErrorHeaders(headers, secret)).toMatchObject({
      requestIds: {},
      rejectedHeaders: ["x-generation-id", "x-request-id"],
    });
  });
  it("preserves a valid HTTP-date without computing a locally guessed retry deadline", () => {
    expect(
      providerErrorHeaders(
        new Headers({ "retry-after": "Tue, 08 Sep 2026 13:00:00 GMT" }),
        secret,
      ).retryAfter,
    ).toEqual({ kind: "http-date", value: "Tue, 08 Sep 2026 13:00:00 GMT" });
  });
  it.each([
    "-1",
    "1.5",
    "soon",
    "120, 180",
    "9".repeat(11),
    "Tue, 31 Feb 2026 13:00:00 GMT",
  ])("rejects an invalid or ambiguous retry value %s", (value) => {
    const result = providerErrorHeaders(
      new Headers({ "retry-after": value }),
      secret,
    );
    expect(result).not.toHaveProperty("retryAfter");
    expect(result.rejectedHeaders).toContain("retry-after");
  });
});

const job = {
  id: "synthetic-job",
  agentId: "synthetic-agent",
  model: "fixture/model",
  payload: {},
  memory: [],
  recentMessages: [],
  commitments: [],
} as unknown as Job;
function errorDriver(reply: Response) {
  const observations: any[] = [],
    diagnostics: any[] = [],
    requests: any[] = [];
  const driver = new OpenRouterDriver("fixture/model", {
    apiKey: secret,
    providerSlug: "fixture-provider",
    reportedProviderNames: ["Fixture Provider"],
    tariff: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 3,
      verifiedAt: new Date().toISOString(),
      maxAgeHours: 24,
    },
    maxOutputTokens: 1000,
    reservationMicros: 100000,
    peers: [],
    observe: async (value) => {
      observations.push(value);
    },
    diagnostic: async (value) => {
      diagnostics.push(value);
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init?.method });
      return reply;
    },
  });
  return { driver, observations, diagnostics, requests };
}
describe("future error generation recovery pointer", () => {
  it("retains the HTTP locator when an HTTP-200 response body cannot be parsed, without fetching metadata", async () => {
    const x = errorDriver(
      new Response('{"broken":', {
        status: 200,
        headers: { "x-generation-id": "gen-broken-json123" },
      }),
    );
    await expect(x.driver.run(job)).rejects.toThrow("PROVIDER_COST_UNKNOWN");
    expect(x.observations[0]).toEqual({
      status: "invalid_response_cost_uncertain",
      generationId: "gen-broken-json123",
    });
    expect(
      x.observations.every(
        (v) =>
          v.costMicros === undefined &&
          v.model === undefined &&
          v.provider === undefined,
      ),
    ).toBe(true);
    expect(x.requests).toHaveLength(1);
  });
  it("records the HTTP locator on 429 and keeps cost/identity unknown; never retries or fetches metadata", async () => {
    const x = errorDriver(
      new Response(
        JSON.stringify({
          id: "gen-body-spoof",
          model: "other/model",
          provider: "Spoof Provider",
          usage: { cost: 0 },
          error: {
            message: "Rate limited",
            metadata: { raw: "upstream rate limited" },
          },
        }),
        {
          status: 429,
          headers: {
            "x-generation-id": "gen-real-header123",
            "x-request-id": "request-123",
            "retry-after": "30",
          },
        },
      ),
    );
    await expect(x.driver.run(job)).rejects.toThrow(
      "PROVIDER_HTTP_429_COST_UNCERTAIN",
    );
    expect(x.requests).toHaveLength(1);
    expect(x.requests[0].method).toBe("POST");
    expect(x.observations).toEqual([
      {
        status: "http_429_cost_uncertain",
        generationId: "gen-real-header123",
        requestId: "request-123",
      },
    ]);
    expect(x.diagnostics[0]).toMatchObject({
      httpStatus: 429,
      costKnown: false,
      responseHeaders: {
        generationId: "gen-real-header123",
        retryAfter: { kind: "seconds", value: "30" },
        retryAuthorized: false,
      },
    });
    expect(JSON.stringify(x.observations)).not.toContain("Spoof");
    expect(x.observations[0]).not.toHaveProperty("costMicros");
    expect(x.observations[0]).not.toHaveProperty("reconciled");
  });
  it("does not recover from invented body headers or fabricate absent header evidence", async () => {
    const x = errorDriver(
      new Response(
        JSON.stringify({
          headers: { "X-Generation-Id": "gen-spoof123", "Retry-After": "0" },
        }),
        { status: 503 },
      ),
    );
    await expect(x.driver.run(job)).rejects.toThrow(
      "PROVIDER_HTTP_503_COST_UNCERTAIN",
    );
    expect(x.observations).toEqual([{ status: "http_503_cost_uncertain" }]);
    expect(x.diagnostics[0].responseHeaders).not.toHaveProperty("retryAfter");
    expect(x.requests).toHaveLength(1);
  });
  it("durably observes a valid header before a failed body read", async () => {
    const stream = new ReadableStream({
      pull(controller) {
        controller.error(new Error("broken body"));
      },
    });
    const x = errorDriver(
      new Response(stream, {
        status: 502,
        headers: { "x-generation-id": "gen-body-broken123" },
      }),
    );
    await expect(x.driver.run(job)).rejects.toThrow(
      "PROVIDER_HTTP_502_COST_UNCERTAIN",
    );
    expect(x.observations).toEqual([
      { status: "http_502_cost_uncertain", generationId: "gen-body-broken123" },
    ]);
    expect(x.diagnostics[0].message).toBeNull();
    expect(x.requests).toHaveLength(1);
  });
});
