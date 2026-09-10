import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const session = "f350b750-0314-4b87-b8df-c6a06ba11111";
function run(
  mode: string,
  overrides: Record<string, string | undefined> = {},
  flags = ["--print-plan"],
  secretOverrides: Record<string, string> = {},
) {
  const d = mkdtempSync(join(tmpdir(), "b4-chat-supervisor-"));
  dirs.push(d);
  const environment: Record<string, string> = {
    FOOTBALL_LEAGUE_ID: "black4-fantasy-2026",
    FOOTBALL_CONVERSATION_SESSION_ID: session,
    B4_LEAGUE_BUZZ_EXECUTABLE: "/nonexistent/buzz",
    ...(mode === "conversation"
      ? {
          FOOTBALL_MANIFEST_ID: "manifest-fixture",
          FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED: "true",
        }
      : { FOOTBALL_CONVERSATION_LISTENER_AGENT_ID: "b4-openai" }),
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete environment[k];
    else environment[k] = v;
  }
  const path = join(d, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      environment,
      secretFiles: {
        DATABASE_URL: "/nonexistent/db",
        ...(mode === "conversation"
          ? { B4_LEAGUE_OPENAI: "/nonexistent/key" }
          : {}),
        ...secretOverrides,
      },
    }),
  );
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/supervise-local.mjs", import.meta.url)),
      mode,
      ...flags,
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, FOOTBALL_SUPERVISOR_CONFIG: path },
    },
  );
}
describe("conversation supervisor separation", () => {
  it("plans a dedicated owner lane without reading inference secrets", () => {
    const r = run("conversation", {}, [
      "--print-plan",
      "--allow-paid-inference",
      "--allow-buzz-sends",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.child).toContain("--conversation");
    expect(p.requiredFlagPresent).toBe(true);
    expect(p.secretValuesRead).toBe(false);
    expect(p.started).toBe(false);
  });
  it("plans a single scoped listener with exact session and identity", () => {
    const r = run("buzz-conversation-listener", {}, [
      "--print-plan",
      "--allow-buzz-reads",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.child.slice(-6)).toEqual([
      "--league",
      "black4-fantasy-2026",
      "--session",
      session,
      "--agent",
      "b4-openai",
    ]);
    expect(p.secretReferences).toEqual(["DATABASE_URL"]);
  });
  for (const mode of ["conversation", "buzz-conversation-listener"])
    for (const value of [undefined, "bad-session"])
      it(`rejects ${mode} session ${value}`, () => {
        expect(
          run(mode, { FOOTBALL_CONVERSATION_SESSION_ID: value }).status,
        ).not.toBe(0);
      });
  it("requires explicit send and inference permission", () => {
    const p = JSON.parse(run("conversation").stdout);
    expect(p.requiredFlagPresent).toBe(false);
    expect(p.buzzSendFlagRequired).toBe(true);
    expect(run("conversation", {}, ["--once"]).status).not.toBe(0);
  });
  it("requires a conversation reply transport", () => {
    expect(
      run("conversation", { FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED: "false" })
        .status,
    ).not.toBe(0);
  });
  it("rejects an unbound listener identity", () => {
    expect(
      run("buzz-conversation-listener", {
        FOOTBALL_CONVERSATION_LISTENER_AGENT_ID: "--inject",
      }).status,
    ).not.toBe(0);
  });
  it("does not leak conversation configuration into normal owner service", () => {
    expect(run("live").status).not.toBe(0);
  });
  it("does not give listener inference secrets", () => {
    expect(
      run("buzz-conversation-listener", {}, ["--print-plan"], {
        B4_LEAGUE_OPENAI: "/nonexistent/key",
      }).status,
    ).not.toBe(0);
  });
  it("never accepts management key references", () => {
    expect(
      run("conversation", {}, ["--print-plan"], {
        B4_LEAGUE_MANAGEMENT: "/nonexistent/key",
      }).status,
    ).not.toBe(0);
  });
});
