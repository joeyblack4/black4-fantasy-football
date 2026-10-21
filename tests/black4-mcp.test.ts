import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error plain ESM module without types
import { BLACK4_MCP, configTarget, ensureBlack4Mcp, signInPlan } from "../scripts/black4-mcp.mjs";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(readFileSync(join(root, "config/native-harnesses.json"), "utf8"));
const url = "https://api.black4.ai/mcp";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function envFor(base: string): Record<string, string> {
  return {
    HOME: join(base, "home"),
    CODEX_HOME: join(base, "codex"),
    CLAUDE_CONFIG_DIR: join(base, "claude"),
    GEMINI_CLI_HOME: join(base, "gemini"),
    QWEN_HOME: join(base, "qwen"),
    GROK_HOME: join(base, "grok"),
    VIBE_HOME: join(base, "vibe"),
    KIMI_CODE_HOME: join(base, "kimi"),
    XDG_CONFIG_HOME: join(base, "xdg"),
    GOOSE_PATH_ROOT: join(base, "goose"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "m", permission: "allow" }),
  };
}

describe("Black 4 MCP in each owner's own harness", () => {
  it("is the customer sign-in on the one remote server", () => {
    expect(BLACK4_MCP).toEqual({
      name: "black4",
      url,
      signInAs: "joeysterling22@gmail.com",
      businessId: "business-fantasy-football",
    });
  });

  it("writes an entry for every franchise harness, once, keeping other settings", () => {
    const harnesses = [...new Set(Object.values(registry.franchises).map((spec: any) => spec.harness))];
    expect(harnesses).toHaveLength(11);
    for (const harness of harnesses as string[]) {
      const base = mkdtempSync(join(tmpdir(), "b4-mcp-"));
      dirs.push(base);
      const env = envFor(base);
      const target = configTarget(harness, env);
      if (target && target.endsWith(".json")) {
        mkdirSync(resolve(target, ".."), { recursive: true });
        writeFileSync(target, JSON.stringify({ keep: true, mcpServers: { other: { url: "x" } } }));
      }
      ensureBlack4Mcp(harness, env);
      const first = target ? readFileSync(target, "utf8") : env.OPENCODE_CONFIG_CONTENT;
      expect(first).toContain(url);
      ensureBlack4Mcp(harness, env);
      const second = target ? readFileSync(target, "utf8") : env.OPENCODE_CONFIG_CONTENT;
      expect(second).toBe(first);
      if (target?.endsWith(".json")) {
        const json = JSON.parse(second);
        expect(json.keep).toBe(true);
        expect(json.mcpServers.other).toEqual({ url: "x" });
        expect(JSON.stringify(json.mcpServers.black4)).toContain(url);
      }
      // Never the staff channel guard or a token in config.
      expect(second).not.toMatch(/X-Black4-Channel-Bound|Bearer|token/i);
    }
  });

  it("keeps an existing codex config and the opencode operator file", () => {
    const base = mkdtempSync(join(tmpdir(), "b4-mcp-"));
    dirs.push(base);
    const env = envFor(base);
    mkdirSync(env.CODEX_HOME, { recursive: true });
    writeFileSync(join(env.CODEX_HOME, "config.toml"), 'model = "gpt"\n');
    ensureBlack4Mcp("codex", env);
    expect(readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8")).toBe(
      `model = "gpt"\n\n[mcp_servers.black4]\nurl = "${url}"\n`,
    );
    const file = join(base, "opencode.json");
    writeFileSync(file, JSON.stringify({ model: "z", provider: {} }));
    ensureBlack4Mcp("opencode", { ...env, OPENCODE_CONFIG: file });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      model: "z",
      provider: {},
      mcp: { black4: { type: "remote", url } },
    });
  });

  it("trusts only the owner's workspace for Gemini, which disables MCP in untrusted folders", () => {
    const base = mkdtempSync(join(tmpdir(), "b4-mcp-"));
    dirs.push(base);
    const env = envFor(base);
    ensureBlack4Mcp("gemini-cli", env, "/league/franchises/google/workspace");
    ensureBlack4Mcp("gemini-cli", env, "/league/franchises/google/workspace");
    expect(JSON.parse(readFileSync(join(env.GEMINI_CLI_HOME, ".gemini/trustedFolders.json"), "utf8"))).toEqual({
      "/league/franchises/google/workspace": "TRUST_FOLDER",
    });
  });

  it("adds goose's extension under an existing extensions block", () => {
    const base = mkdtempSync(join(tmpdir(), "b4-mcp-"));
    dirs.push(base);
    const env = envFor(base);
    const path = join(env.GOOSE_PATH_ROOT, "config/config.yaml");
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "GOOSE_MODE: auto\nextensions:\n  developer:\n    enabled: true\n");
    ensureBlack4Mcp("goose", env);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/extensions:\n {2}black4:\n {4}enabled: true\n {4}type: streamable_http/);
    expect(text).toContain("  developer:\n    enabled: true");
    expect(existsSync(path)).toBe(true);
  });

  it("signs every harness in through its own command or its own screen", () => {
    const binaries = new Proxy({}, { get: (_, key) => `/bin/${String(key)}` });
    for (const spec of Object.values(registry.franchises) as any[]) {
      const plan = signInPlan(spec.harness, {}, binaries);
      expect(plan.command ?? plan.interactive).toBeTruthy();
      if (plan.interactive) expect(plan.steps.length).toBeGreaterThan(0);
    }
    expect(signInPlan("codex", {}, binaries).command).toEqual(["/bin/codex", "mcp", "login", "black4"]);
  });
});
