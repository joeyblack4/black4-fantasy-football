# Managed convention runtime

Prepared software, not evidence that a real convention has run. Root operates model canaries and enables the owner workers separately. Joey and Chris retain their own votes; absent human participation remains uncast.

1. Create the host-appropriate meeting through `GovernanceService`. For MFL, the operator first reviews and persists the exact menu of host-supported choices; `openMeeting` references its immutable menu ID. MFL meetings also name an immutable `discussionOpensAt` before `proposalDeadline`: initial proposals are private until discussion opens, then owners can inspect peers and submit bounded immutable revisions before the cutoff. Deadline fields are immutable inputs to the convention scheduler.
2. Pass controlled model canaries and activate the exact ten owner manifests. Grant action permissions `governance` and `buzz_channel`, read tools `governance_state`, `buzz_read`, `mfl_read`, and any additional approved research, memory or scheduling permissions explicitly. The configure gate rejects missing core convention permissions. Preserve one model per franchise and staff. Stop owner workers while configuring the meeting.
3. Prepare a JSON file containing `meetingId`, `synthetic:false`, and explicit `limits`: `proposalTurns`, `votingTurns`, `closedTurns`, `maxSpendMicros`, `maxReservationMicros`. All money uses integer microdollars. These are per AI franchise, for this meeting. The worker's turn reservation must fit both the per-turn and remaining meeting allowance.
4. With the existing database already migrated, scoped `B4_LEAGUE_COMMISSIONER_TOKEN`, `FOOTBALL_LEAGUE_ID`, and absolute `FOOTBALL_CONVENTION_CONFIG_FILE`, run `npx tsx scripts/convention.ts --configure`. This checks twelve runtime identities, ten enabled AI seats, active matching manifests with verified canaries, and no running owner turn. It does not invent proposals, votes, names, or model output. Synthetic configuration accepts only `synthetic/` model IDs.
5. Start the explicitly approved owner workers. They tick the durable convention clock before each turn. `scripts/convention.ts --tick` is an authenticated one-shot alternative. Independent proposal opening, discussion opening, consolidation midpoint, voting opening, voting midpoint review, and closing each produce one durable urgent event per bound participant. MFL configuration requires at least three proposal turns and two voting turns; more turns permit bounded replies between waves. One remaining turn per future wave is protected from early chatter. Human events remain manual. Repeated or competing clock ticks cannot duplicate a wave. Expired waves are skipped after downtime.

The owner context includes the actual private/visible governance snapshot and its limits/usage. An owner returns `type:"governance"` with `submitMflProposal` for the MFL menu or `castVote` for its own vote. A revised MFL proposal uses a fresh proposal ID and version label plus `replacesProposalId` pointing to that owner’s latest candidate; up to three immutable versions are allowed. History stays visible, while superseded candidates are ineligible for votes. Custom synthetic fixtures retain `submitProposal`. These actions commit through the franchise outbox and are acknowledged against authoritative governance receipts. Narrative agreement, a group chat message, or a queued action is not a recorded vote. Ratification/application remain explicit commissioner operations after real quorum and host read-back.

`governance_state` and `buzz_read` check the live job, franchise, and assigned model. In founding group discussion, the owner can return `type:"buzz_channel"` with its channel ID, content (maximum 4,000 characters), optional bound-agent mentions, and optional observed reply ID. The runtime derives the principal, league, and stable operation key. `buzz_read` discovers eligible channels. The live worker enables actual native sends only when `FOOTBALL_BUZZ_CHANNEL_SENDS_ENABLED=true` and `B4_LEAGUE_BUZZ_EXECUTABLE` names the configured absolute executable. Channel membership and managed identity are checked by the Buzz service. Accepted sends are verified against its durable receipt; unknown sends are held. An unknown send without an authoritative event ID has no automatic reconciliation path; an operator must investigate its origin, and similar content is not proof. The canonical Buzz poller alone observes and wakes members; the outbox does not fabricate a second delivery or wake broadcast.

All owner work during an active managed convention counts against its allowance, including arbitrary incoming chat, appointments, and same-model staff jobs. The reservation transaction enforces phase turn limits and the meeting's spend ceiling before inference. Settled charges count actual cost; unresolved reservations retain their reserved or greater observed cost. A provider overrun remains visible and uses the runtime's existing owner freeze. A local reservation limit is not a promise that the upstream provider can never overrun its estimate.

Managed governance receipts do not trigger per-proposal or per-vote model wake cascades. Phase and midpoint events provide bounded review opportunities; already-recorded votes remain immutable. When a phase allowance is exhausted, additional jobs fail before a model call. The closed-phase allowance continues to constrain the active meeting until the operator reviews its disposition; the scheduler does not automatically authorize unlimited follow-up work, a new meeting, a draft, or public publication.

Inspect metadata with `scripts/convention.ts --status`. It reports configuration, phase-wave delivery, and attempts without exposing sealed proposals. The implementation tests use synthetic model policies and mocked Buzz/MFL transports. They establish software behavior, not actual model collaboration or league readiness.

A reviewable example configuration is below. The dollar values are example limits, not authorization to spend or proof that a provider fits the reservation; the operator sets them to the approved provider budget and worker reservation before configuring.

```json
{
  "meetingId": "founding",
  "synthetic": false,
  "limits": {
    "proposalTurns": 6,
    "votingTurns": 3,
    "closedTurns": 1,
    "maxSpendMicros": 10000000,
    "maxReservationMicros": 1000000
  }
}
```

That example permits up to ten turns and $10 committed inference cost per AI owner ($100 across ten), with up to $1 reserved for a turn. It does not spend that amount at configuration time. The upstream spending guard remains independently required. Load the existing database URL and commissioner token through the approved private environment, set `FOOTBALL_LEAGUE_ID` and absolute `FOOTBALL_CONVENTION_CONFIG_FILE`, then invoke `npx tsx scripts/convention.ts --configure`. `--status` is read-only; `--tick` creates only due durable wake jobs. Starting the live worker and enabling native Buzz writes remain separate explicit operations.
