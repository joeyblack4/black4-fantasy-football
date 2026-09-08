import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { GovernanceService } from "../src/governance/index.js";
import { RuntimeStore } from "../src/runtime/index.js";
import { TestDriver, runOne } from "../src/runtime/worker.js";
import {
  ConventionRuntime,
  createGovernanceReadTools,
} from "../src/runtime/convention.js";
import { FranchiseOutbox } from "../src/franchise/outbox.js";
import { GovernanceActionSchema } from "../src/franchise/schema.js";
import { halfPprRules } from "../src/data/index.js";
import { bindHost } from "../src/league/host.js";
let f: Awaited<ReturnType<typeof testDb>>,
  runtime: RuntimeStore,
  convention: ConventionRuntime,
  governance: GovernanceService,
  league: LeagueService;
const leagueId = "convention-fixture",
  meetingId = "founding";
const commissioner: Actor = {
  id: "commissioner",
  role: "commissioner",
  leagueId,
};
const owners = Array.from({ length: 12 }, (_, i) => ({
  id: `owner${i}`,
  teamId: `team${i}`,
  role: "owner" as const,
  leagueId,
}));
const limits = {
  proposalTurns: 2,
  votingTurns: 3,
  closedTurns: 1,
  maxSpendMicros: 100,
  maxReservationMicros: 60,
};
beforeEach(async () => {
  f = await testDb();
  runtime = new RuntimeStore(f.db);
  league = new LeagueService(f.db);
  governance = new GovernanceService(f.db);
  convention = new ConventionRuntime(f.db, runtime, governance);
  await league.execute(commissioner, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "league",
    name: "SYNTHETIC convention fixture",
    teams: owners.map((o, i) => ({
      id: o.teamId,
      ownerId: o.id,
      name: `Owner ${i}`,
      kind: i < 10 ? "ai" : "human",
    })),
    rules: {
      rosterSize: 1,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      lineupSlots: [{ id: "RB", positions: ["RB"] }],
    },
  });
  for (let i = 0; i < 12; i++) {
    await runtime.createAgent({
      id: `agent${i}`,
      kind: i < 10 ? "ai" : "human",
      model: "synthetic/convention",
      budgetMicros: 1000,
    });
    await f.db.query(
      "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
      [`agent${i}`, leagueId, `team${i}`],
    );
  }
  await governance.execute(commissioner, {
    type: "openMeeting",
    leagueId,
    idempotencyKey: "open",
    meetingId,
    proposalDeadline: new Date(Date.now() + 3600_000).toISOString(),
    voteDeadline: new Date(Date.now() + 7200_000).toISOString(),
  });
});
afterEach(async () => {
  await f?.close();
});
async function start() {
  return convention.start(commissioner, { meetingId, limits, synthetic: true });
}
async function voting() {
  for (const table of ["governance_meetings", "runtime_conventions"])
    await f.db.query(
      `UPDATE ${table} SET proposal_deadline=clock_timestamp()-interval '1 second',vote_deadline=clock_timestamp()+interval '1 hour' WHERE league_id=$1`,
      [leagueId],
    );
  await f.db.query(
    "UPDATE runtime_convention_waves SET due_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '30 minutes' WHERE league_id=$1 AND wave='voting-open'",
    [leagueId],
  );
}
it("requires real matching activated canaries and never fabricates absent human participation", async () => {
  await expect(
    convention.start(commissioner, { meetingId, limits, synthetic: false }),
  ).rejects.toThrow("CONVENTION_MODEL_CANARY_REQUIRED");
  expect((await f.db.query("SELECT 1 FROM runtime_conventions")).rowCount).toBe(
    0,
  );
  await start();
  const ticks = await Promise.all([
    convention.tick(leagueId),
    convention.tick(leagueId),
  ]);
  expect(ticks.flat().filter((x) => x.status === "dispatched")).toHaveLength(1);
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM runtime_jobs WHERE payload->>'kind'='governance.phase'",
      )
    ).rowCount,
  ).toBe(12);
  expect(
    await runtime.claim("human", 30000, undefined, ["agent11"]),
  ).toBeNull();
  expect((await f.db.query("SELECT 1 FROM governance_votes")).rowCount).toBe(0);
});
it("synthetic owners submit proposals and votes through real action receipts and bounded phase wakes", async () => {
  await start();
  await convention.tick(leagueId);
  const rules = (await league.snapshot(leagueId)).league.rules;
  const driver = new TestDriver("synthetic/convention", (job) => ({
    actions: [
      GovernanceActionSchema.parse({
        type: "governance",
        causalId: `${job.payload.phase}:${job.agentId}`,
        command:
          job.payload.phase === "proposals"
            ? {
                type: "submitProposal",
                meetingId,
                proposalId: `proposal-${job.agentId}`,
                version: `version-${job.agentId}`,
                title: `Synthetic ${job.agentId}`,
                rationale: "Test policy, not a model or human decision",
                rules,
                scoringRules: halfPprRules,
                teamOrder: owners.map((o) => o.teamId),
              }
            : {
                type: "castVote",
                proposalId: "proposal-agent0",
                choice: "yes",
              },
      }),
    ],
    costMicros: 1,
    summary: "Synthetic scripted vote; not live deliberation",
  }));
  const outbox = new FranchiseOutbox(f.db, runtime);
  for (let i = 0; i < 10; i++) {
    expect(
      (
        await runOne(runtime, driver, "owner", {
          allowedAgentIds: [`agent${i}`],
          maxCostMicros: 10,
        })
      ).status,
    ).toBe("completed");
    expect(
      (
        await outbox.dispatchOne("governance", {
          allowedAgentIds: [`agent${i}`],
        })
      ).status,
    ).toBe("delivered");
  }
  expect(
    (await f.db.query("SELECT 1 FROM governance_proposals")).rowCount,
  ).toBe(10);
  expect((await f.db.query("SELECT 1 FROM runtime_jobs")).rowCount).toBe(12); // no proposal broadcast cascade
  const sealed = await governance.snapshot(owners[1], meetingId);
  expect(sealed.proposals).toHaveLength(1);
  await voting();
  await convention.tick(leagueId);
  for (let i = 0; i < 10; i++) {
    expect(
      (
        await runOne(runtime, driver, "owner", {
          allowedAgentIds: [`agent${i}`],
          maxCostMicros: 10,
        })
      ).status,
    ).toBe("completed");
    expect(
      (
        await outbox.dispatchOne("governance", {
          allowedAgentIds: [`agent${i}`],
        })
      ).status,
    ).toBe("delivered");
  }
  expect((await f.db.query("SELECT 1 FROM governance_votes")).rowCount).toBe(
    10,
  );
  expect(
    (
      await f.db.query(
        "SELECT 1 FROM governance_votes WHERE team_id IN ('team10','team11')",
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (await league.snapshot(leagueId)).league.constitution_version,
  ).toBeNull();
});
it("caps unrelated chatter turns in each meeting phase before invoking the driver", async () => {
  await start();
  let calls = 0;
  const driver = new TestDriver("synthetic/convention", () => {
    calls++;
    return { actions: [], costMicros: 0, summary: "synthetic" };
  });
  for (let i = 0; i < 3; i++) {
    await runtime.ingestEvent({
      agentId: "agent0",
      causalId: `chatter${i}`,
      payload: { kind: "arbitrary-message" },
    });
    const result = await runOne(runtime, driver, "worker", {
      allowedAgentIds: ["agent0"],
      maxCostMicros: 10,
    });
    expect(result.status).toBe(i < 2 ? "completed" : "failed");
    if (i === 2)
      expect("error" in result && result.error).toContain(
        "CONVENTION_TURN_LIMIT",
      );
  }
  expect(calls).toBe(2);
  await voting();
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "vote-phase",
    payload: {},
  });
  expect(
    (
      await runOne(runtime, driver, "worker", {
        allowedAgentIds: ["agent0"],
        maxCostMicros: 10,
      })
    ).status,
  ).toBe("completed");
  expect(calls).toBe(3);
});
it("unknown prior cost holds meeting budget and cannot be evaded by a new job", async () => {
  await start();
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "uncertain",
    payload: {},
  });
  const unknown = new TestDriver("synthetic/convention", () => {
    throw Error("Synthetic unknown provider outcome");
  });
  expect(
    (
      await runOne(runtime, unknown, "worker", {
        allowedAgentIds: ["agent0"],
        maxCostMicros: 60,
      })
    ).status,
  ).toBe("failed");
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "replacement",
    payload: {},
  });
  let called = false;
  const next = new TestDriver("synthetic/convention", () => {
    called = true;
    return { actions: [], costMicros: 0, summary: "synthetic" };
  });
  const result = await runOne(runtime, next, "worker", {
    allowedAgentIds: ["agent0"],
    maxCostMicros: 60,
  });
  expect(result.status).toBe("failed");
  expect("error" in result && result.error).toContain("CONVENTION_SPEND_LIMIT");
  expect(called).toBe(false);
  expect(
    ((await convention.context("agent0")) as any).usage.committedMicros,
  ).toBe(60);
});
it("governance read tool rejects stale model/job identity and preserves sealed proposals", async () => {
  await start();
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "read",
    payload: {},
  });
  const job = (await runtime.claim("reader"))!;
  const tool = createGovernanceReadTools(f.db, runtime)[0];
  await expect(
    tool.execute({ ...job, model: "other/model" }, {}),
  ).rejects.toThrow("GOVERNANCE_JOB_AUTHORITY_EXPIRED");
  expect(((await tool.execute(job, {})) as any).meetingId).toBe(meetingId);
  await expect(tool.execute(job, { teamId: "team1" })).rejects.toThrow();
});

it("MFL owners can commit native menu proposals through the same verified outbox", async () => {
  await bindHost(f.db, commissioner, {
    leagueId,
    host: "mfl",
    expectedVersion: 0,
    idempotencyKey: "mfl",
    reason: "Synthetic MFL convention fixture",
    config: { season: 2026, leagueId: "12345", configRef: "synthetic" },
  });
  await governance.execute(commissioner, {
    leagueId,
    idempotencyKey: "menu",
    type: "registerMflMenu",
    menuId: "menu",
    title: "Synthetic reviewed menu",
    sourceNote: "Synthetic capability evidence; no external calls",
    questions: [
      {
        id: "scoring",
        label: "Scoring",
        options: [
          {
            id: "ppr",
            label: "PPR",
            content: "Synthetic full PPR option",
            evidenceRefs: ["synthetic"],
          },
        ],
      },
    ],
    applicationSections: [{ id: "scoring", label: "Scoring" }],
  });
  await governance.execute(commissioner, {
    leagueId,
    idempotencyKey: "mfl-meeting",
    type: "openMeeting",
    meetingId,
    menuId: "menu",
    discussionOpensAt: new Date(Date.now() + 1200_000).toISOString(),
    proposalDeadline: new Date(Date.now() + 3600_000).toISOString(),
    voteDeadline: new Date(Date.now() + 7200_000).toISOString(),
  });
  await convention.start(commissioner, {
    meetingId,
    synthetic: true,
    limits: { ...limits, proposalTurns: 6 },
  });
  await convention.tick(leagueId);
  const driver = new TestDriver("synthetic/convention", (job) => ({
    actions: [
      GovernanceActionSchema.parse({
        type: "governance",
        causalId: "native-proposal",
        command: {
          type: "submitMflProposal",
          meetingId,
          proposalId: `${job.agentId}-native-proposal`,
          version: "v1",
          title: "Synthetic MFL choice",
          rationale: "Synthetic policy only",
          menuId: "menu",
          selections: { scoring: "ppr" },
          teamOrder: owners.map((o) => o.teamId),
        },
      }),
    ],
    costMicros: 0,
    summary: "Synthetic policy; no model deliberation claimed",
  }));
  expect(
    (
      await runOne(runtime, driver, "mfl-owner", {
        allowedAgentIds: ["agent0"],
        maxCostMicros: 10,
      })
    ).status,
  ).toBe("completed");
  expect(
    (
      await new FranchiseOutbox(f.db, runtime).dispatchOne("mfl-governance", {
        allowedAgentIds: ["agent0"],
      })
    ).status,
  ).toBe("delivered");
  expect(
    (await f.db.query("SELECT 1 FROM mfl_governance_proposals")).rowCount,
  ).toBe(1);
  expect(
    (await f.db.query("SELECT 1 FROM governance_proposals")).rowCount,
  ).toBe(0);
  expect(
    (
      await runOne(runtime, driver, "second-owner", {
        allowedAgentIds: ["agent1"],
        maxCostMicros: 10,
      })
    ).status,
  ).toBe("completed");
  expect(
    (
      await new FranchiseOutbox(f.db, runtime).dispatchOne("second-outbox", {
        allowedAgentIds: ["agent1"],
      })
    ).status,
  ).toBe("delivered");
  const context = (await convention.context("agent0")) as any;
  expect(context.governance.menu).toBeTruthy();
  expect(context.governance.proposals).toHaveLength(1);
  await f.db.query(
    "UPDATE mfl_governance_meetings SET discussion_opens_at=clock_timestamp()-interval '1 second' WHERE league_id=$1",
    [leagueId],
  );
  await f.db.query(
    "UPDATE runtime_conventions SET discussion_opens_at=clock_timestamp()-interval '1 second' WHERE league_id=$1",
    [leagueId],
  );
  await f.db.query(
    "UPDATE runtime_convention_waves SET due_at=clock_timestamp()-interval '1 second' WHERE league_id=$1 AND wave='discussion'",
    [leagueId],
  );
  await convention.tick(leagueId);
  const consolidation = new TestDriver("synthetic/convention", async (job) => {
    const view = (await createGovernanceReadTools(f.db, runtime)[0].execute(
      job,
      {},
    )) as any;
    expect(view.governance.phase).toBe("discussion");
    expect(view.governance.proposals).toHaveLength(2);
    return {
      actions: [
        GovernanceActionSchema.parse({
          type: "governance",
          causalId: "consolidated-choice",
          command: {
            type: "submitMflProposal",
            meetingId,
            proposalId: "consolidated-v2",
            replacesProposalId: "agent0-native-proposal",
            version: "v2",
            title: "Synthetic consolidated candidate",
            rationale:
              "Synthetic fixture inspected both owners' persisted proposals",
            menuId: "menu",
            selections: { scoring: "ppr" },
            teamOrder: owners.map((o) => o.teamId),
          },
        }),
      ],
      costMicros: 0,
      summary: "Synthetic revision fixture; no real negotiation claimed",
    };
  });
  expect(
    (
      await runOne(runtime, consolidation, "consolidator", {
        allowedAgentIds: ["agent0"],
        maxCostMicros: 10,
      })
    ).status,
  ).toBe("completed");
  expect(
    (
      await new FranchiseOutbox(f.db, runtime).dispatchOne(
        "consolidation-outbox",
        { allowedAgentIds: ["agent0"] },
      )
    ).status,
  ).toBe("delivered");
  const revised = ((await convention.context("agent1")) as any).governance
    .proposals;
  expect(revised).toHaveLength(3);
  expect(
    revised.find((p: any) => p.id === "agent0-native-proposal").ballot_eligible,
  ).toBe(false);
  expect(
    revised.find((p: any) => p.id === "consolidated-v2").ballot_eligible,
  ).toBe(true);
  await f.db.query(
    "UPDATE mfl_governance_meetings SET discussion_opens_at=clock_timestamp()-interval '2 seconds',proposal_deadline=clock_timestamp()-interval '1 second' WHERE league_id=$1",
    [leagueId],
  );
  await f.db.query(
    "UPDATE runtime_conventions SET discussion_opens_at=clock_timestamp()-interval '2 seconds',proposal_deadline=clock_timestamp()-interval '1 second' WHERE league_id=$1",
    [leagueId],
  );
  await f.db.query(
    "UPDATE runtime_convention_waves SET due_at=clock_timestamp()-interval '1 second' WHERE league_id=$1 AND wave='voting-open'",
    [leagueId],
  );
  await convention.tick(leagueId);
  const ballot = new TestDriver("synthetic/convention", () => ({
    actions: [
      GovernanceActionSchema.parse({
        type: "governance",
        causalId: "support-consolidation",
        command: {
          type: "castVote",
          proposalId: "consolidated-v2",
          choice: "yes",
        },
      }),
    ],
    costMicros: 0,
    summary: "Synthetic own ballot",
  }));
  for (const agentId of ["agent0", "agent1"]) {
    expect(
      (
        await runOne(runtime, ballot, "ballot-owner", {
          allowedAgentIds: [agentId],
          maxCostMicros: 10,
        })
      ).status,
    ).toBe("completed");
    expect(
      (
        await new FranchiseOutbox(f.db, runtime).dispatchOne("ballot-outbox", {
          allowedAgentIds: [agentId],
        })
      ).status,
    ).toBe("delivered");
  }
  const recorded = (
    await f.db.query(
      "SELECT team_id FROM mfl_governance_votes WHERE proposal_id='consolidated-v2' ORDER BY team_id",
    )
  ).rows;
  expect(recorded.map((r) => r.team_id)).toEqual(["team0", "team1"]);
  expect(
    (await f.db.query("SELECT 1 FROM mfl_governance_approvals")).rowCount,
  ).toBe(0);
});
it("protects future discussion and consolidation turns from early chatter", async () => {
  await convention.start(commissioner, {
    meetingId,
    synthetic: true,
    limits: { ...limits, proposalTurns: 3 },
  });
  for (const wave of ["discussion", "consolidation"])
    await f.db.query(
      "INSERT INTO runtime_convention_waves(league_id,meeting_id,wave,phase,due_at,expires_at) VALUES($1,$2,$3,'proposals',clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '20 minutes')",
      [leagueId, meetingId, wave],
    );
  await convention.tick(leagueId);
  let calls = 0;
  const driver = new TestDriver("synthetic/convention", () => {
    calls++;
    return {
      actions: [],
      costMicros: 0,
      summary: "Synthetic bounded discussion",
    };
  });
  expect(
    (
      await runOne(runtime, driver, "initial", {
        maxCostMicros: 10,
        allowedAgentIds: ["agent0"],
      })
    ).status,
  ).toBe("completed");
  await runtime.ingestEvent({
    agentId: "agent0",
    causalId: "early-chatter",
    payload: { synthetic: true },
  });
  expect(
    (
      await runOne(runtime, driver, "chat", {
        maxCostMicros: 10,
        allowedAgentIds: ["agent0"],
      })
    ).status,
  ).toBe("failed");
  expect(calls).toBe(1);
  await f.db.query(
    "UPDATE runtime_convention_waves SET due_at=clock_timestamp()-interval '1 second' WHERE league_id=$1 AND wave='discussion'",
    [leagueId],
  );
  await convention.tick(leagueId);
  expect(
    (
      await runOne(runtime, driver, "discussion", {
        maxCostMicros: 10,
        allowedAgentIds: ["agent0"],
      })
    ).status,
  ).toBe("completed");
  expect(calls).toBe(2);
});
