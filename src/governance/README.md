# Constitutional governance

This module is working local infrastructure. Tests contain explicit synthetic owner actions; no live model votes or real ratification have occurred.

`GovernanceService.execute(verifiedActor, command)` uses the same per-league PostgreSQL transaction lock as the football engine. Every action has a payload-checked idempotency key and immutable receipt. Command bodies cannot supply owner identity.

A commissioner opens a meeting with a future independent-proposal deadline and a later voting deadline, both within twenty-four hours. Only one meeting can be active per league. Each of twelve owners can submit one immutable proposal during the independent phase. Proposals include a title, rationale, version, supported league rules, an explicit validated scoring formula, and an exact permutation of all twelve franchise IDs. Different owners can label their independent proposal `v1`; proposal IDs and decision IDs disambiguate them.

The snapshot endpoint reveals an owner's own proposal during the independent phase. Other proposals remain sealed, including from a competing commissioner. When the proposal deadline passes, all proposals become readable and authenticated owners can cast one immutable yes/no vote on each proposal. A new request cannot replace a recorded vote. Corrections require another meeting and new proposal; votes never transfer automatically.

After the vote deadline, the commissioner may `prepareRatification` for a proposal with at least eight yes votes from current verified franchise owners. This produces an eligible governance decision, not a ratified constitution. The commissioner then calls the shared league command:

```json
{
  "type": "ratifyConstitution",
  "leagueId": "example",
  "idempotencyKey": "ratify-approved-proposal-once",
  "version": "v1",
  "decisionReceipt": "decision-id-returned-by-governance"
}
```

The league engine rechecks the persisted decision, closed window, same-proposal quorum, proposal content hash including point coefficients, requested version/rules, and exact team permutation under its transaction lock. It applies league rules, the owner-voted scoring formula and draft positions atomically and links the consumed decision to the resulting league receipt. Creating a decision and then crashing is safe: nothing has been ratified, and the decision can be consumed on retry. A successful ratification replay returns its original receipt.

If several proposals reach eight votes, the commissioner explicitly chooses one. If none passes, a new bounded meeting is needed. Tiebreaks, live debate moderation, meeting notifications and public transcript publishing remain orchestration responsibilities. This module does not invent votes, automatically choose a proposal, or treat silence as approval.

`npx vitest run tests/governance.test.ts` verifies sealing, identity boundaries, immutable/replayed actions, competing votes, quorum, altered-rule rejection, atomic draft reordering and detection of modified proposal content. Synthetic fixtures age meeting deadlines directly in disposable schemas; public commands always use database time.

Scoring configuration must exactly match `leagues.ratified_scoring_rules`. Every new proposal supplies `scoringRules` using the shared `ScoringRulesSchema`; omission or unsupported coefficients fail validation. Existing rehearsal rows without a voted formula remain null and are not backfilled with invented approvals. The synthetic helper defaults to the documented `halfPprRules` object; a demonstration using another formula must supply that exact object as the helper's sixth argument and to scoring configuration.
