import type { Db } from "../db.js";
import { LEAGUE_COMMUNITY, loadManagedCredential } from "./managed-acp.js";
import { createBuzzReader, pollBuzzOnce } from "./listener.js";
import { BuzzArchiveService } from "./archive.js";

/** Credentials stay in the trusted process. Canonical events are the only wakeup source. */
export async function pollManagedBuzzOnce(
  db: Db,
  input: { leagueId: string; agentId: string; executable: string },
) {
  const binding = (
    await db.query(
      "SELECT b.community_url,b.mode,i.mode ingress_mode,p.pubkey FROM buzz_league_bindings b JOIN buzz_participants p USING(league_id) JOIN buzz_ingress_modes i ON i.league_id=p.league_id AND i.agent_id=p.agent_id WHERE b.league_id=$1 AND p.agent_id=$2",
      [input.leagueId, input.agentId],
    )
  ).rows[0];
  if (
    !binding ||
    binding.community_url !== LEAGUE_COMMUNITY ||
    binding.mode !== "real" ||
    binding.ingress_mode !== "poll"
  )
    throw Error("BUZZ_MANAGED_POLL_BINDING_REQUIRED");
  const credential = await loadManagedCredential(
    db,
    input.leagueId,
    input.agentId,
  );
  if (
    credential.pubkey !== binding.pubkey ||
    credential.communityUrl !== LEAGUE_COMMUNITY
  )
    throw Error("BUZZ_MANAGED_POLL_IDENTITY_MISMATCH");
  const listener = {
    leagueId: input.leagueId,
    pubkey: credential.pubkey,
    communityUrl: LEAGUE_COMMUNITY,
    mode: "real" as const,
  };
  const read = createBuzzReader({
    executable: input.executable,
    listener,
    allowNetwork: true,
    environment: {
      BUZZ_PRIVATE_KEY: credential.privateKey,
      BUZZ_RELAY_URL: credential.communityUrl,
      ...(credential.authTag ? { BUZZ_AUTH_TAG: credential.authTag } : {}),
    },
  });
  return pollBuzzOnce(new BuzzArchiveService(db), listener, read);
}
