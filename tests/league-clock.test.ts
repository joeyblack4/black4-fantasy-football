import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, LeagueClock, type Actor } from "../src/league/index.js";
import { ratifySynthetic } from "./league-governance-fixture.js";
async function fixture(active = false) {
  const resource = await testDb(),
    leagueId = "synthetic-clock",
    service = new LeagueService(resource.db),
    clock = new LeagueClock(resource.db);
  const admin: Actor = { id: "clock-admin", role: "commissioner", leagueId },
    system: Actor = { id: "clock-worker", role: "system", leagueId };
  const owners = Array.from({ length: 12 }, (_, i): Actor => ({
    id: "owner-" + i,
    teamId: "team-" + i,
    role: "owner",
    leagueId,
  }));
  const execute = (actor: Actor, command: Record<string, unknown>) =>
    service.execute(actor, {
      leagueId,
      idempotencyKey: randomUUID(),
      ...command,
    });
  await execute(admin, {
    type: "createLeague",
    name: "SYNTHETIC clock rehearsal",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "WR", positions: ["WR"] }],
    },
    teams: owners.map((o, i) => ({
      id: o.teamId,
      ownerId: o.id,
      name: "Synthetic " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await execute(admin, {
    type: "importPlayers",
    players: Array.from({ length: 24 }, (_, i) => ({
      id: "p" + i,
      name: "Synthetic player " + i,
      positions: ["WR"],
    })),
  });
  await execute(admin, {
    type: "importSchedule",
    games: Array.from({ length: 24 }, (_, i) => ({
      playerId: "p" + i,
      week: 1,
      kickoffAt: new Date(Date.now() + 3600000).toISOString(),
      status: "scheduled",
    })),
  });
  await ratifySynthetic(resource.db, service, admin, owners);
  await execute(admin, { type: "startDraft" });
  if (active)
    for (let i = 0; i < 12; i++)
      await execute(owners[i], {
        type: "draftPick",
        expectedPick: i,
        playerId: "p" + i,
      });
  return {
    ...resource,
    leagueId,
    service,
    clock,
    admin,
    system,
    owners,
    execute,
  };
}
describe("trusted league clock — synthetic server deadlines", () => {
  it("does not advance future picks, resolves a deadline once, and safely handles concurrent ticks", async () => {
    const f = await fixture();
    try {
      await f.execute(f.owners[0], {
        type: "setDraftQueue",
        playerIds: ["p3", "p0"],
      });
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work,
      ).toEqual([]);
      // Set the synthetic deadline to database time exactly. No tick parameter accepts a clock.
      await f.db.query(
        "UPDATE leagues SET pick_deadline=clock_timestamp() WHERE id=$1",
        [f.leagueId],
      );
      const first = await f.clock.tick(f.system, { leagueId: f.leagueId });
      expect(first.work).toHaveLength(1);
      expect(first.work[0]).toMatchObject({
        kind: "draft",
        reference: "0",
        status: "applied",
      });
      expect(first.work[0].receipt!.result).toMatchObject({
        teamId: "team-0",
        playerId: "p3",
        automatic: true,
      });
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work,
      ).toEqual([]);
      await f.execute(f.owners[1], {
        type: "setDraftQueue",
        playerIds: ["p3", "p1"],
      });
      await f.db.query(
        "UPDATE leagues SET pick_deadline=clock_timestamp() WHERE id=$1",
        [f.leagueId],
      );
      const raced = await Promise.all([
        f.clock.tick(f.system, { leagueId: f.leagueId }),
        f.clock.tick(f.system, { leagueId: f.leagueId }),
      ]);
      expect(
        raced.flatMap((r) => r.work).filter((w) => w.status === "applied"),
      ).toHaveLength(1);
      expect((await f.service.snapshot(f.leagueId)).picks).toHaveLength(2);
      expect(
        Number(
          (
            await f.db.query(
              "SELECT count(*) FROM league_events WHERE type='autoDraftPick'",
            )
          ).rows[0].count,
        ),
      ).toBe(2);
      expect(
        (
          await f.db.query(
            "SELECT idempotency_key FROM league_command_receipts WHERE actor_id='clock-worker' ORDER BY idempotency_key",
          )
        ).rows.map((r) => r.idempotency_key),
      ).toEqual(["clock:draft:0:0", "clock:draft:1:0"]);
    } finally {
      await f.close();
    }
  });
  it("reports an exhausted owner queue without inventing a pick and recovers after the owner supplies one", async () => {
    const f = await fixture();
    try {
      await f.db.query(
        "UPDATE leagues SET pick_deadline=clock_timestamp() WHERE id=$1",
        [f.leagueId],
      );
      const tick = await f.clock.tick(f.system, {
        leagueId: f.leagueId,
        maxCommands: 1,
      });
      expect(tick.needsAttention).toBe(true);
      expect(tick.work).toMatchObject([
        {
          status: "paused",
          receipt: { result: { status: "paused", automatic: true } },
        },
      ]);
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work,
      ).toEqual([]);
      expect(
        (await f.service.snapshot(f.leagueId)).league.draft_paused_at,
      ).toBeInstanceOf(Date);
      expect((await f.service.snapshot(f.leagueId)).picks).toHaveLength(0);
      await f.execute(f.owners[0], {
        type: "setDraftQueue",
        playerIds: ["p7"],
      });
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work,
      ).toEqual([]);
      await f.execute(f.admin, {
        type: "resumeDraft",
        reason: "Owner supplied a replacement queue",
      });
      await f.db.query(
        "UPDATE leagues SET pick_deadline=clock_timestamp() WHERE id=$1",
        [f.leagueId],
      );
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work[0].status,
      ).toBe("applied");
      expect((await f.service.snapshot(f.leagueId)).league.draft_epoch).toBe(1);
      expect((await f.service.snapshot(f.leagueId)).picks[0].player_id).toBe(
        "p7",
      );
    } finally {
      await f.close();
    }
  });
  it("resolves due waivers once without early execution or duplicate FAAB debit", async () => {
    const f = await fixture(true);
    try {
      await f.execute(f.admin, {
        type: "openWaivers",
        periodId: "week-1",
        closesAt: new Date(Date.now() + 60000).toISOString(),
      });
      await f.execute(f.owners[0], {
        type: "submitClaim",
        claimId: "claim",
        periodId: "week-1",
        addPlayerId: "p12",
        dropPlayerId: "p0",
        bid: 60,
        priority: 0,
      });
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work,
      ).toEqual([]);
      await f.db.query(
        "UPDATE league_waiver_periods SET closes_at=clock_timestamp() WHERE league_id=$1",
        [f.leagueId],
      );
      const raced = await Promise.all([
        f.clock.tick(f.system, { leagueId: f.leagueId }),
        f.clock.tick(f.system, { leagueId: f.leagueId }),
      ]);
      expect(
        raced.flatMap((r) => r.work).filter((w) => w.status === "applied"),
      ).toHaveLength(1);
      expect(
        (await f.clock.tick(f.system, { leagueId: f.leagueId })).work,
      ).toEqual([]);
      const state = await f.service.snapshot(f.leagueId);
      expect(state.teams.find((t) => t.id === "team-0")!.faab).toBe(40);
      expect(state.rosters.find((r) => r.player_id === "p12")!.team_id).toBe(
        "team-0",
      );
      expect(state.waiverPeriods[0].status).toBe("resolved");
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
  it("rejects owner authority, foreign league scope, excessive work bounds and a supplied clock", async () => {
    const f = await fixture();
    try {
      await expect(
        f.clock.tick(f.owners[0], { leagueId: f.leagueId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        f.clock.tick(
          { ...f.system, leagueId: "foreign" },
          { leagueId: f.leagueId },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        f.clock.tick(f.system, { leagueId: f.leagueId, maxCommands: 1000 }),
      ).rejects.toMatchObject({ name: "ZodError" });
      await expect(
        f.clock.tick(f.system, {
          leagueId: f.leagueId,
          now: "2100-01-01T00:00:00Z",
        } as never),
      ).rejects.toMatchObject({ name: "ZodError" });
    } finally {
      await f.close();
    }
  });
});
