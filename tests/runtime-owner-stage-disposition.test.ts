import {
  OwnerStageDispositionService,
  INTRO_UNCERTAINTY_DISCLOSURE,
  ownerStageIntroDisposition,
  assertOwnerStageIntroReplacement,
} from "../src/runtime/owner-stage-disposition.js";
import { enqueueFranchise } from "../src/franchise/outbox.js";
import type { Job } from "../src/runtime/index.js";
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
const replacementCausalId = `onboarding:${stageId}:intro:replacement:reviewed-v1`;
const replacementContent =
  INTRO_UNCERTAINTY_DISCLOSURE +
  " I am introducing my franchise with a newly written plan: I will compare two research sources, record uncertainty in my player assessments, and invite my assigned peer to review the evidence before our next discussion.";
async function heldIntro() {
  await begin();
  expect(
    (
      await turn([
        {
          type: "buzz_channel",
          causalId: `onboarding:${stageId}:intro`,
          channelId: room,
          content: "SYNTHETIC original introduction whose delivery is unknown",
          mentionAgentIds: ["agent1"],
        },
      ])
    ).status,
  ).toBe("completed");
  const result = await outbox.dispatchOne("disposition-fixture", {
    allowedAgentIds: ["agent0"],
  });
  expect(result.status).toBe("held");
  const old = (
    await f.db.query(
      "SELECT * FROM runtime_franchise_outbox WHERE agent_id='agent0'",
    )
  ).rows[0];
  const buzz = (await f.db.query("SELECT * FROM buzz_action_receipts")).rows[0];
  expect(buzz.status).toBe("unknown");
  return {
    old,
    buzz,
    input: {
      stageId,
      agentId: "agent0",
      priorOutboxId: old.id,
      replacementCausalId,
      reason:
        "SYNTHETIC reviewed unresolved delivery, permit new authored introduction",
      evidenceRef: "synthetic:read-only-relay-investigation",
    },
  };
}
it("commissioner disposition permits new work while preserving exact uncertain evidence and requiring canonical replacement", async () => {
  const { old, buzz, input } = await heldIntro();
  expect(await stage.mayInfer("agent0")).toBe(false);
  const service = new OwnerStageDispositionService(f.db);
  const disposition = await service.authorizeReplacementIntro(
    commissioner,
    input,
  );
  expect(disposition).toMatchObject({
    priorBuzzStatus: "unknown",
    priorIntroductionComplete: false,
    externalRetryAuthorized: false,
  });
  expect(await stage.mayInfer("agent0")).toBe(true);
  const context = await stage.context("agent0");
  expect(context).toMatchObject({ introCausalId: replacementCausalId });
  expect(JSON.stringify(context)).toContain(INTRO_UNCERTAINTY_DISCLOSURE);
  expect(
    (await stage.checkpoint(commissioner)).find(
      (x: any) => x.agentId === "agent0",
    )!.missing,
  ).toContain("canonical-buzz-introduction");
  expect(
    (
      await f.db.query(
        "SELECT status FROM runtime_franchise_outbox WHERE id=$1",
        [old.id],
      )
    ).rows[0].status,
  ).toBe("held");
  expect(
    (
      await f.db.query(
        "SELECT status,event_id FROM buzz_action_receipts WHERE id=$1",
        [buzz.id],
      )
    ).rows[0],
  ).toEqual({ status: "unknown", event_id: null });
  expect(
    (await service.authorizeReplacementIntro(commissioner, input)).replayed,
  ).toBe(true);
  await expect(
    service.authorizeReplacementIntro(commissioner, {
      ...input,
      reason: "SYNTHETIC changed justification should conflict",
    }),
  ).rejects.toThrow("DISPOSITION_CONFLICT");
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM runtime_owner_intro_dispositions",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("never allows owners, wrong leagues, wrong stages, or non-intro held actions to grant the exception", async () => {
  const { old, input } = await heldIntro();
  const service = new OwnerStageDispositionService(f.db);
  await expect(
    service.authorizeReplacementIntro(
      { id: "owner0", role: "owner", leagueId, teamId: "team0" },
      input,
    ),
  ).rejects.toThrow("COMMISSIONER_REQUIRED");
  await expect(
    service.authorizeReplacementIntro(
      { ...commissioner, leagueId: "other" },
      input,
    ),
  ).rejects.toThrow("SCOPE");
  await expect(
    service.authorizeReplacementIntro(commissioner, {
      ...input,
      stageId: "other-stage",
    }),
  ).rejects.toThrow("SCOPE");
  await f.db.query(
    "UPDATE runtime_franchise_outbox SET action=jsonb_set(action,'{causalId}','\"not-an-intro\"') WHERE id=$1",
    [old.id],
  );
  await expect(
    service.authorizeReplacementIntro(commissioner, input),
  ).rejects.toThrow("HELD_INTRO_REQUIRED");
  expect(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM runtime_owner_intro_dispositions",
      )
    ).rows[0].n,
  ).toBe(0);
});
it("enforces disclosure, fresh content, exact channel, and no repeat of the original before enqueue", async () => {
  const { old, input } = await heldIntro();
  await new OwnerStageDispositionService(f.db).authorizeReplacementIntro(
    commissioner,
    input,
  );
  const base = {
    leagueId,
    stageId,
    agentId: "agent0",
    action: {
      causalId: replacementCausalId,
      channelId: room,
      content: replacementContent,
    },
  };
  await expect(
    assertOwnerStageIntroReplacement(f.db, {
      ...base,
      action: { ...base.action, content: "No disclosure" },
    }),
  ).rejects.toThrow("DISCLOSURE_REQUIRED");
  await expect(
    assertOwnerStageIntroReplacement(f.db, {
      ...base,
      action: {
        ...base.action,
        content: INTRO_UNCERTAINTY_DISCLOSURE + old.action.content,
      },
    }),
  ).rejects.toThrow("NEW_INTRO_REQUIRED");
  await expect(
    assertOwnerStageIntroReplacement(f.db, {
      ...base,
      action: {
        ...base.action,
        channelId: "22345678-1234-4234-9234-123456789abc",
      },
    }),
  ).rejects.toThrow("CHANNEL_MISMATCH");
  await expect(
    assertOwnerStageIntroReplacement(f.db, {
      ...base,
      action: { ...base.action, causalId: old.causal_id },
    }),
  ).rejects.toThrow("PRIOR_INTRO_REMAINS_UNCERTAIN");
  const previousJob = (
    await f.db.query("SELECT * FROM runtime_jobs WHERE id=$1", [old.job_id])
  ).rows[0];
  await expect(
    transaction(f.db, (tx) =>
      enqueueFranchise(
        tx,
        {
          id: previousJob.id,
          agentId: "agent0",
          fence: previousJob.fence,
        } as Job,
        {
          type: "buzz_channel",
          ...base.action,
          content: "No disclosure",
          mentionAgentIds: [],
        },
      ),
    ),
  ).rejects.toThrow("DISCLOSURE_REQUIRED");
  expect(
    (await f.db.query("SELECT count(*)::int n FROM runtime_franchise_outbox"))
      .rows[0].n,
  ).toBe(1);
});
it("accepted replacement does not qualify until canonical observation, and never qualifies the predecessor", async () => {
  const { input } = await heldIntro();
  await new OwnerStageDispositionService(f.db).authorizeReplacementIntro(
    commissioner,
    input,
  );
  eventToAccept = evt(replacementContent);
  await store.ingestEvent({
    agentId: "agent0",
    causalId: "synthetic-new-work",
    payload: { kind: "onboarding.recovery" },
  });
  expect(
    (
      await turn([
        {
          type: "buzz_channel",
          causalId: replacementCausalId,
          channelId: room,
          content: replacementContent,
          mentionAgentIds: ["agent1"],
        },
      ])
    ).status,
  ).toBe("completed");
  expect(
    (await outbox.dispatchOne("replacement", { allowedAgentIds: ["agent0"] }))
      .status,
  ).toBe("delivered");
  expect(
    (await stage.checkpoint(commissioner)).find(
      (x: any) => x.agentId === "agent0",
    )!.missing,
  ).toContain("canonical-buzz-introduction");
  await ingest(eventToAccept);
  const evidence = (await stage.checkpoint(commissioner)).find(
    (x: any) => x.agentId === "agent0",
  );
  expect(evidence!.missing).not.toContain("canonical-buzz-introduction");
  expect(evidence!.evidence.intro.event_id).toBe(eventToAccept.id);
  expect(
    evidence!.evidence.introDisposition.predecessorUncertainty.priorBuzzStatus,
  ).toBe("unknown");
});
