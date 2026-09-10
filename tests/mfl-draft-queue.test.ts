import { it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { transaction } from "../src/db.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { bindHost } from "../src/league/host.js";
import { MflDraftQueueService } from "../src/mfl/draft-queue.js";
async function fixture() {
  const f = await testDb(),
    leagueId = "synthetic-queue";
  const c: Actor = { id: "commissioner", role: "commissioner", leagueId },
    owner: Actor = { id: "o0", role: "owner", teamId: "t0", leagueId },
    peer: Actor = { id: "o1", role: "owner", teamId: "t1", leagueId };
  await new LeagueService(f.db).execute(c, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "Synthetic local queue",
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
    teams: Array.from({ length: 12 }, (_, i) => ({
      id: "t" + i,
      ownerId: "o" + i,
      name: "Synthetic" + i,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  const binding = {
    leagueId,
    expectedVersion: 0,
    idempotencyKey: "bind",
    reason: "Synthetic only",
    host: "mfl",
    config: { season: 2026, leagueId: "46625", configRef: "synthetic-only" },
  };
  await bindHost(f.db, c, binding);
  return {
    ...f,
    leagueId,
    c,
    owner,
    peer,
    binding,
    queues: new MflDraftQueueService(f.db),
    input: {
      leagueId,
      idempotencyKey: "owner-preferences",
      expectedVersion: 0,
      playerIds: ["13589", "13116"],
    },
  };
}
it("records private owner-authored preferences once, preserving order and explicitly avoiding native uploads or picks", async () => {
  const f = await fixture();
  try {
    const saved = await f.queues.saveQueue(f.owner, f.input);
    expect(saved.result).toMatchObject({
      version: 1,
      playerIds: ["13589", "13116"],
      source: "local-owner-preferences",
      nativeQueueUploaded: false,
      automaticPickAuthorized: false,
    });
    expect((await f.queues.saveQueue(f.owner, f.input)).replayed).toBe(true);
    expect(await f.queues.snapshot(f.owner)).toMatchObject({
      version: 1,
      playerIds: f.input.playerIds,
    });
    expect(await f.queues.snapshot(f.peer)).toMatchObject({
      version: 0,
      playerIds: [],
    });
    await expect(
      f.queues.saveQueue(f.owner, {
        ...f.input,
        playerIds: ["13116", "13589"],
      }),
    ).rejects.toMatchObject({ code: "MFL_QUEUE_IDEMPOTENCY_CONFLICT" });
    await expect(
      f.queues.saveQueue({ ...f.owner, teamId: f.peer.teamId }, f.input),
    ).rejects.toMatchObject({ code: "MFL_OWNER_BINDING_REQUIRED" });
    await expect(f.queues.saveQueue(f.c, f.input)).rejects.toMatchObject({
      code: "MFL_OWNER_BINDING_REQUIRED",
    });
    await expect(
      f.queues.saveQueue(f.owner, { ...f.input, leagueId: "foreign" }),
    ).rejects.toMatchObject({ code: "MFL_OWNER_BINDING_REQUIRED" });
    await expect(
      f.queues.saveQueue(f.owner, {
        ...f.input,
        playerIds: ["13589", "13589"],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    const verified = await transaction(f.db, (tx) =>
      f.queues.verifyReceipt(tx, f.owner, f.input, saved.receiptId),
    );
    expect(verified.receiptId).toBe(saved.receiptId);
    await expect(
      transaction(f.db, (tx) =>
        f.queues.verifyReceipt(
          tx,
          f.owner,
          { ...f.input, playerIds: ["13116"] },
          saved.receiptId,
        ),
      ),
    ).rejects.toMatchObject({ code: "MFL_QUEUE_RECEIPT_MISMATCH" });
    expect(
      (await f.db.query("SELECT * FROM mfl_draft_queue_revisions")).rows,
    ).toHaveLength(1);
    expect(
      (await f.db.query("SELECT * FROM runtime_football_outbox")).rows,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});
it("serializes competing updates, preserves past revisions and rejects stale host receipts", async () => {
  const f = await fixture();
  try {
    const saved = await f.queues.saveQueue(f.owner, f.input);
    const racing = await Promise.allSettled([
      f.queues.saveQueue(f.owner, {
        ...f.input,
        idempotencyKey: "a",
        expectedVersion: 1,
        playerIds: ["17466"],
      }),
      f.queues.saveQueue(f.owner, {
        ...f.input,
        idempotencyKey: "b",
        expectedVersion: 1,
        playerIds: [],
      }),
    ]);
    expect(racing.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await f.queues.snapshot(f.owner)).version).toBe(2);
    expect(
      (await f.db.query("SELECT * FROM mfl_draft_queue_revisions")).rows,
    ).toHaveLength(2);
    await bindHost(f.db, f.c, {
      ...f.binding,
      expectedVersion: 1,
      idempotencyKey: "new-host",
      config: { ...f.binding.config, leagueId: "12345" },
    });
    expect(await f.queues.snapshot(f.owner)).toMatchObject({
      hostVersion: 2,
      version: 0,
      playerIds: [],
    });
    await expect(f.queues.saveQueue(f.owner, f.input)).rejects.toMatchObject({
      code: "MFL_QUEUE_IDEMPOTENCY_CONFLICT",
    });
    await expect(
      transaction(f.db, (tx) =>
        f.queues.verifyReceipt(tx, f.owner, f.input, saved.receiptId),
      ),
    ).rejects.toMatchObject({ code: "MFL_QUEUE_RECEIPT_MISMATCH" });
  } finally {
    await f.close();
  }
});
