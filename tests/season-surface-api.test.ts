import { beforeEach, afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { testDb } from "./helpers.js";
import { LeagueService } from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { NativeSchedules } from "../src/runtime/native-schedules.js";
import { bindHost } from "../src/league/host.js";
import { issueCredential } from "../src/auth.js";
import { createApiServer } from "../src/api.js";
import type { MflAdapter } from "../src/mfl/index.js";

let f: Awaited<ReturnType<typeof testDb>>,
  server: ReturnType<typeof createApiServer>,
  baseUrl: string;
let ownerToken: string, peerToken: string, adminToken: string;
const leagueId = "synthetic-season-api";
const calls: Array<{ actor: unknown; input: unknown }> = [];
async function request(path: string, token: string, input?: unknown) {
  const response = await fetch(baseUrl + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { status: response.status, data: await response.json() };
}
beforeEach(async () => {
  f = await testDb();
  calls.length = 0;
  const admin = { id: "admin", role: "commissioner" as const, leagueId };
  await new LeagueService(f.db).execute(admin, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "SYNTHETIC SEASON API",
    rules: {
      rosterSize: 2,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "QB", positions: ["QB"] }],
    },
    teams: Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`,
      ownerId: `o${index}`,
      name: `Synthetic ${index}`,
      kind: index >= 10 ? ("human" as const) : ("ai" as const),
    })),
  });
  await bindHost(f.db, admin, {
    leagueId,
    host: "mfl",
    config: {
      season: 2026,
      leagueId: "99999",
      configRef: "synthetic-season-http",
    },
    expectedVersion: 0,
    idempotencyKey: "bind",
    reason: "Synthetic season API qualification",
  });
  const runtime = new RuntimeStore(f.db);
  for (let index = 0; index < 2; index++) {
    await runtime.createAgent({
      id: `a${index}`,
      model: "test/native",
      budgetMicros: 0,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`a${index}`, leagueId, `t${index}`],
    );
  }
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  ownerToken = (
    await issueCredential(f.db, {
      id: "o0",
      role: "owner",
      leagueId,
      teamId: "t0",
    })
  ).token;
  peerToken = (
    await issueCredential(f.db, {
      id: "o1",
      role: "owner",
      leagueId,
      teamId: "t1",
    })
  ).token;
  adminToken = (await issueCredential(f.db, admin)).token;
  const fake = {
    read: async (actor: unknown, input: unknown) => {
      calls.push({ actor, input });
      return { synthetic: true, data: { interfaceVersion: "synthetic" } };
    },
  } as unknown as MflAdapter;
  server = createApiServer(f.db, { loadMfl: async () => fake });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await f?.close();
});

it("accepts new reads through the owner binding and rejects injected authority before calling MFL", async () => {
  for (const query of [
    { type: "capabilities" },
    { type: "leagueSettings" },
    { type: "calendar", week: 1 },
    { type: "validateLineup", week: 1, starters: ["01234", "01234"] },
  ]) {
    expect((await request("/v1/football/read", ownerToken, query)).status).toBe(
      200,
    );
  }
  expect(calls).toHaveLength(4);
  expect(
    calls.every(
      (call) =>
        JSON.stringify(call.actor) ===
        JSON.stringify({ id: "o0", role: "owner", leagueId, teamId: "t0" }),
    ),
  ).toBe(true);
  expect(
    (
      await request("/v1/football/read", ownerToken, {
        type: "calendar",
        week: 1,
        teamId: "t1",
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("/v1/football/read", adminToken, { type: "capabilities" }))
      .status,
  ).toBe(403);
  expect(calls).toHaveLength(4);
});

it("keeps private appointment IDs, prompts and occurrence acknowledgements isolated at HTTP boundary", async () => {
  const created = await request("/v1/owner/schedules", ownerToken, {
    operation: "create",
    idempotencyKey: "private-task",
    label: "Private label",
    prompt: "PRIVATE_COMPETITIVE_PLAN",
    timing: { kind: "once", at: "2026-01-01T00:00:00Z" },
  });
  expect(created.status).toBe(200);
  expect(
    (await request("/v1/owner/schedules", ownerToken)).data.schedules[0].prompt,
  ).toBe("PRIVATE_COMPETITIVE_PLAN");
  const peer = await request("/v1/owner/schedules", peerToken);
  expect(peer.data.schedules).toEqual([]);
  expect(peer.data.occurrences).toEqual([]);
  const probe = await request(
    `/v1/owner/schedules?id=${created.data.id}`,
    peerToken,
  );
  const absent = await request("/v1/owner/schedules?id=unknown-id", peerToken);
  expect(probe).toEqual(absent);
  expect(probe.status).toBe(404);
  expect(JSON.stringify(probe)).not.toContain("PRIVATE_COMPETITIVE_PLAN");
  expect(
    (
      await request("/v1/owner/schedules", peerToken, {
        operation: "cancel",
        idempotencyKey: "cancel-other",
        id: created.data.id,
        expectedVersion: 1,
      })
    ).status,
  ).toBe(404);
  const materialized = await new NativeSchedules(f.db).materializeDue(leagueId);
  expect(
    (
      await request("/v1/owner/schedules", peerToken, {
        operation: "acknowledge",
        idempotencyKey: "ack-other",
        occurrenceId: materialized.occurrenceIds[0],
        state: "completed",
      })
    ).status,
  ).toBe(404);
  expect((await request("/v1/owner/schedules", adminToken)).status).toBe(403);
  expect((await request("/v1/operations/schedules", ownerToken)).status).toBe(
    403,
  );
});

it("routes legacy schedule_self to a native appointment while the generic worker is disabled, without granting other-team control", async () => {
  const input = {
    causalId: "legacy-native",
    dueAt: "2026-10-01T12:00:00Z",
    payload: { label: "My follow-up", prompt: "MY_OWN_TASK" },
  };
  expect(
    (await request("/v1/agents/a1/appointments", ownerToken, input)).status,
  ).toBe(403);
  const created = await request(
    "/v1/agents/a0/appointments",
    ownerToken,
    input,
  );
  expect(created.status).toBe(200);
  expect(
    await request("/v1/agents/a0/appointments", ownerToken, input),
  ).toEqual(created);
  const state = await request("/v1/owner/schedules", ownerToken);
  expect(state.data.schedules).toHaveLength(1);
  expect(state.data.schedules[0]).toMatchObject({
    prompt: "MY_OWN_TASK",
    timing: { kind: "once", at: input.dueAt },
  });
  expect(
    Number((await f.db.query("SELECT count(*) n FROM runtime_jobs")).rows[0].n),
  ).toBe(0);
  expect(
    (await f.db.query("SELECT enabled FROM runtime_agents WHERE id='a0'"))
      .rows[0].enabled,
  ).toBe(false);
});
