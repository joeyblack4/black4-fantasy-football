import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { GovernanceService } from "../src/governance/index.js";
import { halfPprRules } from "../src/data/index.js";
import { FranchiseService } from "../src/franchise/service.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { issueCredential } from "../src/auth.js";
import { createApiServer } from "../src/api.js";
let f: Awaited<ReturnType<typeof testDb>>,
  server: Server,
  base: string,
  adminToken: string,
  ownerToken: string,
  peerToken: string,
  service: FranchiseService;
const leagueId = "operator-api-test",
  admin: Actor = { id: "admin", role: "commissioner", leagueId };
const owners = Array.from({ length: 12 }, (_, i): Actor => ({
  id: "o" + i,
  teamId: "t" + i,
  role: "owner",
  leagueId,
}));
beforeEach(async () => {
  f = await testDb();
  service = new FranchiseService(f.db);
  await new LeagueService(f.db).execute(admin, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "Synthetic operator API",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
    teams: owners.map((o, i) => ({
      id: o.teamId,
      ownerId: o.id,
      name: "Fixture " + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await new RuntimeStore(f.db).createAgent({
    id: "t0",
    model: "test/api",
    budgetMicros: 1000,
  });
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$1)",
    ["t0", leagueId],
  );
  adminToken = (await issueCredential(f.db, admin)).token;
  ownerToken = (await issueCredential(f.db, owners[0])).token;
  peerToken = (await issueCredential(f.db, owners[1])).token;
  server = createApiServer(f.db);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await f.close();
});
async function request(path: string, token = adminToken, input?: unknown) {
  const response = await fetch(base + path, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, body: await response.json() };
}
it("expense routes enforce operator mutation, owner read scope and immutable request payloads", async () => {
  const saved = await service.execute(owners[0], {
    agentId: "t0",
    idempotencyKey: "request",
    action: {
      type: "service_request",
      causalId: "request",
      service: "Synthetic subscription",
      purpose: "No external purchase",
      maxCostMicros: 700,
    },
  });
  const requestId = saved.result.requestId as string;
  await service.reviewService(admin, {
    requestId,
    decision: "approved",
    note: "Synthetic approval",
  });
  const begin = { requestId, idempotencyKey: "begin", reserveMicros: 600 };
  expect((await request("/v1/expenses/begin", ownerToken, begin)).status).toBe(
    403,
  );
  expect(
    (
      await request("/v1/expenses/begin", adminToken, {
        ...begin,
        actor: admin,
      })
    ).status,
  ).toBe(400);
  const result = await request("/v1/expenses/begin", adminToken, begin);
  expect(result.status).toBe(200);
  const expenseId = result.body.result.expenseId;
  expect(
    (
      await request("/v1/expenses/begin", adminToken, {
        ...begin,
        reserveMicros: 500,
      })
    ).status,
  ).toBe(409);
  expect((await request("/v1/expenses", ownerToken)).body).toHaveLength(1);
  expect((await request("/v1/expenses", peerToken)).body).toHaveLength(0);
  expect(
    (
      await request("/v1/expenses/uncertain", adminToken, {
        expenseId,
        idempotencyKey: "uncertain",
        evidence: "Synthetic unavailable charge outcome",
      })
    ).status,
  ).toBe(200);
  const settle = {
    expenseId,
    idempotencyKey: "settle",
    actualMicros: 500,
    invoiceReference: "synthetic/vendor/invoice-1",
    evidence: "Synthetic paid invoice evidence",
  };
  expect(
    (await request("/v1/expenses/settle", ownerToken, settle)).status,
  ).toBe(403);
  expect(
    (await request("/v1/expenses/settle", adminToken, settle)).status,
  ).toBe(200);
  expect(
    (
      await request("/v1/expenses/cancel", adminToken, {
        expenseId,
        idempotencyKey: "cancel",
        evidence: "Not enough to claim a zero charge",
      })
    ).status,
  ).toBe(400);
});
it("X endpoints only schedule/read an approved exact batch; credentials and a publisher tick cannot be injected", async () => {
  const saved = await service.execute(owners[0], {
    agentId: "t0",
    idempotencyKey: "draft",
    action: {
      type: "public_draft",
      causalId: "draft",
      draftId: "weekly",
      title: "Synthetic",
      body: "Synthetic exact approved text",
      channel: "x",
    },
  });
  const batch = await service.prepareBatch(admin, {
    items: [
      {
        teamId: "t0",
        draftId: "weekly",
        version: saved.result.version,
        contentHash: saved.result.contentHash,
      },
    ],
  });
  const input = { batchId: batch.id, dueAt: "2026-01-01T00:00:00Z" };
  expect(
    (await request("/v1/publication/x/enqueue", adminToken, input)).status,
  ).toBe(409);
  await service.approveBatch(admin, {
    batchId: batch.id,
    contentHash: batch.content_hash,
  });
  expect(
    (await request("/v1/publication/x/enqueue", ownerToken, input)).status,
  ).toBe(403);
  expect(
    (
      await request("/v1/publication/x/enqueue", adminToken, {
        ...input,
        userAccessToken: "must-not-be-accepted",
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("/v1/publication/x/enqueue", adminToken, input)).status,
  ).toBe(200);
  const rows = await request("/v1/publication/x");
  expect(rows.status).toBe(200);
  expect(rows.body[0]).toMatchObject({
    status: "pending",
    attempt_id: null,
    tweet_id: null,
  });
  expect((await request("/v1/publication/x", ownerToken)).status).toBe(403);
  expect((await request("/v1/publication/x/tick", adminToken, {})).status).toBe(
    404,
  );
  expect(
    (await request("/v1/publication/revoke", adminToken, { batchId: batch.id }))
      .status,
  ).toBe(200);
});
it("the final human review ratifies only the prepared proposal and reviewed hash, with exact-key replay", async () => {
  const governance = new GovernanceService(f.db),
    state = await new LeagueService(f.db).snapshot(leagueId);
  const exec = (actor: Actor, command: Record<string, unknown>) =>
    governance.execute(actor, {
      leagueId,
      idempotencyKey: randomUUID(),
      ...command,
    });
  await exec(admin, {
    type: "openMeeting",
    meetingId: "synthetic",
    proposalDeadline: new Date(Date.now() + 60000).toISOString(),
    voteDeadline: new Date(Date.now() + 120000).toISOString(),
  });
  await exec(owners[0], {
    type: "submitProposal",
    meetingId: "synthetic",
    proposalId: "owner-proposal",
    version: "synthetic-v1",
    title: "Synthetic constitution",
    rationale: "Test votes only",
    rules: state.league.rules,
    scoringRules: halfPprRules,
    teamOrder: owners.map((o) => o.teamId),
  });
  await f.db.query(
    "UPDATE governance_meetings SET proposal_deadline=clock_timestamp()-interval '1 second' WHERE league_id=$1",
    [leagueId],
  );
  for (const owner of owners.slice(0, 8))
    await exec(owner, {
      type: "castVote",
      proposalId: "owner-proposal",
      choice: "yes",
    });
  await f.db.query(
    "UPDATE governance_meetings SET proposal_deadline=clock_timestamp()-interval '2 seconds',vote_deadline=clock_timestamp()-interval '1 second' WHERE league_id=$1",
    [leagueId],
  );
  const prepared = await request("/v1/governance/commands", adminToken, {
    type: "prepareRatification",
    leagueId,
    idempotencyKey: "prepare",
    proposalId: "owner-proposal",
  });
  expect(prepared.status).toBe(200);
  const visible = await request("/v1/governance/meetings");
  const proposal = visible.body.meetings[0].proposals[0];
  const command = {
    type: "ratifyConstitution",
    leagueId,
    idempotencyKey: "ratify",
    version: proposal.version,
    proposalId: proposal.id,
    proposalHash: proposal.content_hash,
    decisionReceipt: prepared.body.result.decisionId,
    rules: proposal.rules,
  };
  expect((await request("/v1/commands", ownerToken, command)).status).toBe(403);
  expect(
    (
      await request("/v1/commands", adminToken, {
        ...command,
        proposalHash: "0".repeat(64),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await request("/v1/commands", adminToken, {
        ...command,
        proposalId: "another-proposal",
      })
    ).status,
  ).toBe(409);
  const ratified = await request("/v1/commands", adminToken, command);
  expect(ratified.status).toBe(200);
  expect(ratified.body.result.status).toBe("ratified");
  expect(
    (await request("/v1/commands", adminToken, command)).body.replayed,
  ).toBe(true);
  const decision = (
    await f.db.query(
      "SELECT consumed_at FROM governance_decisions WHERE id=$1",
      [prepared.body.result.decisionId],
    )
  ).rows[0];
  expect(decision.consumed_at).toBeInstanceOf(Date);
});
