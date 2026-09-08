#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { createDb } from "../src/db.js";
import {
  ManagedBridgeConfigSchema,
  managedIdentity,
  storeManagedIdentity,
  ManagedAcpBridge,
} from "../src/buzz/managed-acp.js";
async function main() {
  const args = process.argv.slice(2),
    path = args[args.indexOf("--config") + 1];
  if (!args.includes("--config") || !path?.startsWith("/"))
    throw new Error("Private absolute bridge config required");
  const config = ManagedBridgeConfigSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  const databaseUrl = process.env[config.databaseEnvironmentVariable];
  if (!databaseUrl) throw new Error("Explicit league database required");
  const identity = managedIdentity(process.env),
    db = createDb(databaseUrl);
  try {
    await storeManagedIdentity(db, config, identity);
    const bridge = new ManagedAcpBridge(db, config);
    let buffer = "";
    // Newline-delimited JSON-RPC matches the supported Buzz ACP transport. No model or network calls here.
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > 1024 * 1024)
        throw new Error("ACP input limit");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Invalid JSON" },
            }) + "\n",
          );
          continue;
        }
        const reply = await bridge.handle(parsed);
        if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
      }
    }
  } finally {
    await db.end();
  }
}
main().catch(() => {
  process.stderr.write(
    "Black4 ACP bridge failed; inspect league configuration and managed identity readiness.\n",
  );
  process.exitCode = 1;
});
