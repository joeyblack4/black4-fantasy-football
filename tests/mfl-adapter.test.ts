import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { MflAdapter, PgMflJournal, type MflConfig } from "../src/mfl/index.js";
import { envelope, draftState } from "../src/mfl/codec.js";
let f: Awaited<ReturnType<typeof testDb>>;
const config: MflConfig = {
  leagueId: "synthetic-mfl",
  season: 2026,
  host: "www43.myfantasyleague.com",
  mflLeagueId: "99999",
  mode: "synthetic",
  userAgent: "Black4SyntheticTest/1",
  franchises: [
    { teamId: "team-a", ownerId: "owner-a", franchiseId: "0001" },
    { teamId: "team-b", ownerId: "owner-b", franchiseId: "0002" },
    { teamId: "team-c", ownerId: "owner-c", franchiseId: "0003" },
  ],
};
const owner = {
    id: "owner-a",
    role: "owner" as const,
    leagueId: config.leagueId,
    teamId: "team-a",
  },
  other = { ...owner, id: "owner-b", teamId: "team-b" },
  third = { ...owner, id: "owner-c", teamId: "team-c" };
const secret = "SYNTHETIC_ONLY_cookie+/=";
beforeEach(async () => {
  f = await testDb();
});
afterEach(async () => {
  await f.close();
});
function fixture() {
  const state = {
    rosters: {
      "0001": ["13589", "13116"],
      "0002": ["17466"],
      "0003": ["14319"],
    } as Record<string, string[]>,
    lineups: { "0001": ["13589"], "0002": [], "0003": [] } as Record<
      string,
      string[]
    >,
    bids: {} as Record<string, string>,
    trades: [] as any[],
    drafted: false,
    draftKind: "live",
  };
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  let mode = "normal",
    cookies = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input)),
      method = init?.method ?? "GET",
      p =
        method === "POST"
          ? new URLSearchParams(String(init?.body))
          : u.searchParams;
    calls.push({ method, path: u.pathname, params: p });
    expect(init?.redirect).toBe("error");
    if (p.get("TYPE") === "players") {
      expect(new Headers(init?.headers).has("Cookie")).toBe(false);
      return Response.json({
        players: {
          player: [
            {
              id: "13589",
              name: "Allen, Josh",
              position: "QB",
              team: "BUF",
              private: "should not project",
            },
            { id: "17466", name: "Beck, Carson", position: "QB", team: "ARI" },
          ],
        },
      });
    }
    expect(new Headers(init?.headers).get("Cookie")).toBe(
      "MFL_USER_ID=" + encodeURIComponent(secret),
    );
    if (u.pathname.includes("draft_results"))
      return new Response(
        `<draftResults ${state.drafted ? 'over="1"' : 'round="01" pick="01" franchise_id="0001"'}><draftPick round="01" pick="01" franchise="0001" player="${state.drafted ? "14319" : ""}" /></draftResults>`,
      );
    expect(p.get("L")).toBe(config.mflLeagueId);
    expect(p.get("JSON")).toBe("1");
    const type = p.get("TYPE"),
      fid = p.get("FRANCHISE_ID") ?? "0001";
    if (method === "GET") {
      if (type === "rosters") {
        const wanted = p.get("FRANCHISE");
        const rows = Object.entries(state.rosters)
          .filter(([id]) => !wanted || id === wanted)
          .map(([id, players]) => ({
            id: mode === "wrongIdentity" ? "0002" : id,
            email: "private@example.invalid",
            player: players.map((id) => ({ id, status: "ROSTER" })),
          }));
        return Response.json({
          rosters: { franchise: rows.length === 1 ? rows[0] : rows },
        });
      }
      if (type === "weeklyResults")
        return Response.json({
          weeklyResults: {
            week: p.get("W"),
            franchise: Object.entries(state.lineups).map(([id, players]) => ({
              id,
              starters: players.join(",") + ",",
            })),
          },
        });
      if (type === "pendingWaivers")
        return Response.json({
          pendingWaivers: state.bids[fid]
            ? {
                blindBidWaiverRequest: {
                  round: "1",
                  addsDrops: state.bids[fid],
                },
              }
            : {},
        });
      if (type === "pendingTrades")
        return Response.json({
          pendingTrades: {
            pendingTrade:
              mode === "leakTrade"
                ? [
                    {
                      trade_id: "10",
                      offeringteam: "0002",
                      offeredto: "0003",
                      will_give_up: "17466,",
                      will_receive: "14319,",
                    },
                  ]
                : state.trades.filter(
                    (t) => t.offeringteam === fid || t.offeredto === fid,
                  ),
          },
        });
      if (type === "liveScoring")
        return Response.json({
          error: { $t: "Live scoring not available until the season starts" },
        });
      if (type === "league")
        return Response.json({
          league: {
            id: config.mflLeagueId,
            draft_kind: state.draftKind,
            loadRosters:
              state.draftKind === "live" ? "live_draft" : "email_draft",
            franchises: {
              franchise: [
                {
                  id: "0001",
                  bbidAvailableBalance: "91.00",
                  email: "private@example.invalid",
                  name: "private name",
                },
                {
                  id: "0002",
                  bbidAvailableBalance: "100.00",
                  email: "someone-else@example.invalid",
                },
              ],
            },
          },
        });
      if (type === "rules")
        return mode === "noRules"
          ? Response.json({
              encoding: "utf-8",
              version: "1.0",
              error: { $t: "Error - No League Scoring Rules" },
            })
          : mode === "rulesAuthError"
            ? Response.json({ error: { $t: "login required" } })
            : Response.json({ rules: { positionRules: [] } });
      throw Error("unexpected synthetic GET");
    }
    expect(p.get("FRANCHISE_ID") ?? p.get("FRANCHISE_PICK")).toMatch(
      /^000[123]$/,
    );
    expect(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM runtime_receipts WHERE type='mfl_operation' AND details->>'state'='submitted'",
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
    if (mode === "applicationError" || mode === "partialError") {
      if (mode === "partialError") state.rosters[fid] = ["17466"];
      return new Response(
        '<?xml version="1.0"?><error>Cannot acquire player because locked ' +
          secret +
          "</error>",
      );
    }
    if (type === "lineup")
      state.lineups[fid] = p.get("STARTERS")!.split(",").filter(Boolean);
    if (type === "fcfsWaiver") {
      state.rosters[fid] = state.rosters[fid]!.filter(
        (id) => !p.get("DROP")!.split(",").includes(id),
      );
      if (p.get("ADD")) state.rosters[fid]!.push(p.get("ADD")!);
    }
    if (type === "blindBidWaiverRequest") {
      expect(p.get("REPLACE")).toBe("1");
      state.bids[fid] = p.get("PICKS")!;
    }
    if (type === "tradeProposal")
      state.trades.push({
        trade_id: String(1000 + state.trades.length),
        offeringteam: fid,
        offeredto: p.get("OFFEREDTO"),
        will_give_up: p.get("WILL_GIVE_UP") + ",",
        will_receive: p.get("WILL_RECEIVE") + ",",
      });
    if (type === "tradeResponse") {
      const trade = state.trades.find((t) => t.trade_id === p.get("TRADE_ID"))!;
      if (p.get("RESPONSE") === "accept") {
        const give = trade.will_give_up.split(",").filter(Boolean),
          receive = trade.will_receive.split(",").filter(Boolean);
        state.rosters[trade.offeringteam] = state.rosters[
          trade.offeringteam
        ]!.filter((id) => !give.includes(id)).concat(receive);
        state.rosters[trade.offeredto] = state.rosters[trade.offeredto]!.filter(
          (id) => !receive.includes(id),
        ).concat(give);
      }
      state.trades = state.trades.filter((t) => t !== trade);
    }
    if (p.get("CMD") === "DRAFT") {
      state.drafted = true;
      return Response.json({ success: "OK" });
    }
    if (mode === "timeoutAfterEffect")
      throw Error("synthetic connection lost " + secret);
    return new Response(
      '<?xml version="1.0" encoding="utf-8"?><status>OK</status>',
    );
  };
  const options = {
    journal: new PgMflJournal(f.db),
    fetchImpl,
    getSessionCookie: async () => {
      cookies++;
      return secret;
    },
    writesEnabled: true,
  };
  return {
    adapter: new MflAdapter(config, options),
    options,
    state,
    calls,
    setMode: (m: string) => {
      mode = m;
    },
    cookies: () => cookies,
  };
}
it("requires writes gate and exact owner binding; refuses injected franchise/league arguments before HTTP", async () => {
  const t = fixture();
  await expect(
    new MflAdapter(config, { ...t.options, writesEnabled: false }).execute(
      owner,
      "disabled",
      { type: "addDrop", addPlayerId: "17466" },
    ),
  ).rejects.toThrow("WRITES_DISABLED");
  await expect(
    t.adapter.execute({ ...owner, role: "commissioner" }, "admin", {
      type: "addDrop",
      addPlayerId: "17466",
    }),
  ).rejects.toThrow("OWNER_BINDING");
  await expect(
    t.adapter.execute(owner, "injected", {
      type: "addDrop",
      addPlayerId: "17466",
      FRANCHISE_ID: "0002",
    }),
  ).rejects.toThrow();
  expect(t.calls).toHaveLength(0);
});
it("parses XML import success, scopes lineage, persists intent, verifies actual lineup and never leaks private export fields", async () => {
  const t = fixture(),
    r = await t.adapter.execute(owner, "lineup1", {
      type: "lineup",
      week: 1,
      starters: ["13116"],
    });
  expect(r.state).toBe("verified");
  expect(r.result).toMatchObject({ franchiseId: "0001", starters: ["13116"] });
  const logged = JSON.stringify(
    (await f.db.query("SELECT details FROM runtime_receipts")).rows,
  );
  expect(logged).not.toContain(secret);
  expect(logged).not.toContain("private@example");
  expect(
    (await t.adapter.verifyReceipt(f.db, owner, "lineup1", r.id)).state,
  ).toBe("verified");
  await expect(t.adapter.lookup(other, "lineup1")).rejects.toThrow("FORBIDDEN");
});
it("serializes duplicate submissions and preserves idempotency conflicts", async () => {
  const t = fixture(),
    a = { type: "lineup", week: 1, starters: ["13116"] };
  const r = await Promise.all([
    t.adapter.execute(owner, "same", a),
    t.adapter.execute(owner, "same", a),
  ]);
  expect(r.map((x) => x.state)).toEqual(["verified", "verified"]);
  expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  await expect(
    t.adapter.execute(owner, "same", { ...a, starters: ["13589"] }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("holds lost write response, read-only reconciliation proves effect, and replay never dispatches again", async () => {
  const t = fixture();
  t.setMode("timeoutAfterEffect");
  const r = await t.adapter.execute(owner, "unknown", {
    type: "addDrop",
    addPlayerId: "17466",
    dropPlayerIds: ["13116"],
  });
  expect(r.state).toBe("unknown");
  expect((await t.adapter.execute(owner, "unknown", r.action)).state).toBe(
    "unknown",
  );
  await expect(
    t.adapter.execute(owner, "new", {
      type: "lineup",
      week: 1,
      starters: ["13589"],
    }),
  ).rejects.toThrow("UNRESOLVED_OPERATION");
  expect((await t.adapter.reconcile(owner, "unknown")).state).toBe("verified");
  expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
it.each(["applicationError", "partialError"])(
  "reads back explicit application errors and holds partial side effects: %s",
  async (mode) => {
    const t = fixture();
    t.setMode(mode);
    const r = await t.adapter.execute(owner, "rejected", {
      type: "addDrop",
      addPlayerId: "17466",
      dropPlayerIds: ["13116"],
    });
    expect(r.state).toBe(mode === "applicationError" ? "rejected" : "unknown");
    expect(
      t.calls.filter((c) => c.params.get("TYPE") === "rosters"),
    ).toHaveLength(2);
    expect(
      JSON.stringify(
        (await f.db.query("SELECT details FROM runtime_receipts")).rows,
      ),
    ).not.toContain(secret);
  },
);
it("sets/replaces/clears one bid round and proves each resulting private pending state", async () => {
  const t = fixture();
  for (const [n, bids] of [
    [1, [{ addPlayerId: "17466", dropPlayerId: "13116", amount: "7" }]],
    [2, [{ addPlayerId: "17466", dropPlayerId: "13116", amount: "9.00" }]],
    [3, []],
  ] as const) {
    const r = await t.adapter.execute(owner, "bid" + n, {
      type: "replaceBids",
      round: 1,
      bids,
    });
    expect(r.state).toBe("verified");
  }
  expect(t.state.bids["0001"]).toBe("");
  expect(
    t.calls
      .filter((c) => c.method === "POST")
      .every((c) => c.params.get("FRANCHISE_ID") === "0001"),
  ).toBe(true);
});
it("trade permissions, offer identification and acceptance require exact counterpart rosters", async () => {
  const t = fixture();
  const offered = await t.adapter.execute(owner, "offer", {
    type: "proposeTrade",
    counterpartyTeamId: "team-b",
    givePlayerIds: ["13589"],
    receivePlayerIds: ["17466"],
  });
  expect(offered.state).toBe("verified");
  const id = (offered.result as any).tradeId;
  const denied = await t.adapter.execute(third, "steal", {
    type: "respondTrade",
    tradeId: id,
    response: "accept",
  });
  expect(denied.state).toBe("rejected");
  const accepted = await t.adapter.execute(other, "accept", {
    type: "respondTrade",
    tradeId: id,
    response: "accept",
  });
  expect(accepted.state).toBe("verified");
  expect(t.state.rosters["0002"]).toContain("13589");
});
it("rejects cross-franchise private trade data and mismatched scoped roster identities", async () => {
  const t = fixture();
  t.setMode("leakTrade");
  await expect(
    t.adapter.read(owner, { type: "pendingTrades" }),
  ).rejects.toThrow("PRIVATE_TRADE_SCOPE");
  t.setMode("wrongIdentity");
  await expect(t.adapter.read(owner, { type: "roster" })).rejects.toThrow(
    "EFFECTIVE_FRANCHISE",
  );
});
it("keeps an uncertain rejection unknown when a trade disappears; absence does not prove rejection", async () => {
  const t = fixture();
  const offered = await t.adapter.execute(owner, "offer", {
    type: "proposeTrade",
    counterpartyTeamId: "team-b",
    givePlayerIds: ["13589"],
    receivePlayerIds: ["17466"],
  });
  t.setMode("timeoutAfterEffect");
  const r = await t.adapter.execute(other, "reject", {
    type: "respondTrade",
    tradeId: (offered.result as any).tradeId,
    response: "reject",
  });
  expect(r.state).toBe("unknown");
  expect((await t.adapter.reconcile(other, "reject")).state).toBe("unknown");
});
it("uses fast static draft state plus expected turn and verifies exact pick afterward", async () => {
  const t = fixture();
  const bad = await t.adapter.execute(other, "wrongturn", {
    type: "draft",
    round: 1,
    pick: 1,
    playerId: "14319",
  });
  expect(bad.state).toBe("rejected");
  const ok = await t.adapter.execute(owner, "draft1", {
    type: "draft",
    round: 1,
    pick: 1,
    playerId: "14319",
  });
  expect(ok.state).toBe("verified");
  expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
it("rejects live draft writes in native email mode even with an actionable static turn; other reads remain available", async () => {
  const t = fixture();
  t.state.draftKind = "email";
  const r = await t.adapter.execute(owner, "email-draft-denied", {
    type: "draft",
    round: 1,
    pick: 1,
    playerId: "14319",
  });
  expect(r.state).toBe("rejected");
  expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  expect(t.calls.some((c) => c.path.includes("draft_results"))).toBe(false);
  const ordinary = await t.adapter.read(owner, { type: "draft" });
  expect(ordinary.data).toMatchObject({
    round: 1,
    pick: 1,
    franchiseId: "0001",
  });
  expect((await t.adapter.read(owner, { type: "roster" })).data).toBeTruthy();
});
it("caches sanitized player research across adapter instances without sending session cookie to global endpoint", async () => {
  const t = fixture();
  const one = await t.adapter.read(owner, { type: "players", search: "Allen" });
  const two = await new MflAdapter(config, t.options).read(other, {
    type: "players",
    position: "QB",
  });
  expect((one.data as any).players).toHaveLength(1);
  expect((two.data as any).players).toHaveLength(2);
  expect(t.calls).toHaveLength(1);
  expect(t.cookies()).toBe(0);
  expect(JSON.stringify(two)).not.toContain("should not project");
});
it("preserves unavailable scores as an explicit error rather than zero or final", async () => {
  const t = fixture();
  await expect(
    t.adapter.read(owner, { type: "scores", week: 1 }),
  ).rejects.toThrow("DATA_UNAVAILABLE");
});
it("rejects unsafe XML and HTML responses and normalizes HTTP200 error envelopes", () => {
  expect(
    envelope('<?xml version="1.0"?><error>API requires logged in user</error>')
      .errorCode,
  ).toBe("MFL_AUTH_REQUIRED");
  expect(() =>
    envelope(
      '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><status>&x;</status>',
    ),
  ).toThrow("UNSAFE");
  expect(() => envelope("<html>Login</html>")).toThrow("INVALID");
  expect(() =>
    draftState(
      '<draftResults><draftPick round="01" round="02" pick="01" franchise="0001"/></draftResults>',
    ),
  ).toThrow("INVALID");
});
it("projects only the authenticated owner FAAB balance without owner contact or other franchise data", async () => {
  const t = fixture(),
    r = await t.adapter.read(owner, { type: "budget" });
  expect(r.data).toEqual({
    teamId: "team-a",
    franchiseId: "0001",
    unit: "FAAB",
    bbidAvailableBalance: "91.00",
  });
  expect(JSON.stringify(r)).not.toContain("100.00");
  expect(
    JSON.stringify(
      (await f.db.query("SELECT details FROM runtime_receipts")).rows,
    ),
  ).not.toContain("private@example");
});
it("does not identify an uncertain trade proposal by a similar new pending offer after a timeout", async () => {
  const t = fixture();
  t.setMode("timeoutAfterEffect");
  const r = await t.adapter.execute(owner, "offer-unknown", {
    type: "proposeTrade",
    counterpartyTeamId: "team-b",
    givePlayerIds: ["13589"],
    receivePlayerIds: ["17466"],
  });
  expect(r.state).toBe("unknown");
  expect(t.state.trades).toHaveLength(1);
  expect((await t.adapter.reconcile(owner, "offer-unknown")).state).toBe(
    "unknown",
  );
  expect(t.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});
it("allows a scoped commissioner draft observer without forging an owner or permitting an external write", async () => {
  const t = fixture(),
    commissioner = {
      id: "commissioner",
      role: "commissioner" as const,
      leagueId: config.leagueId,
    };
  await expect(t.adapter.readDraftForCommissioner(owner)).rejects.toMatchObject(
    { code: "MFL_COMMISSIONER_SCOPE_REQUIRED" },
  );
  await expect(
    t.adapter.readDraftForCommissioner({
      ...commissioner,
      leagueId: "foreign",
    }),
  ).rejects.toMatchObject({ code: "MFL_COMMISSIONER_SCOPE_REQUIRED" });
  expect(t.calls).toHaveLength(0);
  const result = await t.adapter.readDraftForCommissioner(commissioner);
  expect(result).toMatchObject({
    leagueId: config.leagueId,
    synthetic: true,
    data: { round: 1, pick: 1, franchiseId: "0001" },
  });
  expect(t.calls).toHaveLength(2);
  expect(t.calls[0]!.method).toBe("GET");
  const journal = (
    await f.db.query(
      "SELECT details FROM runtime_receipts WHERE type='mfl_read' AND details->>'actorRole'='commissioner'",
    )
  ).rows;
  expect(journal).toHaveLength(1);
  expect(journal[0].details).toMatchObject({
    actorId: "commissioner",
    actorRole: "commissioner",
    request: { type: "draft" },
  });
  expect(journal[0].details.teamId).toBeUndefined();
});

it("receipts the native no-scoring-rules response as a configuration gap rather than an unavailable tool or invented rules", async () => {
  const t = fixture();
  t.setMode("noRules");
  const result = await t.adapter.read(owner, { type: "rules" });
  expect(result).toMatchObject({
    leagueId: config.leagueId,
    teamId: owner.teamId,
    synthetic: true,
    data: {
      status: "not-configured",
      code: "MFL_SCORING_RULES_NOT_CONFIGURED",
      scoringRules: null,
      operatorActionRequired: true,
    },
  });
  expect(result.data.instruction).toContain("read tool is available");
  expect(result.data.instruction).toContain("not approved or applied rules");
  const read = (
    await f.db.query(
      "SELECT details FROM runtime_receipts WHERE type='mfl_read' AND details->>'id'=$1",
      [result.id],
    )
  ).rows[0];
  expect(read.details).toMatchObject({
    leagueId: config.leagueId,
    teamId: owner.teamId,
    request: { type: "rules" },
  });
  expect(t.calls).toHaveLength(1);
  expect(t.calls[0]!.method).toBe("GET");
  t.setMode("rulesAuthError");
  await expect(t.adapter.read(owner, { type: "rules" })).rejects.toMatchObject({
    code: "MFL_AUTH_REQUIRED",
  });
  t.setMode("normal");
  expect((await t.adapter.read(owner, { type: "rules" })).data).toEqual({
    positionRules: [],
  });
});
