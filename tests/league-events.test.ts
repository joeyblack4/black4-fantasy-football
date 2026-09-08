import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import {
  LeagueService,
  LeagueEventDispatcher,
  type Actor,
} from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { ratifySynthetic } from "./league-governance-fixture.js";
async function fixture() {
  const h = await testDb(),
    leagueId = "synthetic-events",
    service = new LeagueService(h.db),
    runtime = new RuntimeStore(h.db),
    dispatcher = new LeagueEventDispatcher(h.db);
  const admin: Actor = { id: "admin", role: "commissioner", leagueId };
  const owners = Array.from({ length: 12 }, (_, i): Actor => ({
    id: "owner-" + i,
    teamId: "team-" + i,
    role: "owner",
    leagueId,
  }));
  const exec = (actor: Actor, c: Record<string, unknown>) =>
    service.execute(actor, { leagueId, idempotencyKey: randomUUID(), ...c });
  const teams = owners.map((o, i) => ({
    id: o.teamId,
    ownerId: o.id,
    name: "Synthetic " + i,
    kind: i < 10 ? "ai" : "human",
  }));
  const rules = {
    rosterSize: 1,
    draftOrder: "snake",
    draftPickSeconds: 60,
    faabBudget: 100,
    lineupSlots: [{ id: "WR", positions: ["WR"] }],
  };
  await exec(admin, {
    type: "createLeague",
    name: "Synthetic event test",
    rules,
    teams,
  });
  await service.execute(
    { ...admin, leagueId: "foreign" },
    {
      type: "createLeague",
      leagueId: "foreign",
      idempotencyKey: "foreign-create",
      name: "Synthetic other league",
      rules,
      teams,
    },
  );
  for (const [i, owner] of owners.entries()) {
    await runtime.createAgent({
      id: "agent-" + i,
      kind: i < 10 ? "ai" : "human",
      model: "SYNTHETIC/fixture",
      budgetMicros: 1000000,
    });
    await h.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent-" + i, leagueId, owner.teamId],
    );
  }
  await runtime.createAgent({
    id: "foreign-agent",
    model: "SYNTHETIC/fixture",
    budgetMicros: 1000000,
  });
  await h.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES('foreign-agent','foreign','team-0')",
  );
  await exec(admin, {
    type: "importPlayers",
    players: Array.from({ length: 24 }, (_, i) => ({
      id: "p" + i,
      name: "Synthetic " + i,
      positions: ["WR"],
    })),
  });
  await exec(admin, {
    type: "importSchedule",
    games: Array.from({ length: 24 }, (_, i) => ({
      playerId: "p" + i,
      week: 1,
      kickoffAt: new Date(Date.now() + 3600000).toISOString(),
      status: "scheduled",
    })),
  });
  await ratifySynthetic(h.db, service, admin, owners);
  return { ...h, leagueId, service, runtime, dispatcher, admin, owners, exec };
}
describe("committed league events to durable scoped owner wakeups", () => {
  it("delivers a committed draft pick to exactly the same league once across competing dispatchers", async () => {
    const f = await fixture();
    try {
      await f.exec(f.admin, { type: "startDraft" });
      await f.dispatcher.dispatchOnce(f.admin, {
        leagueId: f.leagueId,
        limit: 100,
      });
      const pick = await f.exec(f.owners[0], {
        type: "draftPick",
        expectedPick: 0,
        playerId: "p0",
      });
      await Promise.all([
        f.dispatcher.dispatchOnce(f.admin, { leagueId: f.leagueId }),
        f.dispatcher.dispatchOnce(f.admin, { leagueId: f.leagueId }),
      ]);
      const jobs = (
        await f.db.query(
          "SELECT agent_id,payload FROM runtime_jobs WHERE payload->>'eventId'=$1",
          [pick.eventId],
        )
      ).rows;
      expect(jobs).toHaveLength(12);
      expect(new Set(jobs.map((j) => j.agent_id)).size).toBe(12);
      expect(jobs.some((j) => j.agent_id === "foreign-agent")).toBe(false);
      expect(jobs[0].payload.details).toMatchObject({
        playerId: "p0",
        teamId: "team-0",
      });
      expect(
        (await f.dispatcher.dispatchOnce(f.admin, { leagueId: f.leagueId }))
          .delivered,
      ).toBe(0);
      expect(
        Number(
          (
            await f.db.query(
              "SELECT count(*) FROM league_event_deliveries WHERE event_id=$1",
              [pick.eventId],
            )
          ).rows[0].count,
        ),
      ).toBe(12);
    } finally {
      await f.close();
    }
  });
  it("keeps private trade events limited to participants and excludes private queues and claims from broadcast", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], { type: "setDraftQueue", playerIds: ["p0"] });
      await f.exec(f.admin, { type: "startDraft" });
      for (let i = 0; i < 12; i++)
        await f.exec(f.owners[i], {
          type: "draftPick",
          expectedPick: i,
          playerId: "p" + i,
        });
      await f.dispatcher.dispatchOnce(f.admin, {
        leagueId: f.leagueId,
        limit: 1000,
      });
      const trade = await f.exec(f.owners[0], {
        type: "proposeTrade",
        tradeId: "private",
        toTeamId: "team-1",
        givePlayers: ["p0"],
        receivePlayers: ["p1"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      await f.dispatcher.dispatchOnce(f.admin, {
        leagueId: f.leagueId,
        limit: 1000,
      });
      const recipients = (
        await f.db.query(
          "SELECT agent_id FROM runtime_jobs WHERE payload->>'eventId'=$1 ORDER BY agent_id",
          [trade.eventId],
        )
      ).rows.map((r) => r.agent_id);
      expect(recipients).toEqual(["agent-0", "agent-1"]);
      expect(
        Number(
          (
            await f.db.query(
              "SELECT count(*) FROM runtime_jobs WHERE payload->>'eventType'='setDraftQueue'",
            )
          ).rows[0].count,
        ),
      ).toBe(0);
      await expect(
        f.dispatcher.dispatchOnce(f.owners[0], { leagueId: f.leagueId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        f.dispatcher.dispatchOnce(
          { ...f.admin, leagueId: "foreign" },
          { leagueId: f.leagueId },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await f.close();
    }
  });
  it("commits delivery receipt and wakeup together, rolling both back when receipt storage fails", async () => {
    const f = await fixture();
    try {
      await f.exec(f.admin, { type: "startDraft" });
      // Scoped synthetic fault injection; no production state touched.
      await f.db.query(
        "CREATE FUNCTION fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic delivery fault'; END $$",
      );
      await f.db.query(
        "CREATE TRIGGER synthetic_fault BEFORE INSERT ON league_event_deliveries FOR EACH ROW EXECUTE FUNCTION fail_delivery()",
      );
      const failed = await f.dispatcher.dispatchOnce(f.admin, {
        leagueId: f.leagueId,
        limit: 1,
      });
      expect(failed.failed).toHaveLength(1);
      expect(
        Number(
          (await f.db.query("SELECT count(*) FROM runtime_jobs")).rows[0].count,
        ),
      ).toBe(0);
      expect(
        Number(
          (await f.db.query("SELECT count(*) FROM league_event_deliveries"))
            .rows[0].count,
        ),
      ).toBe(0);
      await f.db.query(
        "DROP TRIGGER synthetic_fault ON league_event_deliveries",
      );
      expect(
        (
          await f.dispatcher.dispatchOnce(f.admin, {
            leagueId: f.leagueId,
            limit: 1,
          })
        ).delivered,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
});
