import { hostBinding } from "../league/host.js";
import { executeMflGovernance, snapshotMflGovernance } from "./mfl.js";
import { randomUUID } from "node:crypto";
import { transaction, type Db, type Tx } from "../db.js";
import type { Actor } from "../league/schema.js";
import { governanceCommandSchema, type GovernanceCommand } from "./schema.js";
import { fingerprint, guard, quorum } from "./validation.js";
export * from "./schema.js";
export class GovernanceService {
  constructor(private db: Db) {}
  private async owner(tx: Tx, actor: Actor) {
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
  async execute(actor: Actor, input: GovernanceCommand | unknown) {
    const command = governanceCommandSchema.parse(input);
    guard(
      actor.leagueId === command.leagueId,
      "FORBIDDEN",
      "Credential belongs to another league",
    );
    const hash = fingerprint({ actor, command });
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,7044))",
        [command.leagueId],
      );
      const host = await hostBinding(tx, actor.leagueId);
      if (host.host === "mfl")
        return executeMflGovernance(tx, actor, command, host);
      const old = (
        await tx.query(
          "SELECT * FROM governance_receipts WHERE league_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [command.leagueId, actor.id, command.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        guard(
          old.payload_hash === hash,
          "IDEMPOTENCY_CONFLICT",
          "Key identifies a different governance action",
        );
        return { ...old.response, replayed: true };
      }
      const league = (
        await tx.query("SELECT * FROM leagues WHERE id=$1 FOR UPDATE", [
          command.leagueId,
        ])
      ).rows[0];
      guard(league, "NOT_FOUND", "League does not exist");
      guard(
        league.status === "setup" && !league.constitution_version,
        "RULES_FROZEN",
        "Governance is closed after constitution ratification",
      );
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      let result: Record<string, unknown>;
      switch (command.type) {
        case "openMeeting": {
          guard(
            actor.role === "commissioner",
            "FORBIDDEN",
            "Only the commissioner opens a constitutional meeting",
          );
          const p = new Date(command.proposalDeadline),
            v = new Date(command.voteDeadline);
          guard(
            p > now && v > p && v.getTime() - now.getTime() <= 86400000,
            "INVALID_WINDOW",
            "Meeting requires future proposal/vote deadlines within twenty-four hours",
          );
          guard(
            !(
              await tx.query(
                "SELECT 1 FROM governance_meetings WHERE league_id=$1 AND vote_deadline>$2",
                [actor.leagueId, now],
              )
            ).rowCount,
            "MEETING_OPEN",
            "A constitutional meeting is already open",
          );
          guard(
            !(
              await tx.query(
                "SELECT 1 FROM governance_meetings WHERE league_id=$1 AND id=$2",
                [actor.leagueId, command.meetingId],
              )
            ).rowCount,
            "ALREADY_EXISTS",
            "Meeting ID already exists",
          );
          await tx.query(
            "INSERT INTO governance_meetings(league_id,id,proposal_deadline,vote_deadline) VALUES($1,$2,$3,$4)",
            [actor.leagueId, command.meetingId, p, v],
          );
          result = {
            meetingId: command.meetingId,
            proposalDeadline: command.proposalDeadline,
            voteDeadline: command.voteDeadline,
          };
          break;
        }
        case "submitProposal": {
          const team = await this.owner(tx, actor);
          const m = (
            await tx.query(
              "SELECT * FROM governance_meetings WHERE league_id=$1 AND id=$2",
              [actor.leagueId, command.meetingId],
            )
          ).rows[0];
          guard(m, "NOT_FOUND", "Meeting does not exist");
          guard(
            now < m.proposal_deadline,
            "PROPOSALS_CLOSED",
            "Independent proposal window closed",
          );
          guard(
            !(
              await tx.query(
                "SELECT 1 FROM governance_proposals WHERE league_id=$1 AND meeting_id=$2 AND author_team_id=$3",
                [actor.leagueId, command.meetingId, team],
              )
            ).rowCount,
            "PROPOSAL_LIMIT",
            "Each owner submits one immutable proposal per meeting",
          );
          const teams = (
            await tx.query("SELECT id FROM league_teams WHERE league_id=$1", [
              actor.leagueId,
            ])
          ).rows.map((r) => r.id);
          guard(
            command.teamOrder.every((id) => teams.includes(id)),
            "INVALID_DRAFT_ORDER",
            "Draft order includes a team outside this league",
          );
          guard(
            !(
              await tx.query(
                "SELECT 1 FROM governance_proposals WHERE league_id=$1 AND id=$2",
                [actor.leagueId, command.proposalId],
              )
            ).rowCount,
            "ALREADY_EXISTS",
            "Proposal ID already exists",
          );
          const contentHash = fingerprint({
            title: command.title,
            rationale: command.rationale,
            rules: command.rules,
            scoringRules: command.scoringRules,
            capabilityVersion: command.capabilityVersion,
            teamOrder: command.teamOrder,
            version: command.version,
          });
          await tx.query(
            "INSERT INTO governance_proposals(league_id,id,meeting_id,author_team_id,author_id,version,title,rationale,rules,team_order,content_hash,scoring_rules,capability_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
            [
              actor.leagueId,
              command.proposalId,
              command.meetingId,
              team,
              actor.id,
              command.version,
              command.title,
              command.rationale,
              JSON.stringify(command.rules),
              command.teamOrder,
              contentHash,
              JSON.stringify(command.scoringRules),
              command.capabilityVersion,
            ],
          );
          result = {
            proposalId: command.proposalId,
            authorTeamId: team,
            version: command.version,
            contentHash,
            visibility: "sealed-until-proposal-deadline",
          };
          break;
        }
        case "castVote": {
          const team = await this.owner(tx, actor);
          const p = (
            await tx.query(
              "SELECT p.id,m.proposal_deadline,m.vote_deadline FROM governance_proposals p JOIN governance_meetings m ON m.league_id=p.league_id AND m.id=p.meeting_id WHERE p.league_id=$1 AND p.id=$2",
              [actor.leagueId, command.proposalId],
            )
          ).rows[0];
          guard(p, "NOT_FOUND", "Proposal does not exist");
          guard(
            now >= p.proposal_deadline && now < p.vote_deadline,
            "VOTING_CLOSED",
            "Votes require the published voting window",
          );
          guard(
            !(
              await tx.query(
                "SELECT 1 FROM governance_votes WHERE league_id=$1 AND proposal_id=$2 AND team_id=$3",
                [actor.leagueId, command.proposalId, team],
              )
            ).rowCount,
            "VOTE_IMMUTABLE",
            "A franchise has one immutable vote per proposal",
          );
          await tx.query(
            "INSERT INTO governance_votes(league_id,proposal_id,team_id,owner_id,choice) VALUES($1,$2,$3,$4,$5)",
            [
              actor.leagueId,
              command.proposalId,
              team,
              actor.id,
              command.choice,
            ],
          );
          result = {
            proposalId: command.proposalId,
            teamId: team,
            choice: command.choice,
          };
          break;
        }
        case "registerMflMenu":
        case "submitMflProposal":
        case "approveMflConstitution":
        case "recordMflApplication":
          guard(
            false,
            "FOOTBALL_HOST_MISMATCH",
            "MFL governance requires an MFL host binding",
          );
        case "prepareRatification": {
          guard(
            actor.role === "commissioner",
            "FORBIDDEN",
            "Only the commissioner prepares final ratification",
          );
          const { proposal, yes } = await quorum(
            tx,
            actor.leagueId,
            command.proposalId,
            now,
          );
          const existing = (
            await tx.query(
              "SELECT * FROM governance_decisions WHERE league_id=$1 AND proposal_id=$2",
              [actor.leagueId, command.proposalId],
            )
          ).rows[0];
          const decisionId = existing?.id ?? randomUUID();
          if (!existing)
            await tx.query(
              "INSERT INTO governance_decisions(league_id,id,proposal_id,created_by,yes_votes) VALUES($1,$2,$3,$4,$5)",
              [actor.leagueId, decisionId, command.proposalId, actor.id, yes],
            );
          result = {
            decisionId,
            proposalId: command.proposalId,
            version: proposal.version,
            yesVotes: yes,
            threshold: 8,
            status: "eligible-for-commissioner-ratification",
          };
          break;
        }
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
    });
  }
  async listMeetings(actor: Actor) {
    guard(
      ["owner", "commissioner", "system"].includes(actor.role),
      "FORBIDDEN",
      "Verified identity required",
    );
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      if (actor.role === "owner") await this.owner(tx, actor);
      const host = await hostBinding(tx, actor.leagueId);
      const table =
        host.host === "mfl" ? "mfl_governance_meetings" : "governance_meetings";
      return (
        await tx.query(
          `SELECT * FROM ${table} WHERE league_id=$1 ${host.host === "mfl" ? "AND host_version=$2" : ""} ORDER BY created_at DESC LIMIT 50`,
          host.host === "mfl"
            ? [actor.leagueId, host.version]
            : [actor.leagueId],
        )
      ).rows;
    });
  }
  async snapshot(actor: Actor, meetingId: string) {
    return transaction(this.db, async (tx) => {
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const host = await hostBinding(tx, actor.leagueId);
      if (host.host === "mfl")
        return snapshotMflGovernance(tx, actor, meetingId, host);
      guard(
        ["owner", "commissioner", "system"].includes(actor.role),
        "FORBIDDEN",
        "Verified identity required",
      );
      if (actor.role === "owner") await this.owner(tx, actor);
      const m = (
        await tx.query(
          "SELECT * FROM governance_meetings WHERE league_id=$1 AND id=$2",
          [actor.leagueId, meetingId],
        )
      ).rows[0];
      guard(m, "NOT_FOUND", "Meeting does not exist");
      const now: Date = (await tx.query("SELECT clock_timestamp() AS now"))
        .rows[0].now;
      // Even the competing commissioner cannot inspect sealed proposals through this interface.
      const visible = now >= m.proposal_deadline;
      const proposals = (
        await tx.query(
          "SELECT * FROM governance_proposals WHERE league_id=$1 AND meeting_id=$2 AND ($3::boolean OR author_team_id=$4) ORDER BY created_at",
          [
            actor.leagueId,
            meetingId,
            visible,
            actor.role === "owner" ? actor.teamId : null,
          ],
        )
      ).rows;
      const ids = proposals.map((p) => p.id);
      const votes = (
        await tx.query(
          "SELECT proposal_id,team_id,choice,created_at FROM governance_votes WHERE league_id=$1 AND proposal_id=ANY($2::text[]) ORDER BY created_at",
          [actor.leagueId, ids],
        )
      ).rows;
      return {
        meeting: m,
        phase:
          now < m.proposal_deadline
            ? "independent-proposals"
            : now < m.vote_deadline
              ? "voting"
              : "closed",
        proposals,
        votes,
        threshold: 8,
        electorate: 12,
      };
    });
  }
}
