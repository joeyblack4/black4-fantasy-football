import { it, expect } from "vitest";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import type { Job } from "../src/runtime/index.js";
it("common conversation policy hides football/governance/research and rejects forbidden final actions without executing tools", async () => {
  const requests: any[] = [],
    toolsCalled: string[] = [];
  const driver = new OpenRouterDriver("test/model", {
    apiKey: "synthetic",
    providerSlug: "test",
    reportedProviderNames: ["Test"],
    peers: [],
    tariff: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      verifiedAt: new Date().toISOString(),
      maxAgeHours: 24,
    },
    maxOutputTokens: 1000,
    reservationMicros: 100000,
    maxCalls: 3,
    leagueContext: async () => ({
      conversation: {
        activePermissions: ["remember", "buzz_channel", "buzz_read"],
      },
    }),
    readTools: [
      "buzz_read",
      "mfl_read",
      "governance_state",
      "research_search",
    ].map((name) => ({
      name,
      description: name,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        toolsCalled.push(name);
        return {};
      },
    })),
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      return new Response(
        JSON.stringify({
          model: "test/model",
          provider: "Test",
          usage: { cost: 0.001 },
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  actions: [
                    {
                      type: "football",
                      causalId: "wrong",
                      command: {
                        type: "mfl",
                        action: {
                          type: "draft",
                          round: 1,
                          pick: 1,
                          playerId: "12345",
                        },
                      },
                    },
                  ],
                  summary: "Synthetic forbidden draft",
                }),
              },
            },
          ],
        }),
      );
    },
  });
  await expect(
    driver.run({
      id: "synthetic",
      agentId: "owner",
      model: "test/model",
      kind: "owner",
      memory: [],
    } as unknown as Job),
  ).rejects.toMatchObject({ costMicros: 1000 });
  expect(requests).toHaveLength(1);
  expect(toolsCalled).toEqual([]);
  expect((requests[0].tools ?? []).map((t: any) => t.function.name)).toEqual([
    "buzz_read",
  ]);
  expect(requests[0].provider).toMatchObject({
    only: ["test"],
    allow_fallbacks: false,
  });
});
