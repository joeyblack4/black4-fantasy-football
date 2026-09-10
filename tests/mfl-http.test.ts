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
    // This synthetic row tests the HTTP boundary independently of worker admission.
    await f.db.query(
      "INSERT INTO runtime_rehearsals(league_id,epoch,status,request_hash,original_host,trial_host,cap_micros,synthetic,operator_evidence_ref,reason,configured_by,start_receipt_seq) VALUES($1,'chat-http','stopped','synthetic','{}','{}',100,true,'synthetic','synthetic HTTP fence','admin',0)",
      [leagueId],
    );
    await f.db.query(
      "INSERT INTO runtime_conversation_sessions(id,league_id,epoch,host_snapshot,status,configuration,request_hash,idempotency_key,expires_at,actor_id,receipt_id) VALUES('12345678-1234-4234-9234-123456789abc',$1,'chat-http','{}','active','{}','synthetic','chat',clock_timestamp()+interval '1 hour','admin','22345678-1234-4234-9234-123456789abc')",
      [leagueId],
    );
    for (const token of [owner.token, commissioner.token]) {
      for (const path of [
        "/v1/football/commands",
        "/v1/commands",
        "/v1/franchise/actions",
        "/v1/governance/commands",
        "/v1/publication/approve",
        "/v1/agents/t0/appointments",
      ]) {
        expect(await request(path, token, {})).toMatchObject({
          status: 409,
          data: { error: "CONVERSATION_NATIVE_WORK_HELD" },
        });
      }
    }
    expect(calls).toHaveLength(1);
    expect(
      (await request("/v1/football/read", owner.token, { type: "pendingBids" }))
        .status,
    ).toBe(200);
    expect(calls).toHaveLength(2);
    await f.db.query(
      "UPDATE runtime_conversation_sessions SET expires_at=clock_timestamp()-interval '1 second'",
    );
    expect(
      await request("/v1/football/commands", owner.token, {}),
    ).toMatchObject({
      status: 409,
      data: { error: "CONVERSATION_NATIVE_WORK_HELD" },
    });
    expect(calls).toHaveLength(2);
    const lock = await f.db.connect();
    try {
      // Every rejected HTTP request released its session-transition lock.
      expect(
        (
          await lock.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1,7060)) AS acquired",
            [leagueId],
          )
        ).rows[0].acquired,
      ).toBe(true);
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,7060))", [
        leagueId,
      ]);
    } finally {
      lock.release();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
