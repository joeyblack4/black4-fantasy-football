import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb } from "./helpers.js";
import { LeagueService, type Actor } from "../src/league/index.js";
import { bindHost } from "../src/league/host.js";
import { GovernanceService } from "../src/governance/index.js";
async function fixture() {
  const r = await testDb(),
    leagueId = "synthetic-mfl-governance";
  const g = new GovernanceService(r.db),
    league = new LeagueService(r.db);
  const c: Actor = { id: "commissioner", role: "commissioner", leagueId };
  const owners = Array.from({ length: 12 }, (_, i): Actor => ({
    id: `owner-${i}`,
    teamId: `team-${i}`,
    role: "owner",
    leagueId,
  }));
  await league.execute(c, {
    type: "createLeague",
    leagueId,
    idempotencyKey: "create",
    name: "SYNTHETIC no MFL calls",
    rules: {
      rosterSize: 2,
      draftOrder: "snake",
      draftPickSeconds: 60,
      faabBudget: 100,
      freeAgentMode: "waiversOnly",
      lineupSlots: [{ id: "FLEX", positions: ["RB", "WR", "TE"] }],
    },
    teams: owners.map((o, i) => ({
      id: o.teamId,
      ownerId: o.id,
      name: `Synthetic ${i}`,
      kind: i < 10 ? "ai" : "human",
    })),
  });
  await bindHost(r.db, c, {
    leagueId,
    expectedVersion: 0,
    idempotencyKey: "bind",
    reason: "Synthetic fixture only",
    host: "mfl",
    config: { season: 2026, leagueId: "12345", configRef: "synthetic-config" },
  });
  const exec = (
    actor: Actor,
    input: Record<string, unknown>,
    idempotencyKey: string = randomUUID(),
  ) => g.execute(actor, { leagueId, idempotencyKey, ...input });
  const menu = {
    type: "registerMflMenu",
    menuId: "menu-v1",
    title: "SYNTHETIC options",
    questions: [
      {
        id: "scoring",
        label: "Scoring",
        options: [
          {
            id: "ppr",
            label: "PPR",
            content: "Synthetic full PPR rules placeholder; not live evidence",
            evidenceRefs: ["synthetic-fixture"],
          },
          {
            id: "basic",
            label: "Basic",
            content: "Synthetic basic rules",
            evidenceRefs: ["synthetic-fixture"],
          },
        ],
      },
    ],
    applicationSections: [
      { id: "scoring", label: "Scoring" },
      { id: "order", label: "Draft order" },
    ],
    sourceNote: "SYNTHETIC test-only capability evidence",
  };
  await exec(c, menu);
  await exec(c, {
    type: "openMeeting",
    meetingId: "meeting",
    menuId: "menu-v1",
    proposalDeadline: new Date(Date.now() + 60000).toISOString(),
    voteDeadline: new Date(Date.now() + 120000).toISOString(),
  });
  const proposal = {
    type: "submitMflProposal",
    meetingId: "meeting",
    proposalId: "proposal",
    version: "v1",
    title: "Synthetic owner choice",
    rationale: "SYNTHETIC test harness, no agent deliberation claimed",
    menuId: "menu-v1",
    selections: { scoring: "ppr" },
    teamOrder: owners.map((x) => x.teamId),
  };
  const voting = () =>
    r.db.query(
      "UPDATE mfl_governance_meetings SET proposal_deadline=clock_timestamp()-interval '1 second'",
    );
  const closed = () =>
    r.db.query(
      "UPDATE mfl_governance_meetings SET proposal_deadline=clock_timestamp()-interval '2 seconds',vote_deadline=clock_timestamp()-interval '1 second'",
    );
  async function eligible() {
    await exec(owners[0], proposal);
    await voting();
    for (const o of owners.slice(0, 8))
      await exec(o, {
        type: "castVote",
        proposalId: "proposal",
        choice: "yes",
      });
    await closed();
    return (
      await exec(c, { type: "prepareRatification", proposalId: "proposal" })
    ).result;
  }
  return {
    ...r,
    leagueId,
    g,
    league,
    c,
    owners,
    exec,
    menu,
    proposal,
    voting,
    closed,
    eligible,
  };
}
const rejects = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ code });
describe("MFL governance synthetic isolation", () => {
  it("seals immutable owner proposals; rejects foreign owners, unsupported selections and menu changes", async () => {
    const f = await fixture();
    try {
      await rejects(
        f.exec({ ...f.owners[0], teamId: "team-1" }, f.proposal),
        "FORBIDDEN",
      );
      await rejects(
        f.exec(f.owners[0], {
          ...f.proposal,
          selections: { scoring: "unsupported" },
        }),
        "INVALID_SELECTION",
      );
      await rejects(
        f.exec(f.owners[0], {
          ...f.proposal,
          selections: { scoring: "ppr", extra: "x" },
        }),
        "INVALID_SELECTION",
      );
      await rejects(
        f.exec(f.owners[0], {
          ...f.proposal,
          teamOrder: [...f.owners.slice(0, 11).map((x) => x.teamId), "outside"],
        }),
        "INVALID_DRAFT_ORDER",
      );
      await f.exec(f.owners[0], f.proposal, "proposal-key");
      expect(
        (await f.g.snapshot(f.owners[1], "meeting")).proposals,
      ).toHaveLength(0);
      expect((await f.g.snapshot(f.c, "meeting")).proposals).toHaveLength(0);
      expect(
        (await f.g.snapshot(f.owners[0], "meeting")).proposals,
      ).toHaveLength(1);
      expect(
        (await f.exec(f.owners[0], f.proposal, "proposal-key")).replayed,
      ).toBe(true);
      await rejects(
        f.exec(
          f.owners[0],
          { ...f.proposal, title: "Changed" },
          "proposal-key",
        ),
        "IDEMPOTENCY_CONFLICT",
      );
      await rejects(
        f.exec(f.c, { ...f.menu, title: "Replaced menu" }),
        "ALREADY_EXISTS",
      );
      await f.voting();
      expect(
        (await f.g.snapshot(f.owners[1], "meeting")).proposals,
      ).toHaveLength(1);
      expect(await f.g.listMeetings(f.c)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("requires actual owner votes and prevents simultaneous conflicting votes or early approval", async () => {
    const f = await fixture();
    try {
      await f.exec(f.owners[0], f.proposal);
      await f.voting();
      await rejects(
        f.exec(f.c, {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        }),
        "FORBIDDEN",
      );
      await rejects(
        f.exec(
          { ...f.owners[0], teamId: "team-1" },
          { type: "castVote", proposalId: "proposal", choice: "yes" },
        ),
        "FORBIDDEN",
      );
      const votes = await Promise.allSettled(
        ["yes", "no"].map((choice) =>
          f.exec(f.owners[0], {
            type: "castVote",
            proposalId: "proposal",
            choice,
          }),
        ),
      );
      expect(votes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      await rejects(
        f.exec(f.c, { type: "prepareRatification", proposalId: "proposal" }),
        "VOTING_OPEN",
      );
      for (const o of f.owners.slice(1, 7))
        await f.exec(o, {
          type: "castVote",
          proposalId: "proposal",
          choice: "yes",
        });
      await f.closed();
      await rejects(
        f.exec(f.c, { type: "prepareRatification", proposalId: "proposal" }),
        "QUORUM_NOT_MET",
      );
      expect((await f.g.snapshot(f.c, "meeting")).votes).toHaveLength(7);
    } finally {
      await f.close();
    }
  });
  it("separates exact owner approval from external application attestation; retains uncast human votes", async () => {
    const f = await fixture();
    try {
      const d = await f.eligible();
      const approvalCommand = {
        type: "approveMflConstitution",
        decisionId: d.decisionId,
        proposalId: "proposal",
        proposalHash: d.proposalHash,
        version: "v1",
      };
      await rejects(f.exec(f.owners[0], approvalCommand), "FORBIDDEN");
      await rejects(
        f.exec(f.c, { ...approvalCommand, proposalHash: "0".repeat(64) }),
        "PROPOSAL_MISMATCH",
      );
      const a = (await f.exec(f.c, approvalCommand, "approval")).result;
      expect(a.configured).toBe(false);
      expect((await f.exec(f.c, approvalCommand, "approval")).replayed).toBe(
        true,
      );
      const state = await f.g.snapshot(f.c, "meeting");
      expect(state).toMatchObject({
        configurationStatus: "approved-unapplied",
        application: null,
      });
      expect(state.votes).toHaveLength(8);
      expect(state.votes.some((x) => x.team_id === "team-11")).toBe(false);
      expect(
        (await f.db.query("SELECT constitution_version FROM leagues")).rows[0]
          .constitution_version,
      ).toBeNull();
      const application = {
        type: "recordMflApplication",
        approvalId: a.approvalId,
        proposalHash: a.proposalHash,
        hostVersion: 1,
        attestation: "matches-approved-constitution",
        evidence: ["scoring", "order"].map((sectionId) => ({
          sectionId,
          source: "mfl-native-ui",
          reference: "synthetic-readback",
          observedHash: "a".repeat(64),
          summary: "Synthetic test read-back, no external calls",
          observedAt: new Date().toISOString(),
        })),
      };
      await rejects(
        f.exec(f.c, {
          ...application,
          evidence: application.evidence.slice(0, 1),
        }),
        "APPLICATION_EVIDENCE_REQUIRED",
      );
      await rejects(
        f.exec(f.c, { ...application, hostVersion: 2 }),
        "HOST_VERSION_CONFLICT",
      );
      await rejects(
        f.exec(f.c, {
          ...application,
          evidence: application.evidence.map((x) => ({
            ...x,
            observedAt: "2020-01-01T00:00:00Z",
          })),
        }),
        "STALE_APPLICATION_EVIDENCE",
      );
      await rejects(f.exec(f.owners[0], application), "FORBIDDEN");
      const out = await f.exec(f.c, application, "apply");
      expect(out.result).toMatchObject({
        status: "application-attested",
        externalWritePerformed: false,
      });
      expect((await f.exec(f.c, application, "apply")).replayed).toBe(true);
      expect(await f.g.snapshot(f.c, "meeting")).toMatchObject({
        configurationStatus: "operator-attested",
      });
      await rejects(
        f.league.execute(f.c, {
          type: "ratifyConstitution",
          leagueId: f.leagueId,
          idempotencyKey: "custom-ratify",
          version: "v1",
          decisionReceipt: d.decisionId,
        }),
        "FOOTBALL_HOST_MISMATCH",
      );
    } finally {
      await f.close();
    }
  });
  it("detects changed voted content and invalidates old decisions after host revision", async () => {
    const f = await fixture();
    try {
      const d = await f.eligible();
      await f.db.query(
        "UPDATE mfl_governance_proposals SET content=jsonb_set(content,'{selections,scoring}','\"basic\"')",
      );
      await rejects(
        f.exec(f.c, {
          type: "approveMflConstitution",
          decisionId: d.decisionId,
          proposalId: "proposal",
          proposalHash: d.proposalHash,
          version: "v1",
        }),
        "PROPOSAL_CHANGED",
      );
      await bindHost(f.db, f.c, {
        leagueId: f.leagueId,
        expectedVersion: 1,
        idempotencyKey: "rebind",
        reason: "Synthetic host revision",
        host: "mfl",
        config: {
          season: 2026,
          leagueId: "54321",
          configRef: "changed-synthetic",
        },
      });
      await rejects(f.g.snapshot(f.c, "meeting"), "HOST_VERSION_CONFLICT");
      expect(await f.g.listMeetings(f.c)).toHaveLength(0);
      await rejects(
        f.exec(f.c, { type: "prepareRatification", proposalId: "proposal" }),
        "HOST_VERSION_CONFLICT",
      );
    } finally {
      await f.close();
    }
  });
});
it("reveals owner proposals for real discussion and permits only bounded owner-authored immutable replacement chains", async () => {
  const f = await fixture();
  try {
    const original = await f.exec(f.owners[0], f.proposal);
    const second = {
      ...f.proposal,
      proposalId: "revision-two",
      version: "v2",
      replacesProposalId: "proposal",
      rationale: "Synthetic revision after observing peer discussion",
    };
    await rejects(f.exec(f.owners[0], second), "DISCUSSION_NOT_OPEN");
    expect((await f.g.snapshot(f.owners[1], "meeting")).proposals).toHaveLength(
      0,
    );
    await f.db.query(
      "UPDATE mfl_governance_meetings SET discussion_opens_at=clock_timestamp()-interval '1 second'",
    );
    const revealed = await f.g.snapshot(f.owners[1], "meeting");
    expect(revealed.phase).toBe("discussion");
    expect(revealed.proposals).toHaveLength(1);
    await rejects(f.exec(f.owners[1], second), "REVISION_PREDECESSOR_REQUIRED");
    await rejects(
      f.exec(f.owners[0], { ...second, replacesProposalId: undefined }),
      "REVISION_PREDECESSOR_REQUIRED",
    );
    await rejects(
      f.exec(f.owners[0], { ...second, version: "v1" }),
      "VERSION_REUSED",
    );
    const competing = await Promise.allSettled([
      f.exec(f.owners[0], second, "revision2"),
      f.exec(
        f.owners[0],
        { ...second, proposalId: "branch", version: "branch" },
        "branch",
      ),
    ]);
    expect(competing.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const latest = (await f.g.snapshot(f.c, "meeting")).proposals.find(
      (x) => x.ballot_eligible,
    )!;
    const third = {
      ...f.proposal,
      proposalId: "revision-three",
      version: "v3",
      replacesProposalId: latest.id,
    };
    await f.exec(f.owners[0], third);
    await rejects(
      f.exec(f.owners[0], {
        ...third,
        proposalId: "revision-four",
        version: "v4",
        replacesProposalId: "revision-three",
      }),
      "PROPOSAL_LIMIT",
    );
    const state = await f.g.snapshot(f.owners[1], "meeting");
    expect(state.proposals).toHaveLength(3);
    expect(state.proposals.filter((x) => x.ballot_eligible)).toHaveLength(1);
    expect(state.proposals[0].content_hash).toBe(original.result.contentHash);
    await f.voting();
    await rejects(
      f.exec(f.owners[1], {
        type: "castVote",
        proposalId: "proposal",
        choice: "yes",
      }),
      "PROPOSAL_SUPERSEDED",
    );
    for (const o of f.owners.slice(0, 8))
      await f.exec(o, {
        type: "castVote",
        proposalId: "revision-three",
        choice: "yes",
      });
    await f.closed();
    await rejects(
      f.exec(f.c, { type: "prepareRatification", proposalId: "proposal" }),
      "PROPOSAL_SUPERSEDED",
    );
    const decision = await f.exec(f.c, {
      type: "prepareRatification",
      proposalId: "revision-three",
    });
    expect(decision.result).toMatchObject({
      proposalId: "revision-three",
      version: "v3",
      yesVotes: 8,
    });
  } finally {
    await f.close();
  }
});
