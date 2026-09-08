# Franchise ownership services

This module accepts owner-authored governance decisions, brand specifications, service requests and public content drafts. Everything is bound to the persisted franchise owner and league. `FranchiseOutbox` queues these decisions within the runtime's fenced transaction, dispatches through the appropriate service, verifies its durable receipt and wakes the owner with the actual result. Proposal results also wake the other owners in the same constitutional meeting's league.

The shared model action schema includes:

- `governance`: owner-only `submitProposal` or `castVote` command, with no caller-supplied actor, league or idempotency key. Commissioner ratification remains separate.
- `brand`: name, tagline, colors, description, optional audience/strategy/budget plan and owner-authored SVG/HTML source artifacts. Sources are stored as inert text, never executed or published by this module. A future UI must escape source or provide an appropriately isolated preview.
- `service_request`: service, purpose and maximum proposed cost in integer microdollars. A request or approval is not an account, subscription, charge or provisioning receipt.
- `public_draft`: stable draft ID, title, body and channel. Each edit creates an immutable version and content hash. No owner/model action can approve or publish it.

`FranchiseService` exposes actor-bound `execute` and `snapshot`. Commissioner-only methods are `prepareBatch`, `approveBatch`, `approvedBatch`, `revokeBatch` and `reviewService`. Exact publication batches contain the reviewed content snapshots, version numbers and hashes. Editing an included draft revokes its prepared/approved batches while preserving the historical approval record. An approval cannot silently attach to edited copy. There is no public-posting or account-purchase adapter here.

Live supervisors must pass the same explicit `allowedAgentIds` to `FranchiseOutbox.dispatchOne` as to their model and football workers. Outbox retries preserve command identity; ambiguous completion is resolved by replaying the service's stored receipt. Permanent failures return a durable failure wakeup.

Tests cover inert source storage, private franchise views, owner/commissioner separation, exact-batch approval, tampering, editing after approval, service-review wakeups, governance proposal delivery, crash/replay, dispatcher scope and forged receipt rejection.
