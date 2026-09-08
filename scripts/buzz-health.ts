import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDb } from "../src/db.js";
import { LEAGUE_COMMUNITY } from "../src/buzz/managed-acp.js";

// Read-only, exact live league. Never reads credential blobs or prints raw logs.
const root = fileURLToPath(new URL("../", import.meta.url));
const leagueId = "black4-fantasy-2026";
const filter = process.argv.includes("--agent")
  ? process.argv[process.argv.indexOf("--agent") + 1]
  : undefined;
if (filter !== undefined && !/^b4-[a-z0-9-]+$/.test(filter))
  throw Error("Invalid franchise ID.");
const db = createDb(
  (
    await readFile(join(root, ".local/deploy/database-url.host"), "utf8")
  ).trim(),
);
try {
  const client = await db.connect();
  let identities: any[],
    modes: any[],
    queued: number,
    jobs: any[],
    bindings: any[],
    conversations: any[];
  try {
    await client.query("BEGIN READ ONLY");
    identities = (
      await client.query(
        "SELECT agent_id,team_id,pubkey,registered_at FROM buzz_managed_identities WHERE league_id=$1 AND community_url=$2 AND ($3::text IS NULL OR agent_id=$3) ORDER BY agent_id",
        [leagueId, LEAGUE_COMMUNITY, filter ?? null],
      )
    ).rows;
    modes = (
      await client.query(
        "SELECT agent_id,mode FROM buzz_ingress_modes WHERE league_id=$1 ORDER BY agent_id",
        [leagueId],
      )
    ).rows;
    queued = (
      await client.query(
        "SELECT count(*)::int n FROM buzz_acp_deliveries WHERE league_id=$1",
        [leagueId],
      )
    ).rows[0].n;
    jobs = (
      await client.query(
        "SELECT j.status,count(*)::int n FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 GROUP BY j.status",
        [leagueId],
      )
    ).rows;
    bindings = (
      await client.query(
        "SELECT community_url,mode,binding_receipt_id,archive_consent_receipt_id FROM buzz_league_bindings WHERE league_id=$1",
        [leagueId],
      )
    ).rows;
    conversations = (
      await client.query(
        "SELECT channel_id,kind FROM buzz_conversations WHERE league_id=$1",
        [leagueId],
      )
    ).rows;
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const relayHash = createHash("sha256").update(LEAGUE_COMMUNITY).digest("hex");
  const reports = [];
  for (const identity of identities) {
    const events: { at: string | null; kind: string }[] = [];
    let logStatus = "unavailable";
    if (!/^[a-f0-9]{64}$/.test(identity.pubkey))
      throw Error("Invalid registered public key.");
    const path = join(
      "/Users/joey/Library/Application Support/xyz.block.buzz.app/agents/logs",
      identity.pubkey + "__" + relayHash + ".log",
    );
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink())
        throw Error("Unsafe log path");
      const file = await open(path, "r");
      let text = "";
      try {
        const buffer = Buffer.alloc(Math.min(info.size, 131072));
        const read = await file.read(
          buffer,
          0,
          buffer.length,
          Math.max(0, info.size - buffer.length),
        );
        text = buffer.subarray(0, read.bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
      for (const line of text.split("\n")) {
        let kind: string | undefined;
        if (line.includes("agent initialize failed"))
          kind = line.includes("ACP protocol version 1 required")
            ? "initialize_failed_version_negotiation"
            : "initialize_failed";
        else if (line.includes("agent initialized"))
          kind = "initialize_succeeded";
        else if (line.includes("Black4 ACP bridge failed"))
          kind = "bridge_failed";
        else if (line.includes("Unsupported ACP method"))
          kind = "unsupported_method";
        else if (line.includes("stopped pair runtime")) kind = "stopped";
        if (kind)
          events.push({
            at: line.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/)?.[0] ?? null,
            kind,
          });
      }
      logStatus = info.size > 131072 ? "tail_only" : "read";
    } catch {
      /* Missing/unsafe/unreadable logs are explicit, not healthy. */
    }
    reports.push({
      ...identity,
      logStatus,
      latestProtocolObservation: events.at(-1) ?? null,
      recentProtocolEvents: events.slice(-5),
    });
  }
  console.log(
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        leagueId,
        communityUrl: LEAGUE_COMMUNITY,
        identityCount: identities.length,
        identities: reports,
        ingressModes: modes,
        acpQueuedDeliveries: queued,
        jobs,
        archiveBindings: bindings,
        archiveConversations: conversations,
        limitation:
          "Initialization evidence is not a current process-liveness or successful-message claim.",
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Scoped Buzz health read failed; no credentials or raw log content were printed.",
  );
  process.exitCode = 1;
} finally {
  await db.end();
}
