import { createECDH, createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { transaction, type Db } from "../db.js";
const hex64 = /^[a-f0-9]{64}$/;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** These identities must come from authenticated, verified relay metadata, never a model's assertion. */
export type Peer = {
  pubkey: string;
  ownerPubkey: string | null;
  ownershipVerified: boolean;
  communityUrl: string;
  kind: "human" | "agent";
};
export type LeagueIdentity = Peer & { allowedPeerPubkeys: readonly string[] };
export function validatePeer(
  actor: LeagueIdentity,
  peer: Peer,
  requireReply = true,
): void {
  if (!hex64.test(actor.pubkey) || !hex64.test(peer.pubkey))
    throw new Error("Invalid public key");
  const url = new URL(actor.communityUrl);
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Secure community URL required");
  if (actor.communityUrl !== peer.communityUrl)
    throw new Error("Cross-community peer rejected");
  if (
    actor.pubkey === peer.pubkey ||
    !actor.allowedPeerPubkeys.includes(peer.pubkey)
  )
    throw new Error("Peer is not a permitted league participant");
  if (
    !actor.ownershipVerified ||
    !actor.ownerPubkey ||
    !hex64.test(actor.ownerPubkey)
  )
    throw new Error("Actor owner is unverified");
  if (
    requireReply &&
    peer.kind === "agent" &&
    (!peer.ownershipVerified || peer.ownerPubkey !== actor.ownerPubkey)
  )
    throw new Error("Current Buzz DM gate cannot trigger this peer");
}
export type BuzzPlan = {
  actorPubkey: string;
  communityUrl: string;
  command: "open-dm" | "send";
  args: string[];
  stdin?: string;
  channelId?: string;
};
export function planDmOpen(actor: LeagueIdentity, peers: Peer[]): BuzzPlan {
  if (
    !peers.length ||
    peers.length > 8 ||
    new Set(peers.map((p) => p.pubkey)).size !== peers.length
  )
    throw new Error("DM needs 1-8 distinct peers");
  for (const peer of peers) validatePeer(actor, peer);
  return {
    actorPubkey: actor.pubkey,
    communityUrl: actor.communityUrl,
    command: "open-dm",
    args: ["dms", "open", ...peers.flatMap((p) => ["--pubkey", p.pubkey])],
  };
}
export function planSend(
  actor: LeagueIdentity,
  peer: Peer,
  channel: {
    id: string;
    communityUrl: string;
    memberPubkeys: readonly string[];
    kind?: "dm" | "private-channel";
  },
  content: string,
  replyTo?: string,
): BuzzPlan {
  validatePeer(actor, peer, channel.kind !== "private-channel");
  if (
    !uuid.test(channel.id) ||
    channel.communityUrl !== actor.communityUrl ||
    !channel.memberPubkeys.includes(actor.pubkey) ||
    !channel.memberPubkeys.includes(peer.pubkey)
  )
    throw new Error("Unverified conversation membership");
  if (
    !content.trim() ||
    Buffer.byteLength(content) > 16_384 ||
    content.includes("\u0000")
  )
    throw new Error("Invalid message size or content");
  if (replyTo && !hex64.test(replyTo)) throw new Error("Invalid reply event");
  return {
    actorPubkey: actor.pubkey,
    communityUrl: actor.communityUrl,
    command: "send",
    channelId: channel.id,
    stdin: content,
    args: [
      "messages",
      "send",
      "--channel",
      channel.id,
      "--content",
      "-",
      "--mention",
      peer.pubkey,
      ...(replyTo ? ["--reply-to", replyTo] : []),
    ],
  };
}
export type CliRunner = (
  plan: BuzzPlan,
) => Promise<{ exitCode: number | null; stdout: string }>;
/** Explicitly opt in when constructing a real runner. Nothing executes on import or planning. */
export function createCliRunner(options: {
  executable: string;
  environment: Readonly<Record<string, string>>;
  allowExternalSends: boolean;
}): CliRunner {
  if (!options.allowExternalSends)
    throw new Error("External sends are disabled");
  if (!options.executable.startsWith("/"))
    throw new Error("Absolute Buzz executable required");
  const key = options.environment.BUZZ_PRIVATE_KEY;
  if (!key || !hex64.test(key))
    throw new Error("Scoped hex signing key required");
  let signingPubkey: string;
  try {
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(key, "hex"));
    signingPubkey = ecdh.getPublicKey("hex", "compressed").slice(2);
  } catch {
    throw new Error("Invalid signing key");
  }
  return async (plan) => {
    if (signingPubkey !== plan.actorPubkey)
      throw new Error("Signing identity does not match plan actor");
    if (options.environment.BUZZ_RELAY_URL !== plan.communityUrl)
      throw new Error("Runner community does not match plan");
    if (!options.environment.BUZZ_PRIVATE_KEY)
      throw new Error("Scoped signing key required");
    return new Promise((resolve, reject) => {
      const child = spawn(options.executable, plan.args, {
        shell: false,
        env: { PATH: "/usr/bin:/bin", ...options.environment },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      let overflow = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > 65536) {
          overflow = true;
          child.kill("SIGKILL");
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Buzz executable failed"));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (overflow) reject(new Error("Buzz response exceeded limit"));
        else resolve({ exitCode: code, stdout });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(plan.stdin ?? "");
    });
  };
}
/** Receipt proves relay acceptance only. Peer wakeup/response require independent event receipts. */
export class BuzzReceiptService {
  constructor(private readonly db: Db) {}
  async execute(operationKey: string, plan: BuzzPlan, runner: CliRunner) {
    if (!operationKey || operationKey.length > 200)
      throw new Error("Invalid operation key");
    const planHash = createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    const claim = await transaction(this.db, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,1))",
        [operationKey],
      );
      const previous = await client.query(
        "SELECT * FROM buzz_action_receipts WHERE operation_key=$1",
        [operationKey],
      );
      if (previous.rowCount) {
        if (previous.rows[0].plan_hash !== planHash)
          throw new Error("Buzz operation key payload conflict");
        // A prepared receipt after crash might already have published; never blindly resend.
        return { existing: true, receipt: previous.rows[0] };
      }
      const inserted = await client.query(
        "INSERT INTO buzz_action_receipts(id,operation_key,plan_hash,actor_pubkey,community_url,status,channel_id,expected_content_hash,expected_reply_to) VALUES($1,$2,$3,$4,$5,'prepared',$6,$7,$8) RETURNING *",
        [
          randomUUID(),
          operationKey,
          planHash,
          plan.actorPubkey,
          plan.communityUrl,
          plan.channelId ?? null,
          plan.stdin === undefined
            ? null
            : createHash("sha256").update(plan.stdin).digest("hex"),
          plan.args.includes("--reply-to")
            ? plan.args[plan.args.indexOf("--reply-to") + 1]
            : null,
        ],
      );
      return { existing: false, receipt: inserted.rows[0] };
    });
    if (claim.existing)
      return {
        ...claim.receipt,
        replayed: true,
        requiresReconciliation: ["prepared", "unknown"].includes(
          claim.receipt.status,
        ),
      };
    let status: "accepted" | "rejected" | "unknown" = "unknown";
    let eventId: string | null = null;
    let channelId: string | null = null;
    try {
      const output = await runner(plan);
      const response: unknown = JSON.parse(output.stdout);
      if (response && typeof response === "object") {
        const value = response as Record<string, unknown>;
        if (value.accepted === false) status = "rejected";
        else if (
          output.exitCode === 0 &&
          value.accepted === true &&
          typeof value.event_id === "string" &&
          hex64.test(value.event_id)
        ) {
          eventId = value.event_id;
          const candidate = plan.channelId ?? value.dm_id;
          if (typeof candidate === "string" && uuid.test(candidate)) {
            channelId = candidate;
            status = "accepted";
          }
        }
      }
    } catch {
      /* unknown external result: reconcile rather than retry */
    }
    const result = await this.db.query(
      "UPDATE buzz_action_receipts SET status=$2,event_id=$3,channel_id=COALESCE($4,channel_id),updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [claim.receipt.id, status, eventId, channelId],
    );
    return {
      ...result.rows[0],
      replayed: false,
      requiresReconciliation: status === "unknown",
    };
  }
}
