import { it, expect } from "vitest";
import { z } from "zod";
import {
  projectDraftForModel,
  draftFootballResponseContract,
} from "../src/providers/draft-projection.js";
import { OpenRouterDriver } from "../src/providers/openrouter.js";
import { FootballActionSchema } from "../src/runtime/football-schema.js";
import type { Job } from "../src/runtime/index.js";
function draft() {
  return {
    round: 2,
    pick: 2,
    franchiseId: "0002",
    paused: false,
    stopped: false,
    over: false,
    status: "in_progress",
    sourceTimestamp: "100",
    picks: Array.from({ length: 192 }, (_, i) => ({
      round: Math.floor(i / 12) + 1,
      pick: (i % 12) + 1,
      franchiseId: String((i % 12) + 1).padStart(4, "0"),
      playerId: i < 12 ? String(10000 + i) : null,
    })),
  };
}
function freeze(v: any) {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}
it("losslessly projects only empty future bodies while preserving every completed/current/past slot and source order", () => {
  const original = freeze(draft()),
    before = JSON.stringify(original),
    p: any = projectDraftForModel(original);
  expect(JSON.stringify(original)).toBe(before);
  expect(p).not.toBe(original);
  expect(p.picks).toEqual(original.picks.slice(0, 14));
  const restored = [...p.picks];
  for (const [i, round, pick, franchiseId] of p.emptyFutureSlots.slots)
    restored.splice(i, 0, { round, pick, franchiseId, playerId: null });
  expect(restored).toEqual(original.picks);
  const { picks, emptyFutureSlots, ...root } = p;
  const { picks: old, ...oldRoot } = original;
  expect(root).toEqual(oldRoot);
  expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(
    Buffer.byteLength(before) * 0.55,
  );
});
it("preserves unknown row fields and unknown current turn without attempting lossy compression", () => {
  const d = draft();
  const extended = {
    ...d,
    picks: [{ ...d.picks[50], futureNativeAuthority: "must-preserve" }],
  };
  expect(projectDraftForModel(extended)).toBe(extended);
  const unknown = { ...d, round: null };
  expect(projectDraftForModel(unknown)).toBe(unknown);
});
it("advertises only existing draft/localqueue action validators without weakening the authoritative football validator", () => {
  const schema = draftFootballResponseContract();
  const serialized = JSON.stringify(schema);
  expect(serialized).toContain("mflLocalDraftQueue");
  expect(serialized).toContain('"draft"');
  for (const v of ["proposeTrade", "draftPick", "setLineup", "replaceBids"])
    expect(serialized).not.toContain(v);
  expect(Buffer.byteLength(serialized)).toBeLessThan(
    Buffer.byteLength(JSON.stringify(z.toJSONSchema(FootballActionSchema))) / 3,
  );
  expect(
    FootballActionSchema.safeParse({
      type: "football",
      causalId: "trade",
      command: {
        type: "mfl",
        action: {
          type: "proposeTrade",
          counterpartyTeamId: "peer",
          givePlayerIds: ["10001"],
          receivePlayerIds: ["10002"],
        },
      },
    }).success,
  ).toBe(true);
});
it.each([true, false])(
  "projects only armed rehearsal model bodies=%s; native receipt and journal objects remain intact with tools/memories/decisions unchanged",
  async (armed) => {
    const native = freeze({
      id: "synthetic-native-receipt",
      at: "2026-09-08T00:00:00Z",
      data: draft(),
      synthetic: true,
    });
    const journal = JSON.stringify(native);
    const rules = freeze({
      hash: "same",
      selections: { scoring: "exact-PPR" },
      teamOrder: Array.from({ length: 12 }, (_, i) => "team" + i),
      policies: "unchanged",
    });
    const job = freeze({
      id: "synthetic-job",
      agentId: "owner",
      kind: "owner",
      model: "synthetic/model",
      payload: { draft: draft() },
      memory: [
        { key: "prior", content: "OWNER PRIVATE MEMORY UNCHANGED", version: 2 },
      ],
      recentMessages: [],
      commitments: [],
    }) as unknown as Job;
    const before = JSON.stringify(job);
    const requests: any[] = [];
    const tools = [
      "mfl_read",
      "research_sources",
      "research_search",
      "research_retrieve",
    ];
    const driver = new OpenRouterDriver(job.model, {
      apiKey: "SYNTHETIC",
      providerSlug: "synthetic",
      reportedProviderNames: ["Synthetic"],
      peers: [],
      maxCalls: 3,
      maxOutputTokens: 1000,
      reservationMicros: 100000,
      tariff: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        verifiedAt: new Date().toISOString(),
        maxAgeHours: 24,
      },
      leagueContext: async () => ({
        rehearsal: armed
          ? {
              status: "armed",
              disposableFootball: true,
              host: { host: "mfl", config: { leagueId: "46625" } },
              activePermissions: ["remember", "football", ...tools],
              preparedRules: rules,
            }
          : null,
      }),
      readTools: tools.map((name) => ({
        name,
        description: "SYNTHETIC",
        parameters: { type: "object" },
        execute: async () => native,
      })),
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        return new Response(
          JSON.stringify({
            model: job.model,
            provider: "Synthetic",
            usage: { cost: 0.001 },
            choices: [
              requests.length === 1
                ? {
                    finish_reason: "tool_calls",
                    message: {
                      tool_calls: [
                        {
                          id: "exact-id",
                          type: "function",
                          function: {
                            name: "mfl_read",
                            arguments: '{"type":"draft"}',
                          },
                        },
                      ],
                    },
                  }
                : {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        actions: [
                          {
                            type: "remember",
                            key: "same-action",
                            content: "Owner decision retained",
                          },
                        ],
                        summary: "Synthetic complete",
                      }),
                    },
                  },
            ],
          }),
        );
      },
    });
    const result = await driver.run(job);
    expect(result).toMatchObject({
      costMicros: 2000,
      actions: [
        {
          type: "remember",
          key: "same-action",
          content: "Owner decision retained",
        },
      ],
    });
    expect(JSON.stringify(native)).toBe(journal);
    expect(JSON.stringify(job)).toBe(before);
    const initial = JSON.parse(requests[0].messages[1].content);
    expect(initial.job.memory).toEqual(job.memory);
    expect(initial.leagueContext.rehearsal?.preparedRules ?? null).toEqual(
      armed ? rules : null,
    );
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(tools);
    const readback = JSON.parse(
      requests[1].messages.find((m: any) => m.role === "tool").content,
    );
    expect(readback.id).toBe(native.id);
    expect(Boolean(initial.job.payload.draft.emptyFutureSlots)).toBe(armed);
    expect(Boolean(readback.data.emptyFutureSlots)).toBe(armed);
    expect(
      initial.job.payload.draft.picks.filter((p: any) => p.playerId),
    ).toEqual((job.payload.draft as any).picks.filter((p: any) => p.playerId));
  },
);
