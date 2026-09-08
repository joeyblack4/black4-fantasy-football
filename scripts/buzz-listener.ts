#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createDb } from "../src/db.js";
import { BuzzArchiveService, type BuzzListener } from "../src/buzz/archive.js";
import {
  createBuzzReader,
  pollBuzzOnce,
  readArguments,
} from "../src/buzz/listener.js";
const args = process.argv.slice(2);
const schema = z
  .object({
    leagueId: z.string().min(1),
    communityUrl: z.url(),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.string().startsWith("/"),
    keyEnvironmentVariable: z.string().regex(/^B4_LEAGUE_[A-Z0-9_]+$/),
    authTagEnvironmentVariable: z
      .string()
      .regex(/^B4_LEAGUE_[A-Z0-9_]+$/)
      .optional(),
    pollIntervalMs: z.number().int().min(2000).max(60000).default(5000),
  })
  .strict();
async function main() {
  if (!args.includes("--execute-listener")) {
    console.log(
      JSON.stringify({
        mode: "mock",
        networkCalls: 0,
        modelCalls: 0,
        description:
          "Planning only. Real listener requires persisted league binding and --execute-listener --config /absolute/config.json.",
        commands: [
          readArguments({ command: "dms" }),
          readArguments({
            command: "messages",
            channelId: "12345678-1234-4234-9234-123456789abc",
            since: 0,
          }),
        ],
      }),
    );
    return;
  }
  const path = args[args.indexOf("--config") + 1];
  if (!args.includes("--config") || !path?.startsWith("/"))
    throw new Error("Absolute listener config required");
  if (!process.env.DATABASE_URL)
    throw new Error("Explicit league DATABASE_URL required");
  const config = schema.parse(JSON.parse(await readFile(path, "utf8")));
  const listener: BuzzListener = {
    leagueId: config.leagueId,
    communityUrl: config.communityUrl,
    pubkey: config.pubkey,
    mode: "real",
  };
  const environment: Record<string, string> = {
    BUZZ_RELAY_URL: config.communityUrl,
    BUZZ_PRIVATE_KEY: process.env[config.keyEnvironmentVariable] ?? "",
  };
  if (config.authTagEnvironmentVariable)
    environment.BUZZ_AUTH_TAG =
      process.env[config.authTagEnvironmentVariable] ?? "";
  const reader = createBuzzReader({
    executable: config.executable,
    environment,
    listener,
    allowNetwork: true,
  });
  const db = createDb(),
    service = new BuzzArchiveService(db);
  let stop = false;
  let release: (() => void) | undefined;
  const stopping = () => {
    stop = true;
    release?.();
  };
  process.on("SIGTERM", stopping);
  process.on("SIGINT", stopping);
  // One process per identity; session lock survives polling transactions and releases on process death.
  const lease = await db.connect();
  try {
    const locked = (
      await lease.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,141)) AS locked",
        [`${config.leagueId}:${config.pubkey}`],
      )
    ).rows[0].locked;
    if (!locked) throw new Error("Listener already running for this identity");
    do {
      try {
        const report = await pollBuzzOnce(service, listener, reader);
        console.log(
          JSON.stringify({ at: new Date().toISOString(), ...report }),
        );
      } catch {
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            mode: "real",
            healthy: false,
            error:
              "Listener poll failed; inspect scoped configuration and relay readiness",
          }),
        );
      }
      if (args.includes("--once") || stop) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          release = undefined;
          resolve();
        }, config.pollIntervalMs);
        release = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } while (!stop);
  } finally {
    await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,141))", [
      `${config.leagueId}:${config.pubkey}`,
    ]);
    lease.release();
    await db.end();
  }
}
main().catch(() => {
  console.error(
    "Buzz listener failed; no message content or credentials logged",
  );
  process.exitCode = 1;
});
