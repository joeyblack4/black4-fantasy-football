#!/usr/bin/env node
/** Read-only status of the native fleet owned by Buzz Desktop. Never launches agents. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(root, "config/native-harnesses.json"), "utf8"),
).franchises;
const [action = "status", id] = process.argv.slice(2);
if (action !== "status") {
  console.error(
    "Fleet launch/stop commands are retired. Use Buzz Desktop agent controls; this command only reports status.",
  );
  process.exit(2);
}
if (id && !registry[id]) {
  console.error("Unknown franchise.");
  process.exit(2);
}
const appDir =
  process.env.B4_BUZZ_APP_DATA_DIR ||
  join(homedir(), "Library/Application Support/xyz.block.buzz.app");
const relay = "wss://black4fantasysports.communities.buzz.xyz";
const storePath = join(appDir, "agents/managed-agents.json");
const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
const records = readJson(storePath, null);
const pidDir = join(appDir, "agents/agent-pids");
const receipts = existsSync(pidDir)
  ? readdirSync(pidDir)
      .map((name) => readJson(join(pidDir, name), null))
      .filter(Boolean)
  : [];
const cache = (name) => {
  const rows = readJson(join(root, ".local/buzz-cutover", name), []);
  return Array.isArray(rows) ? rows : [];
};
const growth = cache("growth-messages.json"),
  rules = cache("rules-messages.json");
const marker = (rows, pubkey, text) => {
  if (!pubkey) return null;
  const matches = rows.filter(
    (row) =>
      row.pubkey === pubkey &&
      typeof row.content === "string" &&
      row.content.includes(text) &&
      !row.content.startsWith("OPERATOR"),
  );
  matches.sort((a, b) => Number(b.created_at) - Number(a.created_at));
  return matches[0]
    ? { eventId: matches[0].id, createdAt: matches[0].created_at }
    : null;
};
const processEvidence = (receipt) => {
  if (!Number.isSafeInteger(receipt?.pid) || receipt.pid <= 0) return null;
  try {
    const line = execFileSync(
      "/bin/ps",
      ["-p", String(receipt.pid), "-o", "lstart=,comm="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const matched = line.match(
      /^(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/,
    );
    if (!matched)
      return {
        pid: receipt.pid,
        running: false,
        reason: "process identity unavailable",
      };
    const started = Date.parse(matched[1]),
      recorded = Date.parse(receipt.startedAt);
    const matchesReceipt =
      Number.isFinite(started) &&
      Number.isFinite(recorded) &&
      Math.abs(started - recorded) < 15000;
    return {
      pid: receipt.pid,
      running: matchesReceipt && /(?:^|\/)buzz-acp$/.test(matched[2]),
      startedAt: receipt.startedAt,
      processMatchesReceipt: matchesReceipt,
    };
  } catch {
    return {
      pid: receipt.pid,
      running: false,
      reason: "recorded process absent",
    };
  }
};
for (const agentId of id ? [id] : Object.keys(registry)) {
  const matching = (records || []).filter(
    (record) =>
      record.pubkey &&
      Array.isArray(record.agent_args) &&
      record.agent_args.includes(agentId) &&
      record.agent_args.some((arg) =>
        String(arg).endsWith("/scripts/native-harness.mjs"),
      ),
  );
  const record = matching.length === 1 ? matching[0] : null;
  const evidence = record
    ? receipts
        .filter(
          (receipt) =>
            receipt.key?.pubkey === record.pubkey &&
            receipt.key?.relayUrl === relay,
        )
        .map(processEvidence)
        .filter(Boolean)
    : [];
  const active = evidence.filter((row) => row.running);
  const healthFile = join(
    root,
    "franchises",
    agentId.slice(3),
    "workspace/WORK_LOGS/native-buzz-control-check.md",
  );
  console.log(
    JSON.stringify({
      id: agentId,
      host: "Buzz Desktop",
      configured: !!record,
      configurationStatus:
        records === null
          ? "store unavailable"
          : matching.length > 1
            ? "duplicate records"
            : record
              ? "found"
              : "not found",
      autoStartConfigured: record?.start_on_app_launch ?? null,
      model: record?.model ?? registry[agentId].model,
      pid: active.length === 1 ? active[0].pid : null,
      running: active.length === 1,
      processes: evidence,
      controlCheckFilePresent: existsSync(healthFile),
      growthMarker: marker(growth, record?.pubkey, "NATIVE_GROWTH_OK"),
      rulesMarker: marker(rules, record?.pubkey, "NATIVE_RULES_OK"),
      evidenceNote:
        "PID receipt and local cached evidence only; file presence does not establish full health. Full app relaunch not verified; autoStartConfigured is configuration only.",
    }),
  );
}
