import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companyHarnesses,
  RuntimeConfigSchema,
  type RuntimeConfig,
} from "../src/harnesses/catalog.js";
import { prepareWorkspace, configDigest } from "../src/harnesses/workspaces.js";
import {
  FranchiseObservations,
  eventEnvelope,
  NativeDecisionSchema,
} from "../src/harnesses/protocol.js";
import {
  nativeCanaryPlan,
  parseClaudeOutput,
  parseCodexOutput,
} from "../src/harnesses/adapters.js";
import { NativeHarnessDriver } from "../src/harnesses/driver.js";
import type { Job } from "../src/runtime/index.js";

const config: RuntimeConfig = {
  version: 1,
  leagueId: "test-league",
  agentId: "test-openai",
  teamId: "test-team",
  developer: "OpenAI",
  assignedModel: "synthetic/assigned",
  canonicalModel: "synthetic/assigned",
  harnessId: "codex",
  harnessVersion: null,
  providerModel: null,
  credentialRef: "B4_LEAGUE_TEST_ONLY",
  status: "staged",
  productionActions: false,
  exceptionReason: null,
};
const decision = {
  actions: [],
  summary: "SYNTHETIC fixture; no model called.",
};
const job: Job = {
  id: "fixture-job",
  agentId: config.agentId,
  model: config.assignedModel,
  causalId: "fixture-injury",
  kind: "event",
  payload: { synthetic: true },
  dueAt: new Date(),
  sourceOccurredAt: null,
  attempts: 1,
  fence: 1,
  workerId: "fixture-worker",
  leaseUntil: new Date(),
  memory: [],
  recentMessages: [],
  commitments: [],
};

describe("native franchise contracts", () => {
  it("prefers discovered native companies and requires an explicit substitute rationale", () => {
    expect(Object.keys(companyHarnesses)).toHaveLength(11);
    expect(companyHarnesses.Meta.primary).toBe("muse-code");
    expect(companyHarnesses.DeepSeek.primary).toBe("deepseek-harness");
    expect(companyHarnesses["Z.ai"].primary).toBe("zcode");
    expect(() =>
      RuntimeConfigSchema.parse({ ...config, harnessId: "goose" }),
    ).toThrow();
    expect(() =>
      RuntimeConfigSchema.parse({ ...config, agentId: "../neighbor" }),
    ).toThrow();
    expect(() =>
      RuntimeConfigSchema.parse({ ...config, productionActions: true }),
    ).toThrow();
    expect(() =>
      RuntimeConfigSchema.parse({ ...config, apiKey: "do-not-accept" }),
    ).toThrow();
    expect(() =>
      NativeDecisionSchema.parse({ ...decision, costMicros: 0 }),
    ).toThrow();
  });
  it("prepares separate homes/workspaces idempotently without overwriting identity or memory", async () => {
    // macOS tmpdir can resolve under /var symlink; use the real filesystem path.
    const { realpath } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "b4-harness-")));
    try {
      const a = await prepareWorkspace(root, config, "Existing charter\n");
      expect(
        await prepareWorkspace(root, config, "Existing charter\n"),
      ).toEqual(a);
      const b = await prepareWorkspace(
        root,
        { ...config, agentId: "other-owner" },
        "Existing charter\n",
      );
      expect(a.home).not.toBe(b.home);
      expect(a.workspace).not.toBe(b.workspace);
      expect(await readFile(join(a.workspace, "AGENTS.md"), "utf8")).toContain(
        "STAGED",
      );
      await expect(
        prepareWorkspace(
          root,
          { ...config, assignedModel: "different/model" },
          "Existing charter\n",
        ),
      ).rejects.toThrow("CONFLICT");
      expect(JSON.parse(await readFile(a.config, "utf8")).assignedModel).toBe(
        config.assignedModel,
      );
      expect(configDigest(config)).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses symlinked franchise roots", async () => {
    const { realpath } = await import("node:fs/promises");
    const root = await realpath(await mkdtemp(join(tmpdir(), "b4-symlink-")));
    try {
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), join(root, config.leagueId));
      await expect(prepareWorkspace(root, config, "charter")).rejects.toThrow(
        "UNSAFE",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("binds observations and events without allowing actor or action injection", async () => {
    const request = vi.fn().mockResolvedValue({
      role: "owner",
      leagueId: config.leagueId,
      teamId: config.teamId,
      agentId: config.agentId,
    });
    const observations = new FranchiseObservations({ request }, config);
    await observations.read({ type: "franchise" });
    expect(request).toHaveBeenCalledWith("GET", "/v1/agents/test-openai");
    await expect(
      observations.read({ type: "franchise", agentId: "other" }),
    ).rejects.toThrow();
    await expect(
      observations.read({
        type: "football",
        query: { type: "draft", playerId: "12345" },
      }),
    ).rejects.toThrow();
    await expect(
      observations.read({ type: "send", message: "bad" }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    expect(() => eventEnvelope(config, { ...job, agentId: "other" })).toThrow(
      "BINDING",
    );
    expect(() =>
      eventEnvelope(config, { ...job, model: "other/model" }),
    ).toThrow("BINDING");
  });
  it("rejects a mismatched workspace credential before exposing token-selected football state", async () => {
    const request = vi.fn().mockRejectedValue(Error("403 AGENT_FORBIDDEN"));
    const observations = new FranchiseObservations({ request }, config);
    await expect(
      observations.read({ type: "football", query: { type: "roster" } }),
    ).rejects.toThrow("FORBIDDEN");
    expect(request).toHaveBeenCalledExactlyOnceWith("GET", "/v1/me");
    const wrongIdentity = vi.fn().mockResolvedValue({
      role: "owner",
      leagueId: config.leagueId,
      agentId: "other",
      teamId: "other",
    });
    await expect(
      new FranchiseObservations({ request: wrongIdentity }, config).read({
        type: "host",
      }),
    ).rejects.toThrow("SCOPE_MISMATCH");
    expect(wrongIdentity).toHaveBeenCalledTimes(1);
  });
  it("does not let a transport alter the pinned config or original event state", async () => {
    const driver = new NativeHarnessDriver(config, {
      synthetic: true,
      execute: async ({ config: received, event }) => {
        expect(() => {
          received.providerModel = "different-model";
        }).toThrow();
        event.event.payload.modified = true;
        return {
          decision,
          charge: {
            state: "verified",
            costMicros: 1,
            evidenceId: "synthetic-1",
          },
        };
      },
    });
    const original = JSON.stringify(job);
    const result = await driver.run(job);
    expect(JSON.stringify(job)).toBe(original);
    expect(result.costEvidenceId).toBe("synthetic-1");
  });
  it("blocks real transports before execution and keeps missing charges unknown", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ decision, charge: { state: "unknown" } });
    const live = new NativeHarnessDriver(config, { synthetic: false, execute });
    await expect(live.run(job)).rejects.toThrow(
      "LIVE_ADMISSION_NOT_IMPLEMENTED",
    );
    expect(execute).not.toHaveBeenCalled();
    const fixture = new NativeHarnessDriver(config, {
      synthetic: true,
      execute,
    });
    await expect(fixture.run(job)).rejects.toThrow("COST_UNKNOWN");
  });
  it("holds external actions even with an otherwise valid trusted transport receipt", async () => {
    const driver = new NativeHarnessDriver(config, {
      synthetic: true,
      execute: async () => ({
        decision: {
          ...decision,
          actions: [
            {
              type: "message",
              causalId: "hello",
              recipientId: "other",
              body: "held",
            },
          ],
        },
        charge: {
          state: "verified",
          costMicros: 12,
          evidenceId: "synthetic-receipt",
        },
      }),
    });
    await expect(driver.run(job)).rejects.toMatchObject({
      message: "HARNESS_EXTERNAL_ACTIONS_HELD",
      costMicros: 12,
    });
  });
  it("generates native argument vectors only with explicit model and version, without fallback", () => {
    expect(() => nativeCanaryPlan(config, "/isolated/workspace")).toThrow(
      "PIN_REQUIRED",
    );
    const pinned = {
      ...config,
      providerModel: "fixture-exact-model",
      harnessVersion: "fixture-version",
    };
    const codex = nativeCanaryPlan(pinned, "/isolated/workspace");
    expect(codex.args).toContain("fixture-exact-model");
    expect(codex.launchable).toBe(false);
    expect(codex.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    const claude = nativeCanaryPlan(
      { ...pinned, developer: "Anthropic", harnessId: "claude-code" },
      "/isolated/workspace",
    );
    expect(claude.args).toContain("--strict-mcp-config");
    expect(claude.args).not.toContain("--fallback-model");
    const muse = nativeCanaryPlan(
      { ...pinned, developer: "Meta", harnessId: "muse-code" },
      "/isolated/workspace",
    );
    expect(muse.inputMode).toBe("prompt-file-key-stdin");
    expect(() =>
      nativeCanaryPlan(
        { ...pinned, developer: "Google", harnessId: "gemini-cli" },
        "/isolated/workspace",
      ),
    ).toThrow("NOT_IMPLEMENTED");
  });
  it("parses actual protocol-shaped fixture outputs while leaving CLI costs unsettled", () => {
    const completed = {
      type: "turn.completed",
      usage: { input_tokens: 15, output_tokens: 12 },
    };
    const message = {
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(decision) },
    };
    expect(
      parseCodexOutput(
        [message, completed].map((x) => JSON.stringify(x)).join("\n"),
      ).charge.state,
    ).toBe("unknown");
    expect(() => parseCodexOutput(JSON.stringify(message))).toThrow(
      "INCOMPLETE",
    );
    expect(() =>
      parseCodexOutput(JSON.stringify({ type: "turn.failed" })),
    ).toThrow("FAILED");
    const claude = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: decision,
        usage: {},
        total_cost_usd: 0,
      }),
    );
    expect(claude.reportedCostUsd).toBe(0);
    expect(claude.charge.state).toBe("unknown");
    expect(() =>
      parseClaudeOutput(
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
        }),
      ),
    ).toThrow("FAILED");
  });
});
