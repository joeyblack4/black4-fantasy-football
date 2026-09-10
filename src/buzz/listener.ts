import { createECDH } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { BuzzArchiveService, type BuzzListener } from "./archive.js";
export type BuzzReadRequest =
  | { command: "dms" }
  | { command: "profiles"; pubkeys: string[] }
  | { command: "owner-profile"; name: string; ownerPubkey: string }
  | { command: "members"; channelId: string }
  | { command: "messages"; channelId: string; since: number };
export type BuzzReader = (request: BuzzReadRequest) => Promise<unknown>;
export function readArguments(r: BuzzReadRequest) {
  if (r.command === "dms") return ["dms", "list", "--limit", "200"];
  if (r.command === "profiles") {
    const hex = z.string().regex(/^[a-f0-9]{64}$/);
    z.array(hex).min(1).max(12).parse(r.pubkeys);
    return ["users", "get", ...r.pubkeys.flatMap((p) => ["--pubkey", p])];
  }
  if (r.command === "owner-profile") {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(r.ownerPubkey);
    z.string().min(1).max(200).parse(r.name);
    return ["users", "get", "--owner", r.ownerPubkey, "--name", r.name];
  }
  z.uuid().parse(r.channelId);
  if (r.command === "members")
    return ["channels", "members", "--channel", r.channelId];
  z.number().int().nonnegative().parse(r.since);
  return [
    "messages",
    "get",
    "--channel",
    r.channelId,
    "--since",
    String(r.since),
    "--kinds",
    "9,40002,40003,9005,5",
    "--limit",
    "200",
  ];
}
/** No shell, no caller-provided args, no ambient customer environment. Does not send messages or launch an ACP/model runtime. */
export function createBuzzReader(options: {
  executable: string;
  listener: BuzzListener;
  environment: Readonly<Record<string, string>>;
  allowNetwork: boolean;
}): BuzzReader {
  if (!options.allowNetwork || options.listener.mode !== "real")
    throw new Error("Real reads require explicit network opt-in");
  if (
    !options.executable.startsWith("/") ||
    options.environment.BUZZ_RELAY_URL !== options.listener.communityUrl
  )
    throw new Error("Invalid listener executable or community");
  const u = new URL(options.listener.communityUrl);
  if (
    u.protocol !== "wss:" ||
    u.hostname === "black4.communities.buzz.xyz" ||
    u.hostname.endsWith(".test")
  )
    throw new Error("League-only real community required");
  const key = options.environment.BUZZ_PRIVATE_KEY;
  if (!key || !/^[a-f0-9]{64}$/.test(key))
    throw new Error("Scoped signing key required");
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(key, "hex"));
  if (
    ecdh.getPublicKey("hex", "compressed").slice(2) !== options.listener.pubkey
  )
    throw new Error("Signing identity mismatch");
  return (request) =>
    new Promise((resolve, reject) => {
      const env: Record<string, string> = {
        PATH: "/usr/bin:/bin",
        BUZZ_PRIVATE_KEY: key,
        BUZZ_RELAY_URL: options.listener.communityUrl,
      };
      if (options.environment.BUZZ_AUTH_TAG)
        env.BUZZ_AUTH_TAG = options.environment.BUZZ_AUTH_TAG;
      const child = spawn(options.executable, readArguments(request), {
        shell: false,
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "",
        failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 20000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
          failed = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Buzz read process failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || failed)
          return reject(new Error("Buzz read failed or exceeded bounds"));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid Buzz read JSON"));
        }
      });
    });
}
const dmsSchema = z.array(
  z.object({
    dm_id: z.uuid(),
    participants: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(2)
      .max(9),
    created_at: z.number().int().nonnegative(),
  }),
);
const membersSchema = z.array(
  z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/), role: z.string() }),
);
/** One polling iteration. A full page is a visible archive gap; never silently advance over possible missing events. */
export async function pollBuzzOnce(
  service: BuzzArchiveService,
  listener: BuzzListener,
  read: BuzzReader,
  options: { channelIds?: string[] } = {},
) {
  // Verify the persisted exact binding before the first external request.
  const registered = await service.channels(listener);
  const scopedIds =
    options.channelIds === undefined
      ? undefined
      : z.array(z.uuid()).min(1).max(12).parse(options.channelIds);
  if (
    scopedIds &&
    (new Set(scopedIds).size !== scopedIds.length ||
      scopedIds.some(
        (id) =>
          !registered.some(
            (c) => c.channel_id === id && c.kind === "private-channel",
          ),
      ))
  )
    throw new Error(
      "Scoped polling requires unique registered private channels for this listener",
    );
  // Trusted operator/session scope only. Do not discover or read unrelated DMs in conversation mode.
  const dms = scopedIds ? [] : dmsSchema.parse(await read({ command: "dms" }));
  if (dms.length >= 200)
    throw new Error("DM discovery saturated; reconciliation required");
  const problems: string[] = [];
  for (const dm of dms) {
    try {
      await service.discoverDm(listener, {
        channelId: dm.dm_id,
        memberPubkeys: dm.participants,
        receiptId: `relay-dm:${dm.dm_id}:${dm.created_at}`,
      });
    } catch {
      problems.push(`DM ${dm.dm_id}: membership requires operator review`);
    }
  }
  const results = [];
  for (const c of scopedIds
    ? registered.filter((c) => scopedIds.includes(c.channel_id))
    : await service.channels(listener)) {
    try {
      const members = membersSchema
        .parse(await read({ command: "members", channelId: c.channel_id }))
        .map((p) => p.pubkey);
      const events = z
        .array(z.unknown())
        .max(200)
        .parse(
          await read({
            command: "messages",
            channelId: c.channel_id,
            since: Number(c.since_seconds),
          }),
        );
      results.push({
        channelId: c.channel_id,
        ...(await service.ingestBatch(listener, {
          channelId: c.channel_id,
          memberPubkeys: members,
          events,
          complete: events.length < 200,
        })),
      });
    } catch {
      await service.recordFailure(listener, c.channel_id);
      problems.push(
        `Channel ${c.channel_id}: read or membership validation failed`,
      );
    }
  }
  return {
    mode: listener.mode,
    results,
    problems,
    healthy: problems.length === 0 && results.every((r) => r.complete),
  };
}
