#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { createECDH } from "node:crypto";
import { execFile } from "node:child_process";
import { z } from "zod";
import { createDb } from "../src/db.js";
import {
  planDmOpen,
  planSend,
  createCliRunner,
  BuzzReceiptService,
  type LeagueIdentity,
} from "../src/buzz/index.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const agentSchema = z
  .object({
    pubkey: hex,
    ownerPubkey: hex,
    ownershipEvidenceEventId: hex,
    keyEnvironmentVariable: z.string().regex(/^B4_LEAGUE_[A-Z0-9_]+$/),
    authTagEnvironmentVariable: z
      .string()
      .regex(/^B4_LEAGUE_[A-Z0-9_]+$/)
      .optional(),
  })
  .strict();
const configSchema = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    communityUrl: z.url(),
    executable: z.string().startsWith("/"),
    freshLeagueCommunity: z.literal(true),
    ownershipMetadataVerified: z.literal(true),
    receiverAlreadyListening: z.literal(true),
    agentA: agentSchema,
    agentB: agentSchema,
  })
  .strict();
const args = process.argv.slice(2),
  live = args.includes("--execute-live");
async function main() {
  if (!live) {
    const a: LeagueIdentity = {
      pubkey: "a".repeat(64),
      ownerPubkey: "c".repeat(64),
      ownershipVerified: true,
      communityUrl: "wss://synthetic-league.example.test",
      kind: "agent",
      allowedPeerPubkeys: ["b".repeat(64)],
    };
    const b: LeagueIdentity = {
      ...a,
      pubkey: "b".repeat(64),
      allowedPeerPubkeys: [a.pubkey],
    };
    const open = planDmOpen(a, [b]);
    const send = planSend(
      a,
      b,
      {
        id: "12345678-1234-4234-9234-123456789abc",
        communityUrl: a.communityUrl,
        memberPubkeys: [a.pubkey, b.pubkey],
      },
      "SYNTHETIC CANARY. No message sent.",
    );
    console.log(
      JSON.stringify(
        {
          mode: "MOCK_ONLY",
          networkCalls: 0,
          modelCalls: 0,
          processesSpawned: 0,
          plans: [open, send],
          observedPeerReply: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!args.includes("--confirm-league-only"))
    throw new Error(
      "Live execution requires --confirm-league-only and two dedicated league identities",
    );
  const configPath = args[args.indexOf("--config") + 1];
  if (!args.includes("--config") || !configPath)
    throw new Error("Explicit --config path required");
  const config = configSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const url = new URL(config.communityUrl);
  if (
    url.protocol !== "wss:" ||
    url.host === "black4.communities.buzz.xyz" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use the new isolated league community, never the customer community",
    );
  if (
    config.agentA.pubkey === config.agentB.pubkey ||
    config.agentA.ownerPubkey !== config.agentB.ownerPubkey
  )
    throw new Error(
      "Two distinct agents with the same verified owner are required by the current DM gate",
    );
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Explicit league DATABASE_URL required; run migrations beforehand",
    );
  const identity = (
    a: typeof config.agentA,
    b: typeof config.agentB,
  ): LeagueIdentity => ({
    pubkey: a.pubkey,
    ownerPubkey: a.ownerPubkey,
    ownershipVerified: true,
    communityUrl: config.communityUrl,
    kind: "agent",
    allowedPeerPubkeys: [b.pubkey],
  });
  const a = identity(config.agentA, config.agentB),
    b = identity(config.agentB, config.agentA);
  const environment = (agent: typeof config.agentA) => {
    const key = process.env[agent.keyEnvironmentVariable];
    if (!key) throw new Error("Dedicated league signing key is missing");
    try {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error();
      const curve = createECDH("secp256k1");
      curve.setPrivateKey(Buffer.from(key, "hex"));
      if (curve.getPublicKey("hex", "compressed").slice(2) !== agent.pubkey)
        throw new Error();
    } catch {
      throw new Error(
        "Dedicated key does not match the configured league identity",
      );
    }
    const env: Record<string, string> = {
      BUZZ_RELAY_URL: config.communityUrl,
      BUZZ_PRIVATE_KEY: key,
    };
    if (agent.authTagEnvironmentVariable) {
      const tag = process.env[agent.authTagEnvironmentVariable];
      if (!tag) throw new Error("League delegation tag is missing");
      env.BUZZ_AUTH_TAG = tag;
    }
    return env;
  };
  const envA = environment(config.agentA),
    envB = environment(config.agentB);
  const runnerA = createCliRunner({
    executable: config.executable,
    environment: envA,
    allowExternalSends: true,
  });
  // Validate B's configuration too. No outbound B message is scripted; its independently running agent must respond.
  createCliRunner({
    executable: config.executable,
    environment: envB,
    allowExternalSends: true,
  });
  const read = (argv: string[], env: Record<string, string>) =>
    new Promise<unknown>((resolve, reject) =>
      execFile(
        config.executable,
        argv,
        {
          env: { PATH: "/usr/bin:/bin", ...env },
          timeout: 15000,
          maxBuffer: 1_048_576,
        },
        (error, stdout) => {
          if (error)
            return reject(new Error("Buzz read failed; details redacted"));
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Buzz read returned invalid JSON"));
          }
        },
      ),
    );
  const db = createDb();
  try {
    const receipts = new BuzzReceiptService(db);
    const opened = await receipts.execute(
      "canary:" + config.runId + ":open",
      planDmOpen(a, [b]),
      runnerA,
    );
    if (opened.status !== "accepted" || !opened.channel_id)
      throw new Error(
        "DM open is not accepted; reconcile existing receipt before rerunning",
      );
    // Independent participant read-back, using B's own credentials, before sending the canary.
    const dms = await read(["dms", "list", "--limit", "200"], envB);
    const dm = Array.isArray(dms)
      ? dms.find(
          (d: unknown) =>
            !!d &&
            typeof d === "object" &&
            (d as any).dm_id === opened.channel_id,
        )
      : undefined;
    if (
      !dm ||
      !Array.isArray(dm.participants) ||
      dm.participants.length !== 2 ||
      !dm.participants.includes(a.pubkey) ||
      !dm.participants.includes(b.pubkey)
    )
      throw new Error("Two-member DM membership read-back failed");
    const content = `Black4 league connectivity canary ${config.runId}. Reply once with ACK ${config.runId}. This is an explicitly authorized test.`;
    const sent = await receipts.execute(
      "canary:" + config.runId + ":send",
      planSend(
        a,
        b,
        {
          id: opened.channel_id,
          communityUrl: config.communityUrl,
          memberPubkeys: dm.participants,
        },
        content,
      ),
      runnerA,
    );
    if (sent.status !== "accepted")
      throw new Error(
        "Send acceptance unknown/rejected; reconcile receipt before rerunning",
      );
    const until = Date.now() + 60000;
    do {
      const messages = await read(
        ["messages", "get", "--channel", opened.channel_id, "--limit", "200"],
        envA,
      );
      const reply = Array.isArray(messages)
        ? messages.find(
            (m: any) =>
              m?.pubkey === b.pubkey &&
              hex.safeParse(m.id).success &&
              typeof m.content === "string" &&
              m.content.includes("ACK " + config.runId),
          )
        : undefined;
      if (reply) {
        console.log(
          JSON.stringify(
            {
              mode: "LIVE_CANARY",
              runId: config.runId,
              communityUrl: config.communityUrl,
              openEventId: opened.event_id,
              sendEventId: sent.event_id,
              replyEventId: reply.id,
              replyAuthor: reply.pubkey,
              replyCreatedAt: reply.created_at,
              ackMatched: true,
              limits:
                "Relay reply observed; model identity, cost and durable restart recovery still need independent runtime receipts.",
            },
            null,
            2,
          ),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < until);
    console.log(
      JSON.stringify({
        mode: "LIVE_CANARY",
        runId: config.runId,
        sendAccepted: true,
        observedPeerReply: false,
        status: "REPLY_NOT_OBSERVED_WITHIN_60_SECONDS",
        sendEventId: sent.event_id,
      }),
    );
    process.exitCode = 2;
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "CANARY_FAILED",
      error:
        error instanceof z.ZodError
          ? "Invalid canary configuration"
          : error instanceof Error
            ? error.message
            : "Unknown error",
    }),
  );
  process.exitCode = 1;
});
