import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  OwnerStageRuntime,
  assertOwnerStageResearchBudget,
} from "../src/runtime/owner-stage.js";
import {
  TestDriver,
  runOne,
  KnownZeroCostError,
} from "../src/runtime/worker.js";
import { FranchiseOutbox } from "../src/franchise/outbox.js";
import { FranchiseService } from "../src/franchise/service.js";
import { migrate, transaction } from "../src/db.js";
import { randomUUID } from "node:crypto";
import {
  BuzzArchiveService,
  nostrEventId,
  type BuzzEvent,
} from "../src/buzz/archive.js";
import { BuzzRuntimeOutbound } from "../src/buzz/runtime-outbound.js";
import { BuzzChannelService } from "../src/buzz/channel.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  stage: OwnerStageRuntime,
  outbox: FranchiseOutbox,
  archive: BuzzArchiveService,
  eventToAccept: BuzzEvent | undefined;
const leagueId = "owner-stage-fixture",
  room = "12345678-1234-4234-9234-123456789abc",
  pubkeys = ["a".repeat(64), "b".repeat(64)],
  stageId = "onboarding-v1";
const commissioner = {
  id: "commissioner",
  role: "commissioner" as const,
  leagueId,
};
const listener = {
  leagueId,
  pubkey: pubkeys[0]!,
  communityUrl: "wss://synthetic-onboarding.example.test",
  mode: "mock" as const,
};
const brand = {
  type: "brand" as const,
  causalId: "own-brand",
  name: "Synthetic Original",
  tagline: "A fixture only",
  description: "Synthetic owner identity",
  colors: ["#123456"],
};
const config = () => ({
  stageId,
  policyReceiptId: "SYNTHETIC approved commissioner policy",
  introChannelId: room,
  synthetic: true,
  initiativeDeadline: new Date(Date.now() + 3600000).toISOString(),
  followupDeadline: new Date(Date.now() + 7200000).toISOString(),
  allowedActions: ["brand", "remember", "schedule", "cancel", "buzz_channel"],
  readTools: [
    "research_sources",
    "research_search",
    "research_retrieve",
    "buzz_read",
  ],
  limits: { maxTurns: 8, maxSpendMicros: 100, maxReservationMicros: 20 },
});
function evt(content: string, who = 0, replyTo?: string): BuzzEvent {
  const e = {
    pubkey: pubkeys[who]!,
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [
      ["h", room],
      ["p", pubkeys[1 - who]!],
      ...(replyTo ? [["e", replyTo, "", "reply"]] : []),
    ],
  };
  return { ...e, id: nostrEventId(e) };
}
async function ingest(e: BuzzEvent) {
  return archive.ingestBatch(listener, {
    channelId: room,
    memberPubkeys: pubkeys,
    events: [e],
    complete: true,
  });
}
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  stage = new OwnerStageRuntime(f.db, store);
  archive = new BuzzArchiveService(f.db);
  eventToAccept = undefined;
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC onboarding','{}')",
    [leagueId],
  );
  for (let i = 0; i < 2; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,'ai',$4,$4,100)",
      [leagueId, `team${i}`, `owner${i}`, i],
    );
    await store.createAgent({
      id: `agent${i}`,
      model: "synthetic/onboarding",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`agent${i}`, leagueId, `team${i}`],
    );
  }
  await archive.configure(commissioner, {
    leagueId,
    communityUrl: listener.communityUrl,
    mode: "mock",
    bindingReceiptId: "SYNTHETIC binding",
    archiveConsentReceiptId: "SYNTHETIC consent",
    participants: pubkeys.map((pubkey, i) => ({
      pubkey,
      teamId: `team${i}`,
      ownerId: `owner${i}`,
      agentId: `agent${i}`,
      kind: "agent",
      ownerPubkey: "c".repeat(64),
    })),
  });
  await archive.registerChannel(commissioner, {
    leagueId,
    channelId: room,
    memberPubkeys: pubkeys,
    receiptId: "SYNTHETIC membership",
  });
  for (let i = 0; i < 2; i++)
    await new BuzzRuntimeOutbound(f.db).cutoverToPolling(commissioner, {
      leagueId,
      agentId: `agent${i}`,
      receiptId: "SYNTHETIC cutover",
    });
  const channel = new BuzzChannelService(f.db, async () => ({
    read: async () => pubkeys.map((pubkey) => ({ pubkey, role: "member" })),
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ accepted: true, event_id: eventToAccept!.id }),
    }),
  }));
  outbox = new FranchiseOutbox(f.db, store, undefined, undefined, channel);
});
afterEach(async () => {
  await f?.close();
});
async function begin() {
  await stage.configure(commissioner, config());
  await stage.wakeOwner(commissioner, "agent0");
}
async function turn(actions: any[], agentId = "agent0") {
  return runOne(
    store,
    new TestDriver("synthetic/onboarding", () => ({
      actions,
      costMicros: 0,
      summary: "Synthetic owner-stage fixture",
    })),
    "owner-stage",
    { allowedAgentIds: [agentId], maxCostMicros: 10 },
  );
}
async function drain() {
  for (let i = 0; i < 10; i++) {
    const r = await outbox.dispatchOne("stage-outbox", {
      allowedAgentIds: ["agent0"],
    });
    if (r.status === "idle") return;
    expect(r.status).toBe("delivered");
  }
  throw Error("Unbounded drain");
}
async function appointment(actions: any[] = []) {
  await begin();
  expect(
    (
      await turn([
        {
          type: "schedule",
          causalId: "original-followup",
          dueAt: new Date(Date.now() + 60000).toISOString(),
          payload: {
            kind: "onboarding.followup",
            stageId,
            task: "SYNTHETIC compare observed peer proposal against my source criteria",
          },
        },
      ])
    ).status,
  ).toBe("completed");
  await f.db.query(
    "UPDATE runtime_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE causal_id='original-followup'",
  );
  expect((await turn(actions)).status).toBe("completed");
  return (
    await f.db.query(
      "SELECT * FROM runtime_jobs WHERE causal_id='original-followup'",
    )
  ).rows[0];
}
async function noteLater() {
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "later-retrospective",
    payload: { kind: "owner.report" },
  });
  expect(
    (
      await turn([
        {
          type: "remember",
          key: "owner/onboarding-followup",
          content:
            "SYNTHETIC retrospective report; this later note did not execute the original appointment.",
        },
      ])
    ).status,
  ).toBe("completed");
}
const request = (id: string) => ({
  agentId: "agent0",
  appointmentId: id,
  reason:
    "SYNTHETIC exact completed zero-action task needs one new autonomous test",
  evidenceRef: "synthetic:completion-action-audit",
});
it("a later retrospective note cannot qualify a zero-action appointment; one reviewed new appointment can", async () => {
  const original = await appointment();
  await noteLater();
  expect((await stage.checkpoint(commissioner))[0]!.missing).toContain(
    "completed-useful-followup",
  );
  const review = await stage.authorizeFollowupRetest(
    commissioner,
    request(original.id),
  );
  expect(review).toMatchObject({
    priorActions: 0,
    priorStatus: "completed",
    automaticWake: false,
  });
  expect(
    (await stage.authorizeFollowupRetest(commissioner, request(original.id)))
      .replayed,
  ).toBe(true);
  expect(await stage.context("agent0")).toMatchObject({
    followupRetest: { priorAppointmentId: original.id },
  });
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "choose-new-test",
    payload: { kind: "owner.retest-planning" },
  });
  expect(
    (
      await turn([
        {
          type: "schedule",
          causalId: "owner-chosen-retest",
          dueAt: new Date(Date.now() + 60000).toISOString(),
          payload: {
            kind: "onboarding.followup",
            stageId,
            task: "SYNTHETIC independently inspect the source agreement and record concrete findings",
          },
        },
      ])
    ).status,
  ).toBe("completed");
  expect((await stage.checkpoint(commissioner))[0]!.missing).toContain(
    "completed-useful-followup",
  );
  await f.db.query(
    "UPDATE runtime_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE causal_id='owner-chosen-retest'",
  );
  expect(
    (
      await turn([
        {
          type: "remember",
          key: "owner/onboarding-followup",
          content:
            "SYNTHETIC performed the scheduled comparison and recorded an observed agreement and unresolved uncertainty.",
        },
      ])
    ).status,
  ).toBe("completed");
  const checkpoint = (await stage.checkpoint(commissioner))[0]!;
  expect(checkpoint.missing).not.toContain("completed-useful-followup");
  expect(checkpoint.followupProvenance?.type).toBe(
    "owner_stage.followup_memory_written",
  );
  const preserved = (
    await f.db.query(
      "SELECT status,claimed_at,completed_at FROM runtime_jobs WHERE id=$1",
      [original.id],
    )
  ).rows[0];
  expect(preserved).toEqual({
    status: original.status,
    claimed_at: original.claimed_at,
    completed_at: original.completed_at,
  });
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "attempt-third",
    payload: {},
  });
  expect(
    (
      await turn([
        {
          type: "schedule",
          causalId: "third-test",
          dueAt: new Date(Date.now() + 60000).toISOString(),
          payload: {
            kind: "onboarding.followup",
            stageId,
            task: "SYNTHETIC cannot grant myself another test",
          },
        },
      ])
    ).status,
  ).toBe("failed");
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_jobs WHERE causal_id='third-test'",
      )
    ).rowCount,
  ).toBe(0);
});
it("only a commissioner can authorize this zero-action recovery, with exact scope and an idle owner", async () => {
  const original = await appointment();
  await expect(
    stage.authorizeFollowupRetest(
      { id: "owner0", role: "owner", leagueId, teamId: "team0" },
      request(original.id),
    ),
  ).rejects.toThrow("COMMISSIONER_REQUIRED");
  await expect(
    stage.authorizeFollowupRetest(
      { ...commissioner, leagueId: "other" },
      request(original.id),
    ),
  ).rejects.toThrow("COMPLETED_FOLLOWUP_REQUIRED");
  await store.ingestEvent({ agentId: "agent0", causalId: "busy", payload: {} });
  await store.claim("busy-worker", 30000, undefined, ["agent0"]);
  await expect(
    stage.authorizeFollowupRetest(commissioner, request(original.id)),
  ).rejects.toThrow("QUIESCENT_OWNER_REQUIRED");
});
it("attests legacy completion only from matching job, memory and completion-receipt transactions without changing owner evidence", async () => {
  const original = await appointment([
    {
      type: "remember",
      key: "owner/onboarding-followup",
      content:
        "SYNTHETIC actual appointment findings, saved inside the appointment commit.",
    },
  ]);
  const before = (await stage.checkpoint(commissioner))[0]!.evidence
    .followupNote;
  await f.db.query(
    "DELETE FROM runtime_receipts WHERE type='owner_stage.followup_memory_written'",
  );
  expect((await stage.checkpoint(commissioner))[0]!.missing).toContain(
    "completed-useful-followup",
  );
  await expect(
    stage.authorizeFollowupRetest(commissioner, request(original.id)),
  ).rejects.toThrow("ZERO_ACTION_FOLLOWUP_REQUIRED");
  const attested = await stage.attestLegacyFollowup(commissioner, {
    ...request(original.id),
    reason:
      "SYNTHETIC operator verified exact legacy same-transaction authorship",
  });
  expect(attested.source).toBe("operator-attested-legacy-same-commit");
  const after = (await stage.checkpoint(commissioner))[0]!;
  expect(after.missing).not.toContain("completed-useful-followup");
  expect(after.evidence.followupNote).toEqual(before);
  expect(after.followupProvenance?.type).toBe(
    "owner_stage.followup_legacy_attested",
  );
});
it("refuses legacy attestation when a later job overwrote the note, even though its timestamp is after the appointment start", async () => {
  const original = await appointment([
    {
      type: "remember",
      key: "owner/onboarding-followup",
      content: "SYNTHETIC actual original findings.",
    },
  ]);
  await f.db.query(
    "DELETE FROM runtime_receipts WHERE type='owner_stage.followup_memory_written'",
  );
  await noteLater();
  await expect(
    stage.attestLegacyFollowup(commissioner, request(original.id)),
  ).rejects.toThrow("LEGACY_TRANSACTION_PROOF_REQUIRED");
  expect((await stage.checkpoint(commissioner))[0]!.missing).toContain(
    "completed-useful-followup",
  );
});

it("an explicit semantic-failure retest preserves the completed action but removes its qualification until a new appointment succeeds", async () => {
  const original = await appointment([
    {
      type: "remember",
      key: "owner/onboarding-followup",
      content:
        "SYNTHETIC incorrect result: treated invalid archive cursor as proof of no peer reply.",
    },
  ]);
  const before = (await stage.checkpoint(commissioner))[0]!;
  expect(before.missing).not.toContain("completed-useful-followup");
  const completion = (
    await f.db.query(
      "SELECT seq FROM runtime_receipts WHERE type='job.completed' AND job_id=$1 ORDER BY seq DESC LIMIT 1",
      [original.id],
    )
  ).rows[0];
  const semantic = {
    ...request(original.id),
    outcome: "unsupported_result" as const,
    completionReceiptSequence: String(completion.seq),
    observedFailure:
      "SYNTHETIC owner used an invalid cursor and asserted absence despite a canonical reply receipt.",
    evidenceRef: "synthetic:canonical-reply-and-invalid-cursor",
  };
  await expect(
    stage.authorizeFollowupRetest(commissioner, {
      ...semantic,
      completionReceiptSequence: "999999999",
    }),
  ).rejects.toThrow("COMPLETION_RECEIPT_MISMATCH");
  await expect(
    stage.authorizeFollowupRetest(commissioner, {
      ...request(original.id),
      outcome: "unsupported_result",
    }),
  ).rejects.toThrow("exact completion receipt");
  const disposition = await stage.authorizeFollowupRetest(
    commissioner,
    semantic,
  );
  expect(disposition).toMatchObject({
    outcome: "unsupported_result",
    priorActions: 1,
    automaticWake: false,
    priorAppointmentId: original.id,
  });
  expect((await stage.checkpoint(commissioner))[0]!.missing).toContain(
    "completed-useful-followup",
  );
  expect(
    (
      await f.db.query("SELECT status FROM runtime_jobs WHERE id=$1", [
        original.id,
      ])
    ).rows[0].status,
  ).toBe("completed");
  expect(
    (
      await f.db.query(
        "SELECT content FROM runtime_memory WHERE agent_id='agent0' AND key='owner/onboarding-followup'",
      )
    ).rows[0].content,
  ).toBe(before.evidence.followupNote!.content);
  expect(
    await stage.authorizeFollowupRetest(commissioner, semantic),
  ).toMatchObject({ replayed: true, receiptId: disposition.receiptId });
});

it.each(["completed", "dead"])(
  "permits exactly one reviewed replacement of a known-cost failed retest, ending %s",
  async (replacementOutcome) => {
    const original = await appointment([
      {
        type: "remember",
        key: "owner/onboarding-followup",
        content:
          "SYNTHETIC semantically unsupported result retained for review.",
      },
    ]);
    const completed = (
      await f.db.query(
        "SELECT seq FROM runtime_receipts WHERE type='job.completed' AND job_id=$1",
        [original.id],
      )
    ).rows[0];
    const authorization = await stage.authorizeFollowupRetest(commissioner, {
      ...request(original.id),
      outcome: "unsupported_result",
      completionReceiptSequence: String(completed.seq),
      observedFailure:
        "SYNTHETIC unsupported conclusion contradicted by the actual scoped archive.",
    });
    const schedule = (causalId: string) => ({
      type: "schedule" as const,
      causalId,
      dueAt: new Date(Date.now() + 60000).toISOString(),
      payload: {
        kind: "onboarding.followup",
        stageId,
        task: "SYNTHETIC retry actual peer comparison and record grounded findings",
      },
    });
    await store.ingestEvent({
      agentId: "agent0",
      causalId: "plan-first-retest",
      payload: {},
    });
    expect((await turn([schedule("first-retest")])).status).toBe("completed");
    await f.db.query(
      "UPDATE runtime_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE causal_id='first-retest'",
    );
    const failed = await store.claim("known-failure", 30000, undefined, [
      "agent0",
    ]);
    if (!failed) throw Error("missing retest");
    const reservation = await store.reserve(failed, 10);
    await store.fail(failed, "PROVIDER_OUTPUT_INVALID", {
      retryable: false,
      chargeKnownZero: false,
      reservationId: reservation,
      observedCostMicros: 7,
    });
    const failure = (
      await f.db.query(
        "SELECT seq FROM runtime_receipts WHERE type='job.dead' AND job_id=$1",
        [failed.id],
      )
    ).rows[0];
    const replacementRequest = {
      ...request(failed.id),
      stageId,
      failedFence: failed.fence,
      failedError: "PROVIDER_OUTPUT_INVALID",
      failureReceiptSequence: String(failure.seq),
      expectedKnownCostMicros: 7,
    };
    const planning = await store.ingestEvent({
      agentId: "agent0",
      causalId: "replacement-planning",
      payload: {},
    });
    const job = await store.claim("denied-before-review", 30000, undefined, [
      "agent0",
    ]);
    if (!job) throw Error("missing planning");
    const r = await store.reserve(job, 10);
    await expect(
      store.complete(job, {
        reservationId: r,
        driver: "synthetic/onboarding",
        actions: [schedule("too-early")],
        costMicros: 0,
        summary: "SYNTHETIC",
        synthetic: true,
      }),
    ).rejects.toMatchObject({
      code: "OWNER_STAGE_FOLLOWUP_RETEST_ALREADY_USED",
    });
    await store.fail(job, "SYNTHETIC test denial", {
      retryable: false,
      chargeKnownZero: true,
      reservationId: r,
    });
    const preserved = (
      await f.db.query(
        "SELECT id,status,error,fence FROM runtime_jobs WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[original.id, failed.id]],
      )
    ).rows;
    const money = (
      await f.db.query(
        "SELECT id,status,amount_micros,actual_micros FROM runtime_reservations WHERE job_id=$1",
        [failed.id],
      )
    ).rows;
    const counts = (
      await f.db.query("SELECT count(*)::int n FROM runtime_jobs")
    ).rows[0].n;
    await expect(
      stage.authorizeFailedFollowupRetestReplacement(
        { id: "owner0", role: "owner", leagueId, teamId: "team0" },
        replacementRequest,
      ),
    ).rejects.toThrow("COMMISSIONER_REQUIRED");
    await expect(
      stage.authorizeFailedFollowupRetestReplacement(
        { ...commissioner, leagueId: "foreign" },
        replacementRequest,
      ),
    ).rejects.toThrow("RETEST_AUTHORIZATION_REQUIRED");
    await expect(
      stage.authorizeFailedFollowupRetestReplacement(commissioner, {
        ...replacementRequest,
        failedFence: failed.fence + 1,
      }),
    ).rejects.toThrow("FENCE_MISMATCH");
    await expect(
      stage.authorizeFailedFollowupRetestReplacement(commissioner, {
        ...replacementRequest,
        failureReceiptSequence: String(completed.seq),
      }),
    ).rejects.toThrow("FAILED_RETEST_REQUIRED");
    await expect(
      stage.authorizeFailedFollowupRetestReplacement(commissioner, {
        ...replacementRequest,
        expectedKnownCostMicros: 0,
      }),
    ).rejects.toThrow("KNOWN_COST_REQUIRED");
    await f.db.query(
      "UPDATE runtime_reservations SET status='uncertain' WHERE id=$1",
      [reservation],
    );
    await expect(
      stage.authorizeFailedFollowupRetestReplacement(
        commissioner,
        replacementRequest,
      ),
    ).rejects.toThrow("KNOWN_COST_REQUIRED");
    await f.db.query(
      "UPDATE runtime_reservations SET status='settled' WHERE id=$1",
      [reservation],
    );
    const approved = await stage.authorizeFailedFollowupRetestReplacement(
      commissioner,
      replacementRequest,
    );
    expect(approved).toMatchObject({
      failedAppointmentId: failed.id,
      originalCompletedAppointmentId: original.id,
      knownCostMicros: 7,
      retestAuthorizationReceiptId: authorization.receiptId,
      automaticWake: false,
      walletUnchanged: true,
    });
    expect(
      await stage.authorizeFailedFollowupRetestReplacement(
        commissioner,
        replacementRequest,
      ),
    ).toMatchObject({ receiptId: approved.receiptId, replayed: true });
    expect(
      (await f.db.query("SELECT count(*)::int n FROM runtime_jobs")).rows[0].n,
    ).toBe(counts);
    expect(
      (
        await f.db.query(
          "SELECT id,status,error,fence FROM runtime_jobs WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[original.id, failed.id]],
        )
      ).rows,
    ).toEqual(preserved);
    expect(
      (
        await f.db.query(
          "SELECT id,status,amount_micros,actual_micros FROM runtime_reservations WHERE job_id=$1",
          [failed.id],
        )
      ).rows,
    ).toEqual(money);
    expect(await stage.context("agent0")).toMatchObject({
      followupRetest: {
        failedRetestReplacement: { receiptId: approved.receiptId },
      },
    });
    expect((await stage.checkpoint(commissioner))[0]!.missing).toContain(
      "completed-useful-followup",
    );
    await store.ingestEvent({
      agentId: "agent0",
      causalId: "approved-planning",
      payload: {},
    });
    expect((await turn([schedule("one-approved-replacement")])).status).toBe(
      "completed",
    );
    await f.db.query(
      "UPDATE runtime_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE causal_id='one-approved-replacement'",
    );
    if (replacementOutcome === "completed") {
      expect(
        (
          await turn([
            {
              type: "remember",
              key: "owner/onboarding-followup",
              content:
                "SYNTHETIC independently checked the actual reply and saved useful supported findings.",
            },
          ])
        ).status,
      ).toBe("completed");
      expect((await stage.checkpoint(commissioner))[0]!.missing).not.toContain(
        "completed-useful-followup",
      );
    } else {
      const again = await store.claim(
        "second-known-failure",
        30000,
        undefined,
        ["agent0"],
      );
      if (!again) throw Error("missing replacement");
      const cap = await store.reserve(again, 10);
      await store.fail(again, "PROVIDER_OUTPUT_INVALID", {
        retryable: false,
        chargeKnownZero: false,
        reservationId: cap,
        observedCostMicros: 3,
      });
      await store.ingestEvent({
        agentId: "agent0",
        causalId: "forbidden-third-plan",
        payload: {},
      });
      const third = await store.claim("third", 30000, undefined, ["agent0"]);
      if (!third) throw Error("missing third");
      const hold = await store.reserve(third, 10);
      await expect(
        store.complete(third, {
          reservationId: hold,
          driver: "synthetic/onboarding",
          actions: [schedule("forbidden-third")],
          costMicros: 0,
          summary: "SYNTHETIC",
          synthetic: true,
        }),
      ).rejects.toMatchObject({
        code: "OWNER_STAGE_FOLLOWUP_RETEST_ALREADY_USED",
      });
      await expect(
        stage.authorizeFailedFollowupRetestReplacement(commissioner, {
          ...replacementRequest,
          appointmentId: again.id,
        }),
      ).rejects.toThrow("REPLACEMENT_CONFLICT");
    }
  },
);
