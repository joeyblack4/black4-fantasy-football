import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
import { managedOutboundTransport } from "../src/buzz/runtime-outbound.js";
import { pollManagedBuzzOnce } from "../src/buzz/managed-listener.js";
const root = fileURLToPath(new URL("../", import.meta.url)),
  leagueId = "black4-fantasy-2026",
  channelId = "64f95ba6-a6cd-47aa-b823-46a159e8bbd1";
const content =
  "Operator transport test — sent by the Black4 setup operator through this franchise's managed Buzz connection. This is a connectivity receipt, not an AI owner's opinion or a league proposal. No response is requested. The private commissioner archive is being checked; nothing is being published publicly.";
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify({
      mode: "plan",
      leagueId,
      channelId,
      content,
      modelCalls: 0,
      mentions: [],
    }),
  );
} else {
  const db = createDb(
    (
      await readFile(resolve(root, ".local/deploy/database-url.host"), "utf8")
    ).trim(),
  );
  try {
    const credentials = JSON.parse(
      await readFile(
        resolve(root, ".local/live/owner-credentials.json"),
        "utf8",
      ),
    );
    const commissioner = await authenticate(
      db,
      `Bearer ${credentials.commissioner.token}`,
    );
    if (
      commissioner.role !== "commissioner" ||
      commissioner.leagueId !== leagueId
    )
      throw Error("Commissioner scope required");
    const row = (
      await db.query(
        "SELECT t.owner_id,t.id team_id FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id WHERE b.agent_id='b4-openai' AND b.league_id=$1",
        [leagueId],
      )
    ).rows[0];
    if (!row) throw Error("Managed sender binding missing");
    const actor = {
      id: row.owner_id,
      role: "owner" as const,
      leagueId,
      teamId: row.team_id,
    };
    const service = new BuzzChannelService(
      db,
      managedOutboundTransport(db, {
        executable: "/Users/joey/.local/bin/buzz",
        allowExternalSends: true,
      }),
    );
    const receipt = await service.send(actor, {
      leagueId,
      channelId,
      content,
      mentionAgentIds: [],
      operationKey: "operator-transport-canary-20260908-v1",
    });
    console.log(
      JSON.stringify({ kind: "operator_transport_fixture", ...receipt }),
    );
    await pollManagedBuzzOnce(db, {
      leagueId,
      agentId: "b4-anthropic",
      executable: "/Users/joey/.local/bin/buzz",
    });
    const observed = (
      await db.query(
        "SELECT e.event_id,e.author_pubkey,e.observed_at,(SELECT count(*)::int FROM buzz_inbound_deliveries d WHERE d.league_id=e.league_id AND d.event_id=e.event_id) wakeups FROM buzz_archive_events e WHERE e.league_id=$1 AND e.event_id=$2",
        [leagueId, receipt.eventId],
      )
    ).rows[0];
    console.log(
      JSON.stringify({
        kind: "independent_peer_archive_readback",
        observed: observed ?? null,
      }),
    );
  } finally {
    await db.end();
  }
}
