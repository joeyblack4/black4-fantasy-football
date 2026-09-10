import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEAGUE_HARNESS_PROFILE } from "../src/harnesses/catalog.js";

// Local inventory only: never reads credentials, starts an agent or calls a model.
const root = fileURLToPath(new URL("../", import.meta.url));
const toolchain = JSON.parse(
  await readFile(resolve(root, "tooling/package.json"), "utf8"),
);
const definitions = [
  [
    "Codex",
    "tooling/node_modules/.bin/codex-acp",
    "@agentclientprotocol/codex-acp",
  ],
  [
    "Claude Code",
    "tooling/node_modules/.bin/claude-agent-acp",
    "@agentclientprotocol/claude-agent-acp",
  ],
  ["Gemini CLI", "tooling/node_modules/.bin/gemini", "@google/gemini-cli"],
  ["Grok Build", "tooling/node_modules/.bin/grok", "@xai-official/grok"],
  ["Qwen Code", "tooling/node_modules/.bin/qwen", "@qwen-code/qwen-code"],
  ["Kimi Code", "tooling/node_modules/.bin/kimi", "@moonshot-ai/kimi-code"],
  ["OpenCode", "tooling/node_modules/.bin/opencode", "opencode-ai"],
  ["Vibe", ".local/tooling/bin/vibe-acp", null],
  ["Goose", ".local/tooling/bin/goose", null],
] as const;
const runtimes = await Promise.all(
  definitions.map(async ([harness, path, pkg]) => {
    let executablePresent = false;
    try {
      await access(resolve(root, path), constants.X_OK);
      executablePresent = true;
    } catch {}
    let installedVersion: string | null = null;
    if (pkg) {
      try {
        installedVersion = JSON.parse(
          await readFile(
            resolve(root, "tooling/node_modules", pkg, "package.json"),
            "utf8",
          ),
        ).version;
      } catch {}
    }
    return {
      harness,
      path,
      executablePresent,
      pinnedVersion: pkg ? toolchain.dependencies[pkg] : null,
      installedVersion,
      authenticatedModelAccess: "UNVERIFIED",
    };
  }),
);
let stagedWorkspaces = 0;
try {
  stagedWorkspaces = (
    await readdir(
      resolve(
        root,
        ".local/franchise-runtimes",
        LEAGUE_HARNESS_PROFILE,
        "black4-fantasy-2026",
      ),
    )
  ).filter((name) => name.startsWith("b4-")).length;
} catch {}
console.log(
  JSON.stringify(
    {
      profile: LEAGUE_HARNESS_PROFILE,
      stagedWorkspaces,
      runtimes,
      productionDraftActions: "HELD",
      scope: "filesystem inventory; does not prove execution or authentication",
    },
    null,
    2,
  ),
);
if (runtimes.some((runtime) => !runtime.executablePresent))
  process.exitCode = 1;
