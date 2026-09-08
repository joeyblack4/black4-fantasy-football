import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { FranchiseService } from "../src/franchise/service.js";
import {
  PublicProjection,
  createPublicServer,
  publicScopeHash,
  publicScope,
} from "../src/publication/projection.js";
let f: Awaited<ReturnType<typeof testDb>>,
  projection: PublicProjection,
  franchise: FranchiseService,
  server: Server | undefined;
const leagueId = "synthetic-public-tests";
const commissioner: Actor = {
  id: "commissioner",
  role: "commissioner",
  leagueId,
};
const owner: Actor = { id: "owner0", role: "owner", leagueId, teamId: "team0" };
beforeEach(async () => {
  f = await testDb();
  projection = new PublicProjection(f.db);
  franchise = new FranchiseService(f.db);
  await new LeagueService(f.db).execute(commissioner, {
    leagueId,
    idempotencyKey: "create",
    type: "createLeague",
    name: "Synthetic public test",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: "team" + i,
      ownerId: "owner" + i,
      name: "Fixture " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await new RuntimeStore(f.db).createAgent({
    id: "agent0",
    model: "test/public",
    budgetMicros: 1000,
  });
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
    ["agent0", leagueId, "team0"],
  );
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
    server = undefined;
  }
  await f?.close();
});
async function save(
  body: string,
  draftId: string,
  approve: boolean,
  channel: "x" | "website" = "website",
) {
  const saved = await franchise.execute(owner, {
    agentId: "agent0",
    idempotencyKey: randomUUID(),
    action: {
      type: "public_draft",
      causalId: randomUUID(),
      draftId,
      title: "Title " + draftId,
      body,
      channel,
    },
  });
  const b = await franchise.prepareBatch(commissioner, {
    items: [
      {
        teamId: "team0",
        draftId,
        version: saved.result.version,
        contentHash: saved.result.contentHash,
      },
    ],
  });
  if (approve)
    await franchise.approveBatch(commissioner, {
      batchId: b.id,
      contentHash: b.content_hash,
    });
  return b;
}
async function enable(mode: "rehearsal" | "live" = "rehearsal") {
  await projection.enable(commissioner, { scopeHash: publicScopeHash, mode });
}
async function document() {
  return (
    await f.db.query(
      "SELECT document FROM public_league_snapshots WHERE league_id=$1",
      [leagueId],
    )
  ).rows[0]?.document;
}
async function start() {
  server = createPublicServer(f.db, leagueId);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw Error("address");
  return `http://127.0.0.1:${address.port}`;
}
it("requires scoped commissioner release approval and projects only explicit approved website snapshots", async () => {
  expect(await projection.refresh(leagueId)).toEqual({
    status: "not-released",
  });
  expect(await document()).toBeUndefined();
  await expect(
    projection.enable(owner, { scopeHash: publicScopeHash, mode: "rehearsal" }),
  ).rejects.toThrow("PUBLIC_RELEASE_NOT_APPROVED");
  await expect(
    projection.enable(commissioner, {
      scopeHash: "changed",
      mode: "rehearsal",
    }),
  ).rejects.toThrow("PUBLIC_RELEASE_NOT_APPROVED");
  await save("PRIVATE_UNAPPROVED_DRAFT", "private", false);
  await save("PRIVATE_X_APPROVAL_NOT_WEBSITE", "x", true, "x");
  const approved = await save("Approved literal website text", "public", true);
  await enable();
  await projection.refresh(leagueId);
  const doc = await document();
  expect(doc.excerpts).toEqual([
    {
      batchId: approved.id,
      contentHash: approved.content_hash,
      title: "Title public",
      body: "Approved literal website text",
      teamId: "team0",
    },
  ]);
  expect(JSON.stringify(doc)).not.toContain("PRIVATE_");
  expect(doc.scores).toBeNull();
  expect(doc.constitution).toBeNull();
  await franchise.revokeBatch(commissioner, approved.id);
  await projection.refresh(leagueId);
  expect((await document()).excerpts).toEqual([]);
});
it("omits credentials, private draft queues and manifest key bindings while disclosing harness and known costs", async () => {
  const manifestId = randomUUID();
  await f.db.query(
    `INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status,activated_at) VALUES($1,$2,'agent0',1,$3,'PRIVATE_KEY_FINGERPRINT','active',clock_timestamp())`,
    [
      manifestId,
      leagueId,
      {
        developer: "Test developer",
        model: "test/public",
        providerSlug: "Test endpoint",
        harnessId: "black4-owner-loop",
        harnessVersion: "v1",
        buzzBridgeVersion: "acp-test",
        openWeight: null,
        license: null,
        keyRef: "PRIVATE_KEY_REF",
        upstreamKeyHash: "PRIVATE_KEY_HASH",
      },
    ],
  );
  await f.db.query(
    `INSERT INTO provider_calls(id,manifest_id,agent_id,staff_role,purpose,requested_model,requested_provider,cost_micros) VALUES($1,$2,'agent0','owner','owner','test/public','test',123),($3,$2,'agent0','owner','owner','test/public','test',NULL)`,
    [randomUUID(), manifestId, randomUUID()],
  );
  await f.db.query(
    `INSERT INTO league_draft_queues(league_id,team_id,player_ids) VALUES($1,'team0',ARRAY['PRIVATE_QUEUE_PLAYER'])`,
    [leagueId],
  );
  await enable();
  await projection.refresh(leagueId);
  const doc = await document();
  expect(doc.models[0]).toMatchObject({
    model: "test/public",
    harness: "black4-owner-loop",
    harnessVersion: "v1",
    buzzBridgeVersion: "acp-test",
  });
  expect(doc.costs).toMatchObject({ observedMicros: "123", unresolved: 1 });
  expect(JSON.stringify(doc)).not.toContain("PRIVATE_");
  expect(JSON.stringify(publicScope.fields)).toContain("harness");
  expect(JSON.stringify(publicScope.fields)).toContain("scores");
});
it("renders committed draft, roster and lineup columns from actual schema and rejects synthetic live players", async () => {
  await f.db.query(
    "INSERT INTO league_players(league_id,id,name,positions) VALUES($1,'SYNTHETIC-1','Synthetic runner',ARRAY['RB'])",
    [leagueId],
  );
  await f.db.query(
    "INSERT INTO league_rosters(league_id,team_id,player_id) VALUES($1,'team0','SYNTHETIC-1')",
    [leagueId],
  );
  await f.db.query(
    "INSERT INTO league_draft_picks(league_id,pick_index,team_id,player_id,automatic) VALUES($1,0,'team0','SYNTHETIC-1',false)",
    [leagueId],
  );
  await f.db.query(
    "INSERT INTO league_lineups(league_id,team_id,week,slot_id,player_id) VALUES($1,'team0',1,'RB','SYNTHETIC-1')",
    [leagueId],
  );
  await enable();
  await projection.refresh(leagueId);
  const doc = await document();
  expect(doc.picks).toEqual([
    { index: 0, team: "Fixture 0", player: "Synthetic runner", position: "RB" },
  ]);
  expect(doc.lineups).toEqual([
    { teamId: "team0", week: 1, slot: "RB", playerId: "SYNTHETIC-1" },
  ]);
  expect(doc.rosters).toHaveLength(1);
  await enable("live");
  await expect(projection.refresh(leagueId)).rejects.toThrow(
    "SYNTHETIC_PLAYERS_IN_LIVE_RELEASE",
  );
});
it("fails closed for a changed approval scope, changed release mode, staleness and disabled releases", async () => {
  await enable();
  await projection.refresh(leagueId);
  const url = await start();
  expect((await fetch(url + "/league.json")).status).toBe(200);
  await f.db.query(
    "UPDATE public_league_releases SET scope_hash='obsolete' WHERE league_id=$1",
    [leagueId],
  );
  expect((await fetch(url + "/league.json")).status).toBe(503);
  await expect(projection.refresh(leagueId)).rejects.toThrow(
    "PUBLIC_SCOPE_CHANGED_REAPPROVAL_REQUIRED",
  );
  await enable("live");
  expect((await fetch(url + "/league.json")).status).toBe(503);
  await projection.refresh(leagueId);
  expect((await fetch(url + "/league.json")).status).toBe(200);
  await f.db.query(
    "UPDATE public_league_snapshots SET generated_at=clock_timestamp()-interval '46 seconds' WHERE league_id=$1",
    [leagueId],
  );
  expect((await fetch(url + "/league.json")).status).toBe(503);
  await projection.refresh(leagueId);
  await f.db.query(
    "UPDATE public_league_releases SET enabled=false WHERE league_id=$1",
    [leagueId],
  );
  expect((await fetch(url + "/league.json")).status).toBe(503);
});
it("does not publish changed batch JSON under an earlier content-hash approval", async () => {
  const b = await save("Exactly approved", "public", true);
  await enable();
  await f.db.query(
    `UPDATE franchise_publication_batches SET items=jsonb_set(items,'{0,body}','"UNAPPROVED_TAMPERED_TEXT"'::jsonb) WHERE id=$1`,
    [b.id],
  );
  await expect(projection.refresh(leagueId)).rejects.toThrow(
    "PUBLIC_BATCH_INTEGRITY_FAILURE",
  );
  expect(await document()).toBeUndefined();
});
it("public views query only sanitized tables and cannot trigger a model turn", async () => {
  await enable();
  await projection.refresh(leagueId);
  const statements: string[] = [];
  const publicDb = {
    query: async (sql: string, args: unknown[]) => {
      statements.push(sql);
      return f.db.query(sql, args);
    },
  } as unknown as typeof f.db;
  server = createPublicServer(publicDb, leagueId);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  const before = (await f.db.query("SELECT count(*)::int n FROM runtime_jobs"))
    .rows[0].n;
  for (let i = 0; i < 5; i++)
    expect((await fetch(url + "/league.json")).status).toBe(200);
  expect((await fetch(url + "/v1/owner")).status).toBe(404);
  expect((await fetch(url + "/league.json", { method: "POST" })).status).toBe(
    404,
  );
  expect(statements).toHaveLength(5);
  expect(
    statements.every(
      (s) =>
        s.includes("public_league_snapshots") &&
        s.includes("public_league_releases") &&
        !s.includes("runtime_") &&
        !s.includes("provider_"),
    ),
  ).toBe(true);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
  ).toBe(before);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM provider_calls")).rows[0].n,
  ).toBe(0);
});
