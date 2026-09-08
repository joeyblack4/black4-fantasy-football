import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createDb } from "../src/db.js";
import { authenticate } from "../src/auth.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { ConventionRuntime } from "../src/runtime/convention.js";

const mode = process.argv[2];
if (!["--configure", "--tick", "--status"].includes(mode ?? ""))
  throw Error(
    "Use --configure, --tick or --status with explicit league and scoped commissioner credential. No inference is invoked by this command.",
  );
const leagueId = process.env.FOOTBALL_LEAGUE_ID;
if (!leagueId) throw Error("FOOTBALL_LEAGUE_ID required");
const db = createDb();
try {
  const actor = await authenticate(
    db,
    process.env.B4_LEAGUE_COMMISSIONER_TOKEN
      ? `Bearer ${process.env.B4_LEAGUE_COMMISSIONER_TOKEN}`
      : undefined,
  );
  if (actor.role !== "commissioner" || actor.leagueId !== leagueId)
    throw Error("Scoped commissioner required");
  const service = new ConventionRuntime(db, new RuntimeStore(db));
  if (mode === "--configure") {
    const path = process.env.FOOTBALL_CONVENTION_CONFIG_FILE;
    if (!path || !isAbsolute(path))
      throw Error("Absolute FOOTBALL_CONVENTION_CONFIG_FILE required");
    console.log(
      JSON.stringify(
        await service.start(actor, JSON.parse(await readFile(path, "utf8"))),
      ),
    );
  } else if (mode === "--tick")
    console.log(JSON.stringify(await service.tick(leagueId)));
  else
    console.log(
      JSON.stringify({
        conventions: (
          await db.query(
            "SELECT * FROM runtime_conventions WHERE league_id=$1",
            [leagueId],
          )
        ).rows,
        waves: (
          await db.query(
            "SELECT * FROM runtime_convention_waves WHERE league_id=$1 ORDER BY due_at",
            [leagueId],
          )
        ).rows,
        turns: (
          await db.query(
            "SELECT meeting_id,agent_id,phase,count(*)::int AS attempts FROM runtime_convention_turns WHERE league_id=$1 GROUP BY meeting_id,agent_id,phase",
            [leagueId],
          )
        ).rows,
      }),
    );
} finally {
  await db.end();
}
