import { beforeEach, afterEach, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { OwnerStageRuntime } from "../src/runtime/owner-stage.js";
import { FranchiseService } from "../src/franchise/service.js";
import { BuzzArchiveService, nostrEventId } from "../src/buzz/archive.js";
import { fingerprint } from "../src/governance/validation.js";
const leagueId = "synthetic-close",
  stageId = "onboarding-close",
  room = "12345678-1234-4234-9234-123456789abc";
const commissioner = {
  id: "commissioner",
  role: "commissioner" as const,
  leagueId,
};
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  stage: OwnerStageRuntime;
const pubkey = (i: number) => (i + 1).toString(16).padStart(64, "0");
const close = () =>
  stage.closeReviewed(commissioner, {
    stageId,
    note: "SYNTHETIC reviewed qualification transition",
  });
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  stage = new OwnerStageRuntime(f.db, store);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC stage close','{}')",
    [leagueId],
  );
  for (let i = 0; i < 12; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,name,owner_id,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$2,$3,$4,$5,$5,100)",
      [leagueId, `team${i}`, `owner${i}`, i < 10 ? "ai" : "human", i],
    );
    if (i < 10) {
      await store.createAgent({
        id: `agent${i}`,
        model: "synthetic/model",
        budgetMicros: 1000,
      });
      await f.db.query(
        "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
        [`agent${i}`, leagueId, `team${i}`],
      );
    }
  }
  const archive = new BuzzArchiveService(f.db);
  await archive.configure(commissioner, {
    leagueId,
    communityUrl: "wss://synthetic-close.test",
    mode: "mock",
    bindingReceiptId: "SYNTHETIC binding",
    archiveConsentReceiptId: "SYNTHETIC consent",
    participants: Array.from({ length: 12 }, (_, i) => ({
      pubkey: pubkey(i),
      teamId: `team${i}`,
      ownerId: `owner${i}`,
      kind: i < 10 ? ("agent" as const) : ("human" as const),
      ...(i < 10 ? { agentId: `agent${i}`, ownerPubkey: "f".repeat(64) } : {}),
    })),
  });
  await archive.registerChannel(commissioner, {
    leagueId,
    channelId: room,
    memberPubkeys: Array.from({ length: 12 }, (_, i) => pubkey(i)),
    receiptId: "SYNTHETIC private room",
  });
  await stage.configure(commissioner, {
    stageId,
    policyReceiptId: "SYNTHETIC policy",
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
});
afterEach(async () => f.close());
// All data below is deliberately synthetic fixture evidence; no providers, votes or native sends.
async function canonical(i: number, content: string, replyTo?: string) {
  const e = {
    pubkey: pubkey(i),
    kind: 9,
    content,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", room], ...(replyTo ? [["e", replyTo, "", "reply"]] : [])],
  };
  const id = nostrEventId(e);
  await f.db.query(
    "INSERT INTO buzz_archive_events(league_id,channel_id,event_id,author_pubkey,kind,content,tags,source_created_at,payload_hash,relation_status,mode,provenance) VALUES($1,$2,$3,$4,9,$5,$6,$7,$8,'none','mock','SYNTHETIC transition fixture')",
    [
      leagueId,
      room,
      id,
      e.pubkey,
      content,
      JSON.stringify(e.tags),
      e.created_at,
      fingerprint({ ...e, id }),
    ],
  );
  return id;
}
async function qualify(i: number, research = true) {
  const agentId = `agent${i}`,
    jobId = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,status,fence,claimed_at,completed_at) VALUES($1,$2,$3,'synthetic','appointment',$4,clock_timestamp(),'completed',1,clock_timestamp()-interval '1 second',clock_timestamp())",
    [
      jobId,
      agentId,
      `qualified-${i}`,
      {
        kind: "onboarding.followup",
        stageId,
        task: "SYNTHETIC useful followup completed",
      },
    ],
  );
  await f.db.query(
    "INSERT INTO runtime_owner_stage_turns(league_id,stage_id,agent_id,job_id,fence) VALUES($1,$2,$3,$4,1)",
    [leagueId, stageId, agentId, jobId],
  );
  await f.db.query(
    "INSERT INTO runtime_reservations(id,agent_id,job_id,fence,amount_micros,actual_micros,status) VALUES($1,$2,$3,1,10,1,'settled')",
    [randomUUID(), agentId, jobId],
  );
  await new FranchiseService(f.db).execute(
    { id: `owner${i}`, role: "owner", leagueId, teamId: `team${i}` },
    {
      agentId,
      idempotencyKey: `synthetic-brand-${i}`,
      action: {
        type: "brand",
        causalId: `brand-${i}`,
        name: `Synthetic Brand ${i}`,
        tagline: "Synthetic fixture",
        description: "An explicitly synthetic owner brand",
        colors: ["#123456"],
      },
    },
  );
  for (const key of [
    "owner_operating_packet_v1",
    "owner_capability_needs_v1",
    "owner/onboarding-followup",
  ])
    await f.db.query(
      "INSERT INTO runtime_memory(agent_id,key,content) VALUES($1,$2,$3)",
      [agentId, key, `SYNTHETIC ${key} completed by owner ${i}`],
    );
  await f.db.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('owner_stage.memory_roundtrip',$1,$2,$3),('owner_stage.schedule_authored',$1,$2,$4)",
    [
      agentId,
      jobId,
      {
        stageId,
        usedFor: "SYNTHETIC restored source preference informed research",
        packetSourceVersion: 1,
      },
      { stageId, appointmentId: jobId },
    ],
  );
  const followupMemory = (
    await f.db.query(
      "SELECT content,version,updated_at FROM runtime_memory WHERE agent_id=$1 AND key='owner/onboarding-followup'",
      [agentId],
    )
  ).rows[0];
  await f.db.query(
    "INSERT INTO runtime_receipts(type,agent_id,job_id,details) VALUES('job.completed',$1,$2,$3),('owner_stage.followup_memory_written',$1,$2,$4)",
    [
      agentId,
      jobId,
      { actions: 1 },
      {
        leagueId,
        stageId,
        fence: 1,
        memory: {
          content: followupMemory.content,
          version: followupMemory.version,
          updatedAt: followupMemory.updated_at.toISOString(),
          contentHash: fingerprint(followupMemory.content),
        },
      },
    ],
  );
  const original = await canonical(i, `SYNTHETIC owner ${i} introduction`);
  const peer = await canonical(
    (i + 1) % 10,
    `SYNTHETIC proposal for owner ${i}`,
  );
  const response = await canonical(
    i,
    `SYNTHETIC substantive counterproposal from owner ${i}`,
    peer,
  );
  for (const [causalId, eventId, replyTo] of [
    [`onboarding:${stageId}:intro`, original, undefined],
    [`peer-response-${i}`, response, peer],
  ]) {
    const action = {
      type: "buzz_channel",
      causalId,
      channelId: room,
      content: "SYNTHETIC authored fixture",
      mentionAgentIds: [],
      ...(replyTo ? { replyTo } : {}),
    };
    await f.db.query(
      "INSERT INTO runtime_franchise_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,action,status,service_receipt) VALUES($1,$2,$3,$4,'synthetic',1,$5,$6,$7,$8,'delivered',$9)",
      [
        randomUUID(),
        agentId,
        jobId,
        causalId,
        leagueId,
        `team${i}`,
        `owner${i}`,
        action,
        { result: { eventId } },
      ],
    );
  }
  if (research)
    for (const kind of ["search", "scrape"]) {
      const id = randomUUID(),
        url = `https://www.nfl.com/synthetic-fixture-${i}`;
      const result = {
        status: "retrieved",
        provider: "firecrawl",
        synthetic: true,
        results: [
          {
            url,
            title: "SYNTHETIC source",
            excerpt: "SYNTHETIC page text",
            contentHash: "a".repeat(64),
          },
        ],
      };
      await f.db.query(
        "INSERT INTO research_paid_operations(id,league_id,agent_id,job_id,fence,operation_key,fingerprint,kind,status,reservation_micros,actual_micros,credits_used,tariff,request_hash,response_hash,result,completed_at) VALUES($1,$2,$3,$4,1,$1::uuid::text,'fixture',$5,'completed',4,2,1,'{}',$6,$7,$8,clock_timestamp())",
        [
          id,
          leagueId,
          agentId,
          jobId,
          kind,
          "b".repeat(64),
          "c".repeat(64),
          result,
        ],
      );
      await f.db.query(
        "INSERT INTO research_receipts(id,league_id,agent_id,job_id,tool,url,source_id,status,details,completed_at) VALUES($1,$2,$3,$4,$5,$6,'firecrawl','completed',$7,clock_timestamp())",
        [
          id,
          leagueId,
          agentId,
          jobId,
          kind === "search" ? "research_search" : "research_retrieve",
          kind === "scrape" ? url : null,
          {
            paidOperationId: id,
            requestHash: "b".repeat(64),
            responseHash: "c".repeat(64),
          },
        ],
      );
    }
  await stage.reviewOwner(commissioner, {
    agentId,
    note: "SYNTHETIC operator qualification review",
  });
  return jobId;
}
it("requires all ten real stored review receipts, not nine", async () => {
  for (let i = 0; i < 9; i++) await qualify(i);
  await expect(close()).rejects.toThrow("TEN_REVIEWS_REQUIRED");
  expect(
    (await f.db.query("SELECT status FROM runtime_owner_stages")).rows[0]
      .status,
  ).toBe("active");
});
it("closes only after ten fresh verified reviews and cancels only this stage's onboarding wakeups", async () => {
  for (let i = 0; i < 10; i++) await qualify(i);
  const cancel = await store.ingestEvent({
    agentId: "agent0",
    causalId: "old-onboarding-wake",
    payload: { kind: "owner.onboarding.refresh", stageId },
  });
  const preserve = await store.ingestEvent({
    agentId: "agent0",
    causalId: "independent-work",
    payload: { kind: "business.research", stageId },
  });
  const before = (
    await f.db.query(
      "SELECT id,budget_micros,spent_micros,reserved_micros FROM runtime_agents ORDER BY id",
    )
  ).rows;
  const closes = await Promise.all([close(), close()]);
  const result = closes.find((r) => !r.replayed)!;
  expect(closes.filter((r) => r.replayed)).toHaveLength(1);
  expect(result).toMatchObject({
    status: "reviewed",
    conventionStarted: false,
  });
  expect(result.ownerReviews).toHaveLength(10);
  expect(result.cancelledOnboardingJobIds).toEqual([cancel.id]);
  expect(
    (
      await f.db.query("SELECT status FROM runtime_jobs WHERE id=$1", [
        preserve.id,
      ])
    ).rows[0].status,
  ).toBe("pending");
  expect((await f.db.query("SELECT * FROM runtime_memory")).rowCount).toBe(30);
  expect(
    (
      await f.db.query(
        "SELECT id,budget_micros,spent_micros,reserved_micros FROM runtime_agents ORDER BY id",
      )
    ).rows,
  ).toEqual(before);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM governance_votes")).rows[0]
      .n,
  ).toBe(0);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_football_outbox"))
      .rows[0].n,
  ).toBe(0);
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_conventions"))
      .rows[0].n,
  ).toBe(0);
  expect((await stage.context("agent0")).stage).toBe("not-configured");
  expect((await close()).replayed).toBe(true);
});
it("refuses missing research despite existing onboarding review receipts", async () => {
  for (let i = 0; i < 10; i++) await qualify(i, i !== 9);
  await expect(close()).rejects.toThrow("RESEARCH_BASELINE_REQUIRED");
});
it("refuses newly unresolved costs and in-flight jobs after owner reviews", async () => {
  for (let i = 0; i < 10; i++) await qualify(i);
  await f.db.query(
    "UPDATE runtime_reservations SET status='uncertain' WHERE agent_id='agent0'",
  );
  await expect(close()).rejects.toThrow("EVIDENCE_INCOMPLETE");
  await f.db.query(
    "UPDATE runtime_reservations SET status='settled' WHERE agent_id='agent0'",
  );
  await f.db.query(
    "UPDATE runtime_jobs SET status='running' WHERE agent_id='agent0'",
  );
  await expect(close()).rejects.toThrow("WORK_IN_FLIGHT");
});
it("refuses owner authority, wrong league, changed reviewed evidence", async () => {
  await expect(
    stage.closeReviewed(
      { id: "owner0", role: "owner", leagueId, teamId: "team0" },
      { stageId, note: "Synthetic attempted self release" },
    ),
  ).rejects.toThrow("COMMISSIONER_REQUIRED");
  await expect(
    stage.closeReviewed(
      { ...commissioner, leagueId: "other" },
      { stageId, note: "Synthetic wrong league request" },
    ),
  ).rejects.toThrow("SCOPE");
  for (let i = 0; i < 10; i++) await qualify(i);
  await f.db.query(
    "UPDATE runtime_memory SET content='SYNTHETIC edited after review' WHERE agent_id='agent0' AND key='owner_operating_packet_v1'",
  );
  await expect(close()).rejects.toThrow("REVIEW_EVIDENCE_CHANGED");
});
it("rejects unresolved pre-stage held outboxes without an explicit disposition", async () => {
  for (let i = 0; i < 10; i++) await qualify(i);
  const oldJobId = randomUUID();
  await f.db.query(
    "INSERT INTO runtime_jobs(id,agent_id,causal_id,fingerprint,kind,payload,due_at,status) VALUES($1,'agent0','prestage-job','synthetic','event','{}',clock_timestamp(),'dead')",
    [oldJobId],
  );
  await f.db.query(
    "INSERT INTO runtime_franchise_outbox(id,agent_id,job_id,causal_id,fingerprint,origin_fence,league_id,team_id,owner_id,action,status) SELECT $1,agent_id,$2,'prestage-held','synthetic',0,league_id,team_id,owner_id,action,'held' FROM runtime_franchise_outbox WHERE agent_id='agent0' LIMIT 1",
    [randomUUID(), oldJobId],
  );
  await expect(close()).rejects.toThrow("CLOSE_ACTIONS_OUTSTANDING");
  expect(
    (await f.db.query("SELECT status FROM runtime_owner_stages")).rows[0]
      .status,
  ).toBe("active");
  await f.db.query(
    "INSERT INTO runtime_conventions(league_id,meeting_id,host_version,host_kind,proposal_deadline,vote_deadline,limits,synthetic,status,created_by) VALUES($1,'old-convention',0,'custom',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour','{}',true,'stopped','synthetic-commissioner')",
    [leagueId],
  );
  await f.db.query(
    "INSERT INTO runtime_convention_turns(league_id,meeting_id,agent_id,job_id,fence,phase) VALUES($1,'old-convention','agent0',$2,0,'proposals')",
    [leagueId, oldJobId],
  );
  await expect(close()).rejects.toThrow("CLOSE_ACTIONS_OUTSTANDING");
  await f.db.query(
    "UPDATE runtime_franchise_outbox SET error='OWNER_STAGE_PREVIOUS_INTENT_HELD' WHERE causal_id='prestage-held'",
  );
  await expect(close()).rejects.toThrow("CLOSE_ACTIONS_OUTSTANDING");
  await f.db.query(
    "UPDATE runtime_franchise_outbox SET created_at=(SELECT configured_at-interval '1 second' FROM runtime_owner_stages WHERE league_id=$1 AND id=$2) WHERE causal_id='prestage-held'",
    [leagueId, stageId],
  );
  const audit = (
    await f.db.query(
      "DELETE FROM runtime_receipts WHERE type='owner_stage.configured' RETURNING details",
    )
  ).rows[0];
  await expect(close()).rejects.toThrow("CLOSE_ACTIONS_OUTSTANDING");
  await f.db.query(
    "INSERT INTO runtime_receipts(type,details) VALUES('owner_stage.configured',$1)",
    [audit.details],
  );
  const result = await close();
  expect(result.preservedHistoricalHeldIntents).toHaveLength(1);
  expect(result.preservedHistoricalHeldIntents[0]).toMatchObject({
    meetingId: "old-convention",
    status: "held",
  });
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_franchise_outbox WHERE causal_id='prestage-held'",
      )
    ).rows[0].status,
  ).toBe("held");
});

it("owner context exposes only its own verified settled research proof without page contents or another owner's receipts", async () => {
  await qualify(0);
  const own = (await stage.context("agent0")).researchQualification;
  expect(own).toMatchObject({
    status: "verified",
    pageMatchesSearchCitation: true,
    search: {
      source: "firecrawl",
      creditsUsed: "1",
      allocatedCostMicros: "2",
      urls: ["https://www.nfl.com/synthetic-fixture-0"],
    },
    page: {
      creditsUsed: "1",
      allocatedCostMicros: "2",
      url: "https://www.nfl.com/synthetic-fixture-0",
    },
  });
  expect(own!.search!.receiptId).toMatch(/^[a-f0-9-]{36}$/);
  expect(own!.search!.completedAt).toBeInstanceOf(Date);
  expect(own!.page!.completedAt).toBeInstanceOf(Date);
  expect(own!.instruction).toContain("turns that later failed");
  expect(own!.instruction).toContain("paid internal allocation");
  expect(JSON.stringify(own)).not.toContain("SYNTHETIC page text");
  const other = (await stage.context("agent1")).researchQualification;
  expect(other).toMatchObject({
    status: "incomplete",
    search: null,
    page: null,
  });
  expect(JSON.stringify(other)).not.toContain("synthetic-fixture-0");
  expect(JSON.stringify(other)).not.toContain(own!.search!.receiptId!);
});
