import { createECDH } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  planDmOpen,
  planSend,
  validatePeer,
  createCliRunner,
  BuzzReceiptService,
  type LeagueIdentity,
  type Peer,
} from "../src/buzz/index.js";
import { testDb } from "./helpers.js";
const actor: LeagueIdentity = {
  pubkey: "a".repeat(64),
  ownerPubkey: "c".repeat(64),
  ownershipVerified: true,
  communityUrl: "wss://league.example.test",
  kind: "agent",
  allowedPeerPubkeys: ["b".repeat(64)],
};
const peer: Peer = {
  pubkey: "b".repeat(64),
  ownerPubkey: "c".repeat(64),
  ownershipVerified: true,
  communityUrl: actor.communityUrl,
  kind: "agent",
};
const channel = {
  id: "12345678-1234-4234-9234-123456789abc",
  communityUrl: actor.communityUrl,
  memberPubkeys: [actor.pubkey, peer.pubkey],
};
describe("Buzz plan permission boundary", () => {
  it("allows verified same-owner peers and refuses unsupported DM reply permissions", () => {
    expect(planDmOpen(actor, [peer]).args).toEqual([
      "dms",
      "open",
      "--pubkey",
      peer.pubkey,
    ]);
    expect(() =>
      validatePeer(actor, { ...peer, ownerPubkey: "d".repeat(64) }),
    ).toThrow("cannot trigger");
    expect(() =>
      validatePeer(actor, { ...peer, ownershipVerified: false }),
    ).toThrow("cannot trigger");
    expect(() =>
      validatePeer(actor, {
        ...peer,
        communityUrl: "wss://customer.example.test",
      }),
    ).toThrow("Cross-community");
  });
  it("rejects a signing key that belongs to another actor before invoking any process", async () => {
    const runner = createCliRunner({
      executable: "/nonexistent/test-only-buzz",
      environment: {
        BUZZ_RELAY_URL: actor.communityUrl,
        BUZZ_PRIVATE_KEY: "0".repeat(63) + "1",
      },
      allowExternalSends: true,
    });
    await expect(runner(planDmOpen(actor, [peer]))).rejects.toThrow(
      "Signing identity",
    );
  });
  it("keeps message text out of shell commands and requires verified conversation membership", () => {
    const text = "hello $(touch /tmp/never) `whoami`";
    const plan = planSend(actor, peer, channel, text);
    expect(plan.stdin).toBe(text);
    expect(plan.args).not.toContain(text);
    expect(() =>
      planSend(actor, peer, { ...channel, memberPubkeys: [] }, text),
    ).toThrow("membership");
    expect(() =>
      createCliRunner({
        executable: "/tmp/buzz",
        environment: {},
        allowExternalSends: false,
      }),
    ).toThrow("disabled");
  });
});
describe("Buzz receipts with simulated CLI only", () => {
  let harness: Awaited<ReturnType<typeof testDb>>;
  let service: BuzzReceiptService;
  beforeAll(async () => {
    harness = await testDb();
    service = new BuzzReceiptService(harness.db);
  });
  afterAll(async () => harness?.close());
  it("only counts explicit relay event receipts as accepted and never duplicates concurrent sends", async () => {
    let calls = 0;
    const plan = planSend(actor, peer, channel, "Synthetic test message");
    const runner = async () => {
      calls++;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ accepted: true, event_id: "e".repeat(64) }),
      };
    };
    const results = await Promise.all([
      service.execute("test-1", plan, runner),
      service.execute("test-1", plan, runner),
    ]);
    expect(calls).toBe(1);
    expect(results.some((r) => r.status === "accepted")).toBe(true);
    await expect(
      service.execute(
        "test-1",
        planSend(actor, peer, channel, "changed"),
        runner,
      ),
    ).rejects.toThrow("conflict");
  });
  it("persists bounded CLI diagnostics while withholding credential and message echoes", async () => {
    const key = "0".repeat(63) + "1";
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(key, "hex"));
    const pubkey = ecdh.getPublicKey("hex", "compressed").slice(2);
    const runner = createCliRunner({
      executable: process.execPath,
      environment: {
        BUZZ_PRIVATE_KEY: key,
        BUZZ_RELAY_URL: actor.communityUrl,
      },
      allowExternalSends: true,
    });
    // Local fake process only: it does not contact Buzz or any provider.
    const plan = {
      actorPubkey: pubkey,
      communityUrl: actor.communityUrl,
      command: "send" as const,
      channelId: channel.id,
      stdin: "PRIVATE MESSAGE CONTENT",
      args: [
        "-e",
        "process.stderr.write(JSON.stringify({error:'user_error',message:'mentioned pubkeys are not channel members: PRIVATE MESSAGE CONTENT '+process.env.BUZZ_PRIVATE_KEY}));process.exitCode=1",
      ],
    };
    const result = await service.execute(
      "test-safe-process-diagnostic",
      plan,
      runner,
    );
    expect(result.status).toBe("unknown");
    expect(result.cli_diagnostic).toMatchObject({
      exitCode: 1,
      termination: "exited",
      stderrCategory: "user_error",
      stderrMessageClass: "Mentioned identity is not a channel member",
      stdoutJsonValid: false,
    });
    expect(JSON.stringify(result.cli_diagnostic)).not.toContain(key);
    expect(JSON.stringify(result.cli_diagnostic)).not.toContain(
      "PRIVATE MESSAGE CONTENT",
    );
    expect(
      (
        await service.execute(
          "test-safe-process-diagnostic",
          plan,
          async () => {
            throw Error("must never resend");
          },
        )
      ).replayed,
    ).toBe(true);
  });
  it("marks ambiguous external failure unknown and requires reconciliation instead of retry", async () => {
    let calls = 0;
    const plan = planDmOpen(actor, [peer]);
    const runner = async () => {
      calls++;
      throw new Error("timeout");
    };
    const first = await service.execute("test-timeout", plan, runner);
    const second = await service.execute("test-timeout", plan, runner);
    expect(first.status).toBe("unknown");
    expect(second.requiresReconciliation).toBe(true);
    expect(calls).toBe(1);
    const noEvent = await service.execute("test-no-event", plan, async () => ({
      exitCode: 0,
      stdout: '{"accepted":true}',
    }));
    expect(noEvent.status).toBe("unknown");
  });
});
