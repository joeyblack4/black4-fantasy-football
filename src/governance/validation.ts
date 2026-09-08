import { createHash } from "node:crypto";
import { leagueCapabilityVersion } from "../league/capabilities.js";
import { ScoringRulesSchema } from "../data/index.js";
import type { Tx } from "../db.js";
import {
  LeagueError,
  leagueRulesSchema,
  type LeagueRules,
} from "../league/schema.js";
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const fingerprint = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
export function guard(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new LeagueError(code, message);
}
export async function quorum(
  tx: Tx,
  leagueId: string,
  proposalId: string,
  now: Date,
) {
  const proposal = (
    await tx.query(
      "SELECT p.*,m.vote_deadline FROM governance_proposals p JOIN governance_meetings m ON m.league_id=p.league_id AND m.id=p.meeting_id WHERE p.league_id=$1 AND p.id=$2",
      [leagueId, proposalId],
    )
  ).rows[0];
  guard(proposal, "NOT_FOUND", "Proposal does not exist");
  guard(
    proposal.vote_deadline <= now,
    "VOTING_OPEN",
    "Voting window has not closed",
  );
  const yes = Number(
    (
      await tx.query(
        "SELECT count(*) FROM governance_votes v JOIN league_teams t ON t.league_id=v.league_id AND t.id=v.team_id AND t.owner_id=v.owner_id WHERE v.league_id=$1 AND v.proposal_id=$2 AND v.choice='yes'",
        [leagueId, proposalId],
      )
    ).rows[0].count,
  );
  guard(
    yes >= 8,
    "QUORUM_NOT_MET",
    "At least eight of twelve verified owners must approve this proposal",
  );
  guard(
    proposal.capability_version === leagueCapabilityVersion,
    "CAPABILITY_VERSION_MISMATCH",
    "Proposal must explicitly use the current implemented capability menu",
  );
  const rules = leagueRulesSchema.parse(proposal.rules);
  guard(
    proposal.scoring_rules,
    "SCORING_UNRATIFIED",
    "Proposal has no owner-voted scoring mechanism",
  );
  const scoringRules = ScoringRulesSchema.parse(proposal.scoring_rules);
  const teams = (
    await tx.query("SELECT id FROM league_teams WHERE league_id=$1", [leagueId])
  ).rows.map((r) => r.id);
  guard(
    proposal.team_order.length === 12 &&
      new Set(proposal.team_order).size === 12 &&
      proposal.team_order.every((id: string) => teams.includes(id)),
    "INVALID_DRAFT_ORDER",
    "Draft order is not the twelve league teams",
  );
  guard(
    fingerprint({
      title: proposal.title,
      rationale: proposal.rationale,
      rules,
      scoringRules,
      capabilityVersion: proposal.capability_version,
      teamOrder: proposal.team_order,
      version: proposal.version,
    }) === proposal.content_hash,
    "PROPOSAL_CHANGED",
    "Stored proposal content no longer matches the voted hash",
  );
  return { proposal, rules, scoringRules, yes };
}
/** Called under the shared league transaction lock. No caller-provided vote count confers authority. */
export async function validateDecision(
  tx: Tx,
  leagueId: string,
  decisionId: string,
  version: string,
  now: Date,
  requestedRules?: LeagueRules,
) {
  const decision = (
    await tx.query(
      "SELECT * FROM governance_decisions WHERE league_id=$1 AND id=$2 FOR UPDATE",
      [leagueId, decisionId],
    )
  ).rows[0];
  guard(
    decision,
    "GOVERNANCE_DECISION_REQUIRED",
    "Ratification requires a persisted governance decision",
  );
  guard(
    !decision.consumed_at,
    "DECISION_CONSUMED",
    "Decision already ratified",
  );
  const result = await quorum(tx, leagueId, decision.proposal_id, now);
  guard(
    result.proposal.version === version,
    "PROPOSAL_MISMATCH",
    "Ratification version differs from the approved proposal",
  );
  if (requestedRules)
    guard(
      stable(requestedRules) === stable(result.rules),
      "PROPOSAL_MISMATCH",
      "Ratification rules differ from the approved proposal",
    );
  return { ...result, decision };
}
