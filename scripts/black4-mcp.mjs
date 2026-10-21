/**
 * The Black 4 MCP in every owner's own harness config (Joey, 2026-10-21).
 *
 * Owners reach Black 4 exactly like any MCP client: one remote server,
 * `https://api.black4.ai/mcp`, signed in with OAuth as the Fantasy Football
 * customer (joeysterling22@gmail.com), never as Black 4 staff. Each harness
 * keeps its own sign-in in its own franchise home; no token is shared or
 * copied. Skills come from the MCP's list_skills/get_skill and league tools
 * (Fantasy Football's connections, Treg) from its discovery and provider
 * tools. No channel-bound header: a customer reaches only its own business.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BLACK4_MCP = JSON.parse(
  readFileSync(join(root, "config/black4-mcp.json"), "utf8"),
);
const { name, url } = BLACK4_MCP;

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

/** Merge one server into a JSON file's `key`, keeping every other entry. */
function mergeJson(path, key, entry, base = {}) {
  const current = readJson(path);
  const servers = current[key] ?? {};
  if (JSON.stringify(servers[name]) === JSON.stringify(entry)) return false;
  write(
    path,
    `${JSON.stringify({ ...base, ...current, [key]: { ...servers, [name]: entry } }, null, 2)}\n`,
  );
  return true;
}

/** Append a TOML block once; the harness owns the file's other content. */
function appendToml(path, marker, block) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split("\n").some((line) => line.trim() === marker)) return false;
  write(
    path,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n${block}`,
  );
  return true;
}

/** Where each harness reads its MCP servers, given the franchise's final env. */
export function configTarget(harness, env) {
  switch (harness) {
    case "codex":
      return join(env.CODEX_HOME, "config.toml");
    case "claude-code":
      return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
    case "gemini-cli":
      return join(env.GEMINI_CLI_HOME, ".gemini/settings.json");
    case "qwen-code":
      return join(env.QWEN_HOME, "settings.json");
    case "grok-build":
      return join(env.GROK_HOME, "config.toml");
    case "mistral-vibe":
      return join(env.VIBE_HOME, "config.toml");
    case "kimi-code":
      return join(env.KIMI_CODE_HOME, "mcp.json");
    case "muse-code":
      return join(env.XDG_CONFIG_HOME, "muse/settings.json");
    case "goose":
      return join(env.GOOSE_PATH_ROOT, "config/config.yaml");
    case "opencode":
      return env.OPENCODE_CONFIG || null; // otherwise OPENCODE_CONFIG_CONTENT
    case "minimax-code":
      return join(env.HOME, ".minimax/mcp.json");
    default:
      throw Error(`No Black 4 MCP entry for harness ${harness}`);
  }
}

/**
 * Ensure the Black 4 MCP entry in the harness's own config. Run after every
 * other env and config step, so a provider override or a regenerated
 * settings file cannot drop it. Returns the file it checked.
 */
export function ensureBlack4Mcp(harness, env, workspace) {
  const path = configTarget(harness, env);
  switch (harness) {
    case "codex":
      appendToml(
        path,
        `[mcp_servers.${name}]`,
        `[mcp_servers.${name}]\nurl = "${url}"\n`,
      );
      break;
    case "grok-build":
      appendToml(
        path,
        `[mcp_servers.${name}]`,
        `[mcp_servers.${name}]\nurl = "${url}"\nenabled = true\n`,
      );
      break;
    case "mistral-vibe":
      appendToml(
        path,
        `name = "${name}"`,
        `[[mcp_servers]]\nurl = "${url}"\nname = "${name}"\ntransport = "streamable-http"\n\n[mcp_servers.auth]\ntype = "oauth"\nscopes = []\n`,
      );
      break;
    case "claude-code":
      mergeJson(path, "mcpServers", { type: "http", url });
      break;
    case "gemini-cli":
      mergeJson(path, "mcpServers", { type: "http", url });
      // Gemini disables every MCP server in an untrusted folder; trust only
      // this owner's own workspace, in its own Gemini home.
      if (workspace) {
        const trust = join(env.GEMINI_CLI_HOME, ".gemini/trustedFolders.json");
        const folders = readJson(trust);
        if (folders[workspace] !== "TRUST_FOLDER")
          write(
            trust,
            `${JSON.stringify({ ...folders, [workspace]: "TRUST_FOLDER" }, null, 2)}\n`,
          );
      }
      break;
    case "qwen-code":
      mergeJson(path, "mcpServers", { httpUrl: url });
      break;
    case "kimi-code":
      mergeJson(path, "mcpServers", { url });
      break;
    case "muse-code":
      mergeJson(
        path,
        "mcpServers",
        { type: "http", url },
        { schema_version: 1 },
      );
      break;
    case "minimax-code":
      mergeJson(path, "mcpServers", { url, auth: { type: "oauth2" } });
      break;
    case "goose":
      if (
        !existsSync(path) ||
        !readFileSync(path, "utf8").includes(`  ${name}:`)
      )
        appendGooseExtension(path);
      break;
    case "opencode":
      if (path) mergeJson(path, "mcp", { type: "remote", url });
      else {
        const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          ...content,
          mcp: { ...content.mcp, [name]: { type: "remote", url } },
        });
      }
      break;
  }
  return path;
}

function appendGooseExtension(path) {
  const block = [
    `  ${name}:`,
    "    enabled: true",
    "    type: streamable_http",
    `    name: ${name}`,
    `    uri: ${url}`,
    "    description: Black 4 MCP",
    "    timeout: 300",
    "    envs: {}",
    "    env_keys: []",
    "    headers: {}",
    "    bundled: null",
    "    available_tools: []",
    "",
  ].join("\n");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^extensions:\s*$/m.test(current))
    write(
      path,
      current.replace(/^extensions:\s*$/m, `extensions:\n${block.trimEnd()}`),
    );
  else if (/^extensions:/m.test(current))
    throw Error(
      `${path}: extensions is not a block mapping; add the Black 4 MCP by hand`,
    );
  else
    write(
      path,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}extensions:\n${block}`,
    );
}

/**
 * How Joey signs one owner in, in that owner's own harness and home.
 * `command` runs a CLI login that opens the browser; `interactive` opens the
 * harness so he types `steps` in it. Every flow ends in the browser on
 * WorkOS as joeysterling22@gmail.com.
 */
export function signInPlan(harness, env, binaries) {
  switch (harness) {
    case "codex":
      return { command: [binaries.codex, "mcp", "login", name] };
    case "opencode":
      return { command: [binaries.opencode, "mcp", "auth", name] };
    case "muse-code":
      return { command: [binaries.muse, "mcp", "login", name] };
    case "mistral-vibe":
      // vibe signs in when a server is added; re-adding replaces the entry.
      return {
        command: [binaries.vibe, "mcp", "add", name, "--url", url],
        before: [binaries.vibe, "mcp", "remove", name],
      };
    case "claude-code":
      return {
        interactive: [binaries.claude],
        steps: ["/mcp", `select ${name}`, "Authenticate"],
      };
    case "gemini-cli":
      return { interactive: [binaries.gemini], steps: [`/mcp auth ${name}`] };
    case "qwen-code":
      return { interactive: [binaries.qwen], steps: [`/mcp auth ${name}`] };
    case "grok-build":
      return {
        interactive: [binaries.grok],
        steps: ["/mcps", `select ${name}`, "press i"],
      };
    case "kimi-code":
      return {
        interactive: [binaries.kimi],
        steps: [`/mcp-config login ${name}`],
      };
    case "goose":
      return {
        interactive: [binaries.goose, "session"],
        steps: ["the browser opens when the session connects"],
      };
    case "minimax-code":
      return {
        interactive: [binaries.mcode],
        steps: ["/mcp", `select ${name}`, "sign in"],
      };
    default:
      throw Error(`No sign-in for harness ${harness}`);
  }
}
