import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import {
  NativeSchedules,
  nextNativeScheduleTime,
  type NativeScheduleTransport,
} from "../src/runtime/native-schedules.js";
import type { Principal } from "../src/auth.js";
let f: Awaited<ReturnType<typeof testDb>>, schedules: NativeSchedules;
const actor: Principal = {
  id: "owner",
  role: "owner",
  teamId: "one",
  leagueId: "native-schedule",
};
const other: Principal = {
  id: "other",
  role: "owner",
  teamId: "two",
  leagueId: "native-schedule",
};
const due = {
  operation: "create",
  idempotencyKey: "create",
  label: "My check",
  prompt: "Read my current league state",
  timing: { kind: "once", at: "2026-01-01T00:00:00Z" },
};
function transport(
  overrides: Partial<NativeScheduleTransport> = {},
): NativeScheduleTransport {
  return {
    inspectOwner: async () => ({ status: "ready" }),
    send: async ({ occurrenceId }) => ({ eventId: occurrenceId }),
    reconcile: async () => ({ status: "unknown" }),
    ...overrides,
  };
}
beforeEach(async () => {
  f = await testDb();
  schedules = new NativeSchedules(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'Schedules','{}')",
    [actor.leagueId],
  );
  for (const [index, team] of ["one", "two"].entries())
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$2,'ai',$3,$3,100)",
      [actor.leagueId, team, index],
    );
});
afterEach(async () => {
  await f.close();
});
it("persists appointments and limits list, edits, receipts, and acknowledgements to the authenticated owner", async () => {
  const created = await schedules.command(actor, due);
  expect(await schedules.command(actor, due)).toEqual(created);
  await expect(
    schedules.command(actor, { ...due, prompt: "different" }),
  ).rejects.toThrow(/different schedule command/);
  expect((await new NativeSchedules(f.db).read(actor)).schedules).toHaveLength(
    1,
  );
  expect((await schedules.read(other)).schedules).toHaveLength(0);
  await expect(
    schedules.command(other, {
      operation: "cancel",
      id: created.id,
      expectedVersion: 1,
      idempotencyKey: "cancel",
    }),
  ).rejects.toThrow(/belongs/);
  const materialized = await schedules.materializeDue(actor.leagueId);
  await schedules.dispatchOne(actor.leagueId, transport());
  await expect(
    schedules.command(other, {
      operation: "acknowledge",
      occurrenceId: materialized.occurrenceIds[0],
      state: "completed",
      idempotencyKey: "ack",
    }),
  ).rejects.toThrow(/belongs/);
});
it("concurrent materializers and dispatchers create and send one stable occurrence", async () => {
  await schedules.command(actor, due);
  const created = await Promise.all([
    schedules.materializeDue(actor.leagueId),
    schedules.materializeDue(actor.leagueId),
  ]);
  expect(created.reduce((n, value) => n + value.created, 0)).toBe(1);
  let sent = 0;
  const sender = transport({
    send: async ({ occurrenceId }) => {
      sent++;
      return { eventId: occurrenceId };
    },
  });
  await Promise.all([
    schedules.dispatchOne(actor.leagueId, sender),
    schedules.dispatchOne(actor.leagueId, sender),
  ]);
  expect(sent).toBe(1);
  expect((await schedules.read(actor)).occurrences[0].status).toBe("delivered");
});
it("does not retry unknown outcomes after a restart; reconciles original occurrence", async () => {
  await schedules.command(actor, due);
  await schedules.materializeDue(actor.leagueId);
  let sent = 0;
  const sender = transport({
    send: async () => {
      sent++;
      throw Error("connection lost");
    },
  });
  expect((await schedules.dispatchOne(actor.leagueId, sender)).status).toBe(
    "uncertain",
  );
  schedules = new NativeSchedules(f.db);
  await schedules.dispatchOne(actor.leagueId, sender);
  expect(sent).toBe(1);
  const recovered = await schedules.dispatchOne(
    actor.leagueId,
    transport({
      reconcile: async ({ occurrenceId }) => ({
        status: "found",
        eventId: occurrenceId,
      }),
    }),
  );
  expect(recovered.status).toBe("delivered");
  expect(recovered.reconciled).toBe(true);
});
it("recovers a persisted sending state only after definitive absence, using the same occurrence", async () => {
  await schedules.command(actor, due);
  const result = await schedules.materializeDue(actor.leagueId);
  await f.db.query(
    "UPDATE runtime_native_schedule_occurrences SET status='sending'",
  );
  let deliveredId;
  await schedules.dispatchOne(
    actor.leagueId,
    transport({
      reconcile: async () => ({ status: "absent" }),
      send: async ({ occurrenceId }) => {
        deliveredId = occurrenceId;
        return { eventId: occurrenceId };
      },
    }),
  );
  expect(deliveredId).toBe(result.occurrenceIds[0]);
});
it("busy and explicitly stopped owners queue without interruption while another franchise can run", async () => {
  await schedules.command(actor, due);
  await schedules.command(other, due);
  await schedules.materializeDue(actor.leagueId);
  const sent: string[] = [];
  const sender = transport({
    inspectOwner: async ({ teamId }) => ({
      status: teamId === "one" ? "stopped" : "ready",
    }),
    send: async ({ teamId, occurrenceId }) => {
      sent.push(teamId);
      return { eventId: occurrenceId };
    },
  });
  await schedules.dispatchOne(actor.leagueId, sender);
  expect(sent).toEqual(["two"]);
  expect((await schedules.read(actor)).occurrences[0].status).toBe("blocked");
  await schedules.dispatchOne(
    actor.leagueId,
    transport({ inspectOwner: async () => ({ status: "busy" }) }),
  );
  expect((await schedules.read(actor)).occurrences[0].status).toBe("queued");
});
it("coalesces downtime and busy intervals, and waits for execution receipt before another delivery", async () => {
  const created = await schedules.command(actor, {
    ...due,
    timing: {
      kind: "interval",
      startAt: "2026-01-01T00:00:00Z",
      everySeconds: 60,
    },
  });
  await schedules.materializeDue(actor.leagueId);
  await f.db.query(
    "UPDATE runtime_native_schedules SET next_due_at=clock_timestamp()-interval '5 minutes' WHERE id=$1",
    [created.id],
  );
  await schedules.materializeDue(actor.leagueId);
  expect((await schedules.read(actor)).occurrences).toHaveLength(1);
  await schedules.dispatchOne(actor.leagueId, transport());
  const first = (await schedules.read(actor)).occurrences[0];
  await f.db.query(
    "UPDATE runtime_native_schedules SET next_due_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [created.id],
  );
  await schedules.materializeDue(actor.leagueId);
  expect(
    (await schedules.dispatchOne(actor.leagueId, transport())).status,
  ).toBe("idle");
  await schedules.command(actor, {
    operation: "acknowledge",
    occurrenceId: first.id,
    state: "completed",
    idempotencyKey: "ack",
  });
  expect(
    (await schedules.dispatchOne(actor.leagueId, transport())).status,
  ).toBe("delivered");
  const read = await schedules.read(actor);
  expect(
    read.occurrences.find((x: any) => x.id === first.id)?.execution_evidence
      .source,
  ).toBe("owner-acknowledged");
});
it("cancel and updates require the current version and withdraw queued work only", async () => {
  const created = await schedules.command(actor, due);
  await schedules.materializeDue(actor.leagueId);
  await expect(
    schedules.command(actor, {
      operation: "cancel",
      idempotencyKey: "bad",
      id: created.id,
      expectedVersion: 2,
    }),
  ).rejects.toThrow(/Read the current/);
  await schedules.command(actor, {
    operation: "cancel",
    idempotencyKey: "cancel",
    id: created.id,
    expectedVersion: 1,
  });
  expect(
    (await schedules.dispatchOne(actor.leagueId, transport())).status,
  ).toBe("idle");
  expect((await schedules.read(actor)).occurrences[0].status).toBe("cancelled");
});
it("calendar postponement moves undelivered appointments and cancellation stops them", async () => {
  const event = {
    id: "game-1",
    kind: "kickoff",
    occursAt: "2026-01-01T00:00:00Z",
  };
  await schedules.recordCalendarEvent(actor.leagueId, event);
  const created = await schedules.command(actor, {
    ...due,
    timing: { kind: "event", eventId: event.id, offsetSeconds: -1800 },
  });
  await schedules.materializeDue(actor.leagueId);
  await schedules.recordCalendarEvent(actor.leagueId, {
    ...event,
    occursAt: "2030-01-01T00:00:00Z",
  });
  const read = await schedules.read(actor);
  expect(read.schedules[0].nextDueAt).toBe("2029-12-31T23:30:00.000Z");
  expect(read.occurrences[0].status).toBe("cancelled");
  await schedules.recordCalendarEvent(actor.leagueId, {
    ...event,
    cancelled: true,
  });
  expect(
    (await schedules.read(actor, { id: created.id })).schedules[0].nextDueAt,
  ).toBeNull();
});
it("weekly local time survives DST changes without double firing the repeated hour", () => {
  const timing = {
    kind: "weekly" as const,
    weekdays: [0],
    time: "01:30",
    timezone: "America/Los_Angeles",
  };
  expect(
    nextNativeScheduleTime(
      timing,
      new Date("2026-11-01T07:00:00Z"),
    )?.toISOString(),
  ).toBe("2026-11-01T08:30:00.000Z");
  expect(
    nextNativeScheduleTime(
      timing,
      new Date("2026-11-01T08:30:00Z"),
    )?.toISOString(),
  ).toBe("2026-11-08T09:30:00.000Z");
  expect(
    nextNativeScheduleTime(
      { ...timing, time: "02:30" },
      new Date("2026-03-08T08:00:00Z"),
    )?.toISOString(),
  ).toBe("2026-03-15T09:30:00.000Z");
});
it("subscriptions are owner-selected, private offers reach only their owner, and event replay does not duplicate work", async () => {
  await schedules.command(actor, {
    ...due,
    timing: { kind: "subscription", eventKind: "trade-offer" },
  });
  await schedules.command(other, {
    ...due,
    timing: { kind: "subscription", eventKind: "trade-offer" },
  });
  const event = {
    id: "offer-a",
    kind: "trade-offer" as const,
    occurredAt: "2026-01-01T00:00:00Z",
    audienceTeamId: "one",
  };
  expect(
    (await schedules.recordLeagueEvent(actor.leagueId, event)).created,
  ).toBe(1);
  expect(
    (await schedules.recordLeagueEvent(actor.leagueId, event)).created,
  ).toBe(0);
  expect((await schedules.read(actor)).occurrences).toHaveLength(1);
  expect((await schedules.read(other)).occurrences).toHaveLength(0);
  await expect(
    schedules.recordLeagueEvent(actor.leagueId, {
      ...event,
      audienceTeamId: "two",
    }),
  ).rejects.toThrow(/different observed facts/);
  await expect(
    schedules.command(other, {
      ...due,
      idempotencyKey: "private",
      timing: { kind: "event", eventId: event.id, offsetSeconds: 0 },
    }),
  ).rejects.toThrow(/not available/);
  await expect(
    schedules.recordLeagueEvent(actor.leagueId, {
      ...event,
      id: "future",
      occurredAt: "2099-01-01T00:00:00Z",
    }),
  ).rejects.toThrow(/observed event/);
});
it("cancellation during runtime inspection withdraws work before any send", async () => {
  const created = await schedules.command(actor, due);
  await schedules.materializeDue(actor.leagueId);
  let sent = 0;
  await schedules.dispatchOne(
    actor.leagueId,
    transport({
      inspectOwner: async () => {
        await schedules.command(actor, {
          operation: "cancel",
          idempotencyKey: "cancel-race",
          id: created.id,
          expectedVersion: 1,
        });
        return { status: "ready" };
      },
      send: async () => {
        sent++;
        return { eventId: "unexpected" };
      },
    }),
  );
  expect(sent).toBe(0);
});
it("alternates durable inbox lanes after accepted deliveries, ignoring cancelled and blocked occurrences", async () => {
  const first = await schedules.command(actor, due);
  const cancelled = await schedules.command(actor, {
    ...due,
    idempotencyKey: "cancelled-gap",
    timing: { kind: "once", at: "2026-01-02T00:00:00Z" },
  });
  await schedules.command(actor, {
    ...due,
    idempotencyKey: "next",
    timing: { kind: "once", at: "2026-01-03T00:00:00Z" },
  });
  await schedules.materializeDue(actor.leagueId);
  await schedules.command(actor, {
    operation: "cancel",
    id: cancelled.id,
    expectedVersion: 1,
    idempotencyKey: "cancel-gap",
  });
  await schedules.dispatchOne(
    actor.leagueId,
    transport({ inspectOwner: async () => ({ status: "busy" }) }),
  );
  expect(
    (await schedules.read(actor, { id: first.id })).occurrences[0]
      .delivery_lane,
  ).toBeNull();
  const lanes: number[] = [];
  const sender = transport({
    send: async ({ occurrenceId, deliveryLane }) => {
      lanes.push(deliveryLane);
      return { eventId: occurrenceId };
    },
  });
  await schedules.dispatchOne(actor.leagueId, sender);
  const initial = (await schedules.read(actor, { id: first.id }))
    .occurrences[0];
  await schedules.command(actor, {
    operation: "acknowledge",
    occurrenceId: initial.id,
    state: "completed",
    idempotencyKey: "first-ack",
  });
  await schedules.dispatchOne(actor.leagueId, sender);
  const second = (await schedules.read(actor)).occurrences.find(
    (row: any) => row.status === "delivered",
  );
  await schedules.command(actor, {
    operation: "acknowledge",
    occurrenceId: second.id,
    state: "failed",
    idempotencyKey: "second-ack",
  });
  await schedules.command(actor, { ...due, idempotencyKey: "third" });
  await schedules.materializeDue(actor.leagueId);
  await schedules.dispatchOne(actor.leagueId, sender);
  expect(lanes).toEqual([0, 1, 0]);
});
it("persists the lane before uncertain network I/O and reconciles or retries that exact inbox", async () => {
  await schedules.command(actor, due);
  await schedules.materializeDue(actor.leagueId);
  const attempted: number[] = [];
  await schedules.dispatchOne(
    actor.leagueId,
    transport({
      send: async ({ deliveryLane, occurrenceId }) => {
        const stored = (
          await f.db.query(
            "SELECT delivery_lane,status FROM runtime_native_schedule_occurrences WHERE id=$1",
            [occurrenceId],
          )
        ).rows[0];
        expect(stored).toEqual({
          delivery_lane: deliveryLane,
          status: "sending",
        });
        attempted.push(deliveryLane);
        throw Error("uncertain");
      },
    }),
  );
  schedules = new NativeSchedules(f.db);
  const reconciled: number[] = [];
  await schedules.dispatchOne(
    actor.leagueId,
    transport({
      reconcile: async ({ deliveryLane }) => {
        reconciled.push(deliveryLane);
        return { status: "absent" };
      },
      send: async ({ deliveryLane, occurrenceId }) => {
        attempted.push(deliveryLane);
        return { eventId: occurrenceId };
      },
    }),
  );
  expect(attempted).toEqual([0, 0]);
  expect(reconciled).toEqual([0]);
});
