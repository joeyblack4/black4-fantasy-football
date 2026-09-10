#!/usr/bin/env node
/** Thin native process entrypoint for Buzz. Stdout belongs entirely to ACP. */
import {
  readFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  constants,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(root, "config/native-harnesses.json"), "utf8"),
);
const id = process.argv[2];
const spec = registry.franchises[id];
if (!spec) {
  console.error(
    `Usage: native-harness.mjs <${Object.keys(registry.franchises).join("|")}> [--check]`,
  );
  process.exit(2);
}
// Capture only the identity Buzz supplies to this franchise, for repo-local hosting.
if (
  process.env.BUZZ_PRIVATE_KEY &&
  process.env.BUZZ_RELAY_URL ===
    "wss://black4fantasysports.communities.buzz.xyz"
) {
  const identityDir = join(root, ".local/native-buzz/identities");
  mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  const identityPath = join(identityDir, id + ".json");
  if (!existsSync(identityPath))
    writeFileSync(
      identityPath,
      JSON.stringify({
        agentId: id,
        teamId: id.replace("b4-", "b4-team-"),
        leagueId: "black4-fantasy-2026",
        privateKey: process.env.BUZZ_PRIVATE_KEY,
        authTag: process.env.BUZZ_AUTH_TAG,
        communityUrl: process.env.BUZZ_RELAY_URL,
      }),
      { flag: "wx", mode: 0o600 },
    );
}
const state = join(root, ".local/franchise-runtimes/native-live", id);
const workspace =
  process.env.B4_NATIVE_WORKSPACE ||
  join(root, "franchises", id.replace(/^b4-/, ""), "workspace");
const command = join(root, spec.command);
const keyPath =
  spec.credential && join(root, ".local/credentials", spec.credential);
const env = {
  ...process.env,
  ...spec.env,
  PATH: `${join(root, "tooling/node_modules/.bin")}:${join(root, ".local/tooling/bin")}:${process.env.PATH || ""}`,
};
if (keyPath && existsSync(keyPath))
  env[spec.credentialEnv] = readFileSync(keyPath, "utf8").trim();
const providerConfigPath = join(
  root,
  ".local/native-provider-configs",
  id.replace(/^b4-/, ""),
  "env.json",
);
const providerEnv = existsSync(providerConfigPath)
  ? JSON.parse(readFileSync(providerConfigPath, "utf8"))
  : {};
Object.assign(env, providerEnv);
const authPresent =
  !spec.credential ||
  Boolean(env[spec.credentialEnv]) ||
  (id === "b4-kimi" && Boolean(providerEnv.KIMI_CODE_HOME));
if (process.argv.includes("--check")) {
  console.log(
    JSON.stringify({
      id,
      harness: spec.harness,
      model: spec.model,
      command,
      installed: existsSync(command),
      workspace,
      credential: spec.credential || "native-subscription",
      credentialPresent: authPresent,
      subscriptionVerified: false,
    }),
  );
  process.exit(existsSync(command) && authPresent ? 0 : 1);
}
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const localState = (name) => {
  const p = join(state, name);
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
};
const writeNew = (p, data) => {
  if (!existsSync(p)) writeFileSync(p, data, { mode: 0o600, flag: "wx" });
};
switch (spec.harness) {
  case "codex": {
    env.CODEX_HOME = localState("codex");
    const auth = join(homedir(), ".codex/auth.json"),
      target = join(env.CODEX_HOME, "auth.json");
    if (existsSync(auth) && !existsSync(target))
      copyFileSync(auth, target, constants.COPYFILE_EXCL);
    env.CODEX_PATH = join(
      root,
      ".local/tooling/codex-current/node_modules/.bin/codex",
    );
    env.CODEX_CONFIG = JSON.stringify({
      model: spec.model,
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
    });
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    break;
  }
  case "claude-code":
    env.CLAUDE_CONFIG_DIR = localState("claude");
    // Copy native subscription credentials into this franchise, never mutate the personal keychain.
    if (!existsSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"))) {
      try {
        const nativeAuth = execFileSync(
          "/usr/bin/security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { stdio: ["ignore", "pipe", "pipe"] },
        )
          .toString()
          .trim();
        if (JSON.parse(nativeAuth).claudeAiOauth)
          writeNew(
            join(env.CLAUDE_CONFIG_DIR, ".credentials.json"),
            nativeAuth,
          );
      } catch {}
    }
    {
      const settingsPath = join(env.CLAUDE_CONFIG_DIR, "settings.json");
      const settings = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, "utf8"))
        : {};
      writeFileSync(
        settingsPath,
        JSON.stringify({
          ...settings,
          model: spec.model,
          permissions: {
            ...settings.permissions,
            defaultMode: "bypassPermissions",
          },
        }),
        { mode: 0o600 },
      );
    }
    delete env.ANTHROPIC_API_KEY;
    break;
  case "gemini-cli":
    env.GEMINI_CLI_HOME = localState("gemini");
    break;
  case "grok-build":
    env.GROK_HOME = localState("grok");
    break;
  case "mistral-vibe":
    env.VIBE_HOME = localState("vibe");
    break;
  case "kimi-code":
    env.KIMI_CODE_HOME = localState("kimi");
    break;
  case "qwen-code": {
    env.QWEN_HOME = localState("qwen");
    const controlsPath = join(root, "config/qwen-cost-controls.json");
    const settingsPath = join(env.QWEN_HOME, "settings.json");
    const controls = JSON.parse(readFileSync(controlsPath, "utf8"));
    writeFileSync(settingsPath, `${JSON.stringify(controls, null, 2)}\n`, {
      mode: 0o600,
    });
    break;
  }
  case "goose":
    env.GOOSE_PATH_ROOT = localState("goose");
    break;
  case "opencode":
    env.XDG_DATA_HOME = localState("data");
    env.XDG_STATE_HOME = localState("state");
    env.XDG_CONFIG_HOME = localState("config");
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: spec.model,
      permission: "allow",
    });
    break;
  case "minimax-code":
    env.MCODE_CONFIG_DIR = join(root, spec.stateDirectory);
    break;
}
if (!authPresent) {
  console.error(
    `${id}: missing ${spec.credential}; save the private key at ${keyPath} or set ${spec.credentialEnv}.`,
  );
  process.exit(3);
}
Object.assign(env, providerEnv);
if (providerEnv.OPENCODE_CONFIG) delete env.OPENCODE_CONFIG_CONTENT;
const child = spawn(command, spec.args, {
  cwd: workspace,
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`${id}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
