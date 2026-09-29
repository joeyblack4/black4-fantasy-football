// Native binary plus synthetic echo only. No Meta account or inference calls.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { prepareMuseEnvironment } = await import(
  root + "/scripts/muse-environment.mjs"
);
const state = mkdtempSync(join(tmpdir(), "muse-synthetic-"));
const env = { ...process.env };
prepareMuseEnvironment(root, state, "muse-spark-1.3", env);
env.B4_MUSE_TEST_BINARY = env.B4_MUSE_BINARY;
const echo = join(state, "echo-muse");
writeFileSync(
  echo,
  `#!/bin/bash\nif [ "$1" = exec ]; then\n shift\n filtered=()\n while [ "$#" -gt 0 ]; do\n  case "$1" in --model|--reasoning-effort) shift 2;; *) filtered+=("$1"); shift;; esac\n done\n exec "$B4_MUSE_TEST_BINARY" exec --provider echo "\${filtered[@]}"\nfi\nexec "$B4_MUSE_TEST_BINARY" "$@"\n`,
  { mode: 0o700 },
);
env.B4_MUSE_BINARY = echo;
let child = spawn(root + "/tooling/muse/node_modules/.bin/muse-code-acp", [], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
});
let id = 0;
const pending = new Map();
const updates = [];
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
function readReplies() {
  createInterface({ input: child.stdout }).on("line", (l) => {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error
        ? p.reject(new Error(JSON.stringify(m.error)))
        : p.resolve(m.result);
    } else if (m.method === "session/update") updates.push(m.params.update);
    else if (m.method && m.id !== undefined)
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: "Unsupported test client request" },
        }) + "\n",
      );
  });
}
readReplies();
function req(method, params) {
  return new Promise((resolve, reject) => {
    const rid = ++id;
    const timer = setTimeout(
      () => reject(new Error("timeout " + method)),
      45000,
    );
    pending.set(rid, { resolve, reject, timer });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n",
    );
  });
}
try {
  const init = await req("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "black4-synthetic-muse-check", version: "1" },
    clientCapabilities: {},
  });
  const s = await req("session/new", { cwd: state, mcpServers: [] });
  const model = s.configOptions.find((x) => x.id === "model").currentValue;
  if (!model.includes("muse-spark-1.3"))
    throw new Error("wrong model " + model);
  await req("session/set_mode", {
    sessionId: s.sessionId,
    modeId: "bypassApprovals",
  });
  const first = await req("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "SYNTHETIC_MUSE_FIRST" }],
  });
  const second = await req("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "SYNTHETIC_MUSE_SECOND" }],
  });
  const text = updates
    .filter((x) => x.sessionUpdate === "agent_message_chunk")
    .map((x) => x.content?.text ?? "")
    .join("");
  if (
    !text.includes("SYNTHETIC_MUSE_FIRST") ||
    !text.includes("SYNTHETIC_MUSE_SECOND")
  )
    throw new Error("missing streamed output " + text);
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  child = spawn(root + "/tooling/muse/node_modules/.bin/muse-code-acp", [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => (stderr += d));
  readReplies();
  await req("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "black4-synthetic-muse-check", version: "1" },
    clientCapabilities: {},
  });
  await req("session/load", {
    sessionId: s.sessionId,
    cwd: state,
    mcpServers: [],
  });
  const resumed = await req("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "SYNTHETIC_MUSE_AFTER_RESTART" }],
  });
  console.log(
    JSON.stringify({
      synthetic: true,
      resumed,
      restart: true,
      protocol: init.protocolVersion,
      sessionId: s.sessionId,
      model,
      first,
      second,
      streaming: true,
    }),
  );
} catch (e) {
  console.error(e.message);
  console.error(stderr.slice(-5000));
  process.exitCode = 1;
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  child.stdin.end();
  setTimeout(() => child.kill("SIGTERM"), 2000).unref();
  child.once("exit", () => rmSync(state, { recursive: true, force: true }));
}
