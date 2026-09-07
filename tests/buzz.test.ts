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
