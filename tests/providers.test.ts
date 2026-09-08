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
      providerSlug: "synthetic-provider",
      reportedProviderNames: ["Synthetic Provider"],
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
  provider: "Synthetic Provider",
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

it("rejects a different serving provider while retaining the observed charge", async () => {
  const x = driver({ ...response, provider: "Unapproved Endpoint" });
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_SERVING_IDENTITY_MISMATCH",
    costMicros: 123,
  });
  expect(x.requests[0].provider.only).toEqual(["synthetic-provider"]);
  expect(x.requests[0].provider.require_parameters).toBe(true);
});
it("runs a bounded read tool then counts every model call in the turn", async () => {
  let n = 0,
    reads = 0;
  const dispatched: any[] = [];
  const x = driver(response, {
    maxCalls: 2,
    readTools: [
      {
        name: "source_read",
        description: "Read fixture",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          reads++;
          return { url: "https://example.org", status: "synthetic" };
        },
      },
    ],
    fetchImpl: async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      dispatched.push(body);
      // Model endpoints may support tools without supporting tool_choice.
      if (Object.hasOwn(body, "tool_choice"))
        return new Response("unsupported parameter", { status: 400 });
      return new Response(
        JSON.stringify(
          n++ === 0
            ? {
                ...response,
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      tool_calls: [
                        {
                          id: "read-one",
                          type: "function",
                          function: { name: "source_read", arguments: "{}" },
                        },
                      ],
                    },
                  },
                ],
              }
            : response,
        ),
      );
    },
  });
  expect((await x.driver.run(job)).costMicros).toBe(246);
  expect(reads).toBe(1);
  expect(n).toBe(2);
  expect(dispatched[0].tools).toHaveLength(1);
  expect(dispatched[1]).not.toHaveProperty("tools");
  expect(dispatched[1].messages.at(-1).role).toBe("tool");
});
it("never executes a read tool returned by a mismatched provider", async () => {
  let reads = 0;
  const x = driver(
    {
      ...response,
      provider: "wrong",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id: "t",
                type: "function",
                function: { name: "source_read", arguments: "{}" },
              },
            ],
          },
        },
      ],
    },
    {
      readTools: [
        {
          name: "source_read",
          description: "Read fixture",
          parameters: { type: "object" },
          execute: async () => {
            reads++;
            return {};
          },
        },
      ],
    },
  );
  await expect(x.driver.run(job)).rejects.toThrow("SERVING_IDENTITY");
  expect(reads).toBe(0);
});
it("retains earlier call charges when the final output is invalid", async () => {
  let n = 0;
  const x = driver(response, {
    readTools: [
      {
        name: "read",
        description: "fixture",
        parameters: { type: "object" },
        execute: async () => ({}),
      },
    ],
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          n++ === 0
            ? {
                ...response,
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      tool_calls: [
                        {
                          id: "one",
                          type: "function",
                          function: { name: "read", arguments: "{}" },
                        },
                      ],
                    },
                  },
                ],
              }
            : {
                ...response,
                choices: [
                  { finish_reason: "length", message: { content: "{}" } },
                ],
              },
        ),
      ),
  });
  await expect(x.driver.run(job)).rejects.toMatchObject({ costMicros: 246 });
});

it("rejects an unapproved response provider even when generation metadata names the approved provider", async () => {
  const registry = {
    preflight: async () => ({
      document: {
        providerSlug: "synthetic-provider",
        model: "provider/model",
        reportedProviderNames: ["Synthetic Provider"],
        quantization: null,
        toolPermissions: [],
      },
    }),
    begin: async () => "fixture-call",
    observe: async () => {},
  };
  const x = driver(response, {
    identity: { manifestId: "fixture-manifest", registry, canary: true },
    fetchImpl: async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/generation?")
            ? {
                data: {
                  id: response.id,
                  model: response.model,
                  provider_name: "Synthetic Provider",
                  total_cost: 0.000123,
                },
              }
            : { ...response, provider: "Unapproved Endpoint" },
        ),
      ),
  });
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_SERVING_IDENTITY_MISMATCH",
    costMicros: 123,
  });
});

it("does not replace a known response charge with metadata from another generation", async () => {
  const registry = {
    preflight: async () => ({
      document: {
        providerSlug: "synthetic-provider",
        model: "provider/model",
        reportedProviderNames: ["Synthetic Provider"],
        quantization: null,
        toolPermissions: [],
      },
    }),
    begin: async () => "fixture-call",
    observe: async () => {},
  };
  const x = driver(response, {
    identity: { manifestId: "fixture-manifest", registry, canary: true },
    fetchImpl: async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/generation?")
            ? {
                data: {
                  id: "different-generation",
                  model: response.model,
                  provider_name: "Synthetic Provider",
                  total_cost: 0,
                },
              }
            : response,
        ),
      ),
  });
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_GENERATION_ID_MISMATCH",
    costMicros: 123,
  });
});

it("keeps connectivity canaries separate from owner instructions and rejects actions", async () => {
  const registry = {
    preflight: async () => ({
      document: {
        providerSlug: "synthetic-provider",
        model: "provider/model",
        reportedProviderNames: ["Synthetic Provider"],
        quantization: null,
        toolPermissions: ["message"],
      },
    }),
    begin: async () => "fixture-call",
    observe: async () => {},
  };
  const requests: any[] = [];
  let actions: any[] = [];
  const x = driver(response, {
    identity: { manifestId: "fixture-manifest", registry, canary: true },
    fetchImpl: async (url: string, init: RequestInit) => {
      if (url.includes("/generation?"))
        return new Response(
          JSON.stringify({
            data: {
              id: response.id,
              model: response.model,
              provider_name: "Synthetic Provider",
              total_cost: 0.000123,
            },
          }),
        );
      requests.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({
          ...response,
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  actions,
                  summary: "Controlled synthetic connectivity result",
                }),
              },
            },
          ],
        }),
      );
    },
  });
  expect((await x.driver.run(job)).actions).toEqual([]);
  expect(requests[0].messages[0].content).toContain("Do not name a team");
  expect(requests[0].messages[0].content).not.toContain("Choose your name");
  actions = [
    {
      type: "message",
      causalId: "blocked",
      recipientId: "b",
      body: "Should never execute",
    },
  ];
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_CANARY_ACTION_FORBIDDEN",
    costMicros: 123,
  });
});
