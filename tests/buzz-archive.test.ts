import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  BuzzArchiveService,
  nostrEventId,
  type BuzzEvent,
  type BuzzListener,
} from "../src/buzz/archive.js";
import { BuzzMessagingService } from "../src/buzz/messaging.js";
import {
  pollBuzzOnce,
  readArguments,
  createBuzzReader,
} from "../src/buzz/listener.js";
import type { Principal } from "../src/auth.js";
const leagueId = "synthetic-buzz",
  room = "12345678-1234-4234-9234-123456789abc",
  humanRoom = "22345678-1234-4234-9234-123456789abc";
const pubkeys = ["a", "b", "c", "d"].map((x) => x.repeat(64));
const commissioner: Principal = {
  id: "commissioner",
  leagueId,
  role: "commissioner",
};
const owner = (i: number): Principal => ({
  id: `owner-${i}`,
  teamId: `team-${i}`,
  leagueId,
  role: "owner",
});
const listener = (i = 0): BuzzListener => ({
  leagueId,
  communityUrl: "wss://synthetic-league.example.test",
  pubkey: pubkeys[i]!,
  mode: "mock",
});
let f: Awaited<ReturnType<typeof testDb>>, service: BuzzArchiveService;
function event(
  text: string,
  opts: Partial<Omit<BuzzEvent, "id">> = {},
): BuzzEvent {
  const fields = {
    pubkey: pubkeys[0]!,
    kind: 9,
    content: `SYNTHETIC: ${text}`,
    created_at: Math.floor(Date.now() / 1000) - 5,
    tags: [["h", room]],
    ...opts,
  };
  return { ...fields, id: nostrEventId(fields) };
}
beforeEach(async () => {
  f = await testDb();
  service = new BuzzArchiveService(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC BUZZ TEST','{}')",
    [leagueId],
  );
  for (let i = 0; i < 4; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$3,$4,$5,$6,$6,100)",
      [
        leagueId,
        `team-${i}`,
        `SYNTHETIC ${i}`,
        `owner-${i}`,
        i === 2 ? "human" : "ai",
        i,
      ],
    );
    if (i !== 2) {
      await new RuntimeStore(f.db).createAgent({
        id: `agent-${i}`,
        model: "synthetic/model",
        budgetMicros: 10000,
      });
      await f.db.query(
        "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
        [`agent-${i}`, leagueId, `team-${i}`],
      );
    }
  }
  await service.configure(commissioner, {
    leagueId,
    communityUrl: listener().communityUrl,
    mode: "mock",
    bindingReceiptId: "synthetic-test-only",
    archiveConsentReceiptId: "synthetic-onboarding-immediate-owner-observer",
    participants: pubkeys.map((pubkey, i) => ({
      pubkey,
      teamId: `team-${i}`,
      ownerId: `owner-${i}`,
      kind: i === 2 ? "human" : "agent",
      ...(i === 2
        ? {}
        : { agentId: `agent-${i}`, ownerPubkey: "e".repeat(64) }),
    })),
  });
  await service.discoverDm(listener(), {
    channelId: room,
    memberPubkeys: pubkeys.slice(0, 2),
    receiptId: "synthetic-dm-discovery",
  });
});
afterEach(async () => f?.close());
describe("private Buzz archive and listener — synthetic fixtures only", () => {
  it("deduplicates competing participant observations and atomically wakes one recipient", async () => {
    const e = event("hello");
    const input = {
      channelId: room,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [e],
      complete: true,
    };
    const results = await Promise.all([
      service.ingestBatch(listener(), input),
      service.ingestBatch(listener(1), input),
    ]);
    expect(results.reduce((s, r) => s + r.inserted, 0)).toBe(1);
    expect(results.reduce((s, r) => s + r.delivered, 0)).toBe(1);
    const jobs = (await f.db.query("SELECT * FROM runtime_jobs")).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].agent_id).toBe("agent-1");
    expect(jobs[0].payload.synthetic).toBe(true);
    const archive = await service.query(commissioner, {
      leagueId,
      channelId: room,
    });
    expect(archive.events).toHaveLength(1);
    expect(archive.events[0].event_id).toBe(e.id);
    expect(archive.events[0].observed_at).toBeInstanceOf(Date);
    await expect(
      service.query(owner(3), { leagueId, channelId: room }),
    ).rejects.toThrow("limited to participants");
    await expect(
      service.query(
        { ...commissioner, leagueId: "other" },
        { leagueId, channelId: room },
      ),
    ).rejects.toThrow("does not belong");
  });
  it("archives real-event-shaped fixtures without waking an ACP-owned recipient twice", async () => {
    await f.db.query(
      "INSERT INTO buzz_ingress_modes(league_id,agent_id,mode) VALUES($1,'agent-1','managed_acp')",
      [leagueId],
    );
    const result = await service.ingestBatch(listener(), {
      channelId: room,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [event("shared ingress")],
      complete: true,
    });
    expect(result.inserted).toBe(1);
    expect(result.delivered).toBe(0);
    expect((await f.db.query("SELECT * FROM runtime_jobs")).rowCount).toBe(0);
  });
  it("rejects unauthorized authors, tampering and changed membership without advancing the cursor", async () => {
    for (const events of [
      [event("outsider", { pubkey: "f".repeat(64) })],
      [{ ...event("original"), content: "tampered" }],
    ])
      await expect(
        service.ingestBatch(listener(), {
          channelId: room,
          memberPubkeys: pubkeys.slice(0, 2),
          events,
          complete: true,
        }),
      ).rejects.toThrow();
    await expect(
      service.ingestBatch(listener(), {
        channelId: room,
        memberPubkeys: pubkeys.slice(0, 3),
        events: [],
        complete: true,
      }),
    ).rejects.toThrow("Membership changed");
    expect(
      (await f.db.query("SELECT * FROM buzz_inbound_cursors")).rowCount,
    ).toBe(0);
  });
  it("archives an h-less deletion only through its canonical same-author target, without changing raw tags", async () => {
    const original = event("original");
    const ingest = (events: BuzzEvent[]) =>
      service.ingestBatch(listener(), {
        channelId: room,
        memberPubkeys: pubkeys.slice(0, 2),
        events,
        complete: true,
      });
    await ingest([original]);
    const deletion = event("", {
      kind: 5,
      content: "",
      tags: [["e", original.id]],
    });
    const result = await ingest([deletion]);
    expect(result.inserted).toBe(1);
    expect(result.delivered).toBe(0);
    const archive = await service.query(owner(1), {
      leagueId,
      channelId: room,
    });
    const saved = archive.events.find((e) => e.event_id === deletion.id);
    expect(saved.relation_status).toBe("valid");
    expect(saved.tags).toEqual(deletion.tags);
    expect(nostrEventId(deletion)).toBe(saved.event_id);
    expect((await ingest([deletion])).inserted).toBe(0);
  });
  it("quarantines unknown, wrong-author, and multi-target h-less deletions without poisoning normal messages", async () => {
    const original = event("known original");
    const ingest = (events: BuzzEvent[]) =>
      service.ingestBatch(listener(), {
        channelId: room,
        memberPubkeys: pubkeys.slice(0, 2),
        events,
        complete: true,
      });
    await ingest([original]);
    const unknown = event("", {
      kind: 5,
      content: "",
      tags: [["e", "f".repeat(64)]],
    });
    const wrongAuthor = event("", {
      kind: 5,
      content: "",
      pubkey: pubkeys[1]!,
      tags: [["e", original.id]],
    });
    const multiple = event("", {
      kind: 5,
      content: "",
      tags: [
        ["e", original.id],
        ["e", "f".repeat(64)],
      ],
    });
    const normal = event("useful message after deletion", {
      created_at: original.created_at + 1,
    });
    const result = await ingest([unknown, wrongAuthor, multiple, normal]);
    expect(result).toMatchObject({
      inserted: 1,
      quarantined: 3,
      delivered: 1,
      complete: true,
    });
    const evidence = await service.deletionQuarantine(commissioner, {
      leagueId,
      channelId: room,
    });
    expect(evidence.events).toHaveLength(3);
    expect(evidence.events.map((e) => e.reason).sort()).toEqual([
      "deletion_author_mismatch",
      "deletion_target_not_canonical",
      "single_deletion_target_required",
    ]);
    expect(
      evidence.events.find((e) => e.event_id === unknown.id).raw_event,
    ).toEqual(unknown);
    await expect(
      service.deletionQuarantine(owner(0), { leagueId, channelId: room }),
    ).rejects.toThrow();
    await expect(
      service.deletionQuarantine(
        { ...commissioner, leagueId: "other" },
        { leagueId, channelId: room },
      ),
    ).rejects.toThrow();
    expect(
      (await service.query(owner(1), { leagueId, channelId: room })).events,
    ).toHaveLength(2);
    expect(
      (await ingest([unknown, wrongAuthor, multiple, normal])).quarantined,
    ).toBe(0);
    expect(
      (await f.db.query("SELECT state FROM buzz_inbound_cursors")).rows[0]
        .state,
    ).toBe("healthy");
  });
  it("cannot associate an h-less deletion with a canonical target in a different conversation", async () => {
    await service.discoverDm(listener(), {
      channelId: humanRoom,
      memberPubkeys: pubkeys.slice(0, 2),
      receiptId: "synthetic-other-room",
    });
    const original = event("other room original", { tags: [["h", humanRoom]] });
    await service.ingestBatch(listener(), {
      channelId: humanRoom,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [original],
      complete: true,
    });
    const deletion = event("", {
      kind: 5,
      content: "",
      tags: [["e", original.id]],
    });
    const result = await service.ingestBatch(listener(), {
      channelId: room,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [deletion, event("still delivered")],
      complete: true,
    });
    expect(result).toMatchObject({ inserted: 1, quarantined: 1, delivered: 1 });
    const evidence = await service.deletionQuarantine(commissioner, {
      leagueId,
      channelId: room,
    });
    expect(evidence.events[0].reason).toBe(
      "deletion_target_outside_observed_channel",
    );
    expect(
      (await service.query(owner(1), { leagueId, channelId: humanRoom }))
        .events,
    ).toHaveLength(1);
  });
  it("still rejects ordinary messages without channel tags", async () => {
    await expect(
      service.ingestBatch(listener(), {
        channelId: room,
        memberPubkeys: pubkeys.slice(0, 2),
        events: [event("unscoped", { tags: [] })],
        complete: true,
      }),
    ).rejects.toThrow("Cross-channel event rejected");
    expect(
      (await f.db.query("SELECT * FROM buzz_archive_events")).rowCount,
    ).toBe(0);
  });
  it("retains edit/delete history and distinguishes invalid cross-author edits", async () => {
    const original = event("initial"),
      edit = event("correction", {
        kind: 40003,
        tags: [
          ["h", room],
          ["e", original.id],
        ],
      }),
      invalid = event("forged", {
        pubkey: pubkeys[1],
        kind: 40003,
        tags: [
          ["h", room],
          ["e", original.id],
        ],
      });
    await service.ingestBatch(listener(), {
      channelId: room,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [edit, invalid, original],
      complete: true,
    });
    const rows = (await service.query(owner(0), { leagueId, channelId: room }))
      .events;
    expect(rows.find((r) => r.event_id === original.id).content).toContain(
      "initial",
    );
    expect(rows.find((r) => r.event_id === edit.id).relation_status).toBe(
      "valid",
    );
    expect(rows.find((r) => r.event_id === invalid.id).relation_status).toBe(
      "invalid",
    );
  });
  it("uses private channels for unrelated humans and wakes only explicit recipients", async () => {
    await expect(
      service.discoverDm(listener(), {
        channelId: humanRoom,
        memberPubkeys: pubkeys.slice(0, 3),
        receiptId: "synthetic-bad-dm",
      }),
    ).rejects.toThrow("private channel");
    await service.registerChannel(commissioner, {
      leagueId,
      channelId: humanRoom,
      memberPubkeys: pubkeys.slice(0, 3),
      receiptId: "synthetic-private-room",
    });
    const events = [
      event("human request", {
        pubkey: pubkeys[2],
        tags: [
          ["h", humanRoom],
          ["p", pubkeys[1]!],
        ],
      }),
    ];
    const r = await service.ingestBatch(listener(), {
      channelId: humanRoom,
      memberPubkeys: pubkeys.slice(0, 3),
      events,
      complete: true,
    });
    expect(r.delivered).toBe(1);
    expect(
      (await f.db.query("SELECT agent_id FROM runtime_jobs")).rows.map(
        (r) => r.agent_id,
      ),
    ).toEqual(["agent-1"]);
  });
  it("polls supported commands and marks saturated history as an explicit gap", async () => {
    const report = await pollBuzzOnce(service, listener(), async (r) =>
      r.command === "dms"
        ? [{ dm_id: room, participants: pubkeys.slice(0, 2), created_at: 1 }]
        : r.command === "members"
          ? pubkeys.slice(0, 2).map((pubkey) => ({ pubkey, role: "member" }))
          : Array.from({ length: 200 }, (_, i) => event(`page-${i}`)),
    );
    expect(report.healthy).toBe(false);
    expect(report.results[0]!.complete).toBe(false);
    const c = (await service.channels(listener()))[0];
    expect(c.state).toBe("gap");
    expect(c.since_seconds).toBe("0");
    expect(
      readArguments({ command: "messages", channelId: room, since: 0 }),
    ).toContain("--kinds");
    expect(() =>
      createBuzzReader({
        listener: listener(),
        executable: "/fake",
        environment: {},
        allowNetwork: false,
      }),
    ).toThrow("explicit");
  });
  it("scopes sends and conservatively reconciles uncertain results without re-sending", async () => {
    await service.ingestBatch(listener(), {
      channelId: room,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [],
      complete: true,
    });
    const messages = new BuzzMessagingService(f.db);
    let calls = 0;
    const input = {
      leagueId,
      channelId: room,
      recipientPubkey: pubkeys[1]!,
      content: "SYNTHETIC: unknown send",
      operationKey: "uncertain-1",
    };
    const runner = async () => {
      calls++;
      throw new Error("synthetic timeout");
    };
    const sent = await messages.send(owner(0), input, runner);
    expect(sent.status).toBe("unknown");
    await messages.send(owner(0), input, runner);
    expect(calls).toBe(1);
    await service.ingestBatch(listener(), {
      channelId: room,
      memberPubkeys: pubkeys.slice(0, 2),
      events: [event("unknown send")],
      complete: true,
    });
    const reconciled = await messages.reconcile(commissioner, {
      leagueId,
      operationKey: sent.operation_key,
    });
    expect(reconciled.reconciliation.candidateEventIds).toHaveLength(1);
    expect(reconciled.status).toBe("unknown");
    expect(reconciled.mayRetry).toBe(false);
    await service.recordFailure(listener(), room);
    await expect(
      messages.send(owner(0), { ...input, operationKey: "new" }, runner),
    ).rejects.toThrow("Fresh sender");
  });
});

it("rejects a fabricated future cursor and distinguishes partial pages from no replies", async () => {
  const firstTime = Math.floor(Date.now() / 1000) - 10;
  await service.ingestBatch(listener(), {
    channelId: room,
    memberPubkeys: pubkeys.slice(0, 2),
    events: [
      event("first", { created_at: firstTime }),
      event("real peer response", {
        pubkey: pubkeys[1],
        created_at: firstTime + 1,
      }),
    ],
    complete: true,
  });
  const first = await service.query(owner(0), {
    leagueId,
    channelId: room,
    limit: 1,
  });
  expect(first.events).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  expect(BigInt(first.highWaterSequence)).toBeGreaterThan(
    BigInt(first.nextSequence),
  );
  const next = await service.query(owner(0), {
    leagueId,
    channelId: room,
    afterSequence: first.nextSequence,
    limit: 1,
  });
  expect(next.events[0].content).toContain("real peer response");
  expect(next.hasMore).toBe(false);
  const empty = await service.query(owner(0), {
    leagueId,
    channelId: room,
    afterSequence: next.nextSequence,
  });
  expect(empty.events).toEqual([]);
  expect(empty.hasMore).toBe(false);
  await expect(
    service.query(owner(0), {
      leagueId,
      channelId: room,
      afterSequence: "89400",
    }),
  ).rejects.toMatchObject({ code: "BUZZ_ARCHIVE_CURSOR_AHEAD" });
  await expect(
    service.query(owner(3), {
      leagueId,
      channelId: room,
      afterSequence: "89400",
    }),
  ).rejects.toMatchObject({ code: "BUZZ_ARCHIVE_FORBIDDEN" });
});

it("event lookup returns only the exact original with attribution and separate change metadata", async () => {
  const original = event("original owner message");
  const edit = event("later edit", {
    kind: 40003,
    tags: [
      ["h", room],
      ["e", original.id],
    ],
  });
  await service.ingestBatch(listener(), {
    channelId: room,
    memberPubkeys: pubkeys.slice(0, 2),
    events: [original, edit],
    complete: true,
  });
  const result = await service.event(owner(1), {
    leagueId,
    channelId: room,
    eventId: original.id,
  });
  expect(result.status).toBe("found");
  expect(result.event).toMatchObject({
    event_id: original.id,
    content: original.content,
    author_pubkey: original.pubkey,
    mode: "mock",
    provenance: "synthetic fixture",
  });
  expect(result.author).toEqual({
    pubkey: original.pubkey,
    agent_id: "agent-0",
    team_id: "team-0",
    kind: "agent",
  });
  expect(result.changes.known_change_count).toBe(1);
  expect(result.event.sequence).toMatch(/^\d+$/);
  expect(result.cursors[0].state).toBe("healthy");
  expect(result.archiveIsPublic).toBe(false);
  expect(JSON.stringify(result)).not.toContain(edit.content);
  await expect(
    service.event(owner(3), {
      leagueId,
      channelId: room,
      eventId: original.id,
    }),
  ).rejects.toThrow("Archive is limited");
  await expect(
    service.event(
      { ...owner(1), leagueId: "another-league" },
      { leagueId, channelId: room, eventId: original.id },
    ),
  ).rejects.toThrow();
});

it("event lookup cannot reveal an event through a different authorized channel or unknown ID", async () => {
  const original = event("private original");
  await service.ingestBatch(listener(), {
    channelId: room,
    memberPubkeys: pubkeys.slice(0, 2),
    events: [original],
    complete: true,
  });
  await service.registerChannel(commissioner, {
    leagueId,
    channelId: humanRoom,
    memberPubkeys: pubkeys.slice(0, 3),
    receiptId: "synthetic-other-channel",
  });
  for (const input of [
    { channelId: humanRoom, eventId: original.id },
    { channelId: room, eventId: "f".repeat(64) },
  ]) {
    const result = await service.event(owner(1), { leagueId, ...input });
    expect(result).toMatchObject({
      status: "not_observed",
      event: null,
      author: null,
      changes: null,
    });
    expect(JSON.stringify(result)).not.toContain(original.content);
  }
  await expect(
    service.event(owner(1), { leagueId, channelId: room, eventId: "123" }),
  ).rejects.toThrow();
});

const broadcastPolicy = () => ({
  leagueId,
  channelId: humanRoom,
  enabled: true,
  expectedVersion: 0,
  idempotencyKey: "synthetic-broadcast-enable",
  reason: "SYNTHETIC human channel announcement opt-in",
});
async function broadcastRoom() {
  await service.registerChannel(commissioner, {
    leagueId,
    channelId: humanRoom,
    memberPubkeys: pubkeys.slice(0, 3),
    receiptId: "synthetic-broadcast-members",
  });
  return service.configureHumanBroadcast(commissioner, broadcastPolicy());
}
function humanPost(text: string, at: number, extraTags: string[][] = []) {
  return event(text, {
    pubkey: pubkeys[2],
    created_at: at,
    tags: [["h", humanRoom], ...extraTags],
  });
}
const ingestHuman = (events: BuzzEvent[], i = 0) =>
  service.ingestBatch(listener(i), {
    channelId: humanRoom,
    memberPubkeys: pubkeys.slice(0, 3),
    events,
    complete: true,
  });
it("SYNTHETIC human broadcast is opt-in, fresh, same-channel and deduplicated across listeners", async () => {
  await service.registerChannel(commissioner, {
    leagueId,
    channelId: humanRoom,
    memberPubkeys: pubkeys.slice(0, 3),
    receiptId: "synthetic",
  });
  const old = humanPost("before opt-in", Math.floor(Date.now() / 1000) - 5);
  expect((await ingestHuman([old])).delivered).toBe(0);
  const configured = await service.configureHumanBroadcast(
    commissioner,
    broadcastPolicy(),
  );
  const at = Number(configured.policy.effective_after_seconds);
  expect((await ingestHuman([old])).delivered).toBe(0);
  expect(
    (await ingestHuman([humanPost("freshly observed older history", at - 1)]))
      .delivered,
  ).toBe(0);
  const post = humanPost("whole channel", at);
  const receipts = await Promise.all([
    ingestHuman([post]),
    ingestHuman([post], 1),
  ]);
  expect(receipts.reduce((n, r) => n + r.delivered, 0)).toBe(2);
  const jobs = (
    await f.db.query(
      "SELECT agent_id,payload FROM runtime_jobs ORDER BY agent_id",
    )
  ).rows;
  expect(jobs.map((j) => j.agent_id)).toEqual(["agent-0", "agent-1"]); // agent-3 is outside this channel
  expect(
    jobs.every(
      (j) =>
        j.payload.routing === "human-channel-broadcast" &&
        j.payload.eventId === post.id,
    ),
  ).toBe(true);
  expect(
    (await f.db.query("SELECT * FROM buzz_inbound_deliveries")).rowCount,
  ).toBe(2);
});
it("SYNTHETIC explicit mentions and replies stay targeted; malformed/unknown targets never broadcast", async () => {
  const at = Number((await broadcastRoom()).policy.effective_after_seconds);
  const parent = event("agent parent", {
    created_at: at,
    tags: [["h", humanRoom]],
  });
  expect((await ingestHuman([parent])).delivered).toBe(0);
  expect(
    (await ingestHuman([humanPost("mention", at, [["p", pubkeys[1]!]])]))
      .delivered,
  ).toBe(1);
  expect(
    (
      await ingestHuman([
        humanPost("reply", at, [["e", parent.id, "", "reply"]]),
      ])
    ).delivered,
  ).toBe(1);
  for (const tags of [
    [["p", "f".repeat(64)]],
    [["p"]],
    [["e", "f".repeat(64), "", "reply"]],
    [["e"]],
  ])
    expect(
      (await ingestHuman([humanPost(JSON.stringify(tags), at, tags)]))
        .delivered,
    ).toBe(0);
  expect(
    (
      await f.db.query("SELECT agent_id FROM runtime_jobs ORDER BY agent_id")
    ).rows.map((j) => j.agent_id),
  ).toEqual(["agent-0", "agent-1"]);
});
it("SYNTHETIC agent posts, changes, disabled/ACP recipients and stale human ownership cannot broadcast", async () => {
  const at = Number((await broadcastRoom()).policy.effective_after_seconds);
  await f.db.query(
    "UPDATE runtime_agents SET enabled=false WHERE id='agent-1'",
  );
  const original = humanPost("one enabled", at);
  expect((await ingestHuman([original])).delivered).toBe(1);
  await f.db.query(
    "UPDATE buzz_ingress_modes SET mode='managed_acp' WHERE agent_id='agent-0'",
  );
  expect(
    (await ingestHuman([humanPost("ACP owns ingress", at)])).delivered,
  ).toBe(0);
  expect(
    (
      await ingestHuman([
        event("agent unmentioned", {
          created_at: at,
          tags: [["h", humanRoom]],
        }),
      ])
    ).delivered,
  ).toBe(0);
  for (const kind of [40003, 9005, 5])
    expect(
      (
        await ingestHuman([
          event("change" + kind, {
            pubkey: pubkeys[2],
            kind,
            created_at: at,
            tags: [
              ["h", humanRoom],
              ["e", original.id],
            ],
          }),
        ])
      ).delivered,
    ).toBe(0);
  await f.db.query(
    "UPDATE buzz_ingress_modes SET mode='poll' WHERE agent_id='agent-0'",
  );
  await f.db.query(
    "UPDATE league_teams SET owner_id='replacement-human' WHERE id='team-2'",
  );
  expect(
    (await ingestHuman([humanPost("old human binding", at)])).delivered,
  ).toBe(0);
});
it("SYNTHETIC policy mutation requires commissioner, exact version/private channel, and replay-safe receipts", async () => {
  await expect(
    service.configureHumanBroadcast(commissioner, {
      ...broadcastPolicy(),
      channelId: room,
    }),
  ).rejects.toThrow("private channel");
  await broadcastRoom();
  await expect(
    service.configureHumanBroadcast(owner(2), broadcastPolicy()),
  ).rejects.toThrow();
  await expect(
    service.configureHumanBroadcast(
      { ...commissioner, leagueId: "other" },
      broadcastPolicy(),
    ),
  ).rejects.toThrow();
  expect(
    (await service.configureHumanBroadcast(commissioner, broadcastPolicy()))
      .replayed,
  ).toBe(true);
  await expect(
    service.configureHumanBroadcast(commissioner, {
      ...broadcastPolicy(),
      enabled: false,
    }),
  ).rejects.toThrow("idempotency conflict");
  await expect(
    service.configureHumanBroadcast(commissioner, {
      ...broadcastPolicy(),
      idempotencyKey: "new",
    }),
  ).rejects.toThrow("version conflict");
  const disabled = await service.configureHumanBroadcast(commissioner, {
    ...broadcastPolicy(),
    expectedVersion: 1,
    enabled: false,
    idempotencyKey: "disable",
  });
  expect(
    (
      await ingestHuman([
        humanPost(
          "disabled policy",
          Number(disabled.policy.effective_after_seconds),
        ),
      ])
    ).delivered,
  ).toBe(0);
  expect(
    (await f.db.query("SELECT * FROM buzz_human_broadcast_receipts")).rowCount,
  ).toBe(2);
});

it("SYNTHETIC explicit scoped polling reads only the registered private channel and skips DM discovery", async () => {
  await broadcastRoom();
  const reads: string[] = [];
  const report = await pollBuzzOnce(
    service,
    listener(),
    async (request) => {
      reads.push(request.command);
      if (request.command === "members") {
        expect(request.channelId).toBe(humanRoom);
        return pubkeys
          .slice(0, 3)
          .map((pubkey) => ({ pubkey, role: "member" }));
      }
      if (request.command === "messages") {
        expect(request.channelId).toBe(humanRoom);
        return [];
      }
      throw Error("Unexpected unscoped request");
    },
    { channelIds: [humanRoom] },
  );
  expect(report.healthy).toBe(true);
  expect(reads).toEqual(["members", "messages"]);
  for (const channelIds of [
    [],
    [room],
    [humanRoom, humanRoom],
    ["33345678-1234-4234-9234-123456789abc"],
  ]) {
    await expect(
      pollBuzzOnce(
        service,
        listener(),
        async () => {
          throw Error("Network should not run");
        },
        { channelIds },
      ),
    ).rejects.toThrow();
  }
});
