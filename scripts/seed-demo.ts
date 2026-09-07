import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createDb, migrate } from "../src/db.js";
import {
  LeagueService,
  draftPosition,
  type Actor,
} from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { issueCredential } from "../src/auth.js";
import { ratifySynthetic } from "../tests/league-governance-fixture.js";
import { ScoreboardService, roundRobin } from "../src/scoring/index.js";
import { StatsService } from "../src/data/index.js";
import { syntheticCompleteStats } from "../src/data/fixtures.js";

const db = createDb();
await migrate(db);
try {
  const leagueId = "synthetic-demo-2026",
    service = new LeagueService(db),
    runtime = new RuntimeStore(db);
  const commissioner: Actor = {
    id: "demo-commissioner",
    role: "commissioner",
    leagueId,
  };
  const providers = [
    "OpenAI",
    "Anthropic",
    "Google",
    "xAI",
    "Meta",
    "DeepSeek",
    "Qwen",
    "Mistral",
    "Kimi",
    "Z.ai",
    "Human one",
    "Human two",
  ];
  const owners = providers.map((name, i) => ({
    id: `demo-owner-${i + 1}`,
    role: "owner" as const,
    leagueId,
    teamId: `demo-team-${String(i + 1).padStart(2, "0")}`,
  }));
  const exists = (
    await db.query("SELECT 1 FROM leagues WHERE id=$1", [leagueId])
  ).rowCount;
  if (!exists) {
    const command = (actor: Actor, input: Record<string, unknown>) =>
      service.execute(actor, {
        leagueId,
        idempotencyKey:
          "seed:" +
          input.type +
          ":" +
          (input.expectedPick ?? input.week ?? input.playerId ?? actor.id),
        ...input,
      });
    await command(commissioner, {
      type: "createLeague",
      name: "Black4 Fantasy Football · Synthetic rehearsal",
      rules: {
        rosterSize: 3,
        draftOrder: "snake",
        draftPickSeconds: 60,
        faabBudget: 100,
        lineupSlots: [{ id: "FLEX", positions: ["RB", "WR", "TE"] }],
      },
      teams: owners.map((o, i) => ({
        id: o.teamId,
        ownerId: o.id,
        name: providers[i] + " · test franchise",
        kind: i < 10 ? "ai" : "human",
      })),
    });
    const players = Array.from({ length: 60 }, (_, i) => ({
      id: `SYNTHETIC-P-${String(i + 1).padStart(3, "0")}`,
      name: `Synthetic player ${i + 1}`,
      positions: [["RB", "WR", "TE"][i % 3]],
    }));
    await command(commissioner, { type: "importPlayers", players });
    await command(commissioner, {
      type: "importSchedule",
      games: players.map((p) => ({
        playerId: p.id,
        week: 1,
        kickoffAt: "2050-09-09T00:00:00.000Z",
        status: "scheduled",
      })),
    });
    const demoScoringRules = {
      version: "synthetic-scoring-v1",
      milliPointsPerUnit: {
        receivingYards: 100,
        receptions: 500,
        receivingTouchdowns: 6000,
      },
    };
    await ratifySynthetic(
      db,
      service,
      commissioner,
      owners,
      undefined,
      demoScoringRules,
    );
    await new ScoreboardService(db).configure(commissioner, {
      leagueId,
      week: 1,
      feedId: "synthetic-fixture-v1",
      rules: demoScoringRules,
      matchups: roundRobin(owners.map((o) => o.teamId))[0],
      playerGames: players.map((p) => ({
        playerId: p.id,
        gameId: "SYNTHETIC-GAME-1",
      })),
    });
    const stats = new StatsService(db);
    for (let i = 0; i < players.length; i++)
      await stats.ingest({
        feedId: "synthetic-fixture-v1",
        gameId: "SYNTHETIC-GAME-1",
        playerId: players[i].id,
        revision: 1,
        sourceAt: new Date().toISOString(),
        gameStatus: "live",
        synthetic: true,
        stats: {
          ...syntheticCompleteStats,
          receivingYards: 10 + i * 3,
          receptions: i % 6,
          receivingTouchdowns: i % 2,
        },
      });
    for (const owner of owners)
      await command(owner, {
        type: "setDraftQueue",
        playerIds: players.map((p) => p.id),
      });
    await command(commissioner, { type: "startDraft" });
    for (let pick = 0; pick < 36; pick++)
      await command(owners[draftPosition(pick, 12, "snake")], {
        type: "draftPick",
        expectedPick: pick,
        playerId: players[pick].id,
      });
    const state = await service.snapshot(leagueId, commissioner);
    for (const owner of owners)
      await command(owner, {
        type: "setLineup",
        week: 1,
        slots: {
          FLEX: state.rosters.find((r: any) => r.team_id === owner.teamId)!
            .player_id,
        },
      });
  }
  for (const owner of owners) {
    await runtime.createAgent({
      id: owner.teamId,
      kind: owners.indexOf(owner) < 10 ? "ai" : "human",
      model: "synthetic/test",
      budgetMicros: 600000000,
    });
    await db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$1) ON CONFLICT DO NOTHING",
      [owner.teamId, leagueId],
    );
  }
  // No human owner is impersonated by a worker: only the first two AI test identities get jobs.
  await runtime.ingestEvent({
    agentId: owners[0].teamId,
    causalId: "synthetic-opening-review",
    payload: { scenario: "opening-review", peer: owners[1].teamId },
    sourceOccurredAt: "2026-09-07T00:00:00.000Z",
  });
  const localDir = process.env.FOOTBALL_LOCAL_DIR ?? ".local";
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  let existing: any = {};
  try {
    existing = JSON.parse(
      await readFile(localDir + "/credentials.json", "utf8"),
    );
  } catch {}
  for (const actor of [commissioner, ...owners])
    if (!existing[actor.id])
      existing[actor.id] = await issueCredential(db, actor);
  await writeFile(
    localDir + "/credentials.json",
    JSON.stringify(existing, null, 2),
    { mode: 0o600 },
  );
  console.log(
    "Synthetic 12-team rehearsal seeded; 36 picks and 12 lineups. No real players or model calls.",
  );
  console.log(
    "Credentials saved in the configured local directory (excluded from git). No tokens printed.",
  );
} finally {
  await db.end();
}
