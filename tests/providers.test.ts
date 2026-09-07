import { describe, it, expect } from "vitest";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import type { Job } from "../src/runtime/index.js";
const job = {
  id: "job",
  agentId: "a",
  model: "provider/model",
  payload: {},
  memory: [],
  recentMessages: [],
  commitments: [],
} as unknown as Job;
function driver(reply: any, override: Record<string, unknown> = {}) {
  const requests: any[] = [];
  return {
    requests,
    driver: new OpenRouterDriver("provider/model", {
      apiKey: "synthetic-secret",
      tariff: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 3,
        verifiedAt: new Date().toISOString(),
        maxAgeHours: 24,
      },
      maxOutputTokens: 1000,
      reservationMicros: 100000,
      peers: ["b"],
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify(reply), { status: 200 });
      },
      ...override,
    }),
  };
}
const response = {
  id: "synthetic-generation",
  model: "provider/model",
  usage: { cost: 0.000123 },
  choices: [
    {
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          actions: [
            {
              type: "message",
              causalId: "one",
              recipientId: "b",
              body: "Synthetic fixture",
            },
          ],
          summary: "Synthetic response fixture",
        }),
      },
    },
  ],
};
describe("optional provider request contract (fake transport, no live inference)", () => {
  it("pins exact model, disables fallback, records upstream cost separately from model JSON", async () => {
    const x = driver(response);
    const result = await x.driver.run(job);
    expect(result.costMicros).toBe(123);
    expect(x.requests[0].model).toBe("provider/model");
    expect(x.requests[0].provider.allow_fallbacks).toBe(false);
    expect(x.requests[0]).not.toHaveProperty("models");
  });
  it("rejects model substitutions and unknown cost", async () => {
    await expect(
      driver({ ...response, model: "other/model" }).driver.run(job),
    ).rejects.toThrow("DIFFERENT_MODEL");
    await expect(
      driver({ ...response, usage: {} }).driver.run(job),
    ).rejects.toThrow("COST_UNKNOWN");
  });
  it("records unavailable league context as zero-cost before dispatch", async () => {
    const x = driver(response, {
      leagueContext: async () => {
        throw new Error("private database details");
      },
    });
    await expect(x.driver.run(job)).rejects.toThrow(
      "LEAGUE_CONTEXT_UNAVAILABLE",
    );
    expect(x.requests).toHaveLength(0);
  });
  it("rejects insufficient reservation before any request", async () => {
    const x = driver(response, { reservationMicros: 1 });
    await expect(x.driver.run(job)).rejects.toThrow("RESERVATION_TOO_SMALL");
    expect(x.requests).toHaveLength(0);
  });
  it("rejects stale tariff, truncation and fabricated cost from decision body", async () => {
    await expect(
      driver(response, {
        tariff: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 3,
          verifiedAt: "2020-01-01",
          maxAgeHours: 24,
        },
      }).driver.run(job),
    ).rejects.toThrow("TARIFF");
    await expect(
      driver({
        ...response,
        choices: [{ finish_reason: "length", message: { content: "{}" } }],
      }).driver.run(job),
    ).rejects.toThrow("INCOMPLETE");
    await expect(
      driver({
        ...response,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                actions: [],
                summary: "x",
                costMicros: 0,
              }),
            },
          },
        ],
      }).driver.run(job),
    ).rejects.toThrow();
  });
});
