import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { FranchiseService } from "../src/franchise/service.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  XPublisher,
  validateXText,
  type XTransport,
} from "../src/publication/x-publisher.js";
let f: Awaited<ReturnType<typeof testDb>>,
  franchise: FranchiseService,
  store: RuntimeStore;
const leagueId = "synthetic-x-tests";
const commissioner: Actor = {
  id: "commissioner",
  role: "commissioner",
  leagueId,
};
const system: Actor = { id: "trusted-publisher", role: "system", leagueId };
const owner: Actor = { id: "owner0", role: "owner", leagueId, teamId: "team0" };
const dueAt = "2026-01-01T00:00:00Z";
let calls: { method: string; body?: { text: string } }[];
let transport: XTransport;
beforeEach(async () => {
  f = await testDb();
  franchise = new FranchiseService(f.db);
  store = new RuntimeStore(f.db);
  calls = [];
  await new LeagueService(f.db).execute(commissioner, {
    leagueId,
    idempotencyKey: "create",
    type: "createLeague",
    name: "Synthetic X publisher tests",
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
  await store.createAgent({
    id: "agent0",
    model: "test/x",
    budgetMicros: 1000,
  });
  await f.db.query(
    "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
    ["agent0", leagueId, "team0"],
  );
  transport = async (input) => {
    calls.push({ method: input.method, body: input.body });
    return input.method === "GET"
      ? {
          status: 200,
          body: { data: { id: "12345", username: "Black4Fantasy" } },
        }
      : {
          status: 201,
          body: { data: { id: "67890", text: input.body!.text } },
        };
  };
});
afterEach(async () => {
  await f?.close();
});
function publisher(t = transport, enabled = true) {
  return new XPublisher(f.db, {
    leagueId,
    enabled,
    userAccessToken: "synthetic-never-live-token",
    transport: t,
  });
}
async function save(
  body = "Synthetic post",
  draftId = "weekly",
  channel: "x" | "website" = "x",
) {
  return franchise.execute(owner, {
    agentId: "agent0",
    idempotencyKey: randomUUID(),
    action: {
      type: "public_draft",
      causalId: randomUUID(),
      draftId,
      title: "Synthetic metadata title",
      body,
      channel,
    },
  });
}
async function batch(
  body = "Synthetic post",
  draftId = "weekly",
  channel: "x" | "website" = "x",
) {
  const saved = await save(body, draftId, channel);
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
  await franchise.approveBatch(commissioner, {
    batchId: b.id,
    contentHash: b.content_hash,
  });
  return b;
}
it("publishes exact body once under concurrent claims, persists receipt and delivers a deduplicated owner wake", async () => {
  const b = await batch();
  const p = publisher();
  const scheduled = await p.enqueue(commissioner, { batchId: b.id, dueAt });
  expect(
    (await p.enqueue(commissioner, { batchId: b.id, dueAt })).replayed,
  ).toBe(true);
  const results = await Promise.all([p.tick(system), publisher().tick(system)]);
  expect(results.map((r) => r.status).sort()).toEqual(["idle", "published"]);
  expect(calls.filter((c) => c.method === "POST")).toEqual([
    { method: "POST", body: { text: "Synthetic post" } },
  ]);
  const rows = await p.snapshot(commissioner);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    schedule_id: scheduled.id,
    status: "published",
    tweet_id: "67890",
    user_id: "12345",
    cost_micros: null,
    billing_status: "unknown",
  });
  expect(rows[0].receipt).toMatchObject({
    status: "published",
    tweetId: "67890",
    costMicros: null,
  });
  expect(rows[0].send_started_at).toBeInstanceOf(Date);
  await p.tick(system);
  await p.deliverReceipts(system);
  expect(calls).toHaveLength(2);
  const wakes = await f.db.query(
    "SELECT * FROM runtime_jobs WHERE causal_id=$1",
    ["x-publication:" + rows[0].id],
  );
  expect(wakes.rows).toHaveLength(1);
});
it("uses server due time and rejects another scope, owner, rescheduling or non-X content", async () => {
  const b = await batch();
  const p = publisher();
  await expect(p.enqueue(owner, { batchId: b.id, dueAt })).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    p.enqueue({ ...commissioner, leagueId: "other" }, { batchId: b.id, dueAt }),
  ).rejects.toThrow("FORBIDDEN");
  const future = "2099-01-01T00:00:00Z";
  await p.enqueue(commissioner, { batchId: b.id, dueAt: future });
  expect((await p.tick(system)).status).toBe("idle");
  expect(calls).toHaveLength(0);
  await expect(
    p.enqueue(commissioner, { batchId: b.id, dueAt }),
  ).rejects.toThrow("SCHEDULE_CONFLICT");
  await expect(p.tick(commissioner)).rejects.toThrow("FORBIDDEN");
  const web = await batch("Synthetic website", "web", "website");
  await expect(
    p.enqueue(commissioner, { batchId: web.id, dueAt }),
  ).rejects.toThrow("X_TEXT_ONLY_BATCH_REQUIRED");
});
it("will not contact X after revocation or unconfigured activation", async () => {
  const b = await batch(),
    p = publisher();
  await p.enqueue(commissioner, { batchId: b.id, dueAt });
  expect((await publisher(transport, false).tick(system)).status).toBe(
    "disabled",
  );
  expect(calls).toHaveLength(0);
  await franchise.revokeBatch(commissioner, b.id);
  expect((await p.tick(system)).status).toBe("cancelled");
  expect(calls).toHaveLength(0);
});
it("rechecks approval and latest version after account lookup, including revocation while lookup runs", async () => {
  const b = await batch(),
    p = publisher(async (input) => {
      calls.push({ method: input.method });
      if (input.method === "GET") {
        await franchise.revokeBatch(commissioner, b.id);
        return {
          status: 200,
          body: { data: { id: "12345", username: "black4fantasy" } },
        };
      }
      throw Error("POST MUST NOT OCCUR");
    });
  await p.enqueue(commissioner, { batchId: b.id, dueAt });
  expect((await p.tick(system)).status).toBe("cancelled");
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
  const next = await batch("Approved old text", "versioned");
  const q = publisher(async (input) => {
    calls.push({ method: input.method });
    await save("New unapproved text", "versioned");
    return {
      status: 200,
      body: { data: { id: "12345", username: "black4fantasy" } },
    };
  });
  await q.enqueue(commissioner, { batchId: next.id, dueAt });
  expect((await q.tick(system)).status).toBe("cancelled");
  expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
});
it("rejects a different authenticated account without posting and pins the verified numeric account ID", async () => {
  const b = await batch();
  const p = publisher(async (input) => {
    calls.push({ method: input.method });
    return { status: 200, body: { data: { id: "99999", username: "joey" } } };
  });
  await p.enqueue(commissioner, { batchId: b.id, dueAt });
  expect((await p.tick(system)).status).toBe("rejected");
  expect(calls).toHaveLength(1);
  await f.db.query(
    "INSERT INTO x_publication_accounts(league_id,user_id,username) VALUES($1,'11111','black4fantasy')",
    [leagueId],
  );
  const next = await batch("Another approved text", "next");
  const q = publisher();
  await q.enqueue(commissioner, { batchId: next.id, dueAt });
  expect((await q.tick(system)).status).toBe("cancelled");
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});
it("retains unknown POST acceptance forever and halts later batch items without blind resend", async () => {
  const first = await save("First approved text", "a"),
    second = await save("Second approved text", "b");
  const b = await franchise.prepareBatch(commissioner, {
    items: [
      {
        teamId: "team0",
        draftId: "a",
        version: first.result.version,
        contentHash: first.result.contentHash,
      },
      {
        teamId: "team0",
        draftId: "b",
        version: second.result.version,
        contentHash: second.result.contentHash,
      },
    ],
  });
  await franchise.approveBatch(commissioner, {
    batchId: b.id,
    contentHash: b.content_hash,
  });
  const p = publisher(async (input) => {
    calls.push({ method: input.method });
    if (input.method === "GET")
      return {
        status: 200,
        body: { data: { id: "12345", username: "black4fantasy" } },
      };
    throw Error("provider may have accepted secret synthetic-never-live-token");
  });
  await p.enqueue(commissioner, { batchId: b.id, dueAt });
  expect((await p.tick(system)).status).toBe("uncertain");
  await p.tick(system);
  await p.tick(system);
  const rows = await p.snapshot(commissioner);
  expect(rows.map((r) => r.status)).toEqual(["uncertain", "pending"]);
  expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  expect(JSON.stringify(rows)).not.toContain("synthetic-never-live-token");
  expect(rows[0].receipt.errorCode).toBe("POST_OUTCOME_UNKNOWN");
});
it("recovers interrupted sending as uncertain and never republishes a claimed item", async () => {
  const b = await batch(),
    p = publisher();
  await p.enqueue(commissioner, { batchId: b.id, dueAt });
  await f.db.query(
    "UPDATE x_publication_items SET status='sending',attempt_id=$1,claimed_at=clock_timestamp()-interval '3 minutes'",
    [randomUUID()],
  );
  expect((await p.recover(system)).recovered).toBe(1);
  expect((await p.tick(system)).status).toBe("idle");
  expect((await p.snapshot(commissioner))[0].status).toBe("uncertain");
  expect(calls).toHaveLength(0);
});
it("rejects oversize text conservatively and never truncates or assumes Premium", async () => {
  expect(() => validateXText("a".repeat(281))).toThrow("X_TEXT_TOO_LONG");
  expect(() => validateXText("界".repeat(141))).toThrow("X_TEXT_TOO_LONG");
  expect(() => validateXText("a".repeat(260) + " x.co")).toThrow(
    "X_TEXT_TOO_LONG",
  );
  const b = await batch("a".repeat(281));
  await expect(
    publisher().enqueue(commissioner, { batchId: b.id, dueAt }),
  ).rejects.toThrow("X_TEXT_TOO_LONG");
  expect(calls).toHaveLength(0);
});
