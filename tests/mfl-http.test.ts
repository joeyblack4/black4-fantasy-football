import { it, expect } from "vitest";
import { once } from "node:events";
import { testDb } from "./helpers.js";
import { LeagueService } from "../src/league/index.js";
import { bindHost } from "../src/league/host.js";
import { issueCredential } from "../src/auth.js";
import { createApiServer } from "../src/api.js";
import type { MflAdapter } from "../src/mfl/index.js";

it("MFL HTTP authority comes from the token, rejects actor injection and never exposes legacy custom state", async () => {
  const f = await testDb(),
    leagueId = "synthetic-mfl-http";
  const admin = { id: "admin", role: "commissioner" as const, leagueId };
  await new LeagueService(f.db).execute(admin, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "SYNTHETIC MFL HTTP",
    rules: {
      rosterSize: 2,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "QB", positions: ["QB"] }],
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: "t" + i,
      ownerId: "o" + i,
      name: "Synthetic " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  const owner = await issueCredential(f.db, {
      id: "o0",
      role: "owner",
      leagueId,
      teamId: "t0",
    }),
    commissioner = await issueCredential(f.db, admin);
  await bindHost(f.db, admin, {
    leagueId,
    host: "mfl",
    config: { season: 2026, leagueId: "99999", configRef: "synthetic-http" },
    expectedVersion: 0,
    idempotencyKey: "bind",
    reason: "Synthetic HTTP authority test",
  });
  const calls: any[] = [];
  const fake = {
    read: async (actor: unknown, input: unknown) => {
      calls.push({ actor, input });
      return { data: { privateFor: "t0" }, synthetic: true };
    },
    execute: async (actor: unknown, key: string, input: unknown) => {
      calls.push({ actor, key, input });
      return { state: "verified", synthetic: true };
    },
  } as unknown as MflAdapter;
  const server = createApiServer(f.db, { loadMfl: async () => fake });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  async function request(path: string, token: string, input?: unknown) {
    const r = await fetch(url + path, {
      method: input ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    return { status: r.status, data: await r.json() };
  }
  try {
    expect(
      (await request("/v1/football/read", owner.token, { type: "pendingBids" }))
        .status,
    ).toBe(200);
    expect(calls[0].actor).toEqual({
      id: "o0",
      role: "owner",
      leagueId,
      teamId: "t0",
    });
    expect(
      (
        await request("/v1/football/read", owner.token, {
          type: "pendingBids",
          franchiseId: "0002",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/v1/football/read", commissioner.token, {
          type: "pendingBids",
        })
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(1);
    expect(
      (
        await request("/v1/football/commands", owner.token, {
          idempotencyKey: "one",
          action: { type: "lineup", week: 1, starters: ["01234"] },
          actor: { id: "o1" },
        })
      ).status,
    ).toBe(400);
    expect(calls).toHaveLength(1);
    const state = await request("/v1/leagues/" + leagueId, owner.token);
    expect(state.data).toMatchObject({
      host: "mfl",
      customEngineAuthoritative: false,
    });
    expect(state.data).not.toHaveProperty("rosters");
    const legacy = await request("/v1/commands", owner.token, {
      type: "setDraftQueue",
      leagueId,
      idempotencyKey: "bad-path",
      playerIds: [],
    });
    expect(legacy.status).toBeGreaterThanOrEqual(400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
