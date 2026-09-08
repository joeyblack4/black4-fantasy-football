import { it, expect } from "vitest";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import { objectToolParameters } from "../src/providers/tool-schema.js";
import type { Job } from "../src/runtime/index.js";
const job = {
  id: "fixture",
  agentId: "a",
  model: "test/model",
  kind: "owner",
  memory: [],
} as unknown as Job;
const final = {
  finish_reason: "stop",
  message: {
    content: JSON.stringify({
      actions: [],
      summary: "Synthetic repaired output",
    }),
  },
};
function setup(choices: any[], options: Record<string, unknown> = {}) {
  const requests: any[] = [];
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
    maxCalls: choices.length,
    repairInvalidResponses: true,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      return new Response(
        JSON.stringify({
          model: "test/model",
          provider: "Test",
          usage: { cost: 0.001 },
          choices: [choices[requests.length - 1]],
        }),
      );
    },
    ...options,
  });
  return { driver, requests };
}
it("repairs malformed/truncated decisions within the call cap and retains every charge", async () => {
  const x = setup([
    { finish_reason: "length", message: { content: "{" } },
    { finish_reason: "stop", message: { content: "not json" } },
    final,
  ]);
  expect(await x.driver.run(job)).toMatchObject({
    actions: [],
    costMicros: 3000,
  });
  expect(x.requests).toHaveLength(3);
  expect(x.requests[2].messages.at(-1).content).toContain(
    "No proposed actions were executed",
  );
});
it("reports unavailable invented tools without executing them", async () => {
  let reads = 0;
  const x = setup(
    [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "send_money", arguments: "{}" },
            },
          ],
        },
      },
      final,
    ],
    {
      readTools: [
        {
          name: "read",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            reads++;
          },
        },
      ],
    },
  );
  await x.driver.run(job);
  expect(reads).toBe(0);
  expect(x.requests[1].messages.at(-1).content).toContain("TOOL_NOT_AVAILABLE");
});
it("a valid but stage-forbidden action never escapes in the final decision", async () => {
  const x = setup(
    [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            actions: [{ type: "remember", key: "x", content: "y" }],
            summary: "fixture",
          }),
        },
      },
      final,
    ],
    {
      leagueContext: async () => ({
        ownerStage: { activePermissions: ["buzz_read"] },
      }),
    },
  );
  expect((await x.driver.run(job)).actions).toEqual([]);
  expect(x.requests[1].messages.at(-1).content).toContain(
    "PROVIDER_ACTION_PERMISSION_DENIED",
  );
});
it("does not retry a serving identity failure even with repair enabled", async () => {
  const x = setup([final, final], { reportedProviderNames: ["Other"] });
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_SERVING_IDENTITY_MISMATCH",
    costMicros: 1000,
  });
  expect(x.requests).toHaveLength(1);
});
it("exhausted invalid responses retain cost and fail", async () => {
  const x = setup([{ finish_reason: "stop", message: { content: "bad" } }]);
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_OUTPUT_INVALID",
    costMicros: 1000,
  });
});
it("normalizes discriminated tools to object roots without requiring branch-only fields", () => {
  const result = objectToolParameters({
    oneOf: [
      {
        type: "object",
        properties: { type: { const: "a" }, id: { type: "string" } },
        required: ["type", "id"],
      },
      {
        type: "object",
        properties: { type: { const: "b" } },
        required: ["type"],
      },
    ],
  });
  expect(result.type).toBe("object");
  expect(result.required).toEqual(["type"]);
  expect(result.properties.type.anyOf).toEqual([
    { const: "a" },
    { const: "b" },
  ]);
  expect(() => objectToolParameters({ type: "array" })).toThrow(
    "TOOL_OBJECT_SCHEMA_REQUIRED",
  );
});

it("offers bounded same-engine server search only on the first request and obeys stage permissions", async () => {
  const x = setup(
    [{ finish_reason: "stop", message: { content: "invalid" } }, final],
    { webSearch: true },
  );
  await x.driver.run(job);
  expect(x.requests[0].tools).toEqual([
    {
      type: "openrouter:web_search",
      parameters: {
        engine: "exa",
        mode: "fast",
        max_uses: 1,
        max_results: 3,
        max_total_results: 3,
        max_characters: 1500,
      },
    },
  ]);
  expect(x.requests[0].max_tool_calls).toBe(1);
  expect(x.requests[1].tools).toBeUndefined();
  const denied = setup([final, final], {
    webSearch: true,
    leagueContext: async () => ({
      ownerStage: { activePermissions: ["remember"] },
    }),
  });
  await denied.driver.run(job);
  expect(denied.requests[0].tools).toBeUndefined();
});

it.each([
  'JSON: [{"secret":"PRIVATE_TOOL_ARGUMENT"}]',
  "[1,2]",
  "null",
  "{invalid",
])(
  "classifies malformed read arguments without executing or guessing them: %s",
  async (argumentsText) => {
    let reads = 0;
    const diagnostics: any[] = [];
    const x = setup(
      [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id: "bad-read",
                type: "function",
                function: { name: "read", arguments: argumentsText },
              },
            ],
          },
        },
        final,
      ],
      {
        diagnostic: async (d: any) => diagnostics.push(d),
        readTools: [
          {
            name: "read",
            description: "Synthetic read",
            parameters: { type: "object" },
            execute: async () => {
              reads++;
              return {};
            },
          },
        ],
      },
    );
    expect((await x.driver.run(job)).costMicros).toBe(2000);
    expect(reads).toBe(0);
    const result = JSON.parse(
      x.requests[1].messages.find((m: any) => m.role === "tool").content,
    );
    expect(result.code).toBe("INVALID_TOOL_ARGUMENTS");
    expect(diagnostics).toContainEqual({
      kind: "owner_read_tool_rejected",
      code: "INVALID_TOOL_ARGUMENTS",
      tool: "read",
      executed: false,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_TOOL_ARGUMENT");
    expect(x.requests).toHaveLength(2);
  },
);
it("repairs malformed structured memory before it can escape to runtime commit, retaining every charge", async () => {
  const diagnostics: any[] = [];
  const choice = (content: string) => ({
    finish_reason: "stop",
    message: {
      content: JSON.stringify({
        actions: [
          { type: "remember", key: "owner_capability_needs_v1", content },
        ],
        summary: "SYNTHETIC memory proposal",
      }),
    },
  });
  const x = setup(
    [
      choice('JSON: [{"task":"PRIVATE_OWNER_NEED"}]'),
      choice('[{"task":"SYNTHETIC actual corrected JSON"}]'),
    ],
    {
      leagueContext: async () => ({
        ownerStage: { stage: "onboarding", activePermissions: ["remember"] },
      }),
      diagnostic: async (d: any) => diagnostics.push(d),
    },
  );
  const result = await x.driver.run(job);
  expect(result.costMicros).toBe(2000);
  expect(result.actions).toEqual([
    {
      type: "remember",
      key: "owner_capability_needs_v1",
      content: '[{"task":"SYNTHETIC actual corrected JSON"}]',
    },
  ]);
  expect(
    diagnostics.some((d) => d.code === "PROVIDER_STRUCTURED_MEMORY_INVALID"),
  ).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_OWNER_NEED");
  expect(x.requests[1].messages.at(-1).content).toContain(
    "PROVIDER_STRUCTURED_MEMORY_INVALID",
  );
});
it("rejects malformed memory on the last call with observed cost and no hidden retry", async () => {
  const x = setup(
    [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            actions: [
              {
                type: "remember",
                key: "owner/memory-readback",
                content: "JSON: {private}",
              },
            ],
            summary: "SYNTHETIC",
          }),
        },
      },
    ],
    {
      leagueContext: async () => ({
        ownerStage: { stage: "onboarding", activePermissions: ["remember"] },
      }),
    },
  );
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_STRUCTURED_MEMORY_INVALID",
    costMicros: 1000,
  });
  expect(x.requests).toHaveLength(1);
});
it("reserves the sixth call for a complete actions-and-summary decision with explicit final instruction", async () => {
  let reads = 0;
  const choices = Array.from({ length: 5 }, (_, i) => ({
    finish_reason: "tool_calls",
    message: {
      tool_calls: [
        {
          id: `read-${i}`,
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ],
    },
  }));
  const x = setup([...choices, final], {
    readTools: [
      {
        name: "read",
        description: "Synthetic read",
        parameters: { type: "object" },
        execute: async () => {
          reads++;
          return {};
        },
      },
    ],
  });
  expect((await x.driver.run(job)).costMicros).toBe(6000);
  expect(reads).toBe(5);
  expect(x.requests[5]).not.toHaveProperty("tools");
  expect(x.requests[5].response_format).toEqual({ type: "json_object" });
  expect(x.requests[5].messages[0].content).toContain(
    "This is the final model call",
  );
  expect(x.requests[5].messages[0].content).toContain("both actions");
  expect(x.requests[5].messages[0].content).toContain("Do not omit summary");
  expect(x.requests[5].messages[0].content).toContain(
    "Do not add causalId or other fields to remember",
  );
  expect(x.requests).toHaveLength(6);
});

it("intersects rehearsal and onboarding permissions without allowing either scope to widen the other", async () => {
  const x = setup(
    [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            actions: [
              { type: "remember", key: "fixture", content: "forbidden" },
            ],
            summary: "synthetic denied write",
          }),
        },
      },
      final,
    ],
    {
      leagueContext: async () => ({
        ownerStage: { activePermissions: ["remember"] },
        rehearsal: { activePermissions: [] },
      }),
    },
  );
  expect((await x.driver.run(job)).actions).toEqual([]);
  expect(x.requests[1].messages.at(-1).content).toContain(
    "PROVIDER_ACTION_PERMISSION_DENIED",
  );
});
