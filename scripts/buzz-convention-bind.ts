import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createDb } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { BuzzArchiveService } from "../src/buzz/archive.js";
import { BuzzRuntimeOutbound } from "../src/buzz/runtime-outbound.js";
import { createBuzzReader } from "../src/buzz/listener.js";
import {
  loadManagedCredential,
  LEAGUE_COMMUNITY,
} from "../src/buzz/managed-acp.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const leagueId = "black4-fantasy-2026",
  channelId = "64f95ba6-a6cd-47aa-b823-46a159e8bbd1",
  ownerPubkey =
    "8f61c527478c72a180a4cf368cadc10af0686ccb568ee18d33f46c2fea9ffa8f";
async function privateJson(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) !== 0)
    throw Error("Private file permissions required");
  return JSON.parse(await readFile(path, "utf8"));
}
let stage = "startup";
async function main() {
  if (!process.argv.includes("--execute")) {
    console.log(
      JSON.stringify({
        mode: "plan",
        leagueId,
        communityUrl: LEAGUE_COMMUNITY,
        channelId,
        participants: "ten managed franchises and Joey; Chris identity pending",
        sends: 0,
        modelCalls: 0,
        steps: [
          "Verify exact owner profiles and 11 channel members",
          "Persist scoped archive consent and channel binding",
          "Select canonical polling for ten agents",
        ],
      }),
    );
    return;
  }
  const db = createDb(
    (
      await readFile(resolve(root, ".local/deploy/database-url.host"), "utf8")
    ).trim(),
  );
  try {
    stage = "authenticate";
    const saved = await privateJson(
      resolve(root, ".local/live/owner-credentials.json"),
    );
    const actor = await authenticate(db, `Bearer ${saved.commissioner.token}`);
    if (actor.leagueId !== leagueId || actor.role !== "commissioner")
      throw Error("Commissioner mismatch");
    stage = "identity_catalog";
    const identities = (
      await db.query(
        "SELECT m.agent_id,m.team_id,m.owner_id,m.pubkey FROM buzz_managed_identities m JOIN runtime_bindings b ON b.agent_id=m.agent_id AND b.league_id=m.league_id AND b.team_id=m.team_id WHERE m.league_id=$1 AND m.community_url=$2 ORDER BY m.agent_id",
        [leagueId, LEAGUE_COMMUNITY],
      )
    ).rows;
    if (identities.length !== 10)
      throw Error("Exactly ten managed identities required");
    stage = "bootstrap_configuration";
    for (const i of identities) {
      const config = await privateJson(
        resolve(
          root,
          `.local/live/buzz-${i.agent_id.replace(/^b4-/, "")}.json`,
        ),
      );
      if (
        config.bootstrapOnly !== true ||
        config.communityUrl !== LEAGUE_COMMUNITY ||
        config.agentId !== i.agent_id
      )
        throw Error("Bootstrap-only exact configuration required");
    }
    stage = "managed_credential";
    const credential = await loadManagedCredential(db, leagueId, "b4-openai");
    const reader = createBuzzReader({
      executable: "/Users/joey/.local/bin/buzz",
      listener: {
        leagueId,
        pubkey: credential.pubkey,
        communityUrl: LEAGUE_COMMUNITY,
        mode: "real",
      },
      allowNetwork: true,
      environment: {
        BUZZ_PRIVATE_KEY: credential.privateKey,
        BUZZ_RELAY_URL: LEAGUE_COMMUNITY,
        ...(credential.authTag ? { BUZZ_AUTH_TAG: credential.authTag } : {}),
      },
    });
    stage = "verified_owner_profiles";
    const basic = z
      .array(
        z.object({
          pubkey: z.string(),
          display_name: z.string().optional(),
          name: z.string().optional(),
        }),
      )
      .parse(
        await reader({
          command: "profiles",
          pubkeys: identities.map((i) => i.pubkey),
        }),
      );
    const profiles: {
      pubkey: string;
      owner_pubkey: string;
      verification: "verified";
    }[] = [];
    for (const identity of identities) {
      const raw = basic.find((p) => p.pubkey === identity.pubkey);
      const name = raw?.display_name ?? raw?.name;
      if (!name) throw Error("Registered profile name missing");
      const verified = z
        .array(
          z.object({
            pubkey: z.string(),
            owner_pubkey: z.string(),
            verification: z.literal("verified"),
          }),
        )
        .parse(await reader({ command: "owner-profile", name, ownerPubkey }));
      const match = verified.find((p) => p.pubkey === identity.pubkey);
      if (!match) throw Error("Exact owner profile missing");
      profiles.push(match);
    }
    if (
      profiles.length !== 10 ||
      identities.some(
        (i) =>
          !profiles.some(
            (p) => p.pubkey === i.pubkey && p.owner_pubkey === ownerPubkey,
          ),
      )
    )
      throw Error("Verified owner relation missing");
    stage = "private_channel_membership";
    const members = z
      .array(z.object({ pubkey: z.string(), role: z.string() }))
      .parse(await reader({ command: "members", channelId }));
    const expected = [ownerPubkey, ...identities.map((i) => i.pubkey)].sort();
    if (
      JSON.stringify(members.map((m) => m.pubkey).sort()) !==
      JSON.stringify(expected)
    )
      throw Error("Founding channel membership mismatch");
    const archive = new BuzzArchiveService(db);
    stage = "archive_configuration";
    await archive.configure(actor, {
      leagueId,
      communityUrl: LEAGUE_COMMUNITY,
      mode: "real",
      bindingReceiptId: "founding-private-ui-20260908-verified-cli",
      archiveConsentReceiptId:
        "joey-league-internal-archive-authorization-20260908",
      participants: [
        ...identities.map((i) => ({
          pubkey: i.pubkey,
          ownerId: i.owner_id,
          teamId: i.team_id,
          agentId: i.agent_id,
          kind: "agent" as const,
          ownerPubkey,
        })),
        {
          pubkey: ownerPubkey,
          ownerId: "b4-owner-joey",
          teamId: "b4-team-joey",
          kind: "human",
        },
      ],
    });
    stage = "channel_registration";
    await archive.registerChannel(actor, {
      leagueId,
      channelId,
      memberPubkeys: expected,
      receiptId: "private-founding-native-ui-and-exact-cli-membership-20260908",
    });
    stage = "poll_cutover";
    const outbound = new BuzzRuntimeOutbound(db);
    for (const i of identities) {
      const mode = (
        await db.query(
          "SELECT mode FROM buzz_ingress_modes WHERE league_id=$1 AND agent_id=$2",
          [leagueId, i.agent_id],
        )
      ).rows[0]?.mode;
      if (mode !== "poll")
        await outbound.cutoverToPolling(actor, {
          leagueId,
          agentId: i.agent_id,
          receiptId: "joey-convention-release-canonical-poll-20260908",
        });
    }
    console.log(
      JSON.stringify({
        observedAt: new Date().toISOString(),
        leagueId,
        channelId,
        verifiedMembers: members.length,
        verifiedAgentOwners: profiles.length,
        pollingAgents: identities.length,
        internalArchive: true,
        publicPublication: false,
        sends: 0,
        modelCalls: 0,
      }),
    );
  } finally {
    await db.end();
  }
}
main().catch(() => {
  console.error(
    `Convention binding failed at ${stage}; private details omitted. No messages or model requests are sent by this command.`,
  );
  process.exitCode = 1;
});
