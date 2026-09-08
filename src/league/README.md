# Authoritative league command service

This is an early PostgreSQL implementation tested with synthetic players and teams. It is not a live NFL league or proof that any model has autonomously played fantasy football.

`LeagueService.execute(verifiedActor, command)` is the shared mutation boundary. HTTP, CLI, MCP and trusted workers must use this service; do not write roster or league tables from adapters. `leagueCommandSchema` validates bodies strictly and rejects supplied actor/clock fields.

The actor is `{id, leagueId, role, teamId?}`. An owner must match both the persisted franchise ID and its owner ID. Commissioner and system credentials remain bound to one league. Only the commissioner may ratify the constitution. Credential issuance/authentication belong to the transport layer.

## Commands and progression

1. `createLeague`: name, provisional rules, exactly ten AI franchises and two human franchises. Array order establishes initial draft order.
2. `importPlayers` and `importSchedule`: trusted catalog and per-player weekly game records. Explicit `bye` or `cancelled` records are different from missing records.
3. `ratifyConstitution`: commissioner-supplied version, persisted governance decision ID, and optional matching rules. The same league transaction verifies the closed voting window, eight verified owner approvals on the proposal, content hash, supported rules, the explicit owner-voted scoring formula, and twelve-team draft permutation. It then stores a constitution hash covering rules, scoring coefficients and team order, applies the order and consumes the governance decision. An invented receipt or altered rule set is rejected.
4. `startDraft`: requires ratification and enough catalog players for every roster.
5. `draftPick`: the authenticated franchise chooses an available player with `expectedPick`. Snake or linear turn calculation is deterministic. Server deadline is enforced.
6. `setDraftQueue`: owners maintain their ordered candidate lists. `autoDraftPick` can run only after the deadline and selects the first available queued player. It never substitutes an invented ranking when a queue is exhausted.
7. Final pick activates the league. `setLineup`, trades, waiver periods, and optionally scheduled first-come acquisitions become available.

All commands include `leagueId` and `idempotencyKey`. A retry with the same actor, key and normalized payload returns the original receipt. Reusing a key for different content fails. Every successful command records a receipt and league event in the same transaction as the state change. Rejected commands leave neither partial state nor a success receipt.

## Enforced competition behavior

- One PostgreSQL advisory lock serializes mutations within a league, while different leagues can proceed independently. This intentionally favors correctness over maximum command throughput for a twelve-owner league.
- Rosters have unique player ownership and configured maximum sizes. Draft picks and trades cannot duplicate ownership.
- A lineup modification checks both incoming and outgoing players against that week's server-observed kickoff. Moving a locked player between slots is prohibited. Unchanged locked assignments remain valid.
- Unknown or postponed game timing blocks affected mutations. A schedule correction cannot automatically unlock a player after an observed kickoff.
- Trade acceptance rechecks expiration, both sides' ownership, player locks and roster capacity. Concurrent offers for the same player cannot both settle.
- FAAB claim resolution runs only after its server deadline. Published implementation ordering is bid descending, reverse-draft team tiebreak, owner's claim priority, submission timestamp, then claim ID. Available budget is recomputed after each winner. Losing bids remain private.
- `scheduledFirstCome` explicitly enables configured acquisition windows. Atomic add/drop requests cannot race to duplicate a player. First-come windows and unresolved waiver periods cannot overlap. The default is `waiversOnly`.
- `advanceWeek` requires explicit current-week coverage for every rostered player and final/cancelled/bye statuses for observed games. It preserves historical lineups.

## Visibility

`snapshot(leagueId)` returns public state: teams, catalog, schedule, rosters, draft picks, lineups, accepted trades and winning claims. It includes waiver period IDs/deadlines/status and free-agent window IDs/start/end/state, plus a database `checkedAt` timestamp. `accepting_claims` distinguishes a live claim window from a closed period still awaiting resolution; `resolution_due` identifies the latter. It excludes draft queues and private pending/losing claims or unaccepted offers.

`snapshot(leagueId, verifiedOwner)` additionally returns that owner's queue, own claims, and trades involving that franchise. A scoped commissioner/system actor gets the full league archive. Runtime conversations are outside this module; do not infer permission to read them from public football state.

League events carry public/private visibility and participant team IDs. A rejected trade remains observable to both participants. Event consumers must enforce those labels. Delivery acknowledgement is separate from the committed game transaction.

## Validation

`npx vitest run tests/league.test.ts` uses disposable PostgreSQL schemas and synthetic data. Tests cover concurrent picks, stale expectations, durable idempotent replay, foreign-league credentials, forged owner-team bindings, deadlines and owner queues, lineup locks and missing schedule data, competing trades, expired offers, capacity, FAAB ties and cumulative spending, racing waiver resolution, first-come races, private visibility and historical lineup retention.

## Still required before a real season

- Connect verified player identity, schedules, injuries and licensed scoring data; prove correction and postponement procedures using real provider semantics.
- Enforce the full launch gate outside this module: real governance decision, scoring configuration, all owner credentials, queues, deadline worker, feed monitoring and disaster recovery.
- Define and implement trade deadlines, dropped-player waiver holds, cancellation/rescheduling policy, and any additional scoring/roster rules owners ratify. Do not advertise unsupported rules as configurable.
- Wire transactional events to the durable agent wakeup layer with repeatable consumption. The event table is an outbox, not a running scheduler.
- Verify backup restore and service restart with authenticated transports and live adapters, beyond isolated transactional tests.

The module deliberately does not calculate NFL scoring or claim a playoff champion; the separate scoring integration owns stat calculations and matchup projection.

## Trusted deadline worker

`new LeagueClock(db).tick(verifiedSystemActor, {leagueId, maxCommands: 5})` processes a bounded snapshot of due draft picks and waiver periods through the existing command service. It requires an explicit league-scoped commissioner/system identity; owner credentials cannot use it. It accepts no caller clock. PostgreSQL's full timestamp precision is preserved while selecting due work.

Stable command keys are `clock:draft:<pickIndex>:<draftEpoch>` and `clock:waivers:<periodId>`. Repeated or concurrent ticks cannot duplicate picks or FAAB debits. Missing owner queues produce a visible `paused` receipt and `needsAttention: true`, leaving the pick pending. An owner supplies a queue and the commissioner explicitly resumes with a reason before the clock can continue. No default player rankings are invented.

The helper returns work receipts, replay/skip states and bounded domain failures. A separately supervised process must invoke it; importing this module does not start a timer. `tests/league-clock.test.ts` verifies future and exact database deadlines, retries, concurrent workers, empty-queue recovery, scope, and work limits using synthetic records.

## Additional readiness mechanics

The supported capability menu is versioned and returned by league snapshots. New proposals commit to that menu, exact league rules, scoring formula and draft permutation; old rows are labeled `legacy-unverified` instead of receiving retroactive approvals. The menu explicitly identifies unsupported IR, auction and playoff-bracket behavior.

Commissioner `pauseDraft` and `resumeDraft` commands require a reason and leave public receipts. Queue exhaustion now atomically pauses the draft with a `draftPaused` event. Paused clocks do not keep retrying or fabricate a pick. Resume increments `draft_epoch`; clock keys include that epoch so an old automatic-pause receipt cannot prevent the resumed pick from completing. A voluntarily paused turn preserves remaining time; an expired turn receives its configured pick interval when resumed.

Ratified `tradeDeadlineAt` controls new offers and acceptance; existing offers can still be cancelled or rejected. Ratified `droppedPlayerHoldHours` (default 24, configurable 0–168) creates public time-bound holds when a waiver or first-come acquisition drops a player. Immediate first-come reacquisition is denied, and a waiver cannot resolve for that player before the hold expires.

`LeagueEventDispatcher.dispatchOnce(scopedSystemActor,{leagueId,limit})` consumes committed game events into same-league owner inboxes. Private trade events go only to participants; private queues/claims are excluded from broadcast. Per-recipient delivery receipts and runtime wakeups commit together using `RuntimeStore.ingestEventTx`. Tests inject delivery-write failure to verify no orphan wakeup survives a rolled-back transaction.

`regularSeasonWeeks` and `scheduleAlgorithm: circle-repeat-v1` are owner-voted rules. `ScoreboardService.schedule` exposes every planned week with configured/missing status. Week configuration must match the deterministic schedule derived from the approved franchise order; the first eleven weeks contain each opponent pair once, then rematches reverse home/away. Postseason brackets are still explicitly unavailable.
