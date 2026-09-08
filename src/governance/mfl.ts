import { randomUUID } from "node:crypto";
import {
  activeConventionPause,
  assertConventionNotPaused,
} from "../runtime/convention-control.js";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import {
  hostBinding,
  HostBindingSchema,
  type HostBinding,
} from "../league/host.js";
import type { GovernanceCommand } from "./schema.js";
import {
  MflMenuSchema,
  PrepareMflReturnAnchorSchema,
  RevalidateMflReturnSchema,
  MflProductionMappingSchema,
  type MflMenu,
} from "./mfl-schema.js";
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
  await assertConventionNotPaused(tx, actor.leagueId);
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
      const restored = command.revalidationReceiptId
        ? await validateReturnReceipt(
            tx,
            actor.leagueId,
            command.revalidationReceiptId,
            host,
            now,
          )
        : null;
      if (restored)
        guard(
          restored.anchor.decisionId === command.decisionId &&
            restored.anchor.proposalId === command.proposalId,
          "REVALIDATION_DECISION_MISMATCH",
          "Revalidation belongs to another exact candidate",
        );
      const { p, yes } = await quorum(
        tx,
        actor.leagueId,
        command.proposalId,
        restored?.anchor.originalHost.version ?? host.version,
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
          decision.host_version ===
            (restored?.anchor.originalHost.version ?? host.version),
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
        revalidationReceiptId: command.revalidationReceiptId ?? null,
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
      const approvalReceipt = (
        await tx.query(
          "SELECT response FROM governance_receipts WHERE league_id=$1 AND response#>>'{result,approvalId}'=$2",
          [actor.leagueId, approved.id],
        )
      ).rows;
      guard(
        approvalReceipt.length === 1,
        "APPROVAL_RECEIPT_REQUIRED",
        "Exact recorded approval required",
      );
      const returnReceiptId =
        approvalReceipt[0].response.result.revalidationReceiptId;
      const restored = returnReceiptId
        ? await validateReturnReceipt(
            tx,
            actor.leagueId,
            returnReceiptId,
            host,
            now,
          )
        : null;
      if (restored)
        guard(
          restored.anchor.decisionId === approved.decision_id &&
            restored.anchor.proposalId === approved.proposal_id,
          "REVALIDATION_DECISION_MISMATCH",
          "Approval must retain its exact restored-host decision",
        );
      const { m } = await quorum(
        tx,
        actor.leagueId,
        approved.proposal_id,
        restored?.anchor.originalHost.version ?? host.version,
        now,
      );
      if (restored)
        guard(
          command.evidence.every(
            (x) =>
              x.nativeScope &&
              x.nativeScope.host === restored.anchor.candidate.mapping.host &&
              x.nativeScope.season ===
                restored.anchor.candidate.mapping.season &&
              x.nativeScope.leagueId ===
                restored.anchor.candidate.mapping.mflLeagueId,
          ),
          "REVALIDATION_PRODUCTION_READBACK_REQUIRED",
          "Every restored-host application section must explicitly identify the original production native league; trial evidence is ineligible",
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
  const pause = await activeConventionPause(tx, actor.leagueId, meetingId);
  const now: Date =
    pause?.paused_at ??
    (await tx.query("SELECT clock_timestamp() AS now")).rows[0].now;
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
    pause,
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

// These services are deliberately absent from the owner command union/tool schema.
// All evidence lives in existing append-only governance receipts; old decisions retain their version.
const persisted = (value: unknown) => JSON.parse(JSON.stringify(value));
const evidenceHash = (value: unknown) => fingerprint(persisted(value));
async function returnLock(tx: Tx, leagueId: string) {
  await tx.query(
    "SELECT a.id FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 ORDER BY a.id FOR NO KEY UPDATE OF a",
    [leagueId],
  );
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7044))", [
    leagueId,
  ]);
}
async function returnQuiescence(tx: Tx, leagueId: string) {
  guard(
    !(
      await tx.query(
        `SELECT 1 FROM runtime_jobs j JOIN runtime_bindings b ON b.agent_id=j.agent_id WHERE b.league_id=$1 AND j.status='running'
    UNION ALL SELECT 1 FROM runtime_agents a JOIN runtime_bindings b ON b.agent_id=a.id WHERE b.league_id=$1 AND a.kind='ai' AND a.enabled
    UNION ALL SELECT 1 FROM runtime_football_outbox WHERE league_id=$1 AND status IN ('pending','running')
    UNION ALL SELECT 1 FROM runtime_franchise_outbox WHERE league_id=$1 AND status IN ('pending','running')
    UNION ALL SELECT 1 FROM runtime_conventions WHERE league_id=$1 AND status='active'
    UNION ALL SELECT 1 FROM runtime_rehearsals WHERE league_id=$1 AND status<>'restored'
    UNION ALL SELECT 1 FROM runtime_mfl_draft_observers WHERE league_id=$1 AND status='active'`,
        [leagueId],
      )
    ).rowCount,
    "REVALIDATION_REQUIRES_QUIESCENCE",
    "Pause owners, clocks and external writes before preparing or revalidating a candidate",
  );
}
function productionMapping(host: HostBinding, input: unknown) {
  const mapping = MflProductionMappingSchema.parse(input);
  guard(
    host.host === "mfl" &&
      host.config.leagueId === "62282" &&
      host.config.season === 2026 &&
      host.config.configRef === mapping.configRef,
    "REVALIDATION_PRODUCTION_SCOPE",
    "Exact original production identity and configuration reference required",
  );
  return {
    ...mapping,
    franchises: [...mapping.franchises].sort((a, b) =>
      a.teamId.localeCompare(b.teamId),
    ),
  };
}
async function candidateEvidence(
  tx: Tx,
  leagueId: string,
  decisionId: string,
  originalHost: HostBinding,
  mapping: ReturnType<typeof productionMapping>,
  now: Date,
) {
  const decision = (
    await tx.query(
      "SELECT * FROM mfl_governance_decisions WHERE league_id=$1 AND id=$2",
      [leagueId, decisionId],
    )
  ).rows[0];
  guard(
    decision && decision.host_version === originalHost.version,
    "REVALIDATION_DECISION_REQUIRED",
    "Original host-bound decision required",
  );
  const { p, m, yes } = await quorum(
    tx,
    leagueId,
    decision.proposal_id,
    originalHost.version,
    now,
  );
  guard(
    decision.proposal_hash === p.content_hash && decision.yes_votes === yes,
    "REVALIDATION_DECISION_CHANGED",
    "Original decision and current actual quorum must agree",
  );
  const rawMembers = (
    await tx.query(
      `SELECT t.id AS "teamId",t.owner_id AS "ownerId",t.kind,b.agent_id AS "agentId",a.model,m.id AS "manifestId",m.document
    FROM league_teams t LEFT JOIN runtime_bindings b ON b.league_id=t.league_id AND b.team_id=t.id LEFT JOIN runtime_agents a ON a.id=b.agent_id
    LEFT JOIN provider_manifests m ON m.league_id=t.league_id AND m.agent_id=a.id AND m.status='active' WHERE t.league_id=$1 ORDER BY t.id`,
      [leagueId],
    )
  ).rows;
  guard(
    rawMembers.length === 12 &&
      rawMembers.filter((r) => r.kind === "ai").length === 10 &&
      rawMembers.filter((r) => r.kind === "human").length === 2 &&
      new Set(rawMembers.map((r) => r.teamId)).size === 12,
    "REVALIDATION_TWELVE_MEMBERS_REQUIRED",
    "Exact twelve-team mapping required",
  );
  const members = rawMembers.map(({ document, ...member }) => ({
    ...member,
    manifestHash: document ? evidenceHash(document) : null,
  }));
  guard(
    members.every((member) =>
      mapping.franchises.some(
        (f) => f.teamId === member.teamId && f.ownerId === member.ownerId,
      ),
    ) &&
      members
        .filter((m) => m.kind === "ai")
        .every((m) => m.agentId && m.model && m.manifestId),
    "REVALIDATION_MAPPING_MISMATCH",
    "Verified production franchise map must match all current owners and pinned model manifests",
  );
  const votes = (
    await tx.query(
      "SELECT * FROM mfl_governance_votes WHERE league_id=$1 AND proposal_id=$2 ORDER BY team_id",
      [leagueId, p.id],
    )
  ).rows;
  const voteEvidence = [];
  for (const vote of votes) {
    guard(
      members.some(
        (m) => m.teamId === vote.team_id && m.ownerId === vote.owner_id,
      ),
      "REVALIDATION_VOTE_OWNER_CHANGED",
      "A recorded voter no longer owns its exact franchise",
    );
    const receipts = (
      await tx.query(
        "SELECT * FROM governance_receipts WHERE league_id=$1 AND actor_id=$2 AND response#>>'{result,proposalId}'=$3 AND response#>>'{result,teamId}'=$4 AND response#>>'{result,choice}'=$5",
        [leagueId, vote.owner_id, p.id, vote.team_id, vote.choice],
      )
    ).rows;
    const valid = receipts.filter(
      (r) =>
        r.payload_hash ===
        fingerprint({
          actor: {
            id: vote.owner_id,
            role: "owner",
            leagueId,
            teamId: vote.team_id,
          },
          command: {
            leagueId,
            idempotencyKey: r.idempotency_key,
            type: "castVote",
            proposalId: p.id,
            choice: vote.choice,
          },
          hostVersion: originalHost.version,
        }),
    );
    guard(
      valid.length === 1,
      "REVALIDATION_VOTE_RECEIPT_REQUIRED",
      "Every actual vote needs one authentic original owner command receipt",
    );
    voteEvidence.push({
      ...persisted(vote),
      receiptId: valid[0].id,
      receiptHash: valid[0].payload_hash,
    });
  }
  return persisted({
    decision,
    proposal: p,
    menu: m,
    members,
    votes: voteEvidence,
    mapping,
    yesVotes: yes,
  });
}
async function returnReceipt(
  tx: Tx,
  leagueId: string,
  id: string,
  type: string,
) {
  const row = (
    await tx.query(
      "SELECT * FROM governance_receipts WHERE league_id=$1 AND id=$2",
      [leagueId, id],
    )
  ).rows[0];
  const result = row?.response?.result;
  guard(
    result?.type === type &&
      row.response.receiptId === row.id &&
      result.evidenceHash === evidenceHash(result.evidence),
    "REVALIDATION_RECEIPT_INVALID",
    "Exact untampered scoped return receipt required",
  );
  return { row, result };
}
async function validateReturnLineage(
  tx: Tx,
  leagueId: string,
  anchor: any,
  epoch: string,
  current: HostBinding,
) {
  const rehearsal = (
    await tx.query(
      "SELECT * FROM runtime_rehearsals WHERE league_id=$1 AND epoch=$2",
      [leagueId, epoch],
    )
  ).rows[0];
  guard(
    rehearsal?.status === "restored" && rehearsal.synthetic === false,
    "REVALIDATION_RESTORED_REHEARSAL_REQUIRED",
    "Exact completed real-model trial epoch required",
  );
  const original = HostBindingSchema.parse(anchor.originalHost),
    trial = HostBindingSchema.parse(rehearsal.trial_host);
  guard(
    evidenceHash(rehearsal.original_host) === evidenceHash(original) &&
      original.host === "mfl" &&
      original.config.leagueId === "62282" &&
      original.config.season === 2026 &&
      trial.host === "mfl" &&
      trial.config.leagueId === "46625" &&
      trial.config.season === 2026 &&
      trial.config.configRef !== original.config.configRef &&
      trial.version === original.version + 1 &&
      current.host === "mfl" &&
      current.version === original.version + 2 &&
      evidenceHash(current.config) === evidenceHash(original.config),
    "REVALIDATION_HOST_LINEAGE_INVALID",
    "Only original62282 to disposable46625 to identical62282 is supported",
  );
  const rows = (
    await tx.query(
      "SELECT * FROM league_host_receipts WHERE league_id=$1 AND (binding->>'version')::integer>$2 AND (binding->>'version')::integer<=$3 ORDER BY (binding->>'version')::integer",
      [leagueId, original.version, current.version],
    )
  ).rows;
  guard(
    rows.length === 2 &&
      rows[0].idempotency_key === `rehearsal:${epoch}:arm` &&
      rows[1].idempotency_key === `rehearsal:${epoch}:restore` &&
      evidenceHash(rows[0].previous_binding) === evidenceHash(original) &&
      evidenceHash(rows[0].binding) === evidenceHash(trial) &&
      evidenceHash(rows[1].previous_binding) === evidenceHash(trial) &&
      evidenceHash(rows[1].binding) === evidenceHash(current),
    "REVALIDATION_HOST_RECEIPTS_REQUIRED",
    "Contiguous canonical arm and restore receipts required",
  );
  guard(
    rows.every(
      (r) =>
        r.payload_hash ===
        fingerprint({
          actor: { id: r.actor_id, role: "commissioner", leagueId },
          request: {
            leagueId,
            expectedVersion: r.previous_binding.version,
            host: r.binding.host,
            config: r.binding.config,
            idempotencyKey: r.idempotency_key,
            reason: r.reason,
          },
        }),
    ),
    "REVALIDATION_HOST_RECEIPT_HASH_CHANGED",
    "Host transition receipts must retain their canonical request hashes",
  );
  const receipts = (
    await tx.query(
      "SELECT seq,type,details,created_at FROM runtime_receipts WHERE details->>'leagueId'=$1 AND details->>'epoch'=$2 AND type IN ('rehearsal.armed','rehearsal.stopped','rehearsal.restored') ORDER BY seq",
      [leagueId, epoch],
    )
  ).rows;
  const armed = receipts.filter((r) => r.type === "rehearsal.armed"),
    stopped = receipts.filter((r) => r.type === "rehearsal.stopped"),
    restored = receipts.filter((r) => r.type === "rehearsal.restored");
  guard(
    armed.length === 1 &&
      stopped.length === 1 &&
      restored.length === 1 &&
      Number(armed[0].seq) < Number(stopped[0].seq) &&
      Number(stopped[0].seq) < Number(restored[0].seq) &&
      armed[0].details.hostReceiptId === rows[0].id &&
      restored[0].details.hostReceiptId === rows[1].id &&
      evidenceHash(armed[0].details.host) === evidenceHash(trial) &&
      evidenceHash(restored[0].details.host) === evidenceHash(current) &&
      new Date(anchor.preparedAt) <= new Date(rehearsal.configured_at),
    "REVALIDATION_EPOCH_RECEIPTS_REQUIRED",
    "Pre-trial anchor and complete ordered epoch receipts required",
  );
  const owners = (
    await tx.query(
      "SELECT agent_id,team_id,owner_id,model,manifest_id FROM runtime_rehearsal_owners WHERE league_id=$1 AND epoch=$2 ORDER BY agent_id",
      [leagueId, epoch],
    )
  ).rows;
  guard(
    owners.length === 10 &&
      owners.every((o) =>
        anchor.candidate.members.some(
          (m: any) =>
            m.kind === "ai" &&
            m.agentId === o.agent_id &&
            m.teamId === o.team_id &&
            m.ownerId === o.owner_id &&
            m.model === o.model &&
            m.manifestId === o.manifest_id,
        ),
      ),
    "REVALIDATION_EPOCH_OWNERS_CHANGED",
    "Trial participants must match the original ten pinned owners",
  );
  return persisted({
    epoch,
    originalHost: original,
    trialHost: trial,
    restoredHost: current,
    hostReceipts: rows.map((r) => ({
      id: r.id,
      payloadHash: r.payload_hash,
      previous: r.previous_binding,
      binding: r.binding,
    })),
    epochReceipts: receipts.map((r) => ({
      sequence: r.seq,
      type: r.type,
      details: r.details,
    })),
    owners,
  });
}
async function validateReturnReceipt(
  tx: Tx,
  leagueId: string,
  id: string,
  current: HostBinding,
  now: Date,
) {
  await returnQuiescence(tx, leagueId);
  const { result } = await returnReceipt(
    tx,
    leagueId,
    id,
    "mfl-decision-revalidated",
  );
  const { result: prepared } = await returnReceipt(
    tx,
    leagueId,
    result.evidence.anchorReceiptId,
    "mfl-return-anchor",
  );
  const anchor = prepared.evidence;
  guard(
    result.evidence.currentHostVersion === current.version,
    "HOST_VERSION_CONFLICT",
    "Revalidation belongs to an earlier restored host",
  );
  const lineage = await validateReturnLineage(
    tx,
    leagueId,
    anchor,
    result.evidence.rehearsalEpoch,
    current,
  );
  const mapping = productionMapping(current, result.evidence.mapping);
  const candidate = await candidateEvidence(
    tx,
    leagueId,
    anchor.decisionId,
    anchor.originalHost,
    mapping,
    now,
  );
  guard(
    evidenceHash(lineage) === result.evidence.lineageHash &&
      evidenceHash(candidate) === anchor.candidateHash &&
      evidenceHash(mapping) === evidenceHash(anchor.candidate.mapping),
    "REVALIDATION_EVIDENCE_CHANGED",
    "Original candidate, votes, mappings or host lineage changed",
  );
  return { anchor, result };
}
async function operatorReturnTransaction(
  db: Db,
  actor: Actor,
  request: { leagueId: string; idempotencyKey: string },
  work: (
    tx: Tx,
    host: HostBinding,
    now: Date,
  ) => Promise<{ type: string; evidence: any }>,
) {
  commissioner(actor);
  guard(
    actor.leagueId === request.leagueId,
    "FORBIDDEN",
    "Credential belongs to another league",
  );
  return transaction(db, async (tx) => {
    await returnLock(tx, actor.leagueId);
    const host = await hostBinding(tx, actor.leagueId),
      now = (await tx.query("SELECT clock_timestamp() now")).rows[0].now;
    const payloadHash = fingerprint({
      actor,
      request,
      hostVersion: host.version,
    });
    const old = (
      await tx.query(
        "SELECT * FROM governance_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [actor.leagueId, actor.id, request.idempotencyKey],
      )
    ).rows[0];
    if (old)
      guard(
        old.payload_hash === payloadHash,
        "IDEMPOTENCY_CONFLICT",
        "Return request or host changed",
      );
    // Recompute all current evidence even on exact replay; stale receipts never grant current authority.
    const value = await work(tx, host, now);
    if (old) {
      guard(
        old.response.result.type === value.type &&
          old.response.result.evidenceHash === evidenceHash(value.evidence),
        "REVALIDATION_EVIDENCE_CHANGED",
        "Return receipt no longer matches current evidence",
      );
      return { ...old.response, replayed: true };
    }
    const duplicate = (
      await tx.query(
        "SELECT 1 FROM governance_receipts WHERE league_id=$1 AND response#>>'{result,type}'=$2 AND response#>>'{result,evidence,decisionId}'=$3 AND response#>>'{result,evidence,currentHostVersion}'=$4",
        [
          actor.leagueId,
          value.type,
          value.evidence.decisionId,
          String(host.version),
        ],
      )
    ).rowCount;
    guard(
      !duplicate,
      "REVALIDATION_ALREADY_RECORDED",
      "Use the exact existing return receipt; a second key cannot replace evidence",
    );
    const result = {
      ...value,
      evidenceHash: evidenceHash(value.evidence),
      configured: false,
      approved: false,
      externalWritePerformed: false,
    };
    const response = { receiptId: randomUUID(), result, replayed: false };
    await tx.query(
      "INSERT INTO governance_receipts(league_id,actor_id,idempotency_key,id,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)",
      [
        actor.leagueId,
        actor.id,
        request.idempotencyKey,
        response.receiptId,
        payloadHash,
        response,
      ],
    );
    return response;
  });
}
/** Run after quorum/stop and BEFORE arm. Operator supplies the verified nonsecret production mapping. */
export async function prepareMflReturnAnchor(
  db: Db,
  actor: Actor,
  input: unknown,
) {
  const request = PrepareMflReturnAnchorSchema.parse(input);
  return operatorReturnTransaction(
    db,
    actor,
    request,
    async (tx, host, now) => {
      guard(
        host.version === request.expectedHostVersion,
        "HOST_VERSION_CONFLICT",
        "Expected original host version required",
      );
      await returnQuiescence(tx, actor.leagueId);
      guard(
        !(
          await tx.query(
            "SELECT 1 FROM runtime_rehearsals WHERE league_id=$1 AND status<>'restored'",
            [actor.leagueId],
          )
        ).rowCount,
        "REVALIDATION_TRIAL_ALREADY_STARTED",
        "Anchor must predate trial arming",
      );
      const mapping = productionMapping(host, request.mapping);
      const candidate = await candidateEvidence(
        tx,
        actor.leagueId,
        request.decisionId,
        host,
        mapping,
        now,
      );
      guard(
        candidate.proposal.id === request.proposalId &&
          candidate.proposal.content_hash === request.proposalHash &&
          candidate.menu.content_hash === request.menuHash,
        "REVALIDATION_CANDIDATE_MISMATCH",
        "Exact reviewed candidate and menu hashes required",
      );
      const old = (
        await tx.query(
          "SELECT response FROM governance_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [actor.leagueId, actor.id, request.idempotencyKey],
        )
      ).rows[0];
      return {
        type: "mfl-return-anchor",
        evidence: {
          decisionId: request.decisionId,
          proposalId: request.proposalId,
          proposalHash: request.proposalHash,
          menuHash: request.menuHash,
          originalHost: host,
          currentHostVersion: host.version,
          candidate,
          candidateHash: evidenceHash(candidate),
          preparedAt:
            old?.response.result.evidence.preparedAt ?? now.toISOString(),
          reason: request.reason,
          evidenceRef: request.evidenceRef,
        },
      };
    },
  );
}
/** Revalidation projects one old decision onto the restored version; approval and native application remain separate. */
export async function revalidateMflReturn(
  db: Db,
  actor: Actor,
  input: unknown,
) {
  const request = RevalidateMflReturnSchema.parse(input);
  return operatorReturnTransaction(
    db,
    actor,
    request,
    async (tx, host, now) => {
      guard(
        host.version === request.expectedHostVersion,
        "HOST_VERSION_CONFLICT",
        "Expected restored host version required",
      );
      await returnQuiescence(tx, actor.leagueId);
      const { result: prepared } = await returnReceipt(
        tx,
        actor.leagueId,
        request.anchorReceiptId,
        "mfl-return-anchor",
      );
      const anchor = prepared.evidence,
        mapping = productionMapping(host, request.mapping);
      const lineage = await validateReturnLineage(
        tx,
        actor.leagueId,
        anchor,
        request.rehearsalEpoch,
        host,
      );
      const candidate = await candidateEvidence(
        tx,
        actor.leagueId,
        anchor.decisionId,
        anchor.originalHost,
        mapping,
        now,
      );
      guard(
        evidenceHash(candidate) === anchor.candidateHash &&
          evidenceHash(mapping) === evidenceHash(anchor.candidate.mapping),
        "REVALIDATION_EVIDENCE_CHANGED",
        "Exact original proposal/menu/votes and production mapping required",
      );
      return {
        type: "mfl-decision-revalidated",
        evidence: {
          decisionId: anchor.decisionId,
          proposalId: anchor.proposalId,
          proposalHash: anchor.proposalHash,
          menuHash: anchor.menuHash,
          anchorReceiptId: request.anchorReceiptId,
          rehearsalEpoch: request.rehearsalEpoch,
          originalHostVersion: anchor.originalHost.version,
          currentHostVersion: host.version,
          mapping,
          lineage,
          lineageHash: evidenceHash(lineage),
          candidateHash: anchor.candidateHash,
          reason: request.reason,
          evidenceRef: request.evidenceRef,
        },
      };
    },
  );
}
