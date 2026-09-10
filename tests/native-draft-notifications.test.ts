import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { bindHost, getFootballHost } from "../src/league/host.js";
import { transaction } from "../src/db.js";
import {
  NativeDraftNotifications,
  nativeDraftNoticeContent,
  enqueueNativeDraftNotice,
  type NativeDraftNotice,
} from "../src/runtime/native-draft-notifications.js";
let f: Awaited<ReturnType<typeof testDb>>;
const actor = {
  id: "commissioner",
  role: "commissioner" as const,
  leagueId: "native-notice",
};
const notice: NativeDraftNotice = {
  kind: "on-clock",
  epoch: "test",
  round: 1,
  pick: 1,
  franchiseId: "0001",
  teamId: "one",
  recipientPubkey: "a".repeat(64),
  synthetic: true,
  resume: 0,
};
beforeEach(async () => {
  f = await testDb();
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'notice','{}')",
    [actor.leagueId],
  );
  await f.db.query(
    "INSERT INTO runtime_mfl_draft_observers(league_id,epoch,host_version,host_identity,adapter_scope,binding_hash,synthetic,configured_by,delivery_mode,last_state,last_observed_at) VALUES($1,'test',1,'{}','test','test',true,'commissioner','native-buzz',$2,clock_timestamp())",
    [
      actor.leagueId,
      {
        round: 1,
        pick: 1,
        franchiseId: "0001",
        paused: false,
        stopped: false,
        over: false,
      },
    ],
  );
  await bindHost(f.db, actor, {
    leagueId: actor.leagueId,
    host: "mfl",
    expectedVersion: 0,
    idempotencyKey: "fixture",
    reason: "Synthetic notice fixture",
    config: { season: 2026, leagueId: "12345", configRef: "synthetic" },
  });
  const host = await getFootballHost(f.db, actor.leagueId);
  await f.db.query("UPDATE runtime_mfl_draft_observers SET host_identity=$1", [
    host.identity,
  ]);
  await transaction(f.db, (tx) =>
    enqueueNativeDraftNotice(tx, actor.leagueId, notice),
  );
});
afterEach(async () => {
  await f.close();
});
it("concurrent delivery and reconnect send one notice only", async () => {
  let calls = 0;
  const sender = new NativeDraftNotifications(f.db, async () => {
    calls++;
    return { eventId: "b".repeat(64) };
  });
  const result = await Promise.all([
    sender.deliverOne(actor),
    sender.deliverOne(actor),
  ]);
  expect(result.filter((r) => r.status === "sent")).toHaveLength(1);
  expect(calls).toBe(1);
  expect((await sender.deliverOne(actor)).status).toBe("idle");
});
it("unknown delivery survives reconnect without another send", async () => {
  let calls = 0;
  const sender = new NativeDraftNotifications(f.db, async () => {
    calls++;
    throw Error("connection lost after possible send");
  });
  expect((await sender.deliverOne(actor)).status).toBe("uncertain");
  expect((await sender.deliverOne(actor)).status).toBe("uncertain");
  expect(calls).toBe(1);
});
it("crashed sending marker is not automatically resent", async () => {
  await f.db.query(
    "UPDATE runtime_native_draft_notifications SET status='sending'",
  );
  let calls = 0;
  const sender = new NativeDraftNotifications(f.db, async () => {
    calls++;
    return { eventId: "b".repeat(64) };
  });
  expect((await sender.deliverOne(actor)).status).toBe("uncertain");
  expect(calls).toBe(0);
});
it("pause suppresses notifications, and an obsolete clock is superseded", async () => {
  let calls = 0;
  const sender = new NativeDraftNotifications(f.db, async () => {
    calls++;
    return { eventId: "b".repeat(64) };
  });
  await f.db.query("UPDATE runtime_mfl_draft_observers SET status='held'");
  expect((await sender.deliverOne(actor)).status).toBe("held");
  await f.db.query(
    "UPDATE runtime_mfl_draft_observers SET status='active',last_state=jsonb_set(last_state,'{pick}','2')",
  );
  expect((await sender.deliverOne(actor)).status).toBe("superseded");
  expect(calls).toBe(0);
});
it("pause waits for an admitted notification, then suppresses the next one", async () => {
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r)),
    releasePromise = new Promise<void>((r) => (release = r));
  const sender = new NativeDraftNotifications(f.db, async () => {
    entered();
    await releasePromise;
    return { eventId: "b".repeat(64) };
  });
  const delivery = sender.deliverOne(actor);
  await enteredPromise;
  let paused = false;
  const pausing = transaction(f.db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
      actor.leagueId,
    ]);
    await tx.query("UPDATE runtime_mfl_draft_observers SET status='held'");
    paused = true;
  });
  expect(paused).toBe(false);
  release();
  await delivery;
  await pausing;
  expect((await sender.deliverOne(actor)).status).toBe("held");
});

it("notices identify actual MFL league and readable owner while retaining stable markers", () => {
  const scoped = {
    ...notice,
    mflLeagueId: "46625",
    teamName: "Mistral Voltage",
    rehearsal: true,
  };
  expect(nativeDraftNoticeContent(scoped)).toContain(
    "REHEARSAL — Mistral Voltage — MFL league 46625 reports your turn: round 1, pick 1",
  );
  expect(nativeDraftNoticeContent(scoped)).toContain("[draft:test:1:1:0]");
  expect(
    nativeDraftNoticeContent({
      ...scoped,
      kind: "pick-confirmed",
      playerId: "12345",
    }),
  ).toContain(
    "MFL league 46625 confirmed round 1, pick 1: Mistral Voltage selected player 12345",
  );
});

it("delivers final confirmed pick before holding a completed draft", async () => {
  await f.db.query(
    "UPDATE runtime_native_draft_notifications SET status='superseded'",
  );
  await f.db.query("UPDATE runtime_mfl_draft_observers SET last_state=$1", [
    {
      round: null,
      pick: null,
      franchiseId: null,
      paused: false,
      stopped: true,
      over: true,
    },
  ]);
  await transaction(f.db, (tx) =>
    enqueueNativeDraftNotice(tx, actor.leagueId, {
      ...notice,
      kind: "pick-confirmed",
      round: 16,
      pick: 12,
      playerId: "12345",
    }),
  );
  let content = "";
  const delivery = new NativeDraftNotifications(f.db, async (input) => {
    content = input.content;
    return { eventId: "f".repeat(64) };
  });
  expect((await delivery.deliverOne(actor)).status).toBe("sent");
  expect(content).toContain("confirmed round 16, pick 12");
});
