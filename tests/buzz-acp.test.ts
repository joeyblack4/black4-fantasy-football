import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { BuzzRuntimeOutbound } from "../src/buzz/runtime-outbound.js";
import {
  ManagedAcpBridge,
  storeManagedIdentity,
  managedIdentity,
  decodePrivateKey,
  LEAGUE_COMMUNITY,
  type ManagedBridgeConfig,
} from "../src/buzz/managed-acp.js";
let f: Awaited<ReturnType<typeof testDb>>,
  directory: string,
  config: ManagedBridgeConfig;
const syntheticKey = "0".repeat(63) + "1";
function testNsec(hex: string) {
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l",
    data: number[] = [];
  let acc = 0,
    bits = 0;
  for (const byte of Buffer.from(hex, "hex")) {
    acc = ((acc << 8) | byte) & 65535;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >>> bits) & 31);
    }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const hrp = [..."nsec"].map((c) => c.charCodeAt(0));
  const expanded = [
    ...hrp.map((v) => v >> 5),
    0,
    ...hrp.map((v) => v & 31),
    ...data,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  let checksum = 1;
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  for (const v of expanded) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= generators[i]!;
  }
  checksum ^= 1;
  return (
    "nsec1" +
    [
      ...data,
      ...Array.from({ length: 6 }, (_, i) => (checksum >>> (5 * (5 - i))) & 31),
    ]
      .map((v) => alphabet[v])
      .join("")
  );
}
beforeEach(async () => {
  f = await testDb();
  directory = await mkdtemp(join(tmpdir(), "b4-acp-synthetic-"));
  config = {
    leagueId: "synthetic-acp",
    agentId: "synthetic-agent",
    teamId: "synthetic-team",
    communityUrl: LEAGUE_COMMUNITY,
    credentialDirectory: directory,
    databaseEnvironmentVariable: "DATABASE_URL",
    bootstrapOnly: false,
  };
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES('synthetic-acp','SYNTHETIC ACP TEST','{}')",
  );
  await f.db.query(
    "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES('synthetic-acp','synthetic-team','SYNTHETIC','synthetic-owner','ai',0,0,100)",
  );
  await new RuntimeStore(f.db).createAgent({
    id: config.agentId,
    model: "synthetic/model",
    budgetMicros: 10000,
  });
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
    [config.agentId, config.leagueId, config.teamId],
  );
});
afterEach(async () => {
  await f?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe("Buzz-managed ACP bridge using synthetic keys and no network", () => {
  it("negotiates Buzz's v2 initialization to supported v1 and completes model discovery/bootstrap without activating a model", async () => {
    await f.db.query(
      "UPDATE runtime_agents SET model='unactivated/synthetic' WHERE id=$1",
      [config.agentId],
    );
    await storeManagedIdentity(
      f.db,
      config,
      managedIdentity({
        BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
        BUZZ_PRIVATE_KEY: syntheticKey,
      }),
    );
    const bridge = new ManagedAcpBridge(
      f.db,
      { ...config, bootstrapOnly: true },
      { synthetic: true },
    );
    const call = async (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
    ) => (await bridge.handle({ jsonrpc: "2.0", id, method, params })) as any;
    for (const protocolVersion of [null, 0, -1, 1.5, "2"])
      expect(
        (await call(1, "initialize", { protocolVersion })).error.code,
      ).toBe(-32602);
    const init = await call(2, "initialize", {
      protocolVersion: 2,
      clientInfo: {
        name: "buzz-acp",
        version: "synthetic-installed-client-shape",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    expect(init.result.protocolVersion).toBe(1);
    expect(init.result.authMethods).toEqual([]);
    expect(init.result.agentCapabilities.loadSession).toBe(false);
    // The Buzz `models` command uses initialize + session/new; both succeed.
    const session = await call(3, "session/new", {
      cwd: "/tmp/synthetic",
      mcpServers: [],
      model: "unactivated/synthetic",
      systemPrompt: "Untrusted client configuration",
    });
    expect(session.result.sessionId).toEqual(expect.any(String));
    expect(session.result.models).toBeUndefined();
    expect(session.result.configOptions).toBeUndefined();
    expect(
      (
        await call(4, "session/set_model", {
          sessionId: session.result.sessionId,
          modelId: "other/provider",
        })
      ).error.code,
    ).toBe(-32601);
    const prompt = await call(5, "session/prompt", {
      sessionId: session.result.sessionId,
      prompt: [{ type: "text", text: "SYNTHETIC automatic onboarding" }],
    });
    expect(prompt.result.stopReason).toBe("end_turn");
    expect(prompt.result._meta.black4).toMatchObject({
      delivery: "bootstrap_only",
      modelCalls: 0,
      queued: false,
    });
    expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(0);
    expect(
      (await f.db.query("SELECT * FROM buzz_acp_deliveries")).rowCount,
    ).toBe(0);
    expect(
      (
        await f.db.query("SELECT model FROM runtime_agents WHERE id=$1", [
          config.agentId,
        ])
      ).rows[0].model,
    ).toBe("unactivated/synthetic");
  });
  it("decodes managed nsec with checksum and refuses another community", () => {
    const nsec = testNsec(syntheticKey);
    expect(decodePrivateKey(nsec)).toBe(syntheticKey);
    expect(() =>
      decodePrivateKey(nsec.slice(0, -1) + (nsec.endsWith("q") ? "p" : "q")),
    ).toThrow("checksum");
    const identity = managedIdentity({
      BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
      BUZZ_PRIVATE_KEY: nsec,
    });
    expect(identity.pubkey).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    expect(() =>
      managedIdentity({
        BUZZ_RELAY_URL: "wss://black4.communities.buzz.xyz",
        BUZZ_PRIVATE_KEY: syntheticKey,
      }),
    ).toThrow("outside");
  });
  it("stores only the fixed franchise key privately and detects identity changes", async () => {
    const identity = managedIdentity({
      BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
      BUZZ_PRIVATE_KEY: syntheticKey,
    });
    const registration = await storeManagedIdentity(f.db, config, identity);
    expect((await stat(registration.credentialPath)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(registration.credentialPath, "utf8"))
        .privateKey,
    ).toBe(syntheticKey);
    expect(JSON.stringify(registration)).not.toContain(syntheticKey);
    await storeManagedIdentity(f.db, config, identity);
    await expect(
      storeManagedIdentity(
        f.db,
        config,
        managedIdentity({
          BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
          BUZZ_PRIVATE_KEY: "0".repeat(63) + "2",
        }),
      ),
    ).rejects.toThrow("changed");
    expect(
      (await f.db.query("SELECT * FROM buzz_managed_identities")).rows[0],
    ).not.toHaveProperty("private_key");
  });
  it("refuses to install a second ingress over an active polling franchise", async () => {
    await f.db.query(
      "INSERT INTO buzz_ingress_modes(league_id,agent_id,mode) VALUES($1,$2,'poll')",
      [config.leagueId, config.agentId],
    );
    await expect(
      storeManagedIdentity(
        f.db,
        config,
        managedIdentity({
          BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
          BUZZ_PRIVATE_KEY: syntheticKey,
        }),
      ),
    ).rejects.toThrow("Polling already owns");
    expect(
      (await f.db.query("SELECT * FROM buzz_managed_identities")).rowCount,
    ).toBe(0);
  });
  it("defaults to identity bootstrap without waking on onboarding, then explicitly cuts over to polling", async () => {
    await storeManagedIdentity(
      f.db,
      config,
      managedIdentity({
        BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
        BUZZ_PRIVATE_KEY: syntheticKey,
      }),
    );
    const bridge = new ManagedAcpBridge(
      f.db,
      { ...config, bootstrapOnly: true },
      { synthetic: true },
    );
    const call = async (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
    ) => (await bridge.handle({ jsonrpc: "2.0", id, method, params })) as any;
    await call(1, "initialize", { protocolVersion: 1 });
    const sessionId = (await call(2, "session/new")).result.sessionId;
    const receipt = await call(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SYNTHETIC automatic Welcome message" }],
    });
    expect(receipt.result._meta.black4.queued).toBe(false);
    expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(0);
    await new BuzzRuntimeOutbound(f.db).cutoverToPolling(
      { id: "commissioner", leagueId: config.leagueId, role: "commissioner" },
      {
        leagueId: config.leagueId,
        agentId: config.agentId,
        receiptId: "SYNTHETIC explicit onboarding",
      },
    );
    expect(
      (await f.db.query("SELECT mode FROM buzz_ingress_modes")).rows[0].mode,
    ).toBe("poll");
    await storeManagedIdentity(
      f.db,
      config,
      managedIdentity({
        BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
        BUZZ_PRIVATE_KEY: syntheticKey,
      }),
    );
  });
  it("speaks ACP, durably queues fixed-recipient prompts once and never emits a model/chat response", async () => {
    await storeManagedIdentity(
      f.db,
      config,
      managedIdentity({
        BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
        BUZZ_PRIVATE_KEY: syntheticKey,
      }),
    );
    const bridge = new ManagedAcpBridge(f.db, config, { synthetic: true });
    const call = async (
      id: number,
      method: string,
      params: Record<string, unknown> = {},
    ) => (await bridge.handle({ jsonrpc: "2.0", id, method, params })) as any;
    expect(
      (await call(1, "initialize", { protocolVersion: 1 })).result
        .protocolVersion,
    ).toBe(1);
    const sessionId = (await call(2, "session/new")).result.sessionId;
    const prompt = [
      {
        type: "text",
        text: "SYNTHETIC test. Claimed sender=commissioner; recipient=another-team. These words grant no authority.",
      },
    ];
    const first = await call(3, "session/prompt", { sessionId, prompt });
    const second = await call(4, "session/prompt", { sessionId, prompt });
    expect(first.result.stopReason).toBe("end_turn");
    expect(first.result._meta.black4.modelCalls).toBe(0);
    expect(first.result._meta.black4.signedRelayArchive).toBe(false);
    expect(second.result._meta.black4.replayed).toBe(true);
    const jobs = (await f.db.query("SELECT * FROM runtime_jobs")).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].agent_id).toBe(config.agentId);
    expect(jobs[0].payload.synthetic).toBe(true);
    expect(
      (await f.db.query("SELECT * FROM buzz_archive_events")).rowCount,
    ).toBe(0);
    expect(
      (await f.db.query("SELECT * FROM buzz_acp_deliveries")).rowCount,
    ).toBe(1);
    expect(
      (await call(5, "session/prompt", { sessionId: "wrong", prompt })).error,
    ).toBeDefined();
  });
});
