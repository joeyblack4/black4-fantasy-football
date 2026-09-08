import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import type { HostBinding } from "../league/host.js";
import type { GovernanceCommand } from "./schema.js";
import { MflMenuSchema, type MflMenu } from "./mfl-schema.js";
import { fingerprint, guard } from "./validation.js";
async function owner(tx: Tx, actor: Actor) {
  guard(
    actor.role === "owner" && actor.teamId,
    "FORBIDDEN",
    "Owner identity required",
  );
  guard(
    (
      await tx.query(
        "SELECT 1 FROM league_teams WHERE league_id=$1 AND id=$2 AND owner_id=$3",
        [actor.leagueId, actor.teamId, actor.id],
      )
    ).rowCount,
    "FORBIDDEN",
    "Identity does not own this franchise",
  );
  return actor.teamId;
}
function commissioner(actor: Actor) {
  guard(
    actor.role === "commissioner",
    "FORBIDDEN",
    "Scoped commissioner required",
  );
}
async function menu(
  tx: Tx,
  leagueId: string,
  id: string,
  version: number,
): Promise<{ content: MflMenu; content_hash: string }> {
  const m = (
    await tx.query(
      "SELECT * FROM mfl_governance_menus WHERE league_id=$1 AND id=$2",
      [leagueId, id],
    )
  ).rows[0];
  guard(m, "NOT_FOUND", "MFL capability menu does not exist");
  guard(
    m.host_version === version,
    "HOST_VERSION_CONFLICT",
    "Menu belongs to an earlier MFL binding",
  );
  const content = MflMenuSchema.parse(m.content);
  guard(
    fingerprint(content) === m.content_hash,
    "MENU_CHANGED",
    "Menu content changed",
  );
  return { ...m, content };
}
async function proposal(
  tx: Tx,
  leagueId: string,
  id: string,
  hostVersion: number,
) {
  const p = (
    await tx.query(
      "SELECT p.*,m.menu_id,m.host_version,m.proposal_deadline,m.vote_deadline FROM mfl_governance_proposals p JOIN mfl_governance_meetings m ON m.league_id=p.league_id AND m.id=p.meeting_id WHERE p.league_id=$1 AND p.id=$2",
      [leagueId, id],
    )
  ).rows[0];
  guard(p, "NOT_FOUND", "MFL proposal does not exist");
  guard(
    p.host_version === hostVersion,
    "HOST_VERSION_CONFLICT",
    "Proposal belongs to an earlier MFL binding",
  );
  guard(
    !(
      await tx.query(
        "SELECT 1 FROM mfl_governance_proposals WHERE league_id=$1 AND replaces_proposal_id=$2",
        [leagueId, id],
      )
    ).rowCount,
    "PROPOSAL_SUPERSEDED",
    "This proposal has a newer owner-authored revision; use the current ballot candidate",
  );
  const m = await menu(tx, leagueId, p.menu_id, hostVersion);
  guard(
    fingerprint(p.content) === p.content_hash &&
      p.content.menuHash === m.content_hash &&
      p.content.version === p.version &&
      p.content.title === p.title,
    "PROPOSAL_CHANGED",
    "Owner-approved content changed",
  );
  return { p, m };
}
async function quorum(
  tx: Tx,
  leagueId: string,
  id: string,
  version: number,
  now: Date,
) {
  const { p, m } = await proposal(tx, leagueId, id, version);
  guard(
    now >= p.vote_deadline,
    "VOTING_OPEN",
    "Voting window must close before final approval",
  );
  const yes = Number(
    (
      await tx.query(
        "SELECT count(*) AS n FROM mfl_governance_votes v JOIN league_teams t ON t.league_id=v.league_id AND t.id=v.team_id AND t.owner_id=v.owner_id WHERE v.league_id=$1 AND v.proposal_id=$2 AND v.choice='yes'",
        [leagueId, id],
      )
    ).rows[0].n,
  );
  guard(
    yes >= 8,
    "QUORUM_NOT_MET",
    "Eight distinct current owners must approve the same proposal",
  );
  return { p, m, yes };
}
/** Called only inside GovernanceService's league-locked transaction; never sends to MFL. */
export async function executeMflGovernance(
  tx: Tx,
  actor: Actor,
  command: GovernanceCommand,
  host: HostBinding,
) {
  guard(host.host === "mfl", "FOOTBALL_HOST_MISMATCH", "MFL host required");
  const hash = fingerprint({ actor, command, hostVersion: host.version });
  const old = (
    await tx.query(
      "SELECT * FROM governance_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
      [actor.leagueId, actor.id, command.idempotencyKey],
    )
  ).rows[0];
  if (old) {
    guard(
      old.payload_hash === hash,
      "IDEMPOTENCY_CONFLICT",
      "Key identifies different governance content or host version",
    );
    return { ...old.response, replayed: true };
  }
  const now: Date = (await tx.query("SELECT clock_timestamp() AS now")).rows[0]
    .now;
  const approved = (
    await tx.query(
      "SELECT * FROM mfl_governance_approvals WHERE league_id=$1 AND host_version=$2",
      [actor.leagueId, host.version],
    )
  ).rows[0];
  guard(
    !approved || command.type === "recordMflApplication",
    "RULES_FROZEN",
    "This MFL host version already has an approved constitution",
  );
  let result: Record<string, unknown>;
  switch (command.type) {
    case "registerMflMenu": {
      commissioner(actor);
      const { leagueId: _, idempotencyKey: __, type: ___, ...raw } = command;
      const content = MflMenuSchema.parse(raw);
      guard(
        !(
          await tx.query(
            "SELECT 1 FROM mfl_governance_menus WHERE league_id=$1 AND id=$2",
            [actor.leagueId, command.menuId],
          )
        ).rowCount,
        "ALREADY_EXISTS",
        "Menu is immutable; register a new ID for a new version",
      );
      const contentHash = fingerprint(content);
      await tx.query(
        "INSERT INTO mfl_governance_menus(league_id,id,host_version,content,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          actor.leagueId,
          command.menuId,
          host.version,
          JSON.stringify(content),
          contentHash,
          actor.id,
        ],
      );
      result = {
        menuId: command.menuId,
        contentHash,
        hostVersion: host.version,
        configured: false,
      };
      break;
    }
    case "openMeeting": {
      commissioner(actor);
      guard(
        command.menuId,
        "MENU_REQUIRED",
        "An explicit reviewed MFL menu is required",
      );
      await menu(tx, actor.leagueId, command.menuId, host.version);
      const p = new Date(command.proposalDeadline),
        v = new Date(command.voteDeadline);
      guard(
        p > now && v > p && v.getTime() - now.getTime() <= 86400000,
        "INVALID_WINDOW",
        "Future ordered deadlines within twenty-four hours required",
      );
      guard(
        Number(
          (
            await tx.query(
              "SELECT count(*) n FROM league_teams WHERE league_id=$1",
              [actor.leagueId],
            )
          ).rows[0].n,
        ) === 12,
        "INVALID_ELECTORATE",
        "Exactly twelve franchises required",
      );
      guard(
        !(
          await tx.query(
            "SELECT 1 FROM mfl_governance_meetings WHERE league_id=$1 AND (vote_deadline>$2 OR id=$3)",
            [actor.leagueId, now, command.meetingId],
          )
        ).rowCount,
        "MEETING_OPEN",
        "Meeting already exists or another meeting is open",
      );
      const discussion = command.discussionOpensAt
        ? new Date(command.discussionOpensAt)
        : p;
      guard(
        discussion > now && discussion <= p,
        "INVALID_WINDOW",
        "Discussion must open after now and no later than the proposal cutoff",
      );
      await tx.query(
        "INSERT INTO mfl_governance_meetings(league_id,id,menu_id,host_version,proposal_deadline,vote_deadline,discussion_opens_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          actor.leagueId,
          command.meetingId,
          command.menuId,
          host.version,
          p,
          v,
          discussion,
        ],
      );
      result = {
        meetingId: command.meetingId,
        menuId: command.menuId,
        hostVersion: host.version,
        proposalDeadline: p,
        discussionOpensAt: discussion,
        voteDeadline: v,
      };
      break;
    }
    case "submitMflProposal": {
      const team = await owner(tx, actor);
      const meeting = (
        await tx.query(
          "SELECT * FROM mfl_governance_meetings WHERE league_id=$1 AND id=$2",
          [actor.leagueId, command.meetingId],
        )
      ).rows[0];
      guard(meeting, "NOT_FOUND", "Meeting does not exist");
      guard(
        meeting.host_version === host.version,
        "HOST_VERSION_CONFLICT",
        "Meeting belongs to an earlier host binding",
      );
      guard(
        now < meeting.proposal_deadline,
        "PROPOSALS_CLOSED",
        "Independent proposal window closed",
      );
      guard(
        command.menuId === meeting.menu_id,
        "MENU_MISMATCH",
        "Use the exact meeting menu",
      );
      const m = await menu(tx, actor.leagueId, command.menuId, host.version);
      guard(
        Object.keys(command.selections).length === m.content.questions.length &&
          m.content.questions.every((q) =>
            q.options.some((o) => o.id === command.selections[q.id]),
          ),
        "INVALID_SELECTION",
        "Select exactly one supported option for every question",
      );
      const teams = (
        await tx.query("SELECT id FROM league_teams WHERE league_id=$1", [
          actor.leagueId,
        ])
      ).rows.map((x) => x.id);
      guard(
        teams.length === 12 &&
          command.teamOrder.every((x) => teams.includes(x)),
        "INVALID_DRAFT_ORDER",
        "Draft order must permute all twelve local franchises",
      );
      const history = (
        await tx.query(
          "SELECT * FROM mfl_governance_proposals WHERE league_id=$1 AND meeting_id=$2 AND author_team_id=$3 ORDER BY revision_no",
          [actor.leagueId, command.meetingId, team],
        )
      ).rows;
      guard(
        history.length < 3,
        "PROPOSAL_LIMIT",
        "Each owner may submit at most three immutable versions per meeting",
      );
      const prior = history.at(-1);
      guard(
        !prior || now >= meeting.discussion_opens_at,
        "DISCUSSION_NOT_OPEN",
        "Independent first proposals stay sealed until discussion opens",
      );
      guard(
        prior
          ? command.replacesProposalId === prior.id
          : !command.replacesProposalId,
        "REVISION_PREDECESSOR_REQUIRED",
        "A revision must replace this owner's latest proposal in this meeting",
      );
      guard(
        !history.some((x) => x.version === command.version),
        "VERSION_REUSED",
        "Use a new version label for every immutable revision",
      );
      guard(
        !(
          await tx.query(
            "SELECT 1 FROM mfl_governance_proposals WHERE league_id=$1 AND id=$2",
            [actor.leagueId, command.proposalId],
          )
        ).rowCount,
        "ALREADY_EXISTS",
        "Proposal ID is immutable; use a new ID",
      );
      const revisionNo = history.length + 1;
      const content = {
        version: command.version,
        title: command.title,
        rationale: command.rationale,
        menuId: command.menuId,
        menuHash: m.content_hash,
        selections: command.selections,
        teamOrder: command.teamOrder,
        leaguePolicies: command.leaguePolicies ?? "",
        hostVersion: host.version,
        revisionNo,
        replacesProposalId: command.replacesProposalId ?? null,
        replacesProposalHash: prior?.content_hash ?? null,
      };
      const contentHash = fingerprint(content);
      await tx.query(
        "INSERT INTO mfl_governance_proposals(league_id,id,meeting_id,author_team_id,author_id,version,title,content,content_hash,revision_no,replaces_proposal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          actor.leagueId,
          command.proposalId,
          command.meetingId,
          team,
          actor.id,
          command.version,
          command.title,
          JSON.stringify(content),
          contentHash,
          revisionNo,
          command.replacesProposalId ?? null,
        ],
      );
      result = {
        proposalId: command.proposalId,
        version: command.version,
        contentHash,
        authorTeamId: team,
        revisionNo,
        replacesProposalId: command.replacesProposalId ?? null,
        visibility:
          now < meeting.discussion_opens_at
            ? "sealed-until-discussion"
            : "visible-for-discussion",
      };
      break;
    }
    case "castVote": {
      const team = await owner(tx, actor);
      const { p } = await proposal(
        tx,
        actor.leagueId,
        command.proposalId,
        host.version,
      );
      guard(
        now >= p.proposal_deadline && now < p.vote_deadline,
        "VOTING_CLOSED",
        "Votes require the published voting window",
      );
      guard(
        !(
          await tx.query(
            "SELECT 1 FROM mfl_governance_votes WHERE league_id=$1 AND proposal_id=$2 AND team_id=$3",
            [actor.leagueId, p.id, team],
          )
        ).rowCount,
        "VOTE_IMMUTABLE",
        "Each franchise has one immutable vote per proposal",
      );
      await tx.query(
        "INSERT INTO mfl_governance_votes(league_id,proposal_id,team_id,owner_id,choice) VALUES($1,$2,$3,$4,$5)",
        [actor.leagueId, p.id, team, actor.id, command.choice],
      );
      result = { proposalId: p.id, teamId: team, choice: command.choice };
      break;
    }
    case "prepareRatification": {
      commissioner(actor);
      const { p, yes } = await quorum(
        tx,
        actor.leagueId,
        command.proposalId,
        host.version,
        now,
      );
      const prior = (
        await tx.query(
          "SELECT * FROM mfl_governance_decisions WHERE league_id=$1 AND proposal_id=$2",
          [actor.leagueId, p.id],
        )
      ).rows[0];
      const decisionId = prior?.id ?? randomUUID();
      if (!prior)
        await tx.query(
          "INSERT INTO mfl_governance_decisions(league_id,id,proposal_id,proposal_hash,host_version,yes_votes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            actor.leagueId,
            decisionId,
            p.id,
            p.content_hash,
            host.version,
            yes,
            actor.id,
          ],
        );
      result = {
        decisionId,
        proposalId: p.id,
        proposalHash: p.content_hash,
        version: p.version,
        yesVotes: yes,
        threshold: 8,
        hostVersion: host.version,
        status: "eligible-for-commissioner-approval",
        configured: false,
      };
      break;
    }
    case "approveMflConstitution": {
      commissioner(actor);
      const { p, yes } = await quorum(
        tx,
        actor.leagueId,
        command.proposalId,
        host.version,
        now,
      );
      const decision = (
        await tx.query(
          "SELECT * FROM mfl_governance_decisions WHERE league_id=$1 AND id=$2",
          [actor.leagueId, command.decisionId],
        )
      ).rows[0];
      guard(
        decision &&
          decision.proposal_id === p.id &&
          decision.proposal_hash === p.content_hash &&
          decision.host_version === host.version,
        "GOVERNANCE_DECISION_REQUIRED",
        "Exact prepared decision is required",
      );
      guard(
        command.proposalHash === p.content_hash &&
          command.version === p.version,
        "PROPOSAL_MISMATCH",
        "Approval must name exact proposal hash and version",
      );
      const approvalId = randomUUID();
      await tx.query(
        "INSERT INTO mfl_governance_approvals(league_id,id,decision_id,proposal_id,proposal_hash,version,host_version,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          actor.leagueId,
          approvalId,
          decision.id,
          p.id,
          p.content_hash,
          p.version,
          host.version,
          actor.id,
        ],
      );
      result = {
        approvalId,
        proposalId: p.id,
        proposalHash: p.content_hash,
        version: p.version,
        yesVotes: yes,
        hostVersion: host.version,
        status: "owner-approved-awaiting-mfl-application",
        configured: false,
      };
      break;
    }
    case "recordMflApplication": {
      commissioner(actor);
      guard(
        approved &&
          approved.id === command.approvalId &&
          approved.proposal_hash === command.proposalHash,
        "APPROVAL_MISMATCH",
        "Exact approved constitution is required",
      );
      guard(
        command.hostVersion === host.version,
        "HOST_VERSION_CONFLICT",
        "External read-back belongs to another host binding",
      );
      const { m } = await quorum(
        tx,
        actor.leagueId,
        approved.proposal_id,
        host.version,
        now,
      );
      const sections = m.content.applicationSections.map((x) => x.id);
      guard(
        command.evidence.length === sections.length &&
          new Set(command.evidence.map((x) => x.sectionId)).size ===
            sections.length &&
          command.evidence.every((x) => sections.includes(x.sectionId)),
        "APPLICATION_EVIDENCE_REQUIRED",
        "Provide exactly one read-back receipt for every required configuration section",
      );
      guard(
        command.evidence.every(
          (x) =>
            new Date(x.observedAt) >= approved.approved_at &&
            new Date(x.observedAt) <= now,
        ),
        "STALE_APPLICATION_EVIDENCE",
        "Read-back must occur after approval and before this receipt",
      );
      guard(
        !(
          await tx.query(
            "SELECT 1 FROM mfl_governance_applications WHERE league_id=$1 AND approval_id=$2",
            [actor.leagueId, approved.id],
          )
        ).rowCount,
        "APPLICATION_IMMUTABLE",
        "Application receipt already exists",
      );
      const applicationId = randomUUID();
      await tx.query(
        "INSERT INTO mfl_governance_applications(league_id,id,approval_id,proposal_hash,host_version,evidence,attested_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          actor.leagueId,
          applicationId,
          approved.id,
          approved.proposal_hash,
          host.version,
          JSON.stringify(command.evidence),
          actor.id,
        ],
      );
      result = {
        applicationId,
        approvalId: approved.id,
        proposalHash: approved.proposal_hash,
        hostVersion: host.version,
        status: "application-attested",
        verification: "commissioner-attested-native-or-api-readback",
        externalWritePerformed: false,
      };
      break;
    }
    default:
      guard(
        false,
        "FOOTBALL_HOST_MISMATCH",
        "Custom-engine proposals cannot configure an MFL league",
      );
  }
  const receipt = { receiptId: randomUUID(), result, replayed: false };
  await tx.query(
    "INSERT INTO governance_receipts(league_id,actor_id,idempotency_key,id,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)",
    [
      actor.leagueId,
      actor.id,
      command.idempotencyKey,
      receipt.receiptId,
      hash,
      JSON.stringify(receipt),
    ],
  );
  return receipt;
}
export async function snapshotMflGovernance(
  tx: Tx,
  actor: Actor,
  meetingId: string,
  host: HostBinding,
) {
  guard(
    ["owner", "commissioner", "system"].includes(actor.role),
    "FORBIDDEN",
    "Verified identity required",
  );
  if (actor.role === "owner") await owner(tx, actor);
  const m = (
    await tx.query(
      "SELECT * FROM mfl_governance_meetings WHERE league_id=$1 AND id=$2",
      [actor.leagueId, meetingId],
    )
  ).rows[0];
  guard(m, "NOT_FOUND", "Meeting does not exist");
  guard(
    m.host_version === host.version,
    "HOST_VERSION_CONFLICT",
    "Meeting belongs to an earlier host binding",
  );
  const menuRecord = await menu(tx, actor.leagueId, m.menu_id, host.version);
  const now: Date = (await tx.query("SELECT clock_timestamp() AS now")).rows[0]
    .now;
  const proposals = (
    await tx.query(
      "SELECT p.*,NOT EXISTS(SELECT 1 FROM mfl_governance_proposals newer WHERE newer.league_id=p.league_id AND newer.replaces_proposal_id=p.id) AS ballot_eligible FROM mfl_governance_proposals p WHERE league_id=$1 AND meeting_id=$2 AND ($3::boolean OR author_team_id=$4) ORDER BY created_at",
      [
        actor.leagueId,
        meetingId,
        now >= m.discussion_opens_at || now >= m.proposal_deadline,
        actor.role === "owner" ? actor.teamId : null,
      ],
    )
  ).rows;
  const votes = (
    await tx.query(
      "SELECT proposal_id,team_id,choice,created_at FROM mfl_governance_votes WHERE league_id=$1 AND proposal_id=ANY($2::text[]) ORDER BY created_at",
      [actor.leagueId, proposals.map((x) => x.id)],
    )
  ).rows;
  const approval =
    (
      await tx.query(
        "SELECT * FROM mfl_governance_approvals WHERE league_id=$1 AND host_version=$2 AND proposal_id=ANY($3::text[])",
        [actor.leagueId, host.version, proposals.map((x) => x.id)],
      )
    ).rows[0] ?? null;
  const application = approval
    ? ((
        await tx.query(
          "SELECT id,approval_id,proposal_hash,host_version,attested_by,attested_at FROM mfl_governance_applications WHERE league_id=$1 AND approval_id=$2",
          [actor.leagueId, approval.id],
        )
      ).rows[0] ?? null)
    : null;
  return {
    meeting: m,
    members: (
      await tx.query(
        `SELECT t.id AS "teamId",t.name,t.kind,b.agent_id AS "agentId"
       FROM league_teams t LEFT JOIN runtime_bindings b ON b.league_id=t.league_id AND b.team_id=t.id
       WHERE t.league_id=$1 ORDER BY t.id`,
        [actor.leagueId],
      )
    ).rows,
    phase:
      now < m.proposal_deadline
        ? now < m.discussion_opens_at
          ? "independent-proposals"
          : "discussion"
        : now < m.vote_deadline
          ? "voting"
          : "closed",
    proposals,
    votes,
    threshold: 8,
    electorate: 12,
    host: "mfl",
    hostVersion: host.version,
    menu: menuRecord.content,
    menuHash: menuRecord.content_hash,
    approval,
    application,
    configurationStatus: application
      ? "operator-attested"
      : approval
        ? "approved-unapplied"
        : "unapproved",
  };
}
