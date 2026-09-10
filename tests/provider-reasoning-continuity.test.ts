import { it, expect } from "vitest";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import type { Job } from "../src/runtime/index.js";
const model = "synthetic/reasoning";
const job = (id: string) =>
  ({
    id: id + "-job",
    agentId: id,
    model,
    payload: {},
    memory: [],
    recentMessages: [],
    commitments: [],
  }) as unknown as Job;
function harness(
  reasoning: (owner: string, turn: number) => Record<string, unknown>,
  toolTurns = 1,
) {
  const requests: any[] = [],
    diagnostics: any[] = [],
    observations: any[] = [],
    reads: string[] = [];
  const counts = new Map<string, number>();
  const driver = new OpenRouterDriver(model, {
    apiKey: "synthetic-key",
    providerSlug: "synthetic",
    reportedProviderNames: ["Synthetic"],
    tariff: {
      inputUsdPerMillion: 0.01,
      outputUsdPerMillion: 0.01,
      verifiedAt: new Date().toISOString(),
      maxAgeHours: 24,
    },
    maxOutputTokens: 1000,
    reservationMicros: 100000,
    peers: [],
    maxCalls: toolTurns + 1,
    diagnostic: async (d) => {
      diagnostics.push(d);
    },
    observe: async (d) => {
      observations.push(d);
    },
    readTools: [
      {
        name: "source_read",
        description: "Synthetic read",
        parameters: { type: "object", properties: {} },
        execute: async (j) => {
          reads.push(j.agentId);
          return { synthetic: true };
        },
      },
    ],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      requests.push(body);
      const owner = JSON.parse(body.messages[1].content).job.agentId;
      const turn = counts.get(owner) ?? 0;
      counts.set(owner, turn + 1);
      return new Response(
        JSON.stringify({
          id: `synthetic-${owner}-${turn}`,
          model,
          provider: "Synthetic",
          usage: { cost: 0.000001 },
          choices: [
            {
              finish_reason: turn < toolTurns ? "tool_calls" : "stop",
              message:
                turn < toolTurns
                  ? {
                      content: null,
                      ...reasoning(owner, turn),
                      tool_calls: [
                        {
                          id: `read-${turn}`,
                          type: "function",
                          function: { name: "source_read", arguments: "{}" },
                        },
                      ],
                    }
                  : {
                      content: JSON.stringify({
                        actions: [],
                        summary: "Synthetic final result",
                      }),
                    },
            },
          ],
        }),
      );
    },
  });
  return { driver, requests, diagnostics, observations, reads };
}
it("preserves the exact ordered signed and encrypted blocks and raw reasoning across consecutive tool calls", async () => {
  const blocks = (turn: number) => [
    {
      type: "reasoning.text",
      text: `Private signed reasoning ${turn}\n\t`,
      signature: "OPAQUE+/==\n",
      index: 9,
      format: "provider-v1",
    },
    {
      type: "reasoning.encrypted",
      data: `ENCRYPTED:${turn}+/=`,
      id: "opaque-id",
      index: 3,
      extra: { untouched: [null, true, "\u0000"] },
    },
  ];
  const h = harness(
    (_owner, turn) => ({
      reasoning_details: blocks(turn),
      reasoning: `Private raw reasoning ${turn}\n  `,
    }),
    2,
  );
  const result = await h.driver.run(job("owner-a"));
  expect(result.costMicros).toBe(3);
  const messages = h.requests[2].messages.filter(
    (m: any) => m.role === "assistant",
  );
  expect(messages).toHaveLength(2);
  for (let turn = 0; turn < 2; turn++) {
    expect(messages[turn].reasoning_details).toEqual(blocks(turn));
    expect(JSON.stringify(messages[turn].reasoning_details)).toBe(
      JSON.stringify(blocks(turn)),
    );
    expect(messages[turn].reasoning).toBe(`Private raw reasoning ${turn}\n  `);
  }
  expect(
    JSON.stringify({
      result,
      diagnostics: h.diagnostics,
      observations: h.observations,
    }),
  ).not.toMatch(/Private signed|Private raw|ENCRYPTED|OPAQUE/);
});
it("keeps reasoning local to concurrent owner runs and does not carry it into a fresh job", async () => {
  const h = harness((owner) => ({
    reasoning_details: [
      { type: "reasoning.encrypted", data: `PRIVATE-${owner}` },
    ],
  }));
  await Promise.all([
    h.driver.run(job("owner-a")),
    h.driver.run(job("owner-b")),
  ]);
  for (const body of h.requests) {
    const owner = JSON.parse(body.messages[1].content).job.agentId;
    const other = owner === "owner-a" ? "owner-b" : "owner-a";
    expect(JSON.stringify(body)).not.toContain(`PRIVATE-${other}`);
  }
  await h.driver.run({ ...job("owner-a"), id: "fresh-job" });
  expect(
    h.requests
      .at(-1)
      .messages.some((m: any) => m.reasoning_details || m.reasoning),
  ).toBe(false);
});
it("rejects a different model before it can supply reasoning or execute a read", async () => {
  const h = harness(() => ({ reasoning: "private" }));
  await expect(
    h.driver.run({ ...job("a"), model: "different/model" }),
  ).rejects.toThrow("MODEL_PIN_VIOLATION");
  expect(h.requests).toHaveLength(0);
  expect(h.reads).toHaveLength(0);
});
it("rejects oversized opaque reasoning before executing tools without truncating it or losing the observed charge", async () => {
  const h = harness(() => ({
    reasoning_details: [
      { type: "reasoning.encrypted", data: "X".repeat(262145) },
    ],
  }));
  await expect(h.driver.run(job("a"))).rejects.toMatchObject({
    message: "PROVIDER_REASONING_CONTEXT_LIMIT",
    costMicros: 1,
  });
  expect(h.requests).toHaveLength(1);
  expect(h.reads).toHaveLength(0);
  expect(JSON.stringify(h.diagnostics).length).toBeLessThan(2000);
});
it("for raw-text providers preserves reasoning without manufacturing reasoning_details", async () => {
  const h = harness(() => ({
    reasoning: "SYNTHETIC unchanged raw reasoning\n",
  }));
  await h.driver.run(job("a"));
  const assistant = h.requests[1].messages.find(
    (m: any) => m.role === "assistant",
  );
  expect(assistant.reasoning).toBe("SYNTHETIC unchanged raw reasoning\n");
  expect(assistant).not.toHaveProperty("reasoning_details");
});
