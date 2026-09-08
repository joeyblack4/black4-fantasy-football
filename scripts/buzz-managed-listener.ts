import { createDb } from "../src/db.js";
import { pollManagedBuzzOnce } from "../src/buzz/managed-listener.js";
const args = process.argv.slice(2);
if (!args.includes("--execute")) {
  console.log(
    JSON.stringify({
      mode: "plan",
      modelCalls: 0,
      networkCalls: 0,
      command: "--execute --league ID [--agent ID] [--once]",
    }),
  );
} else {
  const leagueId = args[args.indexOf("--league") + 1];
  const agentId = args.includes("--agent")
    ? args[args.indexOf("--agent") + 1]
    : undefined;
  if (
    !args.includes("--league") ||
    leagueId !== "black4-fantasy-2026" ||
    !process.env.DATABASE_URL ||
    !process.env.B4_LEAGUE_BUZZ_EXECUTABLE?.startsWith("/")
  )
    throw Error(
      "Explicit private league database and Buzz executable required",
    );
  const db = createDb(),
    lease = await db.connect();
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });
  process.on("SIGTERM", () => {
    stop = true;
  });
  try {
    // One fleet listener owns all discovery. Parallel per-identity jobs would repeat channel reads.
    const locked = (
      await lease.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,143)) locked",
        [leagueId],
      )
    ).rows[0].locked;
    if (!locked) throw Error("Managed league listener already running");
    do {
      const agents = (
        await db.query(
          "SELECT p.agent_id FROM buzz_participants p JOIN buzz_ingress_modes i USING(league_id,agent_id) WHERE p.league_id=$1 AND i.mode='poll' AND ($2::text IS NULL OR p.agent_id=$2) ORDER BY p.agent_id",
          [leagueId, agentId ?? null],
        )
      ).rows;
      if (!agents.length) throw Error("No registered polling agents");
      for (const agent of agents) {
        if (stop) break;
        try {
          const report = await pollManagedBuzzOnce(db, {
            leagueId,
            agentId: agent.agent_id,
            executable: process.env.B4_LEAGUE_BUZZ_EXECUTABLE!,
          });
          console.log(
            JSON.stringify({
              at: new Date().toISOString(),
              agentId: agent.agent_id,
              ...report,
            }),
          );
        } catch {
          console.error(
            JSON.stringify({
              at: new Date().toISOString(),
              agentId: agent.agent_id,
              healthy: false,
              error: "Scoped Buzz polling failed",
            }),
          );
        }
      }
      if (args.includes("--once") || stop) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } while (!stop);
  } finally {
    await lease.query("SELECT pg_advisory_unlock(hashtextextended($1,143))", [
      leagueId,
    ]);
    lease.release();
    await db.end();
  }
}
