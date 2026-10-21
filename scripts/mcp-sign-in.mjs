#!/usr/bin/env node
/**
 * Sign one owner's harness in to the Black 4 MCP, in that owner's own home.
 *
 *   node scripts/mcp-sign-in.mjs <owner>      e.g. openai, b4-openai
 *   node scripts/mcp-sign-in.mjs --list
 *
 * Run it on the Fantasy Mac's own screen: the OAuth callback is a localhost
 * port there. Sign in as joeysterling22@gmail.com (the Fantasy Football
 * customer), never as Black 4 staff. Each harness stores its own sign-in.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(root, "config/native-harnesses.json"), "utf8"));
const ids = Object.keys(registry.franchises);
const arg = process.argv[2];

if (!arg || arg === "--list") {
  for (const id of ids) console.log(`${id.replace(/^b4-/, "").padEnd(10)} ${registry.franchises[id].harness}`);
  process.exit(arg ? 0 : 2);
}
const id = ids.find((candidate) => candidate === arg || candidate === `b4-${arg}`);
if (!id) {
  console.error(`Unknown owner ${arg}; one of: ${ids.map((x) => x.replace(/^b4-/, "")).join(", ")}`);
  process.exit(2);
}
const result = spawnSync(process.execPath, [join(root, "scripts/native-harness.mjs"), id, "--sign-in"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
