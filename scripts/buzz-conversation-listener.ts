/** Explicit conversation session only. One managed identity reads approved shared rooms;
 * the canonical archive routes members. No DM discovery, ACP responder or direct wake. */
import { z } from "zod";
import { createDb } from "../src/db.js";
import { pollManagedBuzzOnce } from "../src/buzz/managed-listener.js";
const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
if (!args.includes("--execute")) {
  console.log(
    JSON.stringify({
      mode: "plan",
      networkCalls: 0,
      modelCalls: 0,
      command:
        "--execute --league black4-fantasy-2026 --session UUID --agent ID [--once]",
    }),
  );
} else {
  const leagueId = option("--league"),
    sessionId = z.uuid().parse(option("--session")),
    agentId = z
      .string()
      .regex(/^b4-[a-z]+$/)
      .parse(option("--agent"));
  if (
    leagueId !== "black4-fantasy-2026" ||
    !process.env.DATABASE_URL ||
    !process.env.B4_LEAGUE_BUZZ_EXECUTABLE?.startsWith("/")
  )
    throw Error(
      "Explicit league database and managed Buzz executable required",
    );
  const db = createDb(),
    lease = await db.connect();
  let stop = false,
    locked = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  process.on("SIGTERM", () => {
    stop = true;
  });
  try {
    locked = (
      await lease.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,143)) locked",
        [leagueId],
      )
    ).rows[0].locked;
    if (!locked) throw Error("Managed league listener already running");
    do {
      const session = (
        await db.query(
          `SELECT s.configuration->'channelIds' AS channel_ids FROM runtime_conversation_sessions s
    JOIN runtime_conversation_owners o ON o.session_id=s.id AND o.agent_id=$3
    WHERE s.id=$1 AND s.league_id=$2 AND s.status='active' AND s.expires_at>clock_timestamp()`,
          [sessionId, leagueId, agentId],
        )
      ).rows[0];
      if (!session)
        throw Error(
          "Active scoped conversation session and pinned listener required",
        );
      const channelIds = z
        .array(z.uuid())
        .min(1)
        .max(5)
        .parse(session.channel_ids);
      try {
        const report = await pollManagedBuzzOnce(db, {
          leagueId,
          agentId,
          executable: process.env.B4_LEAGUE_BUZZ_EXECUTABLE!,
          channelIds,
        });
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            sessionId,
            agentId,
            ...report,
          }),
        );
      } catch {
        console.error(
          JSON.stringify({
            at: new Date().toISOString(),
            sessionId,
            healthy: false,
            error: "Scoped conversation polling failed",
          }),
        );
      }
      if (args.includes("--once") || stop) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } while (!stop);
  } finally {
    if (locked)
      await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,143))", [
        leagueId,
      ]);
    lease.release();
    await db.end();
  }
}
