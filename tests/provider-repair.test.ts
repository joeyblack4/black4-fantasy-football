import { it, expect } from "vitest";
import { z } from "zod";
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
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "owner_read_tool_rejected",
          code: "INVALID_TOOL_ARGUMENTS",
          tool: "read",
          executed: false,
        }),
      ]),
    );
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
it("closes tools before the fifth call and repairs an ignored decision boundary on the sixth", async () => {
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
  expect(reads).toBe(4);
  expect(x.requests[4]).not.toHaveProperty("tools");
  expect(x.requests[4].messages[0].content).toContain(
    "read-tool phase is now closed",
  );
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

it("reserves a last-call format repair after four reads without stripping memory metadata or increasing the cap", async () => {
  let reads = 0;
  const choices = Array.from({ length: 4 }, (_, i) => ({
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
  const invalid = {
    finish_reason: "stop",
    message: {
      content: JSON.stringify({
        actions: [
          {
            type: "remember",
            key: "followup",
            content: "Actual observed result",
            version: 2,
          },
        ],
        summary: "Invalid action metadata",
      }),
    },
  };
  const corrected = {
    finish_reason: "stop",
    message: {
      content: JSON.stringify({
        actions: [
          {
            type: "remember",
            key: "followup",
            content: "Actual observed result",
          },
        ],
        summary: "Corrected by the model",
      }),
    },
  };
  const x = setup([...choices, invalid, corrected], {
    readTools: [
      {
        name: "read",
        description: "Synthetic",
        parameters: { type: "object" },
        execute: async () => {
          reads++;
          return {};
        },
      },
    ],
  });
  const result = await x.driver.run(job);
  expect(result).toMatchObject({
    costMicros: 6000,
    actions: [
      { type: "remember", key: "followup", content: "Actual observed result" },
    ],
  });
  expect(reads).toBe(4);
  expect(x.requests).toHaveLength(6);
  expect(x.requests[4].tools).toBeUndefined();
  expect(x.requests[5].tools).toBeUndefined();
  expect(x.requests[5].messages.at(-1).content).toContain("version");
  expect(x.requests[5].messages.at(-1).content).toContain(
    "No proposed actions were executed",
  );
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

function decision(actions: unknown[]) {
  return {
    finish_reason: "stop",
    message: {
      content: JSON.stringify({
        actions,
        summary: "Synthetic bounded decision",
      }),
    },
  };
}
it("explicitly keeps optional tool fields non-strict and repairs invalid union arguments without leaking values", async () => {
  const schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("rules") }).strict(),
    z
      .object({
        type: z.literal("scores"),
        week: z.number().int().positive().optional(),
      })
      .strict(),
  ]);
  const diagnostics: any[] = [];
  let reads = 0;
  const toolCall = (args: unknown) => ({
    finish_reason: "tool_calls",
    message: {
      tool_calls: [
        {
          id: "fixture-read",
          type: "function",
          function: { name: "mfl_read", arguments: JSON.stringify(args) },
        },
      ],
    },
  });
  const x = setup(
    [
      toolCall({
        type: "scores",
        week: null,
        private_secret_key: "DO-NOT-ECHO-VALUE",
      }),
      toolCall({ type: "rules" }),
      final,
      final,
    ],
    {
      diagnostic: async (value: unknown) => {
        diagnostics.push(value);
      },
      readTools: [
        {
          name: "mfl_read",
          description: "Synthetic owner read",
          parameters: z.toJSONSchema(schema),
          execute: async (_job: Job, args: unknown) => {
            const parsed = schema.parse(args);
            reads++;
            return parsed;
          },
        },
      ],
    },
  );
  await x.driver.run(job);
  expect(reads).toBe(1);
  expect(x.requests).toHaveLength(3);
  expect(x.requests[0].tools[0].function.strict).toBe(false);
  expect(x.requests[0].tools[0].function.parameters.required).toEqual(["type"]);
  const rejected = diagnostics.find(
    (d) => d.kind === "owner_read_tool_rejected",
  );
  expect(rejected).toMatchObject({
    executed: false,
    unknownFieldCount: 1,
    providedFields: [
      { key: "type", type: "string" },
      { key: "week", type: "null" },
    ],
  });
  expect(rejected.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "invalid_type",
        path: ["week"],
        expectedType: "number",
      }),
    ]),
  );
  const safe =
    JSON.stringify(rejected) +
    x.requests[1].messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => m.content)
      .join("");
  expect(safe).not.toContain("DO-NOT-ECHO-VALUE");
  expect(safe).not.toContain("private_secret_key");
});

function fullMemoryJob(): Job {
  return {
    ...job,
    memory: [
      ...Array.from({ length: 4 }, (_, i) => ({
        key: `existing-${i}`,
        content: "x".repeat(8000),
        version: 1,
      })),
      { key: "existing-4", content: "x".repeat(760), version: 1 },
    ],
  };
}
it("repairs memory overflow as a full model-authored batch, preserving existing memory and all charges", async () => {
  const scoped = fullMemoryJob();
  const before = JSON.stringify(scoped.memory);
  const diagnostics: any[] = [];
  const keep = {
    type: "remember",
    key: "existing-4",
    content: "Useful concise revised knowledge",
  };
  const x = setup(
    [
      decision([
        { type: "remember", key: "new", content: "n".repeat(60) },
        keep,
      ]),
      decision([keep]),
    ],
    {
      diagnostic: async (d: unknown) => {
        diagnostics.push(d);
      },
    },
  );
  const result = await x.driver.run(scoped);
  expect(result).toMatchObject({ actions: [keep], costMicros: 2000 });
  expect(JSON.stringify(scoped.memory)).toBe(before);
  expect(
    x.requests[0].messages.some((m: any) =>
      m.content.includes('"usedBytes":32760'),
    ),
  ).toBe(true);
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        memoryCapacity: {
          maxBytes: 32768,
          projectedBytes: 32820,
          maxKeys: 100,
          projectedKeys: 6,
          actionIndex: 0,
        },
      }),
    ]),
  );
  expect(x.requests[1].messages.at(-1).content).toContain(
    "No proposed actions were executed",
  );
});
it("accepts an owner-authored smaller replacement before a new memory and counts UTF-8 bytes", async () => {
  const actions = [
    { type: "remember", key: "existing-4", content: "Smaller" },
    { type: "remember", key: "new", content: "😀".repeat(60) },
  ];
  const x = setup([decision(actions)]);
  expect((await x.driver.run(fullMemoryJob())).actions).toEqual(actions);
  const rejected = setup([
    decision([{ type: "remember", key: "new", content: "😀😀😀" }]),
  ]);
  await expect(rejected.driver.run(fullMemoryJob())).rejects.toMatchObject({
    message: "PROVIDER_MEMORY_CAPACITY_EXCEEDED",
    costMicros: 1000,
  });
  expect(rejected.requests).toHaveLength(1);
});
it("enforces the existing key cap while allowing replacement and never adding an unbudgeted retry", async () => {
  const scoped = {
    ...job,
    memory: Array.from({ length: 100 }, (_, i) => ({
      key: `key-${i}`,
      content: "kept",
      version: 1,
    })),
  };
  const x = setup([
    decision([{ type: "remember", key: "new", content: "too many keys" }]),
  ]);
  await expect(x.driver.run(scoped)).rejects.toMatchObject({
    message: "PROVIDER_MEMORY_CAPACITY_EXCEEDED",
    costMicros: 1000,
  });
  expect(x.requests).toHaveLength(1);
  const replacement = {
    type: "remember",
    key: "key-0",
    content: "replacement",
  };
  expect(
    (await setup([decision([replacement])]).driver.run(scoped)).actions,
  ).toEqual([replacement]);
  expect(scoped.memory[0].content).toBe("kept");
});

const batch = (count: number, prefix = "batch") => ({
  finish_reason: "tool_calls",
  message: {
    content: null,
    reasoning: "SYNTHETIC exact reasoning continuity",
    reasoning_details: [
      {
        type: "reasoning.encrypted",
        data: "SYNTHETIC opaque block",
        id: "signed-fixture",
        index: 0,
      },
    ],
    tool_calls: Array.from({ length: count }, (_, i) => ({
      id: prefix + "-" + i,
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ index: i }) },
    })),
  },
});
it("corrects one five-call batch without executing it, preserving tool IDs, reasoning, charges and the original call ceiling", async () => {
  let reads = 0;
  const diagnostics: any[] = [];
  const rejected = batch(5);
  const x = setup([rejected, batch(4, "valid"), final], {
    maxCalls: 6,
    diagnostic: async (d: any) => {
      diagnostics.push({ ...d, readsAtDiagnostic: reads });
    },
    readTools: [
      {
        name: "read",
        description: "SYNTHETIC read",
        parameters: {
          type: "object",
          properties: { index: { type: "integer" } },
        },
        execute: async () => {
          reads++;
          return { status: "verified", synthetic: true };
        },
      },
    ],
  });
  const result = await x.driver.run(job);
  expect(result).toMatchObject({ actions: [], costMicros: 3000 });
  expect(reads).toBe(4);
  expect(x.requests).toHaveLength(3);
  expect(x.requests[0].messages[0].content).toContain(
    "at most 4 read-tool calls",
  );
  expect(diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "owner_read_tool_batch_rejected",
      requestedCount: 5,
      maxReadToolsPerResponse: 4,
      executed: false,
      readsAtDiagnostic: 0,
    }),
  );
  const assistant = x.requests[1].messages.find(
    (m: any) => m.role === "assistant",
  );
  expect(assistant).toEqual({ role: "assistant", ...rejected.message });
  const errors = x.requests[1].messages.filter((m: any) => m.role === "tool");
  expect(errors.map((m: any) => m.tool_call_id)).toEqual(
    rejected.message.tool_calls.map((c) => c.id),
  );
  expect(
    errors.every(
      (m: any) =>
        JSON.parse(m.content).code === "PROVIDER_TOOL_LIMIT" &&
        JSON.parse(m.content).executed === false,
    ),
  ).toBe(true);
  expect(x.requests[1].tools).toBeDefined();
});
it.each(["count", "argument", "aggregate", "duplicate", "malformed"])(
  "rejects a gross %s tool batch without any execution or correction call",
  async (kind) => {
    let reads = 0;
    const choice = batch(kind === "count" ? 17 : 5);
    if (kind === "argument")
      choice.message.tool_calls[0].function.arguments = JSON.stringify({
        x: "x".repeat(32768),
      });
    if (kind === "aggregate")
      choice.message.tool_calls.forEach((c) => {
        c.function.arguments = JSON.stringify({ x: "x".repeat(27000) });
      });
    if (kind === "duplicate")
      choice.message.tool_calls[1].id = choice.message.tool_calls[0].id;
    if (kind === "malformed")
      choice.message.tool_calls[0].function.arguments = "[1]";
    const x = setup([choice, final], {
      maxCalls: 6,
      readTools: [
        {
          name: "read",
          description: "SYNTHETIC",
          parameters: { type: "object" },
          execute: async () => {
            reads++;
          },
        },
      ],
    });
    await expect(x.driver.run(job)).rejects.toMatchObject({
      message:
        kind === "count"
          ? "PROVIDER_TOOL_LIMIT"
          : "PROVIDER_TOOL_BATCH_INVALID",
      costMicros: 1000,
    });
    expect(reads).toBe(0);
    expect(x.requests).toHaveLength(1);
  },
);
it("allows only one overlong correction and retains both charges if the model repeats it", async () => {
  let reads = 0;
  const x = setup([batch(5), batch(5, "again"), final], {
    maxCalls: 6,
    readTools: [
      {
        name: "read",
        description: "SYNTHETIC",
        parameters: { type: "object" },
        execute: async () => {
          reads++;
        },
      },
    ],
  });
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_TOOL_LIMIT",
    costMicros: 2000,
  });
  expect(x.requests).toHaveLength(2);
  expect(reads).toBe(0);
});
it("charges correction against the same six calls and keeps the fifth-call decision boundary", async () => {
  let reads = 0;
  const invalid = {
    finish_reason: "stop",
    message: { content: "SYNTHETIC malformed final" },
  };
  const x = setup(
    [
      batch(5),
      batch(1, "r2"),
      batch(1, "r3"),
      batch(1, "r4"),
      invalid,
      invalid,
    ],
    {
      maxCalls: 6,
      readTools: [
        {
          name: "read",
          description: "SYNTHETIC",
          parameters: { type: "object" },
          execute: async () => {
            reads++;
            return {};
          },
        },
      ],
    },
  );
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROVIDER_OUTPUT_INVALID",
    costMicros: 6000,
  });
  expect(x.requests).toHaveLength(6);
  expect(reads).toBe(3);
  expect(x.requests[4].tools).toBeUndefined();
  expect(x.requests[5].tools).toBeUndefined();
  expect(x.requests[4].messages[0].content).toContain(
    "read-tool phase is now closed",
  );
});
