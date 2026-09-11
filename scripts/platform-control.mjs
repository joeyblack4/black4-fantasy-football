#!/usr/bin/env node
/** Thin courier: existing Buzz identity, fixed community, explicit channel per call. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  readFileSync(join(root, "config/platform-control-helper.json"), "utf8"),
);
const helper = join(root, "scripts/vendor/channel-agent-helper.mjs");
const args = process.argv.slice(2);
const fail = (message) => {
  console.error(`platform-control: ${message}`);
  process.exit(1);
};
if (
  createHash("sha256").update(readFileSync(helper)).digest("hex") !==
  config.sha256
)
  fail("pinned helper checksum mismatch; restore the reviewed bundle");

// This local operator file contains only an API origin, never a credential.
let local = {};
try {
  local = JSON.parse(
    readFileSync(join(root, ".local/platform-control.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT")
    fail("invalid local Platform Control configuration");
}
const baseUrl = local.baseUrl ?? config.baseUrl;
let origin;
if (baseUrl) {
  try {
    origin = new URL(baseUrl);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      fail(
        "Platform Control must be an HTTPS origin without credentials, query, or path",
      );
  } catch {
    fail("invalid Platform Control origin");
  }
}
if (args.length === 1 && args[0] === "--check") {
  console.log(
    JSON.stringify({
      helperVersion: config.helperVersion,
      checksumVerified: true,
      communityId: config.communityId,
      configured: Boolean(origin),
      buzzIdentityPresent: Boolean(process.env.BUZZ_PRIVATE_KEY),
      relayMatches: process.env.BUZZ_RELAY_URL === config.relayUrl,
    }),
  );
  process.exit(0);
}
if (!origin)
  fail(
    "not configured; the operator must set baseUrl in .local/platform-control.json",
  );
if (
  process.env.BUZZ_RELAY_URL !== config.relayUrl ||
  !process.env.BUZZ_PRIVATE_KEY
)
  fail(
    "run inside your Fantasy Buzz identity; no fallback to another key or community",
  );

// Validate flag/value pairs so a payload containing '--url' stays data.
// Preserve upstream subcommands (for example social list or warehouse describe TABLE).
const firstFlag = args.findIndex((token) => token.startsWith("--"));
const offset = firstFlag < 0 ? args.length : firstFlag;
let channel;
for (let i = offset; i < args.length; i += 2) {
  const flag = args[i],
    value = args[i + 1];
  if (
    !/^--[a-z][a-z-]*$/.test(flag) ||
    value === undefined ||
    value.startsWith("--")
  )
    fail("arguments must use --flag value pairs");
  if (["--url", "--community"].includes(flag))
    fail(
      "Platform Control origin and Fantasy community are operator configured",
    );
  if (flag === "--channel") {
    if (channel || !value.trim()) fail("pass exactly one nonempty --channel");
    channel = value;
  }
}
if (!channel)
  fail(
    "--channel is required for every request; use the actual Buzz channel ID",
  );
const child = spawn(
  process.execPath,
  [helper, ...args, "--url", origin.origin, "--community", config.communityId],
  {
    // No provider or operator secrets are needed by the courier.
    env: { BUZZ_PRIVATE_KEY: process.env.BUZZ_PRIVATE_KEY },
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => fail("could not start the pinned helper"));
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
