import { it, expect } from "vitest";
import { MflAdapter } from "../src/mfl/adapter.js";
import type { MflJournalSession, MflConfig } from "../src/mfl/contracts.js";
const config: MflConfig = {
  leagueId: "test",
  season: 2026,
  mflLeagueId: "62282",
  mode: "synthetic",
  host: "www43.myfantasyleague.com",
  userAgent: "Test Agent/1",
  franchises: [
    { teamId: "a", ownerId: "oa", franchiseId: "0001" },
    { teamId: "b", ownerId: "ob", franchiseId: "0002" },
  ],
};
const actor = {
  id: "oa",
  role: "owner" as const,
  leagueId: "test",
  teamId: "a",
};
function fixture(overrides: Record<string, unknown> = {}) {
  const cache = new Map<string, unknown>();
  const calls: string[] = [];
  const session: MflJournalSession = {
    cached: async (k) => cache.get(k) ?? null,
    beforeRequest: async () => {},
    recordRead: async (r) => {
      if (r.cacheKey) cache.set(r.cacheKey as string, r.data);
      return { id: "read", at: new Date().toISOString() };
    },
    find: async () => null,
    unresolved: async () => [],
    append: async (r) => ({ ...r, at: new Date().toISOString() }),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    if (init?.method === "POST") {
      expect(overrides.__acceptLineups).toBe(true);
      const p = new URLSearchParams(String(init.body));
      expect(p.get("TYPE")).toBe("lineup");
      expect(p.get("FRANCHISE_ID")).toBe("0001");
      calls.push("lineup");
      return Response.json({ success: "OK" });
    }
    const type = u.searchParams.get("TYPE")!;
    calls.push(type);
    if (type === overrides.__http429)
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    expect(init?.method).toBe("GET");
    if (["players", "nflSchedule", "nflByeWeeks"].includes(type)) {
      expect(u.hostname).toBe("api.myfantasyleague.com");
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    }
    const bodies: Record<string, unknown> = {
      weeklyResults: {
        weeklyResults: {
          week: "1",
          franchise: [
            { id: "0001", starters: "10000," },
            { id: "0002", starters: "" },
          ],
        },
      },
      pendingTrades: { pendingTrades: {} },
      players: {
        players: {
          player: [
            { id: "10000", name: "Fixture QB", position: "QB", team: "AAA" },
            { id: "0509", name: "Fixture DEF", position: "Def", team: "BBB" },
            {
              id: "10001",
              name: "Fixture kicker",
              position: "PK",
              team: "BBB",
            },
          ],
        },
      },
      rosters: {
        rosters: {
          franchise: [
            { id: "0001", player: { id: "10000", status: "ROSTER" } },
            { id: "0002", player: [] },
          ],
        },
      },
      league: {
        league: {
          id: "62282",
          rosterSize: "16",
          partialLineupAllowed: "NO",
          starters: { count: "9", position: { name: "QB", limit: "1" } },
          franchises: {
            franchise: [
              {
                id: "0001",
                name: "A",
                email: "private@example.invalid",
                bbidAvailableBalance: "99",
              },
              {
                id: "0002",
                name: "B",
                email: "private-peer@example.invalid",
                bbidAvailableBalance: "1",
              },
            ],
          },
        },
      },
      playerRosterStatus: {
        playerRosterStatuses: {
          playerStatus: [
            {
              id: "10000",
              roster_franchise: { franchise_id: "0001", status: "S" },
            },
            { id: "0509", is_fa: "1", locked: "1" },
            { id: "10001", is_fa: "1" },
          ],
        },
      },
      calendar: {
        calendar: { event: { id: "t", type: "TRADE", start_time: "11" } },
      },
      nflSchedule: {
        nflSchedule: {
          week: u.searchParams.get("W"),
          matchup: {
            kickoff: "1788999600",
            team: [{ id: "AAA" }, { id: "BBB" }],
          },
        },
      },
      nflByeWeeks: { nflByeWeeks: { team: { id: "CCC", bye_week: "1" } } },
      schedule: {
        schedule: {
          weeklySchedule: {
            week: "1",
            matchup: { franchise: [{ id: "0001" }, { id: "0002" }] },
          },
        },
      },
      transactions: {
        transactions: {
          transaction: [
            {
              type: "BBID_WAIVER_REQUEST",
              transaction: "SECRET BID",
              franchise: "0002",
            },
            { type: "TRADE", transaction: "SECRET PENDING", status: "pending" },
            {
              type: "FREE_AGENT",
              transaction: "0509|",
              franchise: "0001",
              timestamp: "1788990000",
              comments: "PRIVATE COMMENT",
            },
          ],
        },
      },
    };
    Object.assign(bodies, structuredClone(overrides));
    if (type === "rosters" && u.searchParams.has("FRANCHISE")) {
      const r = bodies.rosters as any;
      r.rosters.franchise = r.rosters.franchise.filter(
        (f: any) => f.id === u.searchParams.get("FRANCHISE"),
      );
    }
    if (!(type in bodies)) throw Error("unexpected " + type);
    return Response.json(bodies[type]);
  };
  return {
    adapter: new MflAdapter(config, {
      journal: { withLock: async (_, fn) => fn(session) },
      getSessionCookie: async () => "test-cookie",
      writesEnabled: true,
      enforceSeasonRules: true,
      fetchImpl,
    }),
    cache,
    calls,
  };
}
it("enriches names, preserves leading zero IDs, and distinguishes locked free agents", async () => {
  const { adapter } = fixture();
  const r = await adapter.read(actor, {
    type: "availability",
    playerIds: ["10000", "0509", "10001"],
  });
  expect(r.data.players.map((p: any) => p.availability)).toEqual([
    "rostered",
    "locked",
    "unowned",
  ]);
  expect(r.data.players[1]).toMatchObject({ id: "0509", name: "Fixture DEF" });
});
it("calendar uses public NFL host without session, resolves verified week notation and lists byes", async () => {
  const { adapter } = fixture();
  const r = await adapter.read(actor, { type: "calendar", week: 1 });
  expect(r.data.byeTeams).toEqual(["CCC"]);
  expect(r.data.events[0]).toMatchObject({
    rawStart: "11",
    timingStatus: "resolved-week-kickoff",
    startsAt: "2026-09-10T00:20:00.000Z",
  });
});
it("public team and transaction projections exclude private budget, contacts, pending bids and comments", async () => {
  const { adapter } = fixture();
  const teams = await adapter.read(actor, { type: "teams" });
  expect(JSON.stringify(teams)).not.toMatch(/private|Balance/);
  const tx = await adapter.read(actor, { type: "transactions" });
  expect(tx.data.transactions).toHaveLength(1);
  expect(JSON.stringify(tx)).not.toMatch(/SECRET|PRIVATE/);
});
it("shared cache preserves original observation time rather than renewing data freshness", async () => {
  const { adapter, cache, calls } = fixture();
  await adapter.read(actor, { type: "teams" });
  const key = [...cache.keys()].find((k) =>
    k.startsWith("mfl-season:league:"),
  )!;
  (cache.get(key) as any).observedAt = "2026-01-01T00:00:00Z";
  const r = await adapter.read(actor, { type: "teams" });
  expect(calls.filter((c) => c === "league")).toHaveLength(1);
  expect(r.metadata.sources).toContainEqual({
    source: "mfl:league",
    observedAt: "2026-01-01T00:00:00Z",
    freshness: "cached",
    sourceUpdatedAt: null,
  });
});
it("production season enforcement rejects illegal lineup with mechanical details before import", async () => {
  const { adapter, calls } = fixture();
  const r = await adapter.execute(actor, "bad-nine", {
    type: "lineup",
    week: 1,
    starters: ["10000"],
  });
  expect(r).toMatchObject({
    state: "rejected",
    reason: "MFL_LINEUP_STARTER_COUNT",
    details: { valid: false },
  });
  expect(calls).toContain("nflSchedule");
});
it("passes a partial lineup through owner preflight and verifies host readback", async () => {
  const { adapter, calls } = fixture({
    __acceptLineups: true,
    league: {
      league: {
        id: "62282",
        rosterSize: "16",
        partialLineupAllowed: "YES",
        starters: {
          count: "9",
          position: [
            { name: "QB", limit: "1" },
            { name: "PK", limit: "1" },
          ],
        },
      },
    },
  });
  const r = await adapter.execute(actor, "partial-season-lineup", {
    type: "lineup",
    week: 1,
    starters: ["10000"],
  });
  expect(r.state).toBe("verified");
  expect(calls.filter((c) => c === "lineup")).toHaveLength(1);
});
it("drop-only actions enforce player kickoff locks with the same season preflight as production", async () => {
  const { adapter } = fixture({
    nflSchedule: {
      nflSchedule: {
        week: "1",
        matchup: {
          kickoff: "1700000000",
          team: [{ id: "AAA" }, { id: "BBB" }],
        },
      },
    },
  });
  expect(
    await adapter.execute(actor, "drop-locked", {
      type: "addDrop",
      dropPlayerIds: ["10000"],
    }),
  ).toMatchObject({ state: "rejected", reason: "MFL_PLAYER_LOCKED" });
});
it("missing authoritative availability cannot become permission to add", async () => {
  const { adapter } = fixture({
    playerRosterStatus: { playerRosterStatuses: { playerStatus: [] } },
  });
  expect(
    await adapter.execute(actor, "missing-status", {
      type: "addDrop",
      addPlayerId: "10001",
      dropPlayerIds: [],
    }),
  ).toMatchObject({ state: "rejected", reason: "MFL_AVAILABILITY_UNKNOWN" });
});
it("trade proposals and acceptances cannot bypass a closed native deadline", async () => {
  const { adapter } = fixture({
    calendar: {
      calendar: {
        event: { id: "deadline", type: "TRADE", start_time: "1700000000" },
      },
    },
    pendingTrades: {
      pendingTrades: {
        pendingTrade: {
          trade_id: "1",
          offeringteam: "0002",
          offeredto: "0001",
          will_give_up: "0509,",
          will_receive: "10000,",
        },
      },
    },
  });
  expect(
    await adapter.execute(actor, "trade-after-deadline", {
      type: "proposeTrade",
      counterpartyTeamId: "b",
      givePlayerIds: ["10000"],
      receivePlayerIds: ["0509"],
    }),
  ).toMatchObject({
    state: "rejected",
    reason: "MFL_TRANSACTION_WINDOW_CLOSED",
  });
  expect(
    await adapter.execute(actor, "accept-after-deadline", {
      type: "respondTrade",
      tradeId: "1",
      response: "accept",
    }),
  ).toMatchObject({
    state: "rejected",
    reason: "MFL_TRANSACTION_WINDOW_CLOSED",
  });
});
it("acceptance rechecks ownership and both final roster sizes", async () => {
  const overrides = {
    calendar: { calendar: {} },
    league: { league: { id: "62282", rosterSize: "1" } },
    rosters: {
      rosters: {
        franchise: [
          { id: "0001", player: [{ id: "10000" }] },
          { id: "0002", player: [{ id: "0509" }, { id: "10001" }] },
        ],
      },
    },
    pendingTrades: {
      pendingTrades: {
        pendingTrade: {
          trade_id: "1",
          offeringteam: "0002",
          offeredto: "0001",
          will_give_up: "0509,10001,",
          will_receive: "10000,",
        },
      },
    },
  };
  const { adapter } = fixture(overrides);
  expect(
    await adapter.execute(actor, "oversize-trade", {
      type: "respondTrade",
      tradeId: "1",
      response: "accept",
    }),
  ).toMatchObject({ state: "rejected", reason: "MFL_TRADE_INVALID_ROSTER" });
});
it("same season preflight permits a legal owner submission and verifies authoritative readback", async () => {
  const { adapter, calls } = fixture({
    __acceptLineups: true,
    league: {
      league: {
        id: "62282",
        rosterSize: "16",
        starters: { count: "1", position: { name: "QB", limit: "1" } },
      },
    },
  });
  const r = await adapter.execute(actor, "legal-season-lineup", {
    type: "lineup",
    week: 1,
    starters: ["10000"],
  });
  expect(r.state).toBe("verified");
  expect(calls.filter((c) => c === "lineup")).toHaveLength(1);
});
it("one upstream429 opens shared cooldown, preserves cached reads and provides retryAt without retrying", async () => {
  const { adapter, calls } = fixture({ __http429: "calendar" });
  await adapter.read(actor, { type: "teams" });
  let failure: any;
  try {
    await adapter.read(actor, { type: "calendar", week: 1 });
  } catch (e) {
    failure = e;
  }
  expect(failure.code).toBe("MFL_THROTTLED");
  expect(Date.parse(failure.details.retryAt)).toBeGreaterThan(
    Date.now() + 110000,
  );
  const before = calls.length;
  await expect(
    adapter.read(actor, { type: "transactions" }),
  ).rejects.toMatchObject({
    code: "MFL_THROTTLED",
    details: { retryAt: failure.details.retryAt },
  });
  expect(calls).toHaveLength(before);
  expect(
    (await adapter.read(actor, { type: "teams" })).data.teams,
  ).toHaveLength(2);
  expect(calls.filter((c) => c === "calendar")).toHaveLength(1);
});
it("all owners share public roster observations and mutation invalidation removes stale views", async () => {
  const { adapter, calls, cache } = fixture();
  await adapter.read(actor, { type: "roster" });
  await adapter.read({ ...actor, id: "ob", teamId: "b" }, { type: "roster" });
  expect(calls.filter((c) => c === "rosters")).toHaveLength(1);
  cache.set("mfl-read-invalidation", {
    invalidatedAt: new Date(Date.now() + 1).toISOString(),
  });
  await adapter.read(actor, { type: "roster" });
  expect(calls.filter((c) => c === "rosters")).toHaveLength(2);
});
it("owner validation reuses read-only roster and lineup exports while write preflight refreshes them", async () => {
  const { adapter, calls } = fixture();
  await adapter.read(actor, { type: "roster" });
  await adapter.read(actor, { type: "lineup", week: 1 });
  await adapter.read(actor, {
    type: "validateLineup",
    week: 1,
    starters: ["10000"],
  });
  expect(calls.filter((c) => c === "rosters")).toHaveLength(1);
  expect(calls.filter((c) => c === "weeklyResults")).toHaveLength(1);
  await adapter.execute(actor, "fresh-preflight", {
    type: "lineup",
    week: 1,
    starters: ["10000"],
  });
  expect(calls.filter((c) => c === "rosters").length).toBeGreaterThan(1);
  expect(calls.filter((c) => c === "weeklyResults").length).toBeGreaterThan(1);
});

it("does not promise FCFS access from player flags and directs rostered lineup locks to validation", async () => {
  const { adapter } = fixture({
    playerRosterStatus: {
      playerRosterStatuses: {
        playerStatus: [{ id: "10001", is_fa: "1", locked: "0", cant_add: "0" }],
      },
    },
  });
  const r = await adapter.read(actor, {
    type: "availability",
    playerIds: ["10000", "10001"],
  });
  expect(r.data.players[1]).toMatchObject({
    availability: "unowned",
    acquisition: { canAcquireNow: null, fcfs: { eligible: null } },
  });
  expect(r.data.players[0]).toMatchObject({
    availability: "rostered",
    upstreamStatus: { locked: null },
    acquisition: { canAcquireNow: false },
  });
  expect(r.data.lineupLockRead.type).toBe("validateLineup");
});
it("separates conditional claim groups from dated processing and marks unknown host windows", async () => {
  const { adapter } = fixture({
    league: {
      league: {
        id: "62282",
        currentWaiverType: "BBID_FCFS",
        bbidConditional: "No",
        maxWaiverRounds: "4",
      },
    },
    calendar: {
      calendar: {
        event: [
          {
            id: "run-a",
            type: "WAIVER_BBID",
            start_time: "1893488400",
            happens: "2",
          },
        ],
      },
    },
  });
  const r = await adapter.read(actor, { type: "waiverRules" });
  expect(r.data).toMatchObject({
    conditional: "No",
    maxWaiverRounds: 4,
    roundParameterRequired: false,
    roundMeaning: "claim-group-not-processing-date",
    submissionClosesAt: null,
  });
  expect(r.data.upcomingProcessingEvents).toHaveLength(3);
  expect(r.data.nextProcessingEvent.id).toBe("run-a");
  expect(r.data.nextProcessingEvent).not.toHaveProperty("round");
});
it("reports known waiver closure without inventing a player's future eligibility time", async () => {
  const { adapter } = fixture({
    calendar: {
      calendar: {
        event: { id: "close", type: "WAIVER_NONE", start_time: "1788990000" },
      },
    },
  });
  const r = await adapter.read(actor, {
    type: "availability",
    playerIds: ["10001"],
  });
  expect(r.data.players[0]).toMatchObject({
    nextEligibleAt: null,
    acquisition: {
      canAcquireNow: false,
      fcfs: { reason: "calendar-waivers-closed" },
    },
  });
});
it("filters transaction timestamps, retains source-week semantics, and exposes truncation", async () => {
  const { adapter } = fixture({
    transactions: {
      transactions: {
        transaction: [
          {
            type: "BBID_WAIVER",
            franchise: "0001",
            transaction: "0509|",
            timestamp: "1789030800",
          },
          {
            type: "BBID_WAIVER",
            franchise: "0002",
            transaction: "10001|",
            timestamp: "1789030801",
          },
          {
            type: "BBID_WAIVER_REQUEST",
            transaction: "PRIVATE",
            timestamp: "1789030800",
          },
          { type: "FREE_AGENT", transaction: "UNKNOWN DATE" },
        ],
      },
    },
  });
  const r = await adapter.read(actor, {
    type: "transactions",
    since: "2026-09-10T09:00:00Z",
    until: "2026-09-10T09:00:02Z",
    limit: 1,
  });
  expect(r.data.transactions).toHaveLength(1);
  expect(r.data.transactions[0].franchiseId).toBe("0002");
  expect(r.data.coverageDetails).toMatchObject({
    matching: 2,
    responseTruncated: true,
    unknownTimestampCount: 1,
    complete: false,
  });
  expect(r.data.filters.mflTransactionWeek).toBeNull();
  expect(JSON.stringify(r.data.transactions)).not.toMatch(
    /PRIVATE|UNKNOWN DATE/,
  );
});
it("read-only bid validation rejects unowned drops without submitting or disclosing another owner's bids", async () => {
  const { adapter, calls } = fixture();
  const r = await adapter.read(actor, {
    type: "validateBids",
    round: 1,
    bids: [{ addPlayerId: "0509", dropPlayerId: "10001", amount: "0" }],
  });
  expect(r.data).toMatchObject({
    submitted: false,
    upstreamAcceptance: null,
    valid: false,
    issues: [{ code: "MFL_PLAYER_NOT_OWNED" }],
  });
  expect(calls).not.toContain("blindBidWaiverRequest");
});
it("read-only bid validation respects the host's conditional round limit", async () => {
  const { adapter, calls } = fixture({
    league: {
      league: { id: "62282", bbidConditional: "Yes", maxWaiverRounds: "4" },
    },
  });
  const r = await adapter.read(actor, {
    type: "validateBids",
    round: 5,
    bids: [],
  });
  expect(r.data).toMatchObject({
    submitted: false,
    valid: false,
    issues: [{ code: "MFL_WAIVER_ROUND_INVALID", maxWaiverRounds: 4 }],
  });
  expect(calls).not.toContain("blindBidWaiverRequest");
});

it("validates bids with the existing budget preflight and never claims upstream acceptance", async () => {
  const { adapter, calls } = fixture({
    league: {
      league: {
        id: "62282",
        bbidConditional: "No",
        bbidIncrement: "1",
        franchises: { franchise: [{ id: "0001", bbidAvailableBalance: "99" }] },
      },
    },
    pendingWaivers: { pendingWaivers: {} },
  });
  const query = {
    type: "validateBids",
    round: 1,
    bids: [{ addPlayerId: "10001", dropPlayerId: "10000", amount: "0" }],
  };
  const valid = await adapter.read(actor, query);
  expect(valid.data).toMatchObject({
    valid: true,
    submitted: false,
    upstreamAcceptance: null,
    scope: "existing-submission-preflight",
  });
  const invalid = await adapter.read(actor, {
    ...query,
    bids: [{ ...query.bids[0], amount: "100" }],
  });
  expect(invalid.data).toMatchObject({
    valid: false,
    submitted: false,
    issues: [{ code: "MFL_BID_BUDGET_REJECTED" }],
  });
  expect(calls).not.toContain("blindBidWaiverRequest");
});
