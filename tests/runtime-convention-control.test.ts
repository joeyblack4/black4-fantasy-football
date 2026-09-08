import { beforeEach, afterEach, it, expect } from "vitest";
import { testDb } from "./helpers.js";
import { RuntimeStore } from "../src/runtime/index.js";
import {
  ConventionRuntime,
  reserveConventionTurn,
} from "../src/runtime/convention.js";
import { ConventionControlService } from "../src/runtime/convention-control.js";
import { GovernanceService } from "../src/governance/index.js";
import { bindHost } from "../src/league/host.js";
import { transaction } from "../src/db.js";
let f: Awaited<ReturnType<typeof testDb>>,
  store: RuntimeStore,
  gov: GovernanceService,
  runtime: ConventionRuntime,
  control: ConventionControlService;
const leagueId = "synthetic-pause",
  meetingId = "same-meeting",
  actor = { id: "commissioner", role: "commissioner" as const, leagueId };
const owner = (i: number) => ({
  id: `owner${i}`,
  teamId: `team${i}`,
  role: "owner" as const,
  leagueId,
});
const pauseRequest = {
  meetingId,
  idempotencyKey: "pause",
  expectedHostVersion: 1,
  reason: "Synthetic transport repair",
};
beforeEach(async () => {
  f = await testDb();
  store = new RuntimeStore(f.db);
  gov = new GovernanceService(f.db);
  runtime = new ConventionRuntime(f.db, store, gov);
  control = new ConventionControlService(f.db);
  await f.db.query(
    "INSERT INTO leagues(id,name,rules) VALUES($1,'SYNTHETIC pause','{}')",
    [leagueId],
  );
  for (let i = 0; i < 12; i++) {
    await f.db.query(
      "INSERT INTO league_teams(league_id,id,owner_id,name,kind,draft_position,waiver_priority,faab) VALUES($1,$2,$3,$4,$5,$6,$6,100)",
      [
        leagueId,
        `team${i}`,
        `owner${i}`,
        `SYNTHETIC ${i}`,
        i < 10 ? "ai" : "human",
        i,
      ],
    );
    {
      await store.createAgent({
        id: `agent${i}`,
        kind: i < 10 ? "ai" : "human",
        model: "synthetic/pause",
        budgetMicros: 1000000,
      });
      await f.db.query(
        "INSERT INTO runtime_bindings(agent_id,league_id,team_id) VALUES($1,$2,$3)",
        [`agent${i}`, leagueId, `team${i}`],
      );
    }
  }
  await bindHost(f.db, actor, {
    leagueId,
    host: "mfl",
    expectedVersion: 0,
    idempotencyKey: "host",
    reason: "Synthetic fixture",
    config: { season: 2026, leagueId: "12345", configRef: "synthetic" },
  });
  await gov.execute(actor, {
    type: "registerMflMenu",
    leagueId,
    idempotencyKey: "menu",
    menuId: "menu",
    title: "SYNTHETIC",
    sourceNote: "No native calls",
    questions: [
      {
        id: "score",
        label: "Synthetic scoring",
        options: [
          {
            id: "ppr",
            label: "PPR",
            content: "SYNTHETIC option",
            evidenceRefs: ["synthetic"],
          },
        ],
      },
    ],
    applicationSections: [{ id: "score", label: "Scoring" }],
  });
  const now = Date.now();
  await gov.execute(actor, {
    type: "openMeeting",
    leagueId,
    idempotencyKey: "open",
    meetingId,
    menuId: "menu",
    discussionOpensAt: new Date(now + 60000).toISOString(),
    proposalDeadline: new Date(now + 120000).toISOString(),
    voteDeadline: new Date(now + 240000).toISOString(),
  });
  await runtime.start(actor, {
    meetingId,
    synthetic: true,
    limits: {
      proposalTurns: 3,
      votingTurns: 2,
      closedTurns: 1,
      maxSpendMicros: 100000,
      maxReservationMicros: 10000,
    },
  });
  for (const i of [0, 1])
    await gov.execute(owner(i), {
      type: "submitMflProposal",
      leagueId,
      idempotencyKey: `proposal-${i}`,
      meetingId,
      proposalId: `proposal-${i}`,
      menuId: "menu",
      version: "v1",
      title: "SYNTHETIC",
      rationale: `Private rationale ${i}`,
      selections: { score: "ppr" },
      teamOrder: Array.from({ length: 12 }, (_, i) => `team${i}`),
    });
  await f.db.query("UPDATE runtime_agents SET enabled=false");
});
afterEach(async () => {
  await f.close();
});
it("freezes authenticated writes, disclosure, tick and reservation; resumes exact future clocks without changing candidates", async () => {
  const before = (
    await f.db.query("SELECT * FROM mfl_governance_meetings WHERE id=$1", [
      meetingId,
    ])
  ).rows[0];
  const proposals = (
    await f.db.query("SELECT * FROM mfl_governance_proposals ORDER BY id")
  ).rows;
  const p: any = await control.pause(actor, pauseRequest);
  expect(p.status).toBe("paused");
  expect(p.proposalCount).toBe(2);
  await expect(
    gov.execute(owner(0), {
      type: "castVote",
      leagueId,
      idempotencyKey: "forbidden-vote",
      proposalId: "proposal-0",
      choice: "yes",
    }),
  ).rejects.toThrow("CONVENTION_PAUSED");
  await expect(
    gov.execute(actor, {
      type: "prepareRatification",
      leagueId,
      idempotencyKey: "forbidden-ratify",
      proposalId: "proposal-0",
    }),
  ).rejects.toThrow("CONVENTION_PAUSED");
  const snap: any = await gov.snapshot(owner(0), meetingId);
  expect(snap.pause.id).toBe(p.pauseId);
  expect(snap.proposals).toHaveLength(1);
  expect(await runtime.tick(leagueId)).toEqual([]);
  await expect(
    transaction(f.db, (tx) =>
      reserveConventionTurn(
        tx,
        {
          agentId: "agent0",
          id: "00000000-0000-4000-8000-000000000001",
        } as any,
        1,
      ),
    ),
  ).rejects.toThrow("CONVENTION_PAUSED");
  expect(((await runtime.context("agent0")) as any).status).toBe("paused");
  await new Promise((r) => setTimeout(r, 20));
  const resumed: any = await control.resume(actor, {
    pauseId: p.pauseId,
    idempotencyKey: "resume",
    reason: "Synthetic fix verified",
  });
  expect(resumed.durationMs).toBeGreaterThan(0);
  expect(resumed.workersEnabled).toBe(false);
  const after = (
    await f.db.query("SELECT * FROM mfl_governance_meetings WHERE id=$1", [
      meetingId,
    ])
  ).rows[0];
  for (const key of [
    "discussion_opens_at",
    "proposal_deadline",
    "vote_deadline",
  ])
    expect(after[key].getTime() - before[key].getTime()).toBe(
      resumed.durationMs,
    );
  expect(
    (await f.db.query("SELECT * FROM mfl_governance_proposals ORDER BY id"))
      .rows,
  ).toEqual(proposals);
  expect(
    (await f.db.query("SELECT * FROM mfl_governance_votes")).rowCount,
  ).toBe(0);
  expect(
    (await f.db.query("SELECT 1 FROM runtime_agents WHERE enabled")).rowCount,
  ).toBe(0);
  const replay: any = await control.resume(actor, {
    pauseId: p.pauseId,
    idempotencyKey: "resume",
    reason: "Synthetic fix verified",
  });
  expect(replay.replayed).toBe(true);
  expect(replay.durationMs).toBe(resumed.durationMs);
});
it("serializes concurrent pause and preserves idempotency while refusing unsafe actors and live work", async () => {
  await expect(control.pause(owner(0), pauseRequest)).rejects.toThrow(
    "COMMISSIONER_REQUIRED",
  );
  await expect(
    control.pause({ ...actor, leagueId: "other" }, pauseRequest),
  ).rejects.toThrow();
  await f.db.query("UPDATE runtime_agents SET enabled=true WHERE id='agent0'");
  await expect(control.pause(actor, pauseRequest)).rejects.toThrow(
    "MUST_BE_DISABLED",
  );
  await f.db.query("UPDATE runtime_agents SET enabled=false");
  const [a, b]: any[] = await Promise.all([
    control.pause(actor, pauseRequest),
    control.pause(actor, pauseRequest),
  ]);
  expect(a.pauseId).toBe(b.pauseId);
  expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  await expect(
    control.pause(actor, { ...pauseRequest, reason: "changed" }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(
    (await f.db.query("SELECT * FROM runtime_convention_pauses")).rowCount,
  ).toBe(1);
});
it("resume refuses altered ballots/candidates rather than silently shifting a corrupted meeting", async () => {
  const p: any = await control.pause(actor, pauseRequest);
  await f.db.query(
    "UPDATE mfl_governance_proposals SET title='TAMPERED' WHERE id='proposal-0'",
  );
  await expect(
    control.resume(actor, {
      pauseId: p.pauseId,
      idempotencyKey: "resume",
      reason: "test",
    }),
  ).rejects.toThrow("CONTENT_CHANGED");
  expect(
    (await f.db.query("SELECT status FROM runtime_convention_pauses")).rows[0]
      .status,
  ).toBe("paused");
});

it("records explicit common proposal extension separately from elapsed pause and preserves wave timing", async () => {
  const original = (await f.db.query("SELECT * FROM mfl_governance_meetings"))
    .rows[0];
  const waves = (
    await f.db.query("SELECT * FROM runtime_convention_waves ORDER BY wave")
  ).rows;
  const p: any = await control.pause(actor, pauseRequest);
  const r: any = await control.resume(actor, {
    pauseId: p.pauseId,
    idempotencyKey: "extend",
    reason: "Equal procedural recovery for every owner",
    proposalExtensionMs: 600000,
  });
  expect(r.proposalExtensionMs).toBe(600000);
  expect(r.cumulativeProposalExtensionMs).toBe(600000);
  const after = (await f.db.query("SELECT * FROM mfl_governance_meetings"))
    .rows[0];
  expect(
    after.discussion_opens_at.getTime() -
      original.discussion_opens_at.getTime(),
  ).toBe(r.durationMs);
  for (const key of ["proposal_deadline", "vote_deadline"])
    expect(after[key].getTime() - original[key].getTime()).toBe(
      r.durationMs + 600000,
    );
  const afterWaves = (
    await f.db.query("SELECT * FROM runtime_convention_waves ORDER BY wave")
  ).rows;
  for (let i = 0; i < waves.length; i++) {
    for (const key of ["due_at", "expires_at"]) {
      const increment =
        waves[i].status === "pending"
          ? r.durationMs +
            (waves[i][key] >= original.proposal_deadline ? 600000 : 0)
          : 0;
      expect(afterWaves[i][key].getTime() - waves[i][key].getTime()).toBe(
        increment,
      );
    }
  }
  expect(
    (
      await f.db.query(
        "SELECT response FROM runtime_convention_control_receipts WHERE idempotency_key='extend'",
      )
    ).rows[0].response.proposalExtensionMs,
  ).toBe(600000);
  const replay: any = await control.resume(actor, {
    pauseId: p.pauseId,
    idempotencyKey: "extend",
    reason: "Equal procedural recovery for every owner",
    proposalExtensionMs: 600000,
  });
  expect(replay.replayed).toBe(true);
  expect(replay.durationMs).toBe(r.durationMs);
  await expect(
    control.resume(actor, {
      pauseId: p.pauseId,
      idempotencyKey: "extend",
      reason: "Equal procedural recovery for every owner",
      proposalExtensionMs: 600001,
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});

it("does not reopen an elapsed proposal boundary or extend after ballots; freezes elapsed disclosure", async () => {
  for (const table of ["mfl_governance_meetings", "runtime_conventions"])
    await f.db.query(
      `UPDATE ${table} SET discussion_opens_at=clock_timestamp()-interval '2 seconds',proposal_deadline=clock_timestamp()-interval '1 second'`,
    );
  const original = (await f.db.query("SELECT * FROM mfl_governance_meetings"))
    .rows[0];
  await gov.execute(owner(0), {
    type: "castVote",
    leagueId,
    idempotencyKey: "real-synthetic-vote",
    proposalId: "proposal-0",
    choice: "yes",
  });
  const p: any = await control.pause(actor, pauseRequest);
  await expect(
    control.resume(actor, {
      pauseId: p.pauseId,
      idempotencyKey: "bad-extend",
      reason: "test",
      proposalExtensionMs: 1,
    }),
  ).rejects.toThrow("PREVOTE_PAUSE");
  const r: any = await control.resume(actor, {
    pauseId: p.pauseId,
    idempotencyKey: "valid-resume",
    reason: "test",
  });
  const after = (await f.db.query("SELECT * FROM mfl_governance_meetings"))
    .rows[0];
  expect(after.proposal_deadline).toEqual(original.proposal_deadline);
  expect(after.discussion_opens_at).toEqual(original.discussion_opens_at);
  expect(after.vote_deadline.getTime() - original.vote_deadline.getTime()).toBe(
    r.durationMs,
  );
  expect(
    (await f.db.query("SELECT * FROM mfl_governance_votes")).rowCount,
  ).toBe(1);
});

it("binds candidate timestamps in frozen content and refuses a running job", async () => {
  await transaction(f.db, (tx) =>
    store.ingestEventTx(tx, {
      agentId: "agent0",
      causalId: "synthetic-live",
      payload: { kind: "synthetic" },
    }),
  );
  await f.db.query(
    "UPDATE runtime_jobs SET status='running',lease_until=clock_timestamp()+interval '1 minute' WHERE id=(SELECT id FROM runtime_jobs LIMIT 1)",
  );
  await expect(control.pause(actor, pauseRequest)).rejects.toThrow(
    "NOT_QUIESCENT",
  );
  await f.db.query(
    "UPDATE runtime_jobs SET status='pending',lease_until=NULL WHERE status='running'",
  );
  const p: any = await control.pause(actor, pauseRequest);
  await f.db.query(
    "UPDATE mfl_governance_proposals SET created_at=created_at+interval '1 second' WHERE id='proposal-0'",
  );
  await expect(
    control.resume(actor, {
      pauseId: p.pauseId,
      idempotencyKey: "tampered-time",
      reason: "test",
    }),
  ).rejects.toThrow("CONTENT_CHANGED");
});
