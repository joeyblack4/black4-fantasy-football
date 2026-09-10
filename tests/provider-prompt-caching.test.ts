import { it, expect } from "vitest";
import {
  promptCachePolicy,
  cacheUsageDiagnostic,
} from "../src/providers/prompt-caching.js";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import type { Job } from "../src/runtime/index.js";
const model = "anthropic/synthetic-model";
const job = {
  id: "synthetic-job",
  agentId: "synthetic-owner",
  model,
  kind: "owner",
  memory: [],
  payload: {},
} as unknown as Job;
function harness(options: any = {}) {
  const requests: any[] = [],
    diagnostics: any[] = [],
    observations: any[] = [];
  let index = 0;
  const m = options.model ?? model,
    provider = options.providerSlug ?? "anthropic";
  const manifest = {
    id: "synthetic-manifest",
    document: {
      model: m,
      providerSlug: provider,
      reportedProviderNames: ["Synthetic"],
      quantization: null,
      toolPermissions: ["research_sources"],
    },
  };
  const registry = {
    preflight: async () => manifest,
    begin: async () => `call-${index + 1}`,
    observe: async (_id: any, v: any) => observations.push(v),
    diagnostic: async (_id: any, v: any) => diagnostics.push(v),
  };
  const cfg: any = {
    apiKey: "SYNTHETIC",
    providerSlug: provider,
    reportedProviderNames: ["Synthetic"],
    peers: [],
    maxCalls: 2,
    maxOutputTokens: 1000,
    reservationMicros: 3000000,
    tariff: {
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 50,
      verifiedAt: new Date().toISOString(),
      maxAgeHours: 24,
    },
    identity: {
      registry,
      manifestId: manifest.id,
      canary: options.canary ?? false,
    },
    readTools: [
      {
        name: "research_sources",
        description: "SYNTHETIC",
        parameters: { type: "object" },
        execute: async () => ({ status: "synthetic" }),
      },
    ],
    fetchImpl: async (_url: any, init: any) => {
      if (init?.method === "GET" || String(_url).includes("/generation"))
        return new Response(
          JSON.stringify({
            data: {
              id: `generation-${index}`,
              model: m,
              provider_name: "Synthetic",
              total_cost: 0.001,
              native_tokens_prompt: 1000,
              native_tokens_completion: 10,
            },
          }),
        );
      const body = JSON.parse(init.body);
      requests.push(body);
      index++;
      return new Response(
        JSON.stringify({
          id: `generation-${index}`,
          model: m,
          provider: "Synthetic",
          usage: { cost: 0.001, ...(options.usage ?? {}) },
          choices: [
            index === 1
              ? {
                  finish_reason: "tool_calls",
                  message: {
                    tool_calls: [
                      {
                        id: "exact-tool-id",
                        type: "function",
                        function: { name: "research_sources", arguments: "{}" },
                      },
                    ],
                  },
                }
              : {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify({
                      actions: [],
                      summary: "Synthetic complete",
                    }),
                  },
                },
          ],
        }),
      );
    },
    ...options,
  };
  delete cfg.canary;
  delete cfg.usage;
  delete cfg.model;
  return {
    driver: new OpenRouterDriver(m, cfg),
    requests,
    diagnostics,
    observations,
  };
}
it("uses the exact capability route, preserves manual pins and actual cost, and reports missing usage as unknown", async () => {
  const x = harness();
  expect((await x.driver.run(job)).costMicros).toBe(2000);
  expect(x.requests).toHaveLength(2);
  for (const r of x.requests) {
    expect(r.cache_control).toEqual({ type: "ephemeral" });
    expect(r.provider).toEqual({
      only: ["anthropic"],
      allow_fallbacks: false,
      require_parameters: true,
    });
  }
  expect(
    x.diagnostics
      .filter((d) => d.kind === "inference_request_settings")
      .every(
        (d) =>
          d.promptCaching.request.type === "ephemeral" &&
          d.promptCaching.inputCacheWriteFactor === 1.25,
      ),
  ).toBe(true);
  const cache = x.diagnostics.filter(
    (d) => d.kind === "provider_prompt_cache_usage",
  );
  expect(cache).toHaveLength(2);
  expect(cache[0]).toMatchObject({
    cachedTokens: null,
    cacheWriteTokens: null,
    usageStatus: "unknown",
    discountAssumed: false,
    costMicros: 1000,
  });
  expect(x.observations.every((o) => o.costMicros === 1000)).toBe(true);
});
it("retains observed cache reads/writes without subtracting an assumed discount from reported cost", async () => {
  const x = harness({
    usage: {
      prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 50 },
    },
  });
  expect((await x.driver.run(job)).costMicros).toBe(2000);
  expect(x.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "provider_prompt_cache_usage",
      cachedTokens: 1000,
      cacheWriteTokens: 50,
      usageStatus: "reported",
      discountAssumed: false,
      costMicros: 1000,
    }),
  );
  expect(
    cacheUsageDiagnostic({
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    }),
  ).toMatchObject({
    cachedTokens: 0,
    cacheWriteTokens: 0,
    usageStatus: "reported",
  });
});
it.each([
  { model: "anthropic/synthetic-model", providerSlug: "amazon-bedrock" },
  { model: "other/synthetic-model", providerSlug: "anthropic" },
  { model: "other/synthetic-model", providerSlug: "other" },
])("leaves cache field absent on unsupported pinned routes %j", async (o) => {
  const x = harness(o);
  await x.driver.run({ ...job, model: o.model });
  expect(x.requests.every((r) => !("cache_control" in r))).toBe(true);
});
it("leaves default canaries unchanged but sends cache parameter when a canary explicitly tests it", async () => {
  const base = harness({ canary: true });
  await base.driver.run(job);
  expect(base.requests.every((r) => !("cache_control" in r))).toBe(true);
  const explicit = harness({ canary: true, promptCaching: "anthropic-5m" });
  await explicit.driver.run(job);
  expect(
    explicit.requests.every((r) => r.cache_control?.type === "ephemeral"),
  ).toBe(true);
});
it("rejects explicit unsupported cache policy before requesting inference", async () => {
  const x = harness({
    providerSlug: "amazon-bedrock",
    promptCaching: "anthropic-5m",
  });
  await expect(x.driver.run(job)).rejects.toMatchObject({
    message: "PROMPT_CACHE_CAPABILITY_MISMATCH",
  });
  expect(x.requests).toHaveLength(0);
});
it("reserves cache-write worst-case before existing safety margin and rejects the same cap before dispatch", async () => {
  const large = {
    ...job,
    memory: [{ key: "fixture", content: "x".repeat(50000), version: 1 }],
  };
  const base = harness({ promptCaching: "disabled" });
  await base.driver.run(large);
  const body = base.requests[0];
  const baseEstimate = Math.ceil(
    ((Buffer.byteLength(JSON.stringify(body)) + 4096) * 10 + 1000 * 50) * 1.25,
  );
  const cached = harness({ reservationMicros: baseEstimate + 500 });
  await expect(cached.driver.run(large)).rejects.toMatchObject({
    message: "RESERVATION_TOO_SMALL",
  });
  expect(cached.requests).toHaveLength(0);
  expect(
    promptCachePolicy(model, "anthropic", false).inputCacheWriteFactor,
  ).toBe(1.25);
});
