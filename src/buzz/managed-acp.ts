import { createECDH, createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { transaction, type Db } from "../db.js";
import { RuntimeStore } from "../runtime/index.js";
export const LEAGUE_COMMUNITY =
  "wss://black4fantasysports.communities.buzz.xyz";
export const ManagedBridgeConfigSchema = z
  .object({
    leagueId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    agentId: z.string().min(1).max(150),
    teamId: z.string().min(1).max(150),
    communityUrl: z.literal(LEAGUE_COMMUNITY),
    credentialDirectory: z.string().startsWith("/"),
    bootstrapOnly: z.boolean().default(true),
    databaseEnvironmentVariable: z
      .string()
      .regex(/^(DATABASE_URL|B4_LEAGUE_[A-Z0-9_]+)$/)
      .default("DATABASE_URL"),
  })
  .strict();
export type ManagedBridgeConfig = z.infer<typeof ManagedBridgeConfigSchema>;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
/** NIP-19 nsec decode including Bech32 checksum. No network or key output. */
export function decodePrivateKey(input: string): string {
  if (/^[a-f0-9]{64}$/.test(input)) return input;
  if (!input.startsWith("nsec1") || input !== input.toLowerCase())
    throw new Error("Managed signing key has unsupported encoding");
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l",
    values = [...input.slice(5)].map((c) => alphabet.indexOf(c));
  if (values.some((v) => v < 0) || values.length !== 58)
    throw new Error("Invalid managed nsec");
  const hrp = [..."nsec"].map((c) => c.charCodeAt(0));
  const expanded = [
    ...hrp.map((v) => v >> 5),
    0,
    ...hrp.map((v) => v & 31),
    ...values,
  ];
  let checksum = 1;
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  for (const value of expanded) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= generators[i]!;
  }
  if (checksum !== 1) throw new Error("Invalid managed nsec checksum");
  let acc = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const value of values.slice(0, -6)) {
    acc = ((acc << 5) | value) & 65535;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 255);
    }
  }
  if (bytes.length !== 32 || bits >= 5 || ((acc << (8 - bits)) & 255) !== 0)
    throw new Error("Invalid managed nsec padding");
  return Buffer.from(bytes).toString("hex");
}
export type ManagedIdentity = {
  pubkey: string;
  communityUrl: string;
  privateKey: string;
  authTag?: string;
  ownerPubkeyHint: string | null;
};
export function managedIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): ManagedIdentity {
  const relay = environment.BUZZ_RELAY_URL;
  if (!relay) throw new Error("Buzz-managed relay missing");
  const url = new URL(relay);
  const expected = new URL(LEAGUE_COMMUNITY);
  if (
    !["wss:", "https:"].includes(url.protocol) ||
    url.host !== expected.host ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "Managed agent is outside the authorized football community",
    );
  const privateKey = decodePrivateKey(environment.BUZZ_PRIVATE_KEY ?? "");
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "hex"));
  const pubkey = ecdh.getPublicKey("hex", "compressed").slice(2);
  let ownerPubkeyHint: string | null = null;
  const authTag = environment.BUZZ_AUTH_TAG;
  if (authTag) {
    const parsed = z.array(z.string()).length(4).parse(JSON.parse(authTag));
    if (parsed[0] !== "auth" || !/^[a-f0-9]{64}$/.test(parsed[1]!))
      throw new Error("Invalid owner attestation shape");
    ownerPubkeyHint = parsed[1]!;
  }
  return {
    pubkey,
    communityUrl: LEAGUE_COMMUNITY,
    privateKey,
    ...(authTag ? { authTag } : {}),
    ownerPubkeyHint,
  };
}
/** Capture only the managed franchise identity in a private directory outside this repository. Private material is never returned to ACP or stored in PostgreSQL. */
export async function storeManagedIdentity(
  db: Db,
  config: ManagedBridgeConfig,
  identity: ManagedIdentity,
) {
  if (identity.communityUrl !== config.communityUrl)
    throw new Error("Managed community mismatch");
  const binding = (
    await db.query(
      "SELECT b.*,t.owner_id,a.kind FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id JOIN runtime_agents a ON a.id=b.agent_id WHERE b.agent_id=$1 AND b.league_id=$2 AND b.team_id=$3",
      [config.agentId, config.leagueId, config.teamId],
    )
  ).rows[0];
  if (!binding || binding.kind !== "ai")
    throw new Error("Pre-registered AI franchise runtime binding required");
  await mkdir(config.credentialDirectory, { recursive: true, mode: 0o700 });
  const stat = await lstat(config.credentialDirectory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error(
      "Credential directory must be owned, nonsymlink and mode 0700",
    );
  const directory = await realpath(config.credentialDirectory),
    repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  if (directory === repo || directory.startsWith(repo + "/"))
    throw new Error("Credentials cannot be stored in the repository");
  const path = join(directory, `${identity.pubkey}.json`);
  const secret = JSON.stringify({
    version: 1,
    leagueId: config.leagueId,
    agentId: config.agentId,
    teamId: config.teamId,
    communityUrl: identity.communityUrl,
    pubkey: identity.pubkey,
    privateKey: identity.privateKey,
    authTag: identity.authTag ?? null,
  });
  const fingerprint = sha(secret);
  // Transaction lock prevents simultaneous process registration under different identities.
  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,142))", [
      `${config.leagueId}:${config.agentId}`,
    ]);
    await tx.query(
      "INSERT INTO buzz_ingress_modes(league_id,agent_id,mode) VALUES($1,$2,'managed_acp') ON CONFLICT DO NOTHING",
      [config.leagueId, config.agentId],
    );
    const ingress = (
      await tx.query(
        "SELECT mode FROM buzz_ingress_modes WHERE league_id=$1 AND agent_id=$2",
        [config.leagueId, config.agentId],
      )
    ).rows[0];
    if (
      ingress.mode !== "managed_acp" &&
      !(
        await tx.query(
          "SELECT 1 FROM buzz_managed_identities WHERE league_id=$1 AND agent_id=$2",
          [config.leagueId, config.agentId],
        )
      ).rowCount
    )
      throw new Error(
        "Polling already owns this franchise ingress; explicit cutover required",
      );
    const old = (
      await tx.query(
        "SELECT * FROM buzz_managed_identities WHERE league_id=$1 AND agent_id=$2",
        [config.leagueId, config.agentId],
      )
    ).rows[0];
    if (
      old &&
      (old.pubkey !== identity.pubkey ||
        old.credential_fingerprint !== fingerprint ||
        old.credential_path !== path)
    )
      throw new Error(
        "Managed identity changed; operator reconciliation required",
      );
    try {
      await writeFile(path, secret + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const st = await lstat(path);
      if (
        st.isSymbolicLink() ||
        (st.mode & 0o077) !== 0 ||
        st.uid !== process.getuid?.() ||
        sha((await readFile(path, "utf8")).trim()) !== fingerprint
      )
        throw new Error("Existing managed credential mismatch");
    }
    await tx.query(
      "INSERT INTO buzz_managed_identities(league_id,agent_id,team_id,pubkey,community_url,credential_path,credential_fingerprint,owner_pubkey_hint,provenance,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
      [
        config.leagueId,
        config.agentId,
        config.teamId,
        identity.pubkey,
        identity.communityUrl,
        path,
        fingerprint,
        identity.ownerPubkeyHint,
        "Buzz-managed child environment; owner tag shape checked, no independent attestation signature verification",
        binding.owner_id,
      ],
    );
    return {
      pubkey: identity.pubkey,
      leagueId: config.leagueId,
      agentId: config.agentId,
      credentialPath: path,
    };
  });
}
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
/** ACP stdio sink. It acknowledges durable queueing, emits no chat text, and makes no model call. Prompt text is not promoted to signed event metadata or actor authority. */
export class ManagedAcpBridge {
  private initialized = false;
  private sessions = new Set<string>();
  private runtime: RuntimeStore;
  constructor(
    private db: Db,
    private config: ManagedBridgeConfig,
    private options: { synthetic: boolean } = { synthetic: false },
  ) {
    this.runtime = new RuntimeStore(db);
  }
  async handle(raw: unknown): Promise<unknown | null> {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success)
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid ACP request" },
      };
    const request = parsed.data;
    if (request.id === undefined) {
      if (request.method === "session/cancel") return null;
      return null;
    }
    const response = (result: unknown) => ({
      jsonrpc: "2.0",
      id: request.id,
      result,
    });
    const error = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: request.id,
      error: { code, message },
    });
    try {
      if (request.method === "initialize") {
        // The client advertises its latest version; the agent responds with its
        // own supported version. Buzz currently requests 2 and accepts 1.
        // This advertises only our v1 capabilities, never invented v2 support.
        const requestedVersion = request.params?.protocolVersion;
        if (
          typeof requestedVersion !== "number" ||
          !Number.isSafeInteger(requestedVersion) ||
          requestedVersion < 1
        )
          return error(
            -32602,
            "Positive integer ACP protocol version required",
          );
        this.initialized = true;
        return response({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: {
              image: false,
              audio: false,
              embeddedContext: false,
            },
            mcpCapabilities: { http: false, sse: false },
          },
          agentInfo: {
            name: "black4-franchise-bridge",
            title: "Black4 Franchise Bridge",
            version: "0.1.0",
          },
          authMethods: [],
        });
      }
      if (!this.initialized) return error(-32000, "Initialize required");
      if (request.method === "session/new") {
        if (this.sessions.size >= 100) return error(-32000, "Session limit");
        const sessionId = randomUUID();
        this.sessions.add(sessionId);
        return response({ sessionId });
      }
      if (request.method !== "session/prompt")
        return error(-32601, "Unsupported ACP method");
      const params = z
        .object({
          sessionId: z.string(),
          prompt: z
            .array(
              z
                .object({
                  type: z.literal("text"),
                  text: z.string().max(262144),
                })
                .passthrough(),
            )
            .min(1)
            .max(20),
        })
        .passthrough()
        .parse(request.params);
      if (!this.sessions.has(params.sessionId))
        return error(-32602, "Unknown ACP session");
      const prompt = params.prompt.map((p) => ({ type: "text", text: p.text }));
      const serialized = JSON.stringify(prompt);
      if (Buffer.byteLength(serialized) > 262144)
        return error(-32602, "Prompt exceeds bridge limit");
      const ingress = (
        await this.db.query(
          "SELECT mode FROM buzz_ingress_modes WHERE league_id=$1 AND agent_id=$2",
          [this.config.leagueId, this.config.agentId],
        )
      ).rows[0];
      if (this.config.bootstrapOnly || ingress?.mode === "poll")
        return response({
          stopReason: "end_turn",
          _meta: {
            black4: {
              delivery: "bootstrap_only",
              modelCalls: 0,
              queued: false,
              reason: "Canonical polling owns this franchise wakeup path",
            },
          },
        });
      const promptHash = sha(serialized);
      const receipt = await transaction(this.db, async (tx) => {
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,143))",
          [`${this.config.leagueId}:${this.config.agentId}:${promptHash}`],
        );
        const binding = (
          await tx.query(
            "SELECT m.pubkey FROM buzz_managed_identities m JOIN runtime_bindings b ON b.agent_id=m.agent_id AND b.league_id=m.league_id AND b.team_id=m.team_id JOIN league_teams t ON t.league_id=m.league_id AND t.id=m.team_id AND t.owner_id=m.owner_id JOIN buzz_ingress_modes i ON i.league_id=m.league_id AND i.agent_id=m.agent_id AND i.mode='managed_acp' WHERE m.league_id=$1 AND m.agent_id=$2 AND m.team_id=$3 AND m.community_url=$4 FOR SHARE OF b",
            [
              this.config.leagueId,
              this.config.agentId,
              this.config.teamId,
              this.config.communityUrl,
            ],
          )
        ).rows[0];
        if (!binding) throw new Error("Managed franchise binding missing");
        const old = (
          await tx.query(
            "SELECT id,inbox_id FROM buzz_acp_deliveries WHERE league_id=$1 AND agent_id=$2 AND prompt_hash=$3",
            [this.config.leagueId, this.config.agentId, promptHash],
          )
        ).rows[0];
        if (old) return { ...old, replayed: true };
        const job = await this.runtime.ingestEventTx(tx, {
          agentId: this.config.agentId,
          causalId: `buzz-acp:${promptHash}`,
          payload: {
            kind: "buzz.acp_delivery",
            leagueId: this.config.leagueId,
            agentId: this.config.agentId,
            recipientPubkey: binding.pubkey,
            prompt,
            synthetic: this.options.synthetic,
            provenance:
              "Buzz-managed ACP delivery; embedded event IDs and sender text are unverified",
            contentTrust:
              "untrusted prompt content; no embedded actor authority",
          },
        });
        const id = randomUUID();
        await tx.query(
          "INSERT INTO buzz_acp_deliveries(id,league_id,agent_id,session_id,prompt_hash,prompt,inbox_id,provenance,synthetic) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            this.config.leagueId,
            this.config.agentId,
            params.sessionId,
            promptHash,
            serialized,
            job.id,
            "Managed ACP prompt; not signed relay archive",
            this.options.synthetic,
          ],
        );
        return { id, inbox_id: job.id, replayed: false };
      });
      return response({
        stopReason: "end_turn",
        _meta: {
          black4: {
            deliveryReceiptId: receipt.id,
            inboxId: receipt.inbox_id,
            replayed: receipt.replayed,
            modelCalls: 0,
            delivery: "durably_queued",
            signedRelayArchive: false,
          },
        },
      });
    } catch {
      return error(
        -32000,
        "Franchise bridge could not durably accept this delivery",
      );
    }
  }
}

/** Trusted host-only credential resolver. Never expose this result through HTTP/MCP, logs, or model context. */
export async function loadManagedCredential(
  db: Db,
  leagueId: string,
  agentId: string,
) {
  const row = (
    await db.query(
      "SELECT m.* FROM buzz_managed_identities m JOIN runtime_bindings b ON b.agent_id=m.agent_id AND b.league_id=m.league_id AND b.team_id=m.team_id JOIN league_teams t ON t.league_id=m.league_id AND t.id=m.team_id AND t.owner_id=m.owner_id WHERE m.league_id=$1 AND m.agent_id=$2",
      [leagueId, agentId],
    )
  ).rows[0];
  if (!row || row.community_url !== LEAGUE_COMMUNITY)
    throw new Error("Managed league credential unavailable");
  const info = await lstat(row.credential_path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Unsafe managed credential file");
  const raw = (await readFile(row.credential_path, "utf8")).trim();
  if (sha(raw) !== row.credential_fingerprint)
    throw new Error("Managed credential fingerprint mismatch");
  const saved = JSON.parse(raw);
  const identity = managedIdentity({
    BUZZ_PRIVATE_KEY: saved.privateKey,
    BUZZ_RELAY_URL: saved.communityUrl,
    BUZZ_AUTH_TAG: saved.authTag ?? undefined,
  });
  if (
    identity.pubkey !== row.pubkey ||
    saved.leagueId !== leagueId ||
    saved.agentId !== agentId ||
    saved.teamId !== row.team_id
  )
    throw new Error("Managed credential scope mismatch");
  return identity;
}
