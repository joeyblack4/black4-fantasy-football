import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createDb, migrate } from "../src/db.js";
import { LeagueService } from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { issueCredential } from "../src/auth.js";
const leagueId = "black4-fantasy-2026";
const owners = [
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google", "Google"],
  ["xai", "xAI"],
  ["meta", "Meta"],
  ["deepseek", "DeepSeek"],
  ["qwen", "Qwen"],
  ["mistral", "Mistral"],
  ["kimi", "Moonshot / Kimi"],
  ["zai", "Z.ai"],
  ["joey", "Joey Sterling"],
  ["chris", "Chris Schaaf"],
];
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify(
      {
        mode: "plan",
        leagueId,
        owners: owners.map(([id, name]) => ({ id, name })),
        inferenceEnabled: false,
        constitution: "unratified",
        secondHuman: "Chris Schaaf; Buzz identity and login pending",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const dir = resolve(process.env.FOOTBALL_PRIVATE_DIRECTORY ?? ".local/live");
await mkdir(dir, { recursive: true, mode: 0o700 });
const marker = join(dir, "bootstrap.started");
try {
  await access(marker);
  throw Error(
    "Bootstrap already attempted; inspect private state before resuming.",
  );
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const url =
  process.env.DATABASE_URL ??
  (
    await readFile(
      process.env.FOOTBALL_DATABASE_URL_FILE ??
        ".local/deploy/database-url.host",
      "utf8",
    )
  ).trim();
const db = createDb(url);
await migrate(db);
try {
  if ((await db.query("SELECT 1 FROM leagues LIMIT 1")).rowCount)
    throw Error("Live bootstrap requires an empty dedicated league database.");
  await writeFile(marker, new Date().toISOString(), {
    mode: 0o600,
    flag: "wx",
  });
  const commissioner = {
    id: "joey-commissioner",
    role: "commissioner" as const,
    leagueId,
  };
  const league = new LeagueService(db),
    runtime = new RuntimeStore(db);
  await league.execute(commissioner, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "live-bootstrap-v1",
    name: "Black4 Fantasy Football",
    rules: {
      rosterSize: 16,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [
        { id: "QB", positions: ["QB"] },
        { id: "RB1", positions: ["RB"] },
        { id: "RB2", positions: ["RB"] },
        { id: "WR1", positions: ["WR"] },
        { id: "WR2", positions: ["WR"] },
        { id: "TE", positions: ["TE"] },
        { id: "FLEX", positions: ["RB", "WR", "TE"] },
      ],
    },
    teams: owners.map(([id, name], i) => ({
      id: "b4-team-" + id,
      ownerId: "b4-owner-" + id,
      name: i < 10 ? name + " — awaiting owner identity" : name,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  const credentials: Record<string, unknown> = {
    commissioner: await issueCredential(db, commissioner),
  };
  for (const [[id], i] of owners.map((v, i) => [v, i] as const)) {
    const agentId = "b4-" + id,
      teamId = "b4-team-" + id;
    await runtime.createAgent({
      id: agentId,
      model: i < 10 ? "unactivated/" + id : "human/manual",
      budgetMicros: i < 10 ? 600000000 : 0,
      kind: i < 10 ? "ai" : "human",
    });
    await db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [agentId, leagueId, teamId],
    );
    if (i === 10)
      credentials.joey = await issueCredential(db, {
        id: "b4-owner-" + id,
        role: "owner",
        leagueId,
        teamId,
      });
    if (i < 10) {
      const config = {
        leagueId,
        agentId,
        teamId,
        communityUrl: "wss://black4fantasysports.communities.buzz.xyz",
        credentialDirectory: resolve(
          process.env.FOOTBALL_BUZZ_CREDENTIAL_DIRECTORY ??
            "/Users/joey/.local/share/black4-football/private/buzz",
        ),
        databaseEnvironmentVariable: "B4_LEAGUE_DATABASE_URL",
        bootstrapOnly: true,
      };
      await writeFile(
        join(dir, "buzz-" + id + ".json"),
        JSON.stringify(config, null, 2),
        { mode: 0o600, flag: "wx" },
      );
    }
  }
  await writeFile(
    join(dir, "owner-credentials.json"),
    JSON.stringify(credentials, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      leagueId,
      franchiseSeats: 12,
      AISeats: 10,
      humanAssigned: 2,
      humanUnassigned: 0,
      players: 0,
      votes: 0,
      providerCalls: 0,
      publicRelease: false,
      privateConfigDirectory: dir,
    }),
  );
} finally {
  await db.end();
}
