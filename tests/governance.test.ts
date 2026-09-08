import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { halfPprRules } from "../src/data/index.js";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { GovernanceService } from "../src/governance/index.js";
async function fixture() {
  const resource = await testDb(),
    leagueId = "synthetic-governance",
    league = new LeagueService(resource.db),
    governance = new GovernanceService(resource.db);
  const commissioner: Actor = {
    id: "commissioner",
    role: "commissioner",
    leagueId,
  };
  const owners = Array.from({ length: 12 }, (_, i): Actor => ({
    id: `owner-${i}`,
    teamId: `team-${i}`,
    leagueId,
    role: "owner",
  }));
  const rules = {
    rosterSize: 2,
    draftOrder: "snake",
    draftPickSeconds: 60,
    faabBudget: 100,
    freeAgentMode: "waiversOnly",
    lineupSlots: [{ id: "FLEX", positions: ["RB", "WR", "TE"] }],
  };
  await league.execute(commissioner, {
    leagueId,
    idempotencyKey: "create",
    type: "createLeague",
    name: "SYNTHETIC governance fixture",
    rules,
    teams: owners.map((o, i) => ({
      id: o.teamId,
      ownerId: o.id,
      name: `Test owner ${i}`,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  const exec = (
    actor: Actor,
    command: Record<string, unknown>,
    key: string = randomUUID(),
  ) => governance.execute(actor, { leagueId, idempotencyKey: key, ...command });
  await exec(commissioner, {
    type: "openMeeting",
    meetingId: "meeting",
    proposalDeadline: new Date(Date.now() + 60000).toISOString(),
    voteDeadline: new Date(Date.now() + 120000).toISOString(),
  });
  const proposal = (proposalId = "proposal", version = "v1") => ({
    type: "submitProposal",
    meetingId: "meeting",
    proposalId,
    version,
    title: "Test owner-authored rules",
    rationale:
      "SYNTHETIC: test harness choices; no live AI deliberation claimed.",
    rules,
    scoringRules: halfPprRules,
    teamOrder: owners.map((o) => o.teamId!).reverse(),
  });
  const voting = () =>
    resource.db.query(
      "UPDATE governance_meetings SET proposal_deadline=clock_timestamp()-interval '1 second'",
    );
  const close = () =>
    resource.db.query(
      "UPDATE governance_meetings SET proposal_deadline=clock_timestamp()-interval '2 seconds',vote_deadline=clock_timestamp()-interval '1 second'",
    );
  return {
    ...resource,
    closeSchema: resource.close,
    leagueId,
    league,
    governance,
    commissioner,
    owners,
    rules,
    exec,
    proposal,
    voting,
    close,
  };
}
const rejects = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ name: "LeagueError", code });
describe("constitutional governance — synthetic authenticated owners", () => {
  it("seals independent proposals until voting and preserves immutable author content", async () => {
    const f = await fixture();
    try {
      const first = await f.exec(f.owners[0], f.proposal(), "original");
      expect(
        (await f.governance.snapshot(f.owners[0], "meeting")).proposals,
      ).toHaveLength(1);
      expect(
        (await f.governance.snapshot(f.owners[1], "meeting")).proposals,
      ).toHaveLength(0);
      expect(
        (await f.governance.snapshot(f.commissioner, "meeting")).proposals,
      ).toHaveLength(0);
      expect(
        (await f.exec(f.owners[0], f.proposal(), "original")).replayed,
      ).toBe(true);
      await rejects(
        f.exec(
          f.owners[0],
          { ...f.proposal(), title: "Changed under same key" },
          "original",
        ),
        "IDEMPOTENCY_CONFLICT",
      );
      await rejects(
        f.exec(f.owners[0], f.proposal("another", "v2")),
        "PROPOSAL_LIMIT",
      );
      await f.voting();
      const visible = await f.governance.snapshot(f.owners[1], "meeting");
      expect(visible.phase).toBe("voting");
      expect(visible.proposals[0]).toMatchObject({
        author_id: "owner-0",
        title: "Test owner-authored rules",
        content_hash: first.result.contentHash,
      });
      await rejects(
        f.exec(f.owners[1], f.proposal("late", "v2")),
        "PROPOSALS_CLOSED",
      );
    } finally {
      await f.closeSchema();
    }
  });
  it("rejects forged owners, outside teams, unknown rules, and supplied voting authority", async () => {
    const f = await fixture();
    try {
      await rejects(
        f.exec({ ...f.owners[0], teamId: "team-1" }, f.proposal()),
        "FORBIDDEN",
      );
      await rejects(
        f.exec({ ...f.owners[0], leagueId: "foreign" }, f.proposal()),
        "FORBIDDEN",
      );
      await rejects(
        f.exec(f.owners[0], {
          ...f.proposal(),
          teamOrder: [...f.owners.slice(0, 11).map((o) => o.teamId), "outside"],
        }),
        "INVALID_DRAFT_ORDER",
      );
      await expect(
        f.exec(f.owners[0], {
          ...f.proposal(),
          rules: { ...f.rules, unimplementedBonus: 100 },
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
      await f.exec(f.owners[0], f.proposal());
      await f.voting();
      await rejects(
        f.exec(
          { ...f.owners[0], teamId: "team-1" },
          { type: "castVote", proposalId: "proposal", choice: "yes" },
        ),
        "FORBIDDEN",
      );
      await expect(
        f.exec(f.owners[0], {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
          ownerId: "owner-1",
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
    } finally {
      await f.closeSchema();
    }
  });
  it("records exactly one immutable vote when a franchise sends competing votes concurrently", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], f.proposal());
      await rejects(
        f.exec(f.owners[0], {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        }),
        "VOTING_CLOSED",
      );
      await f.voting();
      const votes = await Promise.allSettled([
        f.exec(
          f.owners[0],
          { type: "castVote", proposalId: "proposal", choice: "yes" },
          "yes",
        ),
        f.exec(
          f.owners[0],
          { type: "castVote", proposalId: "proposal", choice: "no" },
          "no",
        ),
      ]);
      expect(votes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
      const choice = votes[0].status === "fulfilled" ? "yes" : "no";
      expect(
        (
          await f.exec(
            f.owners[0],
            { type: "castVote", proposalId: "proposal", choice },
            choice,
          )
        ).replayed,
      ).toBe(true);
      expect(
        (await f.governance.snapshot(f.owners[0], "meeting")).votes,
      ).toHaveLength(1);
    } finally {
      await f.closeSchema();
    }
  });
  it("requires eight verified approvals on the same immutable proposal after the voting window", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], f.proposal());
      await f.voting();
      for (const owner of f.owners.slice(0, 7))
        await f.exec(owner, {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        });
      await rejects(
        f.exec(f.commissioner, {
          type: "prepareRatification",
          proposalId: "proposal",
        }),
        "VOTING_OPEN",
      );
      await f.close();
      await rejects(
        f.exec(f.commissioner, {
          type: "prepareRatification",
          proposalId: "proposal",
        }),
        "QUORUM_NOT_MET",
      );
      await rejects(
        f.exec(f.owners[7], {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        }),
        "VOTING_CLOSED",
      );
      await rejects(
        f.league.execute(f.commissioner, {
          leagueId: f.leagueId,
          idempotencyKey: "fake",
          type: "ratifyConstitution",
          version: "v1",
          decisionReceipt: "invented-decision",
        }),
        "GOVERNANCE_DECISION_REQUIRED",
      );
      expect(
        (await f.league.snapshot(f.leagueId)).league.constitution_version,
      ).toBeNull();
    } finally {
      await f.closeSchema();
    }
  });
  it("atomically ratifies approved rules and a collision-safe twelve-team draft permutation", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], f.proposal());
      await f.voting();
      for (const owner of f.owners.slice(0, 8))
        await f.exec(owner, {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        });
      await f.close();
      await rejects(
        f.exec(f.owners[0], {
          type: "prepareRatification",
          proposalId: "proposal",
        }),
        "FORBIDDEN",
      );
      const decision = await f.exec(f.commissioner, {
        type: "prepareRatification",
        proposalId: "proposal",
      });
      const command = {
        leagueId: f.leagueId,
        idempotencyKey: "ratify",
        type: "ratifyConstitution",
        version: "v1",
        decisionReceipt: decision.result.decisionId,
      };
      await rejects(
        f.league.execute(f.commissioner, {
          ...command,
          rules: { ...f.rules, faabBudget: 1000 },
        }),
        "PROPOSAL_MISMATCH",
      );
      await rejects(
        f.league.execute({ ...f.commissioner, role: "system" }, command),
        "FORBIDDEN",
      );
      const ratified = await f.league.execute(f.commissioner, command);
      expect((await f.league.execute(f.commissioner, command)).replayed).toBe(
        true,
      );
      const state = await f.league.snapshot(f.leagueId);
      expect(state.teams.map((t) => t.id)).toEqual(
        f.owners.map((o) => o.teamId).reverse(),
      );
      expect(state.teams.map((t) => t.waiver_priority)).toEqual(
        Array.from({ length: 12 }, (_, i) => 11 - i),
      );
      expect(state.league.constitution_version).toBe("v1");
      expect(state.league.ratified_scoring_rules).toEqual(halfPprRules);
      expect(
        (await f.db.query("SELECT * FROM governance_decisions")).rows[0],
      ).toMatchObject({
        ratification_receipt_id: ratified.receiptId,
        yes_votes: 8,
      });
      expect(
        (await f.db.query("SELECT consumed_at FROM governance_decisions"))
          .rows[0].consumed_at,
      ).toBeInstanceOf(Date);
      await rejects(
        f.exec(f.owners[8], {
          type: "castVote",
          proposalId: "proposal",
          choice: "no",
        }),
        "RULES_FROZEN",
      );
    } finally {
      await f.closeSchema();
    }
  });
  it("detects post-vote proposal content corruption instead of ratifying a changed rule set", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], f.proposal());
      await f.voting();
      for (const owner of f.owners.slice(0, 8))
        await f.exec(owner, {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        });
      await f.close();
      const decision = await f.exec(f.commissioner, {
        type: "prepareRatification",
        proposalId: "proposal",
      });
      // Direct fixture corruption models an unexpected storage alteration; public APIs cannot update proposals.
      await f.db.query(
        "UPDATE governance_proposals SET title='Changed after votes'",
      );
      await rejects(
        f.league.execute(f.commissioner, {
          leagueId: f.leagueId,
          idempotencyKey: "ratify",
          type: "ratifyConstitution",
          version: "v1",
          decisionReceipt: decision.result.decisionId,
        }),
        "PROPOSAL_CHANGED",
      );
      expect(
        (await f.league.snapshot(f.leagueId)).league.constitution_version,
      ).toBeNull();
      expect(
        (await f.db.query("SELECT consumed_at FROM governance_decisions"))
          .rows[0].consumed_at,
      ).toBeNull();
    } finally {
      await f.closeSchema();
    }
  });
  it("does not pool votes across independently authored proposals sharing a version label", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], f.proposal("proposal-a", "v1"));
      await f.exec(f.owners[1], {
        ...f.proposal("proposal-b", "v1"),
        title: "Independent second owner proposal",
      });
      await f.voting();
      for (const owner of f.owners.slice(0, 4))
        await f.exec(owner, {
          type: "castVote",
          proposalId: "proposal-a",
          choice: "yes",
        });
      for (const owner of f.owners.slice(4, 8))
        await f.exec(owner, {
          type: "castVote",
          proposalId: "proposal-b",
          choice: "yes",
        });
      await f.close();
      await rejects(
        f.exec(f.commissioner, {
          type: "prepareRatification",
          proposalId: "proposal-a",
        }),
        "QUORUM_NOT_MET",
      );
      await rejects(
        f.exec(f.commissioner, {
          type: "prepareRatification",
          proposalId: "proposal-b",
        }),
        "QUORUM_NOT_MET",
      );
      expect(
        (await f.governance.snapshot(f.owners[0], "meeting")).proposals,
      ).toHaveLength(2);
    } finally {
      await f.closeSchema();
    }
  });

  it("requires the scoring mechanism in the owner proposal and detects changed point coefficients after voting", async () => {
    const f = await fixture();
    try {
      await expect(
        f.exec(f.owners[0], { ...f.proposal(), scoringRules: undefined }),
      ).rejects.toMatchObject({ name: "ZodError" });
      await expect(
        f.exec(f.owners[0], {
          ...f.proposal(),
          scoringRules: {
            version: "unsupported",
            milliPointsPerUnit: { madeUpStat: 1000 },
          },
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
      await f.exec(f.owners[0], f.proposal());
      await f.voting();
      for (const owner of f.owners.slice(0, 8))
        await f.exec(owner, {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        });
      await f.close();
      const decision = await f.exec(f.commissioner, {
        type: "prepareRatification",
        proposalId: "proposal",
      });
      await f.db.query(
        "UPDATE governance_proposals SET scoring_rules=jsonb_set(scoring_rules,'{milliPointsPerUnit,receptions}','1000'::jsonb)",
      );
      await rejects(
        f.league.execute(f.commissioner, {
          leagueId: f.leagueId,
          idempotencyKey: "changed-formula",
          type: "ratifyConstitution",
          version: "v1",
          decisionReceipt: decision.result.decisionId,
        }),
        "PROPOSAL_CHANGED",
      );
      expect(
        (await f.league.snapshot(f.leagueId)).league.ratified_scoring_rules,
      ).toBeNull();
    } finally {
      await f.closeSchema();
    }
  });
});
