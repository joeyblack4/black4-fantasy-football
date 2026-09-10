import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { NativeSchedules } from "../src/runtime/native-schedules.js";
import {
  NativeScheduleFeeds,
  type ScheduleFeedReader,
} from "../src/runtime/native-schedule-feeds.js";
import type { Principal } from "../src/auth.js";
let f: Awaited<ReturnType<typeof testDb>>, schedules: NativeSchedules;
const actor: Principal = {
  id: "owner",
  role: "owner",
  teamId: "one",
  leagueId: "native-feed",
};
const other: Principal = {
  id: "other",
  role: "owner",
  teamId: "two",
  leagueId: "native-feed",
};
const args = { leagueId: actor.leagueId, owners: [actor, other], baseWeek: 1 };
const receipt = (teamId: string, data: unknown) => ({
  id: "source-receipt",
  leagueId: actor.leagueId,
  teamId,
  at: new Date().toISOString(),
  synthetic: true,
  data,
});
beforeEach(async () => {
  f = await testDb();
  schedules = new NativeSchedules(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'Feeds','{}')",
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
async function primeCalendar(feeds: NativeScheduleFeeds) {
  for (const week of [1, 2])
    await feeds.save(actor.leagueId, `calendar:${week}`, "healthy", {
      week,
      lastKickoff: "2099-01-01T00:00:00Z",
    });
}
async function age(source: string) {
  await f.db.query(
    "UPDATE runtime_native_schedule_feeds SET observed_at=clock_timestamp()-interval '10 minutes' WHERE source=$1",
    [source],
  );
}
async function subscribe(owner: Principal, eventKind: string) {
  await schedules.command(owner, {
    operation: "create",
    idempotencyKey: eventKind,
    label: eventKind,
    prompt: "Inspect new league event",
    timing: { kind: "subscription", eventKind },
  });
}
it("collects one shared calendar per poll and exposes stable resolvable event IDs without guessing ambiguous dates", async () => {
  const calls: string[] = [];
  const feeds = new NativeScheduleFeeds(
    f.db,
    schedules,
    async (owner, query) => {
      calls.push(owner.teamId!);
      return receipt(owner.teamId!, {
        games: [{ id: "nfl:1:NE-SEA", kickoffAt: "2099-01-01T00:00:00Z" }],
        events: [
          {
            id: "BBID",
            type: "waiver",
            startsAt: null,
            timingStatus: "unresolved-host-value",
          },
          {
            id: "deadline",
            type: "deadline",
            startsAt: "2099-01-02T00:00:00Z",
            timingStatus: "timestamp",
          },
        ],
      });
    },
  );
  await feeds.poll(args);
  expect(calls).toHaveLength(1);
  const read = await schedules.read(other);
  expect(read.calendarEvents.map((event: any) => event.id)).toEqual([
    "nfl:1:NE-SEA",
    "mfl-calendar:deadline",
  ]);
  expect(read.feeds[0].status).toBe("healthy");
});
it("establishes a public transaction baseline, then emits only verified new awards and completed transactions", async () => {
  const rows: any[] = [
    {
      type: "WAIVER",
      timestamp: "2026-01-01T00:00:00Z",
      franchiseId: "0001",
      transaction: "old",
    },
  ];
  const feeds = new NativeScheduleFeeds(f.db, schedules, async (owner) =>
    receipt(owner.teamId!, { transactions: [...rows] }),
  );
  await primeCalendar(feeds);
  await subscribe(actor, "waiver-processed");
  await subscribe(other, "transaction-completed");
  await feeds.poll(args);
  expect((await schedules.read(actor)).occurrences).toHaveLength(0);
  rows.unshift({
    type: "BBID_WAIVER",
    timestamp: new Date().toISOString(),
    franchiseId: "0001",
    transaction: "new",
  });
  await age("transactions");
  await feeds.poll(args);
  expect((await schedules.read(actor)).occurrences).toHaveLength(1);
  expect((await schedules.read(other)).occurrences).toHaveLength(1);
  await age("transactions");
  await feeds.poll(args);
  expect((await schedules.read(actor)).occurrences).toHaveLength(1);
});
it("does not read private trades for owners who did not subscribe, and isolates incoming offer events", async () => {
  const rows: any[] = [],
    calls: string[] = [];
  const reader: ScheduleFeedReader = async (owner) => {
    calls.push(owner.teamId!);
    return receipt(owner.teamId!, rows);
  };
  const feeds = new NativeScheduleFeeds(f.db, schedules, reader);
  await primeCalendar(feeds);
  expect((await feeds.poll(args)).status).toBe("idle");
  expect(calls).toHaveLength(0);
  await subscribe(actor, "trade-offer");
  await feeds.poll(args);
  rows.push({ tradeId: "123", offeredToTeamId: "one" });
  await age("trades:one");
  await feeds.poll(args);
  expect(calls).toEqual(["one", "one"]);
  expect((await schedules.read(actor)).occurrences).toHaveLength(1);
  expect((await schedules.read(other)).occurrences).toHaveLength(0);
  expect(
    (await schedules.read(other)).feeds.some(
      (row: any) => row.source === "trades:one",
    ),
  ).toBe(false);
});
it("source failure remains unknown and preserves prior success without leaking errors or reading every owner", async () => {
  const feeds = new NativeScheduleFeeds(f.db, schedules, async () => {
    throw Error("sensitive URL token=example");
  });
  await primeCalendar(feeds);
  await age("calendar:1");
  const result = await feeds.poll(args);
  expect(result.status).toBe("failed");
  expect(result.errorCode).toBe("SOURCE_READ_FAILED");
  const read = await schedules.read(actor),
    feed = read.feeds.find((row: any) => row.source === "calendar:1");
  expect(feed?.last_success_at).toBeTruthy();
  expect(feed?.status).toBe("failed");
  expect(JSON.stringify(read)).not.toContain("sensitive");
});
it("does not call an overflowing bounded transaction window a healthy catch-up", async () => {
  let rows: any[] = [
    {
      type: "WAIVER",
      timestamp: "2026-01-01T00:00:00Z",
      franchiseId: "0001",
      transaction: "baseline-anchor",
    },
  ];
  const feeds = new NativeScheduleFeeds(f.db, schedules, async (owner) =>
    receipt(owner.teamId!, { transactions: rows }),
  );
  await primeCalendar(feeds);
  await subscribe(actor, "transaction-completed");
  await feeds.poll(args);
  const before = (
    await f.db.query(
      "SELECT cursor FROM runtime_native_schedule_feeds WHERE source='transactions'",
    )
  ).rows[0].cursor;
  rows = Array.from({ length: 200 }, (_, index) => ({
    type: "FREE_AGENT",
    timestamp: new Date().toISOString(),
    franchiseId: "0001",
    transaction: `new-${index}`,
  }));
  await age("transactions");
  const result = await feeds.poll(args);
  expect(result.status).toBe("unknown");
  expect(result.errorCode).toBe("TRANSACTION_FEED_GAP_REQUIRES_RECONCILIATION");
  const after = (
    await f.db.query(
      "SELECT cursor FROM runtime_native_schedule_feeds WHERE source='transactions'",
    )
  ).rows[0].cursor;
  expect(after.seen).toEqual(before.seen);
  expect((await schedules.read(actor)).occurrences).toHaveLength(0);
  expect(
    (await schedules.read(actor)).feeds.find(
      (row: any) => row.source === "transactions",
    )?.status,
  ).toBe("unknown");
});
it("replaces changed future recurrence dates and cancels their queued appointments while preserving delivered work", async () => {
  let start = "2099-09-10T09:00:00Z";
  const feeds = new NativeScheduleFeeds(f.db, schedules, async (owner) =>
    receipt(owner.teamId!, {
      games: [],
      events: [
        {
          id: "bbid",
          type: "WAIVER_BBID",
          startsAt: start,
          timingStatus: "timestamp",
          repeatsFollowingWeeks: 2,
        },
      ],
    }),
  );
  await feeds.poll(args);
  let events = (await schedules.read(actor)).calendarEvents;
  expect(events).toHaveLength(3);
  const oldDerived = events.find((row: any) => row.id !== "mfl-calendar:bbid");
  const appointment = await schedules.command(actor, {
    operation: "create",
    idempotencyKey: "relative",
    label: "My chosen event",
    prompt: "Inspect the event",
    timing: { kind: "event", eventId: oldDerived.id, offsetSeconds: 0 },
  });
  await f.db.query(
    "UPDATE runtime_native_schedules SET next_due_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [appointment.id],
  );
  await schedules.materializeDue(actor.leagueId);
  const delivered = await schedules.command(actor, {
    operation: "create",
    idempotencyKey: "delivered-relative",
    label: "Already delivered event",
    prompt: "Earlier event work",
    timing: { kind: "event", eventId: oldDerived.id, offsetSeconds: 0 },
  });
  await f.db.query(
    "UPDATE runtime_native_schedules SET next_due_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [delivered.id],
  );
  const materialized = await schedules.materializeDue(actor.leagueId);
  await f.db.query(
    "UPDATE runtime_native_schedule_occurrences SET status='delivered',event_id='accepted-proof' WHERE id=$1",
    [materialized.occurrenceIds[0]],
  );
  start = "2099-09-11T09:00:00Z";
  await primeCalendar(feeds);
  await age("calendar:1");
  await feeds.poll(args);
  events = (await schedules.read(actor)).calendarEvents;
  expect(events.find((row: any) => row.id === oldDerived.id)?.cancelled).toBe(
    true,
  );
  expect(events.filter((row: any) => !row.cancelled)).toHaveLength(3);
  expect(
    (await schedules.read(actor, { id: appointment.id })).occurrences[0].status,
  ).toBe("cancelled");
  expect(
    (await schedules.read(actor, { id: delivered.id })).occurrences[0].status,
  ).toBe("delivered");
});
