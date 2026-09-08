import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ratifySynthetic } from "./league-governance-fixture.js";
import { testDb } from "./helpers.js";
import {
  LeagueService,
  draftPosition,
  type Actor,
  type LeagueCommand,
  LeagueError,
} from "../src/league/index.js";

async function fixture(
  active = false,
  rosterSize = 2,
  freeAgentMode = "waiversOnly",
  ruleOverrides: Record<string, unknown> = {},
) {
  const resource = await testDb(),
    service = new LeagueService(resource.db),
    leagueId = "synthetic-test-league";
  const commissioner: Actor = {
    id: "commissioner",
    leagueId,
    role: "commissioner",
  };
  const owners = Array.from({ length: 12 }, (_, i): Actor => ({
    id: `owner-${i}`,
    teamId: `team-${i}`,
    leagueId,
    role: "owner",
  }));
  const command = async (
    actor: Actor,
    body:
      | Omit<LeagueCommand, "leagueId" | "idempotencyKey">
      | Record<string, unknown>,
    key: string = randomUUID(),
  ) => service.execute(actor, { leagueId, idempotencyKey: key, ...body });
  await command(commissioner, {
    type: "createLeague",
    name: "SYNTHETIC TEST — no live NFL data",
    rules: {
      rosterSize,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      ...ruleOverrides,
      freeAgentMode,
      lineupSlots: [{ id: "FLEX", positions: ["RB", "WR", "TE"] }],
    },
    teams: owners.map((o, i) => ({
      id: o.teamId!,
      ownerId: o.id,
      name: `Synthetic ${i}`,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await command(commissioner, {
    type: "importPlayers",
    players: Array.from({ length: 48 }, (_, i) => ({
      id: `p${i}`,
      name: `Synthetic Player ${i}`,
      positions: i === 47 ? ["QB"] : ["RB"],
    })),
  });
  await command(commissioner, {
    type: "importSchedule",
    games: Array.from({ length: 48 }, (_, i) => ({
      playerId: `p${i}`,
      week: 1,
      kickoffAt: new Date(Date.now() + 3600000).toISOString(),
      status: "scheduled",
    })),
  });
  await code(
    command(commissioner, { type: "startDraft" }),
    "CONSTITUTION_UNRATIFIED",
  );
  await ratifySynthetic(resource.db, service, commissioner, owners);
  await command(commissioner, { type: "startDraft" });
  if (active)
    for (let i = 0; i < 12 * rosterSize; i++)
      await command(owners[draftPosition(i, 12, "snake")], {
        type: "draftPick",
        expectedPick: i,
        playerId: `p${i}`,
      });
  return { ...resource, service, leagueId, commissioner, owners, command };
}
async function code(p: Promise<unknown>, expected: string) {
  await expect(p).rejects.toMatchObject({
    name: "LeagueError",
    code: expected,
  });
}

describe("PostgreSQL authoritative league commands — synthetic fixtures", () => {
  it("enforces 12-team snake order and serializes competing picks with durable replay", async () => {
    const f = await fixture();
    try {
      expect(
        Array.from({ length: 25 }, (_, i) => draftPosition(i, 12, "snake")),
      ).toEqual([
        ...Array.from({ length: 12 }, (_, i) => i),
        ...Array.from({ length: 12 }, (_, i) => 11 - i),
        0,
      ]);
      await code(
        f.command(f.owners[1], {
          type: "draftPick",
          expectedPick: 0,
          playerId: "p1",
        }),
        "NOT_YOUR_TURN",
      );
      const results = await Promise.allSettled([
        f.command(
          f.owners[0],
          { type: "draftPick", expectedPick: 0, playerId: "p0" },
          "race-a",
        ),
        f.command(
          f.owners[0],
          { type: "draftPick", expectedPick: 0, playerId: "p1" },
          "race-b",
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await f.service.snapshot(f.leagueId)).rosters).toHaveLength(1);
      const winner = results.findIndex((r) => r.status === "fulfilled");
      const replay = await new LeagueService(f.db).execute(f.owners[0], {
        leagueId: f.leagueId,
        idempotencyKey: winner === 0 ? "race-a" : "race-b",
        type: "draftPick",
        expectedPick: 0,
        playerId: winner === 0 ? "p0" : "p1",
      });
      expect(replay.replayed).toBe(true);
      await code(
        f.command(
          f.owners[0],
          { type: "draftPick", expectedPick: 1, playerId: "p2" },
          winner === 0 ? "race-a" : "race-b",
        ),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(
        Number(
          (
            await f.db.query(
              "SELECT count(*) FROM league_events WHERE type='draftPick'",
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await f.db.query(
              "SELECT count(*) FROM league_command_receipts WHERE response IS NULL",
            )
          ).rows[0].count,
        ),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("checks persisted ownership and league scope; strips no authority-bearing extra fields", async () => {
    const f = await fixture();
    try {
      await code(
        f.command(
          { ...f.owners[0], teamId: "team-1" },
          { type: "draftPick", expectedPick: 0, playerId: "p0" },
        ),
        "FORBIDDEN",
      );
      await code(
        f.command(
          { ...f.commissioner, leagueId: "another-league" },
          {
            type: "importPlayers",
            players: [{ id: "evil", name: "Evil", positions: ["RB"] }],
          },
        ),
        "FORBIDDEN",
      );
      await expect(
        f.command(f.owners[0], {
          type: "draftPick",
          expectedPick: 0,
          playerId: "p0",
          actor: f.commissioner,
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
      await code(
        f.command(f.owners[0], { type: "autoDraftPick", expectedPick: 0 }),
        "FORBIDDEN",
      );
      await code(
        f.command(f.owners[0], {
          type: "importPlayers",
          players: [{ id: "evil", name: "Evil", positions: ["RB"] }],
        }),
        "FORBIDDEN",
      );
    } finally {
      await f.close();
    }
  });
  it("auto-picks only from a persisted owner-authored queue after server deadline", async () => {
    const f = await fixture();
    try {
      await f.command(f.owners[0], {
        type: "setDraftQueue",
        playerIds: ["p7", "p3"],
      });
      await code(
        f.command(f.commissioner, { type: "autoDraftPick", expectedPick: 0 }),
        "NOT_DUE",
      );
      expect((await f.service.snapshot(f.leagueId)).draftQueues).toEqual([]);
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[0])).draftQueues[0]
          .player_ids,
      ).toEqual(["p7", "p3"]);
      // Explicitly age the synthetic fixture's deadline; no clock is accepted by a command.
      await f.db.query(
        "UPDATE leagues SET pick_deadline=clock_timestamp()-interval '1 second'",
      );
      await code(
        f.command(f.owners[0], {
          type: "draftPick",
          expectedPick: 0,
          playerId: "p3",
        }),
        "PICK_EXPIRED",
      );
      const picked = await f.command(f.commissioner, {
        type: "autoDraftPick",
        expectedPick: 0,
      });
      expect(picked.result).toMatchObject({
        playerId: "p7",
        teamId: "team-0",
        automatic: true,
      });
      await f.db.query(
        "UPDATE leagues SET pick_deadline=clock_timestamp()-interval '1 second'",
      );
      const paused = await f.command(f.commissioner, {
        type: "autoDraftPick",
        expectedPick: 1,
      });
      expect(paused.result).toMatchObject({
        status: "paused",
        automatic: true,
        nextPick: 1,
      });
      expect(
        (await f.service.snapshot(f.leagueId)).league.draft_paused_at,
      ).toBeInstanceOf(Date);
    } finally {
      await f.close();
    }
  });
  it("locks both outgoing and incoming lineup players at their own kickoff and freezes slot moves", async () => {
    const f = await fixture(true);
    try {
      await f.command(f.owners[0], {
        type: "setLineup",
        week: 1,
        slots: { FLEX: "p0" },
      });
      await code(
        f.command(f.owners[1], {
          type: "setLineup",
          week: 1,
          slots: { FLEX: "p0" },
        }),
        "OWNERSHIP_CONFLICT",
      );
      await f.command(f.commissioner, {
        type: "importSchedule",
        games: [
          {
            playerId: "p0",
            week: 1,
            kickoffAt: new Date(Date.now() - 10000).toISOString(),
            status: "scheduled",
          },
        ],
      });
      await code(
        f.command(f.owners[0], {
          type: "setLineup",
          week: 1,
          slots: { FLEX: "p23" },
        }),
        "PLAYER_LOCKED",
      );
      await code(
        f.command(f.owners[0], { type: "setLineup", week: 1, slots: {} }),
        "PLAYER_LOCKED",
      );
      // An identical lineup remains a safe no-op even after kickoff.
      await f.command(f.owners[0], {
        type: "setLineup",
        week: 1,
        slots: { FLEX: "p0" },
      });
      await code(
        f.command(f.commissioner, {
          type: "importSchedule",
          games: [
            {
              playerId: "p0",
              week: 1,
              kickoffAt: new Date(Date.now() + 100000).toISOString(),
              status: "scheduled",
            },
          ],
        }),
        "LOCK_REGRESSION",
      );
      await code(
        f.command(f.owners[0], {
          type: "setLineup",
          week: 2,
          slots: { FLEX: "p23" },
        }),
        "UNKNOWN_GAME_TIME",
      );
      expect((await f.service.snapshot(f.leagueId)).lineups).toMatchObject([
        { team_id: "team-0", player_id: "p0" },
      ]);
      await f.command(f.commissioner, {
        type: "importSchedule",
        games: [
          {
            playerId: "p1",
            week: 1,
            kickoffAt: new Date(Date.now() - 10000).toISOString(),
            status: "scheduled",
          },
        ],
      });
      await code(
        f.command(f.owners[1], {
          type: "setLineup",
          week: 1,
          slots: { FLEX: "p1" },
        }),
        "PLAYER_LOCKED",
      );
    } finally {
      await f.close();
    }
  });
  it("commits exactly one of two competing accepted trades and hides unaccepted offers", async () => {
    const f = await fixture(true);
    try {
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      await f.command(f.owners[0], {
        type: "proposeTrade",
        tradeId: "trade-a",
        toTeamId: "team-1",
        givePlayers: ["p0"],
        receivePlayers: ["p1"],
        expiresAt,
      });
      await f.command(f.owners[0], {
        type: "proposeTrade",
        tradeId: "trade-b",
        toTeamId: "team-2",
        givePlayers: ["p0"],
        receivePlayers: ["p2"],
        expiresAt,
      });
      expect((await f.service.snapshot(f.leagueId)).trades).toHaveLength(0);
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[1])).trades,
      ).toHaveLength(1);
      await code(
        f.command(f.owners[3], { type: "acceptTrade", tradeId: "trade-a" }),
        "FORBIDDEN",
      );
      const accepted = await Promise.allSettled([
        f.command(f.owners[1], { type: "acceptTrade", tradeId: "trade-a" }),
        f.command(f.owners[2], { type: "acceptTrade", tradeId: "trade-b" }),
      ]);
      expect(accepted.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const state = await f.service.snapshot(f.leagueId);
      expect(state.trades).toHaveLength(1);
      expect(state.rosters).toHaveLength(24);
      expect(new Set(state.rosters.map((r) => r.player_id)).size).toBe(24);
      for (const team of state.teams)
        expect(state.rosters.filter((r) => r.team_id === team.id)).toHaveLength(
          2,
        );
      expect(state.rosters.find((r) => r.player_id === "p0")!.team_id).not.toBe(
        "team-0",
      );
    } finally {
      await f.close();
    }
  });
  it("rechecks trade expiration, player locks, and roster capacity at acceptance", async () => {
    const f = await fixture(true);
    try {
      const expiresAt = new Date(Date.now() + 60000).toISOString();
      await f.command(f.owners[0], {
        type: "proposeTrade",
        tradeId: "size",
        toTeamId: "team-1",
        givePlayers: ["p0", "p23"],
        receivePlayers: ["p1"],
        expiresAt,
      });
      await code(
        f.command(f.owners[1], { type: "acceptTrade", tradeId: "size" }),
        "ROSTER_FULL",
      );
      await f.command(f.owners[0], {
        type: "proposeTrade",
        tradeId: "lock",
        toTeamId: "team-1",
        givePlayers: ["p0"],
        receivePlayers: ["p1"],
        expiresAt,
      });
      await f.command(f.commissioner, {
        type: "importSchedule",
        games: [
          {
            playerId: "p1",
            week: 1,
            kickoffAt: new Date(Date.now() - 10000).toISOString(),
            status: "scheduled",
          },
        ],
      });
      await code(
        f.command(f.owners[1], { type: "acceptTrade", tradeId: "lock" }),
        "PLAYER_LOCKED",
      );
      await f.db.query(
        "UPDATE league_trades SET expires_at=clock_timestamp()-interval '1 second' WHERE id='lock'",
      );
      await code(
        f.command(f.owners[1], { type: "acceptTrade", tradeId: "lock" }),
        "EXPIRED",
      );
      expect((await f.service.snapshot(f.leagueId)).trades).toHaveLength(0);
      expect(
        (await f.service.snapshot(f.leagueId)).rosters.find(
          (r) => r.player_id === "p0",
        )!.team_id,
      ).toBe("team-0");
    } finally {
      await f.close();
    }
  });
  it("resolves FAAB ties deterministically, never overspends, and serializes resolver races", async () => {
    const f = await fixture(true);
    try {
      await f.command(f.commissioner, {
        type: "openWaivers",
        periodId: "week1",
        closesAt: new Date(Date.now() + 60000).toISOString(),
      });
      await f.command(f.owners[0], {
        type: "submitClaim",
        claimId: "tie-low",
        periodId: "week1",
        addPlayerId: "p24",
        dropPlayerId: "p0",
        bid: 30,
        priority: 0,
      });
      await f.command(f.owners[11], {
        type: "submitClaim",
        claimId: "tie-high",
        periodId: "week1",
        addPlayerId: "p24",
        dropPlayerId: "p11",
        bid: 30,
        priority: 0,
      });
      await f.command(f.owners[10], {
        type: "submitClaim",
        claimId: "expensive-first",
        periodId: "week1",
        addPlayerId: "p25",
        dropPlayerId: "p10",
        bid: 70,
        priority: 0,
      });
      await f.command(f.owners[10], {
        type: "submitClaim",
        claimId: "expensive-second",
        periodId: "week1",
        addPlayerId: "p26",
        dropPlayerId: "p13",
        bid: 70,
        priority: 1,
      });
      expect((await f.service.snapshot(f.leagueId)).claims).toHaveLength(0);
      const ownerView = await f.service.snapshot(f.leagueId, f.owners[0]);
      expect(ownerView.claims).toHaveLength(1);
      expect(ownerView.claims[0].id).toBe("tie-low");
      expect(ownerView.waiverPeriods).toEqual([
        {
          id: "week1",
          closes_at: expect.any(Date),
          status: "open",
          accepting_claims: true,
          resolution_due: false,
        },
      ]);
      expect((await f.service.snapshot(f.leagueId)).waiverPeriods).toEqual(
        ownerView.waiverPeriods,
      );
      expect(ownerView.checkedAt).toEqual(expect.any(String));
      await code(
        f.command(f.commissioner, {
          type: "resolveWaivers",
          periodId: "week1",
        }),
        "NOT_DUE",
      );
      await f.db.query(
        "UPDATE league_waiver_periods SET closes_at=clock_timestamp()-interval '1 second'",
      );
      await code(
        f.command(f.owners[0], { type: "cancelClaim", claimId: "tie-low" }),
        "WAIVERS_CLOSED",
      );
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[1])).waiverPeriods[0],
      ).toMatchObject({
        id: "week1",
        status: "open",
        accepting_claims: false,
        resolution_due: true,
      });
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[1])).claims,
      ).toHaveLength(0);
      const resolved = await Promise.allSettled([
        f.command(
          f.commissioner,
          { type: "resolveWaivers", periodId: "week1" },
          "resolve-a",
        ),
        f.command(
          f.commissioner,
          { type: "resolveWaivers", periodId: "week1" },
          "resolve-b",
        ),
      ]);
      expect(resolved.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const state = await f.service.snapshot(f.leagueId);
      expect(state.claims).toHaveLength(2);
      expect(state.waiverPeriods[0]).toMatchObject({
        status: "resolved",
        accepting_claims: false,
        resolution_due: false,
      });
      expect(state.rosters.find((r) => r.player_id === "p24")!.team_id).toBe(
        "team-11",
      );
      expect(state.rosters.find((r) => r.player_id === "p25")!.team_id).toBe(
        "team-10",
      );
      expect(state.rosters.some((r) => r.player_id === "p26")).toBe(false);
      expect(state.teams.find((t) => t.id === "team-10")!.faab).toBe(30);
      expect(state.teams.find((t) => t.id === "team-11")!.faab).toBe(70);
      expect(state.rosters).toHaveLength(24);
      const mine = await f.service.snapshot(f.leagueId, f.owners[10]);
      expect(
        mine.claims.find((c) => c.id === "expensive-second"),
      ).toMatchObject({ status: "lost", reason: "INSUFFICIENT_FAAB" });
      expect(
        Number(
          (
            await f.db.query(
              "SELECT count(*) FROM league_events WHERE type='resolveWaivers'",
            )
          ).rows[0].count,
        ),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("atomically arbitrates first-come races within an authorized server-timed window", async () => {
    const f = await fixture(true, 2, "scheduledFirstCome");
    try {
      await f.command(f.commissioner, {
        type: "openFreeAgency",
        windowId: "open",
        opensAt: new Date(Date.now() - 1000).toISOString(),
        closesAt: new Date(Date.now() + 60000).toISOString(),
      });
      await code(
        f.command(f.commissioner, {
          type: "openWaivers",
          periodId: "overlap",
          closesAt: new Date(Date.now() + 60000).toISOString(),
        }),
        "WINDOW_CONFLICT",
      );
      const available = (await f.service.snapshot(f.leagueId, f.owners[0]))
        .freeAgentWindows;
      expect(available).toEqual([
        {
          id: "open",
          opens_at: expect.any(Date),
          closes_at: expect.any(Date),
          state: "open",
        },
      ]);
      const race = await Promise.allSettled([
        f.command(f.owners[0], {
          type: "addFreeAgent",
          windowId: "open",
          addPlayerId: "p24",
          dropPlayerId: "p0",
        }),
        f.command(f.owners[1], {
          type: "addFreeAgent",
          windowId: "open",
          addPlayerId: "p24",
          dropPlayerId: "p1",
        }),
      ]);
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const state = await f.service.snapshot(f.leagueId);
      expect(state.rosters).toHaveLength(24);
      expect(state.rosters.filter((r) => r.player_id === "p24")).toHaveLength(
        1,
      );
      const losingPlayer = race[0].status === "fulfilled" ? "p1" : "p0";
      expect(state.rosters.some((r) => r.player_id === losingPlayer)).toBe(
        true,
      );
      await f.db.query(
        "UPDATE league_free_agent_windows SET opens_at=clock_timestamp()-interval '2 seconds',closes_at=clock_timestamp()-interval '1 second'",
      );
      await code(
        f.command(f.owners[0], {
          type: "addFreeAgent",
          windowId: "open",
          addPlayerId: "p25",
          dropPlayerId: "p23",
        }),
        "WINDOW_CLOSED",
      );
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[0])).freeAgentWindows[0]
          .state,
      ).toBe("closed");
    } finally {
      await f.close();
    }
  });
  it("fails closed for missing game times but permits explicit bye records", async () => {
    const f = await fixture(true);
    try {
      await f.command(f.commissioner, {
        type: "importSchedule",
        games: [
          {
            playerId: "p0",
            week: 1,
            kickoffAt: new Date(Date.now() - 10000).toISOString(),
            status: "bye",
          },
        ],
      });
      await f.command(f.owners[0], {
        type: "setLineup",
        week: 1,
        slots: { FLEX: "p0" },
      });
      await code(
        f.command(f.commissioner, {
          type: "openFreeAgency",
          windowId: "forbidden",
          opensAt: new Date(Date.now() - 1000).toISOString(),
          closesAt: new Date(Date.now() + 60000).toISOString(),
        }),
        "RULES_FORBID",
      );
      await code(
        f.command(
          { ...f.commissioner, role: "system" },
          {
            type: "ratifyConstitution",
            version: "v2",
            decisionReceipt: "not-a-vote",
          },
        ),
        "FORBIDDEN",
      );
      await code(
        f.command(f.commissioner, {
          type: "ratifyConstitution",
          version: "v2",
          decisionReceipt: "not-a-vote",
        }),
        "RULES_FROZEN",
      );
      const state = await f.service.snapshot(f.leagueId);
      expect(state.league.constitution_version).toBe("synthetic-v1");
      expect(state.league.constitution_rules_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await f.close();
    }
  });

  it("keeps rejected-trade events visible to both participants and no unrelated owners", async () => {
    const f = await fixture(true);
    try {
      await f.command(f.owners[0], {
        type: "proposeTrade",
        tradeId: "rejected",
        toTeamId: "team-1",
        givePlayers: ["p0"],
        receivePlayers: ["p1"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      await f.command(f.owners[1], {
        type: "rejectTrade",
        tradeId: "rejected",
      });
      const event = (
        await f.db.query(
          "SELECT visibility,participant_team_ids FROM league_events WHERE type='rejectTrade'",
        )
      ).rows[0];
      expect(event.visibility).toBe("private");
      expect([...event.participant_team_ids].sort()).toEqual([
        "team-0",
        "team-1",
      ]);
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[2])).trades,
      ).toHaveLength(0);
      expect(
        (await f.service.snapshot(f.leagueId, f.owners[0])).trades[0].status,
      ).toBe("rejected");
    } finally {
      await f.close();
    }
  });
  it("preserves historic lineups across a completed-week transition and blocks incomplete weeks", async () => {
    const f = await fixture(true);
    try {
      await f.command(f.owners[0], {
        type: "setLineup",
        week: 1,
        slots: { FLEX: "p0" },
      });
      await code(
        f.command(f.commissioner, { type: "advanceWeek", week: 2 }),
        "GAMES_NOT_FINAL",
      );
      await f.command(f.commissioner, {
        type: "importSchedule",
        games: Array.from({ length: 48 }, (_, i) => ({
          playerId: `p${i}`,
          week: 1,
          kickoffAt: new Date(Date.now() - 10000).toISOString(),
          status: "final",
        })),
      });
      await f.command(f.commissioner, { type: "advanceWeek", week: 2 });
      await code(
        f.command(f.owners[0], { type: "setLineup", week: 1, slots: {} }),
        "PAST_WEEK",
      );
      const state = await f.service.snapshot(f.leagueId);
      expect(state.league.current_week).toBe(2);
      expect(state.lineups[0]).toMatchObject({ week: 1, player_id: "p0" });
    } finally {
      await f.close();
    }
  });
  it("supports commissioner pause/resume with receipts, remaining time and stale-epoch rejection", async () => {
    const f = await fixture();
    try {
      await code(
        f.command(f.owners[0], {
          type: "pauseDraft",
          reason: "Owner cannot pause the league",
        }),
        "FORBIDDEN",
      );
      await code(
        f.command(
          { ...f.commissioner, role: "system" },
          { type: "pauseDraft", reason: "System cannot manually pause" },
        ),
        "FORBIDDEN",
      );
      const paused = await f.command(
        f.commissioner,
        { type: "pauseDraft", reason: "Commissioner technical interruption" },
        "pause-once",
      );
      expect(paused.result).toMatchObject({
        status: "paused",
        automatic: false,
      });
      expect(Number(paused.result.remainingMs)).toBeGreaterThan(0);
      await code(
        f.command(f.owners[0], {
          type: "draftPick",
          expectedPick: 0,
          playerId: "p0",
        }),
        "DRAFT_PAUSED",
      );
      expect(
        (
          await f.command(
            f.commissioner,
            {
              type: "pauseDraft",
              reason: "Commissioner technical interruption",
            },
            "pause-once",
          )
        ).replayed,
      ).toBe(true);
      const resumed = await f.command(f.commissioner, {
        type: "resumeDraft",
        reason: "Commissioner verified recovery",
      });
      expect(resumed.result).toMatchObject({
        status: "drafting",
        draftEpoch: 1,
      });
      await code(
        f.command(f.owners[0], {
          type: "draftPick",
          expectedPick: 0,
          expectedDraftEpoch: 0,
          playerId: "p0",
        }),
        "STALE_DRAFT_EPOCH",
      );
      await f.command(f.owners[0], {
        type: "draftPick",
        expectedPick: 0,
        expectedDraftEpoch: 1,
        playerId: "p0",
      });
      const state = await f.service.snapshot(f.leagueId);
      expect(state.picks).toHaveLength(1);
      expect(state.league.draft_paused_at).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("enforces ratified trade deadlines on proposals and acceptance while allowing offer cancellation", async () => {
    const f = await fixture(true, 2, "waiversOnly", {
      tradeDeadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    try {
      await f.command(f.owners[0], {
        type: "proposeTrade",
        tradeId: "deadline",
        toTeamId: "team-1",
        givePlayers: ["p0"],
        receivePlayers: ["p1"],
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });
      // Synthetic fixture clock boundary, not a commissioner rule-edit command.
      await f.db.query(
        "UPDATE leagues SET rules=jsonb_set(rules,'{tradeDeadlineAt}',to_jsonb((clock_timestamp()-interval '1 second')::text))",
      );
      await code(
        f.command(f.owners[1], { type: "acceptTrade", tradeId: "deadline" }),
        "TRADE_DEADLINE_PASSED",
      );
      await code(
        f.command(f.owners[2], {
          type: "proposeTrade",
          tradeId: "late",
          toTeamId: "team-3",
          givePlayers: ["p2"],
          receivePlayers: ["p3"],
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        "TRADE_DEADLINE_PASSED",
      );
      await f.command(f.owners[0], {
        type: "cancelTrade",
        tradeId: "deadline",
      });
      expect(
        (await f.service.snapshot(f.leagueId)).rosters.find(
          (r) => r.player_id === "p0",
        )!.team_id,
      ).toBe("team-0");
    } finally {
      await f.close();
    }
  });
  it("holds newly dropped players against immediate first-come acquisition without partial roster loss", async () => {
    const f = await fixture(true, 2, "scheduledFirstCome", {
      droppedPlayerHoldHours: 24,
    });
    try {
      await f.command(f.commissioner, {
        type: "openFreeAgency",
        windowId: "holds",
        opensAt: new Date(Date.now() - 1000).toISOString(),
        closesAt: new Date(Date.now() + 60000).toISOString(),
      });
      await f.command(f.owners[0], {
        type: "addFreeAgent",
        windowId: "holds",
        addPlayerId: "p24",
        dropPlayerId: "p0",
      });
      const state = await f.service.snapshot(f.leagueId, f.owners[1]);
      expect(state.playerHolds).toMatchObject([
        {
          player_id: "p0",
          dropping_team_id: "team-0",
          reason: "free_agent_drop",
        },
      ]);
      await code(
        f.command(f.owners[1], {
          type: "addFreeAgent",
          windowId: "holds",
          addPlayerId: "p0",
          dropPlayerId: "p1",
        }),
        "PLAYER_ON_HOLD",
      );
      expect(
        (await f.service.snapshot(f.leagueId)).rosters.find(
          (r) => r.player_id === "p1",
        )!.team_id,
      ).toBe("team-1");
      await f.db.query(
        "UPDATE league_player_holds SET expires_at=clock_timestamp()-interval '1 second'",
      );
      await f.command(f.owners[1], {
        type: "addFreeAgent",
        windowId: "holds",
        addPlayerId: "p0",
        dropPlayerId: "p1",
      });
      expect(
        (await f.service.snapshot(f.leagueId)).rosters.find(
          (r) => r.player_id === "p0",
        )!.team_id,
      ).toBe("team-1");
    } finally {
      await f.close();
    }
  });
});
