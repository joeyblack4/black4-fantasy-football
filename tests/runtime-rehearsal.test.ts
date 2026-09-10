import { afterEach, beforeEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  RehearsalRuntime,
  RehearsalArmSchema,
  persistedReviewSnapshotHash,
  assertRehearsalBudget,
  rehearsalUsage,
  tagRehearsalWake,
} from "../src/runtime/rehearsal.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import { FootballOutbox } from "../src/runtime/football-outbox.js";
import { bindHost, hostBinding } from "../src/league/host.js";
import { transaction } from "../src/db.js";
import { randomUUID } from "node:crypto";
import { fingerprint } from "../src/governance/validation.js";
import { hash as mflHash } from "../src/mfl/codec.js";
import { FranchiseService } from "../src/franchise/service.js";
import { GovernanceService } from "../src/governance/index.js";
import type { Db } from "../src/db.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  service: RehearsalRuntime;
const leagueId = "rehearsal-fixture",
  epoch = "draft-trial-1";
const actor = { id: "commissioner", role: "commissioner" as const, leagueId };
const config = {
  epoch,
  expectedHostVersion: 1,
  trialConfigRef: "fixture-trial46625",
  capMicros: 100,
  synthetic: true,
  operatorEvidenceRef:
    "SYNTHETIC paused processes and private trial readiness evidence",
  reason:
    "Synthetic disposable native draft rehearsal; no model or network calls",
};
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  service = new RehearsalRuntime(f.db, store);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC rehearsal','{}')",
    [leagueId],
  );
  for (let i = 0; i < 2; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,'ai',$4,$4,100)",
      [leagueId, "team" + i, "owner" + i, i],
    );
    await store.createAgent({
      id: "agent" + i,
      model: "synthetic/rehearsal",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent" + i, leagueId, "team" + i],
    );
  }
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  await bindHost(f.db, actor, {
    leagueId,
    expectedVersion: 0,
    host: "mfl",
    config: {
      season: 2026,
      leagueId: "62282",
      configRef: "fixture-production",
    },
    idempotencyKey: "original-host",
    reason: "Synthetic original production host identity",
  });
});
afterEach(async () => {
  await f?.close();
});
async function enable() {
  await f.db.query("UPDATE runtime_agents SET enabled=true");
}
async function wake(causalId: string, agentId = "agent0") {
  return service.wakeOwner(actor, {
    epoch,
    agentId,
    causalId,
    reason: "SYNTHETIC owner-authored trial draft evaluation",
  });
}
async function run(costMicros = 0, maxCostMicros = 10, actions: any[] = []) {
  return runOne(
    store,
    new TestDriver("synthetic/rehearsal", (job) => ({
      actions,
      costMicros,
      summary: JSON.stringify({ synthetic: true, provenance: job.rehearsal }),
    })),
    "fixture-worker",
    { allowedAgentIds: ["agent0"], maxCostMicros },
  );
}

it("arms a tagged epoch without cloning wallets or consuming unrelated pending work", async () => {
  await enable();
  const old = await store.ingestEvent({
    agentId: "agent0",
    causalId: "prior-production",
    payload: { privateProductionTask: true },
  });
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  const wallet = (
    await f.db.query(
      "SELECT id,budget_micros,spent_micros,reserved_micros FROM runtime_agents ORDER BY id",
    )
  ).rows;
  await expect(
    service.arm({ ...actor, role: "owner", teamId: "team0" }, config),
  ).rejects.toMatchObject({ code: "REHEARSAL_COMMISSIONER_REQUIRED" });
  const armed = await service.arm(actor, config);
  expect(armed.status).toBe("armed");
  expect(armed.trial_host.config.leagueId).toBe("46625");
  expect(armed.trial_host.version).toBe(2);
  expect((await service.arm(actor, config)).epoch).toBe(epoch);
  await expect(
    service.arm(actor, { ...config, capMicros: 101 }),
  ).rejects.toMatchObject({ code: "REHEARSAL_IDEMPOTENCY_CONFLICT" });
  expect(
    (
      await f.db.query(
        "SELECT id,budget_micros,spent_micros,reserved_micros FROM runtime_agents ORDER BY id",
      )
    ).rows,
  ).toEqual(wallet);
  await enable();
  expect((await run()).status).toBe("idle");
  const trial = await wake("owner-turn");
  expect((await run()).status).toBe("completed");
  expect(
    (await f.db.query("SELECT status FROM runtime_jobs WHERE id=$1", [old.id]))
      .rows[0].status,
  ).toBe("pending");
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='rehearsal.owner_decision' AND job_id=$1",
        [trial.id],
      )
    ).rows[0].details,
  ).toMatchObject({
    epoch,
    modelExecution: "synthetic-test",
    disposableFootball: true,
    host: { version: 2, config: { leagueId: "46625" } },
  });
});
it("enforces canonical rehearsal liability cap across model and research reservations", async () => {
  await service.arm(actor, config);
  await enable();
  await wake("spent");
  expect((await run(60, 60)).status).toBe("completed");
  const jobId = (await wake("remaining")).id;
  const job = await store.claim("reserve", 30000, undefined, ["agent0"]);
  if (!job) throw Error("missing");
  expect(job.id).toBe(jobId);
  await expect(store.reserve(job, 41)).rejects.toMatchObject({
    code: "REHEARSAL_CAP_EXHAUSTED",
  });
  const reservation = await store.reserve(job, 30);
  await expect(
    transaction(f.db, (tx) => assertRehearsalBudget(tx, job, 11)),
  ).rejects.toMatchObject({ code: "REHEARSAL_CAP_EXHAUSTED" });
  await store.fail(job, "SYNTHETIC unknown provider outcome", {
    retryable: false,
    chargeKnownZero: false,
    reservationId: reservation,
  });
  await wake("unknown-block");
  expect((await run()).status).toBe("failed");
  const wallet = (
    await f.db.query(
      "SELECT budget_micros,spent_micros,reserved_micros FROM runtime_agents WHERE id='agent0'",
    )
  ).rows[0];
  expect(wallet).toEqual({
    budget_micros: "1000",
    spent_micros: "60",
    reserved_micros: "30",
  });
  expect((await service.context("agent0"))?.usage).toMatchObject({
    committed_micros: "90",
    unresolved: 1,
  });
});
it("rejects in-flight arming, model drift and non-draft actions", async () => {
  await enable();
  await expect(service.arm(actor, config)).rejects.toMatchObject({
    code: "REHEARSAL_OWNERS_NOT_PAUSED",
  });
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  await service.arm(actor, config);
  await enable();
  await wake("no-publishing");
  expect(
    (
      await run(0, 10, [
        {
          type: "brand",
          causalId: "forbidden-brand",
          name: "Synthetic",
          tagline: "No public action",
          description: "Forbidden rehearsal action",
          colors: ["#123456"],
        },
      ])
    ).status,
  ).toBe("failed");
  expect(
    (await f.db.query("SELECT 1 FROM runtime_franchise_outbox")).rowCount,
  ).toBe(0);
  await wake("drift");
  await f.db.query(
    "UPDATE runtime_agents SET model='synthetic/other' WHERE id='agent0'",
  );
  await expect(
    store.claim("drift", 30000, undefined, ["agent0"]),
  ).rejects.toMatchObject({ code: "REHEARSAL_OWNER_DRIFT" });
});
it("restores under a new version only after native outcomes are known and never replays trial jobs", async () => {
  await service.arm(actor, config);
  await enable();
  const pending = await wake("pending-rehearsal");
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('mfl_operation',$1)",
    [
      {
        scope: "SYNTHETIC scope",
        idempotencyKey: "unknown-write",
        leagueId,
        state: "unknown",
      },
    ],
  );
  await service.stop(actor, {
    epoch,
    reason: "Stop synthetic owner workers after trial inspection",
  });
  expect(
    (
      await f.db.query("SELECT status FROM runtime_jobs WHERE id=$1", [
        pending.id,
      ])
    ).rows[0].status,
  ).toBe("cancelled");
  await expect(
    service.restore(actor, {
      epoch,
      reason: "Restore original synthetic host after reviewed trial",
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_NATIVE_OUTCOME_UNKNOWN" });
  expect((await hostBinding(f.db, leagueId)).version).toBe(2);
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('mfl_operation',$1)",
    [
      {
        scope: "SYNTHETIC scope",
        idempotencyKey: "unknown-write",
        leagueId,
        state: "rejected",
      },
    ],
  );
  await service.restore(actor, {
    epoch,
    reason: "Restore original synthetic host after reviewed trial",
  });
  expect(await hostBinding(f.db, leagueId)).toMatchObject({
    version: 3,
    config: { leagueId: "62282", configRef: "fixture-production" },
  });
  await f.db.query("UPDATE runtime_jobs SET status='pending' WHERE id=$1", [
    pending.id,
  ]);
  await enable();
  expect((await run()).status).toBe("idle");
});
it("admits only a trusted fresh observer wake for the exact trial host version", async () => {
  await service.arm(actor, config);
  await enable();
  const job = await store.ingestEvent({
    agentId: "agent0",
    causalId: "observer-wake",
    payload: { kind: "mfl.draft.turn" },
  });
  await expect(
    transaction(f.db, (tx) =>
      tagRehearsalWake(tx, {
        jobId: job.id,
        leagueId,
        hostVersion: 1,
        source: "draft-observer",
      }),
    ),
  ).rejects.toMatchObject({ code: "REHEARSAL_WAKE_HOST_MISMATCH" });
  await transaction(f.db, (tx) =>
    tagRehearsalWake(tx, {
      jobId: job.id,
      leagueId,
      hostVersion: 2,
      source: "draft-observer",
    }),
  );
  await enable();
  expect((await run()).status).toBe("completed");
});
it("coalesces verified trial queue success and blocks restore for held trial intent", async () => {
  await service.arm(actor, config);
  await enable();
  await wake("queue");
  expect(
    (
      await run(0, 10, [
        {
          type: "football",
          causalId: "local-queue",
          command: {
            type: "mflLocalDraftQueue",
            expectedVersion: 0,
            playerIds: ["12345"],
          },
        },
      ])
    ).status,
  ).toBe("completed");
  const outbox = new FootballOutbox(f.db, store);
  expect(
    (
      await outbox.dispatchOne("fixture-outbox", {
        allowedAgentIds: ["agent0"],
      })
    ).status,
  ).toBe("delivered");
  const resultWake = (
    await f.db.query(
      "SELECT j.* FROM runtime_jobs j JOIN runtime_rehearsal_jobs x ON x.job_id=j.id WHERE j.causal_id LIKE 'football-result:%'",
    )
  ).rows[0];
  expect(resultWake).toBeUndefined();
  expect((await run()).status).toBe("idle");
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='rehearsal.football_success_coalesced'",
      )
    ).rows[0].details,
  ).toMatchObject({
    epoch,
    nextWakeSource: "draft-observer",
    inferenceWakeCreated: false,
  });
  await wake("held-intent");
  expect(
    (
      await run(0, 10, [
        {
          type: "football",
          causalId: "held-draft",
          command: {
            type: "mfl",
            action: { type: "draft", round: 1, pick: 1, playerId: "12345" },
          },
        },
      ])
    ).status,
  ).toBe("completed");
  await f.db.query(
    "UPDATE runtime_football_outbox SET status='held',error='SYNTHETIC uncertain native outcome' WHERE causal_id='held-draft'",
  );
  await service.stop(actor, {
    epoch,
    reason: "Synthetic stop after one confirmed queue and held draft intent",
  });
  await expect(
    service.restore(actor, {
      epoch,
      reason:
        "Synthetic restore must wait for authoritative intent reconciliation",
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_NATIVE_INTENTS_NOT_TERMINAL" });
  expect((await hostBinding(f.db, leagueId)).version).toBe(2);
});
it("keeps arming and host-switch retries idempotent and refuses commits after an epoch stop", async () => {
  const results = await Promise.all([
    service.arm(actor, config),
    service.arm(actor, config),
  ]);
  expect(results.every((r) => r.status === "armed")).toBe(true);
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int AS n FROM league_host_receipts WHERE idempotency_key LIKE 'rehearsal:%:arm'",
      )
    ).rows[0].n,
  ).toBe(1);
  await enable();
  const initial = await wake("same-wake");
  expect((await wake("same-wake")).id).toBe(initial.id);
  const job = await store.claim("stale-commit", 30000, undefined, ["agent0"]);
  if (!job) throw Error("missing");
  const reservation = await store.reserve(job, 10);
  await expect(
    service.stop(actor, {
      epoch,
      reason: "Synthetic stop must await running owner work",
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_WORK_IN_FLIGHT" });
  await f.db.query(
    "UPDATE runtime_rehearsals SET status='stopped' WHERE league_id=$1",
    [leagueId],
  );
  await expect(
    store.complete(job, {
      reservationId: reservation,
      costMicros: 0,
      actions: [
        {
          type: "remember",
          key: "must-not-commit",
          content: "SYNTHETIC stale work",
        },
      ],
      summary: "Synthetic stale epoch",
      driver: "DETERMINISTIC_TEST_DRIVER",
      synthetic: true,
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_NOT_ARMED" });
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_memory WHERE key='must-not-commit'",
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.db.query("SELECT status FROM runtime_reservations WHERE id=$1", [
        reservation,
      ])
    ).rows[0].status,
  ).toBe("reserved");
});
it("holds the matching trial observer on stop but refuses an in-flight observation", async () => {
  const armed = await service.arm(actor, config);
  await f.db.query(
    "INSERT INTO runtime_mfl_draft_observers(league_id,epoch,host_version,host_identity,adapter_scope,binding_hash,synthetic,configured_by,lease_until) VALUES($1,'synthetic-observer',2,$2,'synthetic','fixture',true,'commissioner',clock_timestamp()+interval '1 minute')",
    [leagueId, armed.trial_host.config],
  );
  await expect(
    service.stop(actor, {
      epoch,
      reason: "Synthetic graceful stop waits for observer completion",
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_OBSERVER_IN_FLIGHT" });
  await f.db.query(
    "UPDATE runtime_mfl_draft_observers SET lease_until=NULL WHERE league_id=$1",
    [leagueId],
  );
  await service.stop(actor, {
    epoch,
    reason: "Synthetic graceful stop after observer completion",
  });
  expect(
    (
      await f.db.query(
        "SELECT status,hold_reason,fence FROM runtime_mfl_draft_observers WHERE league_id=$1",
        [leagueId],
      )
    ).rows[0],
  ).toEqual({ status: "held", hold_reason: "REHEARSAL_STOPPED", fence: 1 });
});
it("requires the full current owner set and a matching live onboarding closure before live-mode arm", async () => {
  const liveConfig = { ...config, synthetic: false };
  await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
    code: "REHEARSAL_TWELVE_TEAMS_TEN_OWNERS_REQUIRED",
  });
  for (let i = 2; i < 12; i++) {
    const kind = i < 10 ? "ai" : "human";
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,$4,$5,$5,100)",
      [leagueId, "team" + i, "owner" + i, kind, i],
    );
    await store.createAgent({
      id: "agent" + i,
      model: "fixture-live/model-" + i,
      budgetMicros: 1000,
      kind,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent" + i, leagueId, "team" + i],
    );
  }
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
    code: "REHEARSAL_CLOSED_ONBOARDING_REQUIRED",
  });
  const stageId = "synthetic-evidence-live-contract",
    charter = "SYNTHETIC test charter; no actual owner qualification claimed",
    assignment = "SYNTHETIC fixture only";
  const stageConfig = {
    stageId,
    policyReceiptId: "SYNTHETIC reviewed policy",
    introChannelId: randomUUID(),
    initiativeDeadline: new Date(Date.now() + 3600000).toISOString(),
    followupDeadline: new Date(Date.now() + 7200000).toISOString(),
    synthetic: false,
    allowedActions: ["brand", "remember", "schedule", "cancel", "buzz_channel"],
    readTools: [
      "research_sources",
      "research_search",
      "research_retrieve",
      "buzz_read",
    ],
    limits: { maxTurns: 8, maxSpendMicros: 100, maxReservationMicros: 20 },
  };
  await f.db.query(
    "INSERT INTO runtime_owner_stages(league_id,id,stage,status,configuration,charter,assignment,content_hash,configured_by,receipt_id) VALUES($1,$2,'onboarding','reviewed',$3,$4,$5,$6,'commissioner',$7)",
    [
      leagueId,
      stageId,
      stageConfig,
      charter,
      assignment,
      fingerprint({ config: stageConfig, charter, assignment }),
      randomUUID(),
    ],
  );
  await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
    code: "REHEARSAL_TEN_CLOSED_REVIEWS_REQUIRED",
  });
  const ownerReviews = [];
  for (let i = 0; i < 10; i++) {
    const agentId = "agent" + i,
      model = "fixture-live/model-" + i;
    await f.db.query("UPDATE runtime_agents SET model=$2 WHERE id=$1", [
      agentId,
      model,
    ]);
    await f.db.query(
      "INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status) VALUES($1,$2,$3,1,$4,'SYNTHETIC-fingerprint','active')",
      [randomUUID(), leagueId, agentId, { model }],
    );
    const brand = await new FranchiseService(f.db).execute(
      { id: "owner" + i, role: "owner", leagueId, teamId: "team" + i },
      {
        agentId,
        idempotencyKey: "SYNTHETIC-brand",
        action: {
          type: "brand",
          causalId: "brand",
          name: "Synthetic fixture " + i,
          tagline: "Fixture only",
          description: "No real brand decision or qualification claimed",
          colors: ["#123456"],
        },
      },
    );
    const evidence = {
        brand: { receiptId: brand.receiptId },
        fixtureOnly: true,
        observedAt: new Date("2026-09-08T06:00:00.000Z"),
        nested: [{ completedAt: new Date("2026-09-08T06:01:00.000Z") }],
      },
      evidenceHash = fingerprint(evidence),
      reviewReceiptId = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_owner_stage_reviews(league_id,stage_id,agent_id,evidence_hash,evidence,note,reviewed_by,receipt_id) VALUES($1,$2,$3,$4,$5,'SYNTHETIC review fixture','commissioner',$6)",
      [leagueId, stageId, agentId, evidenceHash, evidence, reviewReceiptId],
    );
    ownerReviews.push({
      agentId,
      reviewReceiptId,
      evidenceHash,
      researchStatus: "verified",
    });
  }
  const closure = {
    receiptId: randomUUID(),
    leagueId,
    stageId,
    status: "reviewed",
    ownerReviews,
  };
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.closed',$1)",
    [closure],
  );
  await f.db.query(
    "UPDATE league_teams SET owner_id='replacement-unreviewed-owner' WHERE league_id=$1 AND id='team0'",
    [leagueId],
  );
  await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
    code: "REHEARSAL_CURRENT_OWNER_REVIEWS_REQUIRED",
  });
  await f.db.query(
    "UPDATE league_teams SET owner_id='owner0' WHERE league_id=$1 AND id='team0'",
    [leagueId],
  );
  await f.db.query(
    "UPDATE runtime_owner_stage_reviews SET evidence_hash='tampered' WHERE agent_id='agent0'",
  );
  await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
    code: "REHEARSAL_CURRENT_OWNER_REVIEWS_REQUIRED",
  });
  await f.db.query(
    "UPDATE runtime_owner_stage_reviews SET evidence_hash=$1 WHERE agent_id='agent0'",
    [ownerReviews[0]!.evidenceHash],
  );
  const before = (
    await f.db.query(
      "SELECT * FROM runtime_owner_stage_reviews ORDER BY agent_id",
    )
  ).rows;
  expect(
    before.every(
      (r) => r.evidence_hash !== persistedReviewSnapshotHash(r.evidence),
    ),
  ).toBe(true);
  const attestationRequest = {
    stageId,
    closureReceiptId: closure.receiptId,
    idempotencyKey: "synthetic-review-date-roundtrip",
    expectedReviews: before.map((r) => ({
      agentId: r.agent_id,
      reviewReceiptId: r.receipt_id,
      legacyEvidenceHash: r.evidence_hash,
      persistedSnapshotHash: persistedReviewSnapshotHash(r.evidence),
    })),
    reason:
      "SYNTHETIC explicit review of preserved persisted snapshot timestamps",
    evidenceRef: "synthetic:review-date-diagnosis",
  };
  await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
    code: "REHEARSAL_REVIEW_SNAPSHOT_ATTESTATION_REQUIRED",
  });
  await expect(
    service.attestClosedReviewSnapshots(
      { ...actor, role: "owner", teamId: "team0" },
      attestationRequest,
    ),
  ).rejects.toMatchObject({ code: "REHEARSAL_COMMISSIONER_REQUIRED" });
  await expect(
    service.attestClosedReviewSnapshots(actor, {
      ...attestationRequest,
      closureReceiptId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_CLOSED_REVIEW_SCOPE_MISMATCH" });
  await expect(
    service.attestClosedReviewSnapshots(actor, {
      ...attestationRequest,
      expectedReviews: attestationRequest.expectedReviews.map((r, i) =>
        i === 0 ? { ...r, persistedSnapshotHash: "0".repeat(64) } : r,
      ),
    }),
  ).rejects.toMatchObject({
    code: "REHEARSAL_EXPECTED_REVIEW_SNAPSHOT_MISMATCH",
  });
  await expect(
    service.attestClosedReviewSnapshots(actor, {
      ...attestationRequest,
      expectedReviews: Array(10).fill(attestationRequest.expectedReviews[0]),
    }),
  ).rejects.toMatchObject({
    code: "REHEARSAL_TEN_DISTINCT_REVIEW_SNAPSHOTS_REQUIRED",
  });
  const attested = await service.attestClosedReviewSnapshots(
    actor,
    attestationRequest,
  );
  expect(attested).toMatchObject({
    algorithm: "json-persisted-v1",
    legacyHashesUnchanged: true,
    reviewProjectionsUnchanged: true,
    closureUnchanged: true,
    automaticWake: false,
  });
  expect(
    await service.attestClosedReviewSnapshots(actor, attestationRequest),
  ).toMatchObject({ receiptId: attested.receiptId, replayed: true });
  expect(
    (
      await f.db.query(
        "SELECT * FROM runtime_owner_stage_reviews ORDER BY agent_id",
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='owner_stage.closed'",
      )
    ).rows[0].details,
  ).toEqual(closure);
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_receipts WHERE type='rehearsal.review_snapshots_attested'",
      )
    ).rowCount,
  ).toBe(1);
  for (const [path, value] of [
    ["{observedAt}", "2026-09-08T06:00:00.001Z"],
    ["{nested,0,completedAt}", "2026-09-08T06:01:00.001Z"],
    ["{fixtureOnly}", false],
  ] as const) {
    await f.db.query(
      "UPDATE runtime_owner_stage_reviews SET evidence=jsonb_set(evidence,$1::text[],$2::jsonb) WHERE agent_id='agent0'",
      [path, JSON.stringify(value)],
    );
    await expect(service.arm(actor, liveConfig)).rejects.toMatchObject({
      code: "REHEARSAL_REVIEW_SNAPSHOT_CHANGED",
    });
    await expect(
      service.attestClosedReviewSnapshots(actor, attestationRequest),
    ).rejects.toMatchObject({
      code: "REHEARSAL_EXPECTED_REVIEW_SNAPSHOT_MISMATCH",
    });
    await f.db.query(
      "UPDATE runtime_owner_stage_reviews SET evidence=$1 WHERE agent_id='agent0'",
      [before.find((r) => r.agent_id === "agent0").evidence],
    );
  }
  await expect(
    service.attestClosedReviewSnapshots(actor, {
      ...attestationRequest,
      idempotencyKey: "cannot-re-attest-changed-review",
    }),
  ).rejects.toMatchObject({ code: "REHEARSAL_REVIEW_ATTESTATION_CONFLICT" });
  const preparedDecision = await prepareRulesFixture();
  expect(
    (await service.arm(actor, { ...liveConfig, preparedDecision })).status,
  ).toBe("armed");
  const allContexts = await Promise.all(
    Array.from({ length: 10 }, (_, i) => service.context("agent" + i)),
  );
  expect(
    allContexts.every(
      (c) =>
        JSON.stringify(c!.preparedRules) ===
        JSON.stringify(allContexts[0]!.preparedRules),
    ),
  ).toBe(true);
  expect(allContexts[0]!.preparedRules).toMatchObject({
    status: "provisional-trial-fixture",
    productionRatificationPerformed: false,
    proposal: {
      id: preparedDecision.proposalId,
      selections: {
        scoring: "ppr",
        roster: "16",
        lineup: "nine",
        draft: "snake",
      },
      leaguePolicies:
        "SYNTHETIC commissioner pace target; no fabricated human choices.",
    },
  });
  expect(
    allContexts[0]!.preparedRules!.selectedOptions.map((o) => o.content),
  ).toEqual([
    "SYNTHETIC PPR: receptions 1; passing TD 4; rushing TD 6.",
    "SYNTHETIC 16 roster spots and 16 rounds.",
    "SYNTHETIC 9 starters: QB1 RB2 WR2 TE1 FLEX1 PK1 DEF1.",
    "SYNTHETIC snake, exact owner-approved teamOrder.",
  ]);
  expect(
    (
      await f.db.query(
        "SELECT details FROM runtime_receipts WHERE type='rehearsal.arming'",
      )
    ).rows[0].details.onboarding,
  ).toMatchObject({
    stageId,
    closureReceiptId: closure.receiptId,
    snapshotAttestationReceiptId: attested.receiptId,
  });
});
it("serializes football claim after stop without locking an outbox row first", async () => {
  await service.arm(actor, config);
  await enable();
  await wake("claim-race");
  expect(
    (
      await run(0, 10, [
        {
          type: "football",
          causalId: "race-queue",
          command: {
            type: "mflLocalDraftQueue",
            expectedVersion: 0,
            playerIds: ["12345"],
          },
        },
      ])
    ).status,
  ).toBe("completed");
  let reached!: () => void, release!: () => void;
  const atLeague = new Promise<void>((resolve) => (reached = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const statements: string[] = [];
  const intercepted = {
    ...f.db,
    connect: async () => {
      const client = await f.db.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (...args: any[]) => {
              const sql = String(args[0]);
              statements.push(sql);
              if (sql.includes("pg_advisory_xact_lock")) {
                reached();
                await gate;
              }
              return (target.query as any)(...args);
            };
          const value = (target as any)[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Db;
  const claiming = new FootballOutbox(intercepted, store).claim(
    "claim-after-stop",
    30000,
    ["agent0"],
  );
  await Promise.race([
    atLeague,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Error("claim did not acquire league lock")),
        1500,
      ),
    ),
  ]);
  expect(statements.some((sql) => sql.includes("FOR UPDATE"))).toBe(false);
  await service.stop(actor, {
    epoch,
    reason: "Synthetic stop wins before waiting outbox claim",
  });
  release();
  expect(await claiming).toBeNull();
  expect(
    (await f.db.query("SELECT status,attempts FROM runtime_football_outbox"))
      .rows[0],
  ).toEqual({ status: "dead", attempts: 0 });
});
it.each(["verified", "rejected", "unknown"] as const)(
  "reconciles a stopped disabled rehearsal by reads only with outcome %s",
  async (state) => {
    await service.arm(actor, config);
    await enable();
    await wake("uncertain-draft");
    const action = { type: "draft", round: 1, pick: 1, playerId: "12345" };
    expect(
      (
        await run(0, 10, [
          {
            type: "football",
            causalId: "unknown-native",
            command: { type: "mfl", action },
          },
        ])
      ).status,
    ).toBe("completed");
    const initialOutbox = new FootballOutbox(f.db, store),
      claim = await initialOutbox.claim("uncertain-dispatch", 30000, [
        "agent0",
      ]);
    if (!claim) throw Error("missing claim");
    await initialOutbox.hold(claim, "SYNTHETIC uncertain result");
    const notice = (
      await f.db.query(
        "SELECT j.id,x.epoch,x.source FROM runtime_jobs j JOIN runtime_rehearsal_jobs x ON x.job_id=j.id WHERE j.causal_id=$1",
        ["football-held:" + claim.id],
      )
    ).rows[0];
    expect(notice).toMatchObject({ epoch, source: "football-held" });
    await service.stop(actor, {
      epoch,
      reason: "Synthetic stopped rehearsal before read-only recovery",
    });
    expect(
      await initialOutbox.claim("must-not-dispatch", 30000, ["agent0"]),
    ).toBeNull();
    const before = (
      await f.db.query("SELECT id,status FROM runtime_jobs ORDER BY id")
    ).rows;
    let reads = 0,
      posts = 0;
    const official = {
      id: randomUUID(),
      idempotencyKey: "runtime-football:" + claim.id,
      scope: "SYNTHETIC scope",
      leagueId,
      teamId: "team0",
      franchiseId: "0001",
      actorId: "owner0",
      action,
      actionHash: fingerprint(action),
      state,
      synthetic: true,
      at: new Date().toISOString(),
      affectedTeamIds: ["team0"],
    };
    const adapter = {
      execute: async () => {
        posts++;
        throw Error("POST must never occur during reconciliation");
      },
      reconcile: async (principal: any, key: string) => {
        reads++;
        expect(principal).toEqual({
          id: "owner0",
          role: "owner",
          leagueId,
          teamId: "team0",
        });
        expect(key).toBe(official.idempotencyKey);
        return official;
      },
      verifyReceipt: async (
        _tx: any,
        _principal: any,
        key: string,
        receiptId: string,
      ) => {
        expect(key).toBe(official.idempotencyKey);
        expect(receiptId).toBe(official.id);
        return official;
      },
    };
    const recovering = new FootballOutbox(
      f.db,
      store,
      undefined,
      async () => adapter as any,
    );
    expect(await recovering.reconcileHeld(claim.id, "operator-read-only")).toBe(
      state === "verified"
        ? "delivered"
        : state === "rejected"
          ? "failed"
          : "held",
    );
    expect(reads).toBe(1);
    expect(posts).toBe(0);
    expect(
      (await f.db.query("SELECT id,status FROM runtime_jobs ORDER BY id")).rows,
    ).toEqual(before);
    expect(
      (await f.db.query("SELECT enabled FROM runtime_agents WHERE id='agent0'"))
        .rows[0].enabled,
    ).toBe(false);
    if (state !== "unknown") {
      await service.restore(actor, {
        epoch,
        reason: "Synthetic restore after known native readback outcome",
      });
      await f.db.query("UPDATE runtime_jobs SET status='pending' WHERE id=$1", [
        notice.id,
      ]);
      await enable();
      expect((await run()).status).toBe("idle");
    } else {
      const draft = {
        round: 1,
        pick: 1,
        picks: [{ round: 1, pick: 1, franchiseId: "0001", playerId: null }],
      };
      const op = { ...official, before: draft };
      const operation = (
        await f.db.query(
          "INSERT INTO runtime_receipts(type,details) VALUES('mfl_operation',$1) RETURNING seq",
          [op],
        )
      ).rows[0];
      const readId = randomUUID();
      await f.db.query(
        "INSERT INTO runtime_receipts(type,details) VALUES('mfl_read',$1)",
        [
          {
            id: readId,
            scope: op.scope,
            actorId: actor.id,
            actorRole: "commissioner",
            request: { type: "draft" },
            resultHash: mflHash(draft),
          },
        ],
      );
      const input = {
        epoch,
        outboxId: claim.id,
        operationId: op.id,
        expectedOperationSeq: String(operation.seq),
        operationHash: fingerprint(op),
        draftReadReceiptId: readId,
        draft,
        reason: "SYNTHETIC explicitly retire uncertain trial without replay",
        evidenceRef: "synthetic:quarantine-test",
      };
      await expect(
        service.quarantineRetiredTrialIntent(actor, {
          ...input,
          operationHash: "0".repeat(64),
        }),
      ).rejects.toThrow("REHEARSAL_QUARANTINE_OPERATION_MISMATCH");
      await expect(
        service.quarantineRetiredTrialIntent(actor, {
          ...input,
          draft: { ...draft, pick: 2 },
        }),
      ).rejects.toThrow("REHEARSAL_FRESH_TRIAL_READ_REQUIRED");
      const quarantine = await service.quarantineRetiredTrialIntent(
        actor,
        input,
      );
      expect(quarantine).toMatchObject({
        journalState: "unknown",
        upstreamRejectionProven: false,
        replayAuthorized: false,
        preservedPicks: 0,
      });
      expect(
        (await service.quarantineRetiredTrialIntent(actor, input)).receiptId,
      ).toBe(quarantine.receiptId);
      expect(
        (
          await f.db.query(
            "SELECT details FROM runtime_receipts WHERE seq=$1",
            [operation.seq],
          )
        ).rows[0].details,
      ).toEqual(op);
      expect(
        (
          await f.db.query(
            "SELECT status,error FROM runtime_football_outbox WHERE id=$1",
            [claim.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: "dead",
        error: "RETIRED_TRIAL_UNKNOWN_QUARANTINED",
      });
      await service.restore(actor, {
        epoch,
        reason: "SYNTHETIC return after retiring exact uncertain trial intent",
      });
      expect(posts).toBe(0);
    }
  },
);
it("tags terminal football failure notices to their originating epoch", async () => {
  await service.arm(actor, config);
  await enable();
  await wake("failed-draft");
  expect(
    (
      await run(0, 10, [
        {
          type: "football",
          causalId: "rejected-native",
          command: {
            type: "mfl",
            action: { type: "draft", round: 1, pick: 1, playerId: "12345" },
          },
        },
      ])
    ).status,
  ).toBe("completed");
  const outbox = new FootballOutbox(f.db, store),
    claim = await outbox.claim("failed", 30000, ["agent0"]);
  if (!claim) throw Error("missing");
  await outbox.fail(claim, "SYNTHETIC authoritative rejection", false);
  const notice = (
    await f.db.query(
      "SELECT j.id,x.epoch,x.source FROM runtime_jobs j JOIN runtime_rehearsal_jobs x ON x.job_id=j.id WHERE j.causal_id=$1",
      ["football-failed:" + claim.id],
    )
  ).rows[0];
  expect(notice).toMatchObject({ epoch, source: "football-failure" });
  await service.stop(actor, {
    epoch,
    reason: "Synthetic failure receipt inspected before stop",
  });
  await service.restore(actor, {
    epoch,
    reason: "Synthetic restore after terminal rejected trial",
  });
  await f.db.query("UPDATE runtime_jobs SET status='pending' WHERE id=$1", [
    notice.id,
  ]);
  await enable();
  expect((await run()).status).toBe("idle");
});

// Synthetic receipts below exercise wake policy; no native request is performed.
it.each([true, false])(
  "coalesces native draft success only for rehearsal=%s",
  async (trial) => {
    if (trial) await service.arm(actor, config);
    await enable();
    if (trial) await wake("draft-success");
    else
      await store.ingestEvent({
        agentId: "agent0",
        causalId: "production-draft",
        payload: { kind: "fixture" },
      });
    const action = {
      type: "draft" as const,
      round: 1,
      pick: 1,
      playerId: "12345",
    };
    expect(
      (
        await run(0, 10, [
          {
            type: "football",
            causalId: "native-success",
            command: { type: "mfl", action },
          },
        ])
      ).status,
    ).toBe("completed");
    let official: any;
    const adapter = {
      execute: async (_actor: any, key: string) =>
        (official = {
          id: randomUUID(),
          idempotencyKey: key,
          scope: "SYNTHETIC",
          leagueId,
          teamId: "team0",
          franchiseId: "0001",
          actorId: "owner0",
          action,
          actionHash: fingerprint(action),
          state: "verified",
          synthetic: true,
          at: new Date().toISOString(),
          affectedTeamIds: ["team0"],
        }),
      verifyReceipt: async () => official,
    };
    const outbox = new FootballOutbox(
      f.db,
      store,
      undefined,
      async () => adapter as any,
    );
    expect(
      (await outbox.dispatchOne("synthetic", { allowedAgentIds: ["agent0"] }))
        .status,
    ).toBe("delivered");
    expect(
      (
        await f.db.query(
          "SELECT id FROM runtime_jobs WHERE causal_id LIKE 'football-result:%'",
        )
      ).rowCount,
    ).toBe(trial ? 0 : 1);
    expect(
      (
        await f.db.query(
          "SELECT id FROM runtime_football_outbox WHERE status='delivered' AND engine_receipt IS NOT NULL",
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.db.query(
          "SELECT seq FROM runtime_receipts WHERE type='rehearsal.football_success_coalesced'",
        )
      ).rowCount,
    ).toBe(trial ? 1 : 0);
  },
);
it("accepts an explicit twenty dollar cap without changing the default or canonical funding", async () => {
  const { capMicros: _, ...withoutCap } = config;
  expect(RehearsalArmSchema.parse(withoutCap).capMicros).toBe(5_000_000);
  expect(
    RehearsalArmSchema.safeParse({ ...config, capMicros: 20_000_001 }).success,
  ).toBe(false);
  await f.db.query("UPDATE runtime_agents SET budget_micros=600000000");
  await service.arm(actor, { ...config, capMicros: 20_000_000 });
  expect(
    (await f.db.query("SELECT cap_micros FROM runtime_rehearsals")).rows[0]
      .cap_micros,
  ).toBe("20000000");
  expect(
    (
      await f.db.query(
        "SELECT budget_micros,reserved_micros,spent_micros FROM runtime_agents",
      )
    ).rows.every(
      (r) =>
        r.budget_micros === "600000000" &&
        r.reserved_micros === "0" &&
        r.spent_micros === "0",
    ),
  ).toBe(true);
});

async function prepareRulesFixture() {
  for (let i = 2; i < 12; i++) {
    if (
      (
        await f.db.query(
          "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2",
          [leagueId, "team" + i],
        )
      ).rowCount
    )
      continue;
    const kind = i < 10 ? "ai" : "human";
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,$4,$5,$5,100)",
      [leagueId, "team" + i, "owner" + i, kind, i],
    );
    await store.createAgent({
      id: "agent" + i,
      kind,
      model: "synthetic/rehearsal",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      ["agent" + i, leagueId, "team" + i],
    );
  }
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  const gov = new GovernanceService(f.db);
  const questions = [
    {
      id: "scoring",
      label: "Scoring",
      options: [
        {
          id: "ppr",
          label: "PPR",
          content: "SYNTHETIC PPR: receptions 1; passing TD 4; rushing TD 6.",
          evidenceRefs: ["synthetic://fixture/scoring"],
        },
      ],
    },
    {
      id: "roster",
      label: "Roster",
      options: [
        {
          id: "16",
          label: "Sixteen",
          content: "SYNTHETIC 16 roster spots and 16 rounds.",
          evidenceRefs: ["synthetic://fixture/roster"],
        },
      ],
    },
    {
      id: "lineup",
      label: "Starters",
      options: [
        {
          id: "nine",
          label: "Nine",
          content: "SYNTHETIC 9 starters: QB1 RB2 WR2 TE1 FLEX1 PK1 DEF1.",
          evidenceRefs: ["synthetic://fixture/lineup"],
        },
      ],
    },
    {
      id: "draft",
      label: "Order",
      options: [
        {
          id: "snake",
          label: "Snake",
          content: "SYNTHETIC snake, exact owner-approved teamOrder.",
          evidenceRefs: ["synthetic://fixture/draft"],
        },
      ],
    },
  ];
  await gov.execute(actor, {
    type: "registerMflMenu",
    leagueId,
    idempotencyKey: "prepared-menu",
    menuId: "prepared-menu",
    title: "SYNTHETIC rule menu",
    sourceNote: "SYNTHETIC test only",
    questions,
    applicationSections: [{ id: "native", label: "SYNTHETIC application" }],
  });
  await gov.execute(actor, {
    type: "openMeeting",
    leagueId,
    idempotencyKey: "prepared-meeting",
    meetingId: "prepared-meeting",
    menuId: "prepared-menu",
    proposalDeadline: new Date(Date.now() + 60000).toISOString(),
    voteDeadline: new Date(Date.now() + 120000).toISOString(),
  });
  await gov.execute(
    { id: "owner0", role: "owner", leagueId, teamId: "team0" },
    {
      type: "submitMflProposal",
      leagueId,
      idempotencyKey: "prepared-proposal",
      meetingId: "prepared-meeting",
      proposalId: "prepared-proposal",
      version: "v1",
      title: "SYNTHETIC agreed rules",
      rationale: "SYNTHETIC fixture, not a real model choice",
      menuId: "prepared-menu",
      selections: {
        scoring: "ppr",
        roster: "16",
        lineup: "nine",
        draft: "snake",
      },
      teamOrder: Array.from({ length: 12 }, (_, i) => "team" + i),
      leaguePolicies:
        "SYNTHETIC commissioner pace target; no fabricated human choices.",
    },
  );
  await f.db.query(
    "UPDATE mfl_governance_meetings SET discussion_opens_at=clock_timestamp()-interval '2 seconds',proposal_deadline=clock_timestamp()-interval '1 second' WHERE id='prepared-meeting'",
  );
  for (let i = 0; i < 8; i++)
    await gov.execute(
      { id: "owner" + i, role: "owner", leagueId, teamId: "team" + i },
      {
        type: "castVote",
        leagueId,
        idempotencyKey: "prepared-vote-" + i,
        proposalId: "prepared-proposal",
        choice: "yes",
      },
    );
  await f.db.query(
    "UPDATE mfl_governance_meetings SET vote_deadline=clock_timestamp()-interval '1 millisecond' WHERE id='prepared-meeting'",
  );
  const d: any = await gov.execute(actor, {
    type: "prepareRatification",
    leagueId,
    idempotencyKey: "prepared-decision",
    proposalId: "prepared-proposal",
  });
  const m = (
    await f.db.query(
      "SELECT content_hash FROM mfl_governance_menus WHERE id='prepared-menu'",
    )
  ).rows[0];
  return {
    decisionId: d.result.decisionId,
    proposalId: d.result.proposalId,
    proposalHash: d.result.proposalHash,
    menuHash: m.content_hash,
  };
}
it("binds only the exact selected prepared rules transactionally and rejects wrong hashes or current host", async () => {
  const preparedDecision = await prepareRulesFixture();
  await expect(
    service.arm(actor, {
      ...config,
      preparedDecision: { ...preparedDecision, proposalHash: "a".repeat(64) },
    }),
  ).rejects.toThrow("PREPARED_PROPOSAL_MISMATCH");
  expect((await f.db.query("SELECT 1 FROM runtime_rehearsals")).rowCount).toBe(
    0,
  );
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_receipts WHERE type='rehearsal.trial_rules_bound'",
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    service.arm(actor, {
      ...config,
      preparedDecision: { ...preparedDecision, menuHash: "a".repeat(64) },
    }),
  ).rejects.toThrow("PREPARED_MENU_MISMATCH");
  await service.arm(actor, { ...config, preparedDecision });
  const c = await service.context("agent0");
  expect(c!.preparedRules!.proposal.teamOrder).toEqual(
    Array.from({ length: 12 }, (_, i) => "team" + i),
  );
  const original = (
    await f.db.query(
      "SELECT * FROM mfl_governance_proposals WHERE id='prepared-proposal'",
    )
  ).rows[0];
  await f.db.query(
    "UPDATE mfl_governance_proposals SET content=jsonb_set(content,'{leaguePolicies}',$1::jsonb) WHERE id='prepared-proposal'",
    [JSON.stringify("changed")],
  );
  await expect(service.context("agent0")).rejects.toThrow(
    "PREPARED_PROPOSAL_MISMATCH",
  );
  await f.db.query(
    "UPDATE mfl_governance_proposals SET content=$1 WHERE id='prepared-proposal'",
    [original.content],
  );
  await f.db.query(
    "UPDATE league_host_bindings SET version=version+1 WHERE league_id=$1",
    [leagueId],
  );
  await expect(service.context("agent0")).rejects.toThrow(
    "PREPARED_CURRENT_HOST_MISMATCH",
  );
});
it("keeps legacy synthetic context explicit and fails closed when real mode has no prepared binding", async () => {
  await service.arm(actor, config);
  expect((await service.context("agent0"))!.preparedRules).toBeNull();
  await f.db.query("UPDATE runtime_rehearsals SET synthetic=false");
  await expect(service.context("agent0")).rejects.toThrow(
    "PREPARED_RULES_BINDING_REQUIRED",
  );
});

async function failed429Fixture() {
  const manifestId = randomUUID();
  await f.db.query(
    `INSERT INTO provider_manifests(id,league_id,agent_id,version,document,key_fingerprint,status)
    VALUES($1,$2,'agent0',1,$3,'synthetic-key-hash','active')`,
    [
      manifestId,
      leagueId,
      { model: "synthetic/rehearsal", providerSlug: "synthetic/provider" },
    ],
  );
  await service.arm(actor, config);
  await enable();
  await wake("synthetic-first-429");
  const job = (await store.claim(
    "failed-worker",
    30000,
    "synthetic/rehearsal",
    ["agent0"],
  ))!;
  const reservationId = await store.reserve(job, 30);
  const callId = randomUUID();
  await f.db.query(
    `INSERT INTO provider_calls(id,manifest_id,agent_id,job_id,fence,staff_role,purpose,requested_model,requested_provider,status,completed_at)
    VALUES($1,$2,'agent0',$3,$4,'owner','owner','synthetic/rehearsal','synthetic/provider','http_429_cost_uncertain',clock_timestamp())`,
    [callId, manifestId, job.id, job.fence],
  );
  await store.fail(job, "PROVIDER_HTTP_429_COST_UNCERTAIN", {
    retryable: false,
    chargeKnownZero: false,
    reservationId,
  });
  const request = {
    epoch,
    expectedHostVersion: 2,
    agentId: "agent0",
    manifestId,
    jobId: job.id,
    fence: job.fence,
    callId,
    reservationId,
    idempotencyKey: "review-429",
    reason:
      "SYNTHETIC reviewed transient first-request rejection, charge remains unknown",
    evidenceRef: "synthetic://429-evidence",
  };
  return { job, request };
}
async function nextBudget(amount: number) {
  await wake("next-scoped-turn");
  const job = (await store.claim("next-worker", 30000, "synthetic/rehearsal", [
    "agent0",
  ]))!;
  return { job, reserve: () => store.reserve(job, amount) };
}
it("acknowledges an exact covered 429 concurrently without changing wallet, evidence, or waking work", async () => {
  const { request } = await failed429Fixture();
  const walletBefore = (
    await f.db.query(
      "SELECT spent_micros,reserved_micros FROM runtime_agents WHERE id='agent0'",
    )
  ).rows;
  const holdBefore = (
    await f.db.query("SELECT * FROM runtime_reservations WHERE id=$1", [
      request.reservationId,
    ])
  ).rows;
  const [a, b] = await Promise.all([
    service.acknowledgeCoveredCostHold(actor, request),
    service.acknowledgeCoveredCostHold(actor, request),
  ]);
  expect(a.receiptId).toBe(b.receiptId);
  expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  expect(
    (
      await f.db.query(
        "SELECT count(*) FROM runtime_receipts WHERE type='rehearsal.cost_hold_acknowledged'",
      )
    ).rows[0].count,
  ).toBe("1");
  expect(
    (
      await f.db.query(
        "SELECT spent_micros,reserved_micros FROM runtime_agents WHERE id='agent0'",
      )
    ).rows,
  ).toEqual(walletBefore);
  expect(
    (
      await f.db.query("SELECT * FROM runtime_reservations WHERE id=$1", [
        request.reservationId,
      ])
    ).rows,
  ).toEqual(holdBefore);
  expect(
    (
      await f.db.query(
        "SELECT count(*) FROM runtime_jobs WHERE status IN('pending','running')",
      )
    ).rows[0].count,
  ).toBe("0");
  expect(await rehearsalUsage(f.db, leagueId, epoch, "agent0")).toMatchObject({
    committed_micros: "30",
    unresolved: 1,
    covered_unresolved: 1,
    unreviewed_unresolved: 0,
  });
  const next = await nextBudget(70);
  await expect(next.reserve()).resolves.toEqual(expect.any(String));
  expect(
    (
      await f.db.query(
        "SELECT reserved_micros FROM runtime_agents WHERE id='agent0'",
      )
    ).rows[0].reserved_micros,
  ).toBe("100");
});
it("keeps the unchanged cap and blocks new unacknowledged uncertainty", async () => {
  const { request } = await failed429Fixture();
  await service.acknowledgeCoveredCostHold(actor, request);
  const next = await nextBudget(71);
  await expect(next.reserve()).rejects.toThrow("REHEARSAL_CAP_EXHAUSTED");
  const r = await store.reserve(next.job, 20);
  await store.fail(next.job, "PROVIDER_HTTP_429_COST_UNCERTAIN", {
    retryable: false,
    chargeKnownZero: false,
    reservationId: r,
  });
  const usage = await rehearsalUsage(f.db, leagueId, epoch, "agent0");
  expect(usage).toMatchObject({
    committed_micros: "50",
    unresolved: 2,
    covered_unresolved: 1,
    unreviewed_unresolved: 1,
  });
  await wake("third-turn");
  const third = (await store.claim("third", 30000, "synthetic/rehearsal", [
    "agent0",
  ]))!;
  await expect(store.reserve(third, 1)).rejects.toThrow(
    "REHEARSAL_COST_UNRESOLVED",
  );
  await expect(
    service.acknowledgeCoveredCostHold(actor, {
      ...request,
      idempotencyKey: "second-review",
    }),
  ).rejects.toThrow("REHEARSAL_COST_REVIEW_CONFLICT");
});
it("rejects owner, different league/host/call/fence, and review payload conflicts", async () => {
  const { request } = await failed429Fixture();
  await expect(
    service.acknowledgeCoveredCostHold(
      { ...actor, role: "owner", teamId: "team0" },
      request,
    ),
  ).rejects.toThrow("COMMISSIONER");
  await expect(
    service.acknowledgeCoveredCostHold(
      { ...actor, leagueId: "other" },
      request,
    ),
  ).rejects.toThrow("SCOPE");
  await expect(
    service.acknowledgeCoveredCostHold(actor, {
      ...request,
      expectedHostVersion: 3,
    }),
  ).rejects.toThrow("SCOPE");
  await expect(
    service.acknowledgeCoveredCostHold(actor, {
      ...request,
      callId: randomUUID(),
    }),
  ).rejects.toThrow("CALL_MISMATCH");
  await expect(
    service.acknowledgeCoveredCostHold(actor, { ...request, fence: 2 }),
  ).rejects.toThrow("DEAD_FIRST_429");
  await service.acknowledgeCoveredCostHold(actor, request);
  await expect(
    service.acknowledgeCoveredCostHold(actor, {
      ...request,
      reason: "changed reviewed request reason",
    }),
  ).rejects.toThrow("CONFLICT");
});
it.each(["key", "manifest", "hold", "call", "receipt"] as const)(
  "invalidates covered admission after %s evidence changes",
  async (change) => {
    const { request } = await failed429Fixture();
    await service.acknowledgeCoveredCostHold(actor, request);
    if (change === "key")
      await f.db.query(
        "UPDATE provider_manifests SET key_fingerprint='changed' WHERE id=$1",
        [request.manifestId],
      );
    if (change === "manifest")
      await f.db.query(
        "UPDATE provider_manifests SET status='retired' WHERE id=$1",
        [request.manifestId],
      );
    if (change === "hold")
      await f.db.query(
        "UPDATE runtime_reservations SET amount_micros=29 WHERE id=$1",
        [request.reservationId],
      );
    if (change === "call")
      await f.db.query(
        "UPDATE provider_calls SET request_id='later-evidence' WHERE id=$1",
        [request.callId],
      );
    if (change === "receipt")
      await f.db.query(
        "UPDATE runtime_receipts SET details=jsonb_set(details,'{evidence,reservation,heldMicros}','29') WHERE type='rehearsal.cost_hold_acknowledged'",
      );
    expect(await rehearsalUsage(f.db, leagueId, epoch, "agent0")).toMatchObject(
      { unresolved: 1, covered_unresolved: 0, unreviewed_unresolved: 1 },
    );
  },
);
it("rejects effects or uncovered wallet liability and blocks native uncertainty after acknowledgment", async () => {
  const { request } = await failed429Fixture();
  await f.db.query(
    "UPDATE runtime_agents SET reserved_micros=29 WHERE id='agent0'",
  );
  await expect(
    service.acknowledgeCoveredCostHold(actor, request),
  ).rejects.toThrow("WALLET_HOLD_MISSING");
  await f.db.query(
    "UPDATE runtime_agents SET reserved_micros=30 WHERE id='agent0'",
  );
  await f.db.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('rehearsal.owner_decision','agent0',$1,'{}')",
    [request.jobId],
  );
  await expect(
    service.acknowledgeCoveredCostHold(actor, request),
  ).rejects.toThrow("EFFECTS_PRESENT");
  await f.db.query(
    "DELETE FROM runtime_receipts WHERE type='rehearsal.owner_decision'",
  );
  await service.acknowledgeCoveredCostHold(actor, request);
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('mfl_operation',$1)",
    [
      {
        leagueId,
        scope: "synthetic",
        idempotencyKey: "uncertain-native",
        state: "unknown",
      },
    ],
  );
  const next = await nextBudget(1);
  await expect(next.reserve()).rejects.toThrow("REHEARSAL_NATIVE_UNRESOLVED");
});

it.each(["football", "franchise", "research"] as const)(
  "refuses to acknowledge a request with any persisted %s effect",
  async (kind) => {
    const { request } = await failed429Fixture();
    if (kind === "research")
      await f.db.query(
        `INSERT INTO research_paid_operations(id,league_id,agent_id,job_id,fence,operation_key,fingerprint,kind,status,reservation_micros,tariff,request_hash)
    VALUES($1,$2,'agent0',$3,1,'synthetic-effect','synthetic','search','unknown',1,'{}','synthetic')`,
        [randomUUID(), leagueId, request.jobId],
      );
    else {
      // The payload is deliberately inert: mere existence is enough to block admission.
      const table =
        kind === "football"
          ? "runtime_football_outbox"
          : "runtime_franchise_outbox";
      const column = kind === "football" ? "command" : "action";
      await f.db.query(
        `INSERT INTO ${table}(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,${column},status)
      VALUES($1,'agent0',$2,'synthetic-effect','synthetic',1,$3,'team0','owner0','{}','dead')`,
        [randomUUID(), request.jobId, leagueId],
      );
    }
    await expect(
      service.acknowledgeCoveredCostHold(actor, request),
    ).rejects.toThrow("EFFECTS_PRESENT");
  },
);
it("preserves acknowledged invoice uncertainty when stopping and restoring production", async () => {
  const { request } = await failed429Fixture();
  const a = await service.acknowledgeCoveredCostHold(actor, request);
  const before = (
    await f.db.query("SELECT * FROM runtime_reservations WHERE id=$1", [
      request.reservationId,
    ])
  ).rows;
  await service.stop(actor, {
    epoch,
    reason: "SYNTHETIC completed bounded evaluation; preserve pending invoice",
  });
  expect(await rehearsalUsage(f.db, leagueId, epoch, "agent0")).toMatchObject({
    unresolved: 1,
    covered_unresolved: 0,
  });
  await service.restore(actor, {
    epoch,
    reason: "SYNTHETIC restore production host; invoice remains reserved",
  });
  expect(
    (
      await f.db.query("SELECT * FROM runtime_reservations WHERE id=$1", [
        request.reservationId,
      ])
    ).rows,
  ).toEqual(before);
  expect((await hostBinding(f.db, leagueId)).config.leagueId).toBe("62282");
  expect(
    (
      await f.db.query(
        "SELECT details->>'receiptId' id FROM runtime_receipts WHERE type='rehearsal.cost_hold_acknowledged'",
      )
    ).rows[0].id,
  ).toBe(a.receiptId);
  expect(
    (
      await f.db.query(
        "SELECT reserved_micros,spent_micros FROM runtime_agents WHERE id='agent0'",
      )
    ).rows[0],
  ).toEqual({ reserved_micros: "30", spent_micros: "0" });
});
