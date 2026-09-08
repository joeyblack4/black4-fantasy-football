# MFL draft observer and local owner queue

Prepared and tested with a synthetic MFL adapter and mocked HTTP. This document does not claim that the observer, a live draft, or any owner inference has been started.

The commissioner-authorized observer uses the existing verified MFL deployment to read only the static draft state. It never invokes a model, makes a pick, uploads a native queue, or reads private franchise bids/trades. A changed active turn creates one durable urgent job for the franchise identified by the persisted MFL mapping. Humans receive manual jobs that AI workers cannot claim. Repeated polls of the same turn create no extra jobs. A pause produces no pick wake; a resume can produce one new wake for that turn's resumed activation. The actual owner must read fresh state and choose an exact native draft action; MFL preflight still controls acceptance.

Observation leases fence concurrent/crashed pollers. Host version, deployment scope, franchise ownership, completed history, and monotonic turn/source state are checked before releasing a wake. An apparent reset or corrected pick history holds the observer for explicit review. Re-arm a held observer with a new operator-chosen epoch after reviewing the source. Do not reuse an old epoch for a different draft. A reset that produces identical empty upstream state has no distinguishable reset identifier; knowingly resetting MFL requires a new reviewed epoch even if the observer cannot detect it from the response.

## Prepared process

Apply migrations through `029_mfl_draft_observer.sql` using the normal migration process. Supply the existing private database URL and scoped `B4_LEAGUE_COMMISSIONER_TOKEN`, plus the verified `FOOTBALL_MFL_CONFIG_FILE` and `MFL_SESSION_FILE`. `FOOTBALL_LEAGUE_ID` selects one league. The helper loads the existing protected deployment/session files; no credential or actor can come from an agent's draft payload.

Prepare an absolute `FOOTBALL_MFL_DRAFT_OBSERVER_CONFIG_FILE` with this shape, substituting the actual reviewed epoch and persisted host version:

```json
{
  "epoch": "reviewed-draft-epoch",
  "expectedHostVersion": 1,
  "synthetic": false
}
```

- `npx tsx scripts/mfl-draft-observer.ts --configure` explicitly arms observation after a fresh read-only native settings check (`draft_kind=live`, `loadRosters=live_draft`, exact league ID); it makes no pick or model call. Email-mode future draft slots cannot arm the observer.
- `npx tsx scripts/mfl-draft-observer.ts --status` reads only local observer metadata.
- Set `FOOTBALL_MFL_DRAFT_OBSERVER_ENABLED=true`, then run `npx tsx scripts/mfl-draft-observer.ts --poll`; `--once` performs one observation. `FOOTBALL_MFL_DRAFT_POLL_MS` defaults to 5000 and accepts 5000–60000. The script revalidates commissioner credentials each iteration, logs only changes/attention, handles termination, and can be supervised as a separate process. Polling does not guarantee upstream freshness. Read failures create no model job and may retry the GET; unknown write reconciliation is a separate system.

No actual stack, observer or supervisor installation was started by this implementation task. An active convention continues to enforce its closed-phase turn/spend caps; the operator must explicitly review its transition before enabling draft owner work.

The observer rechecks native live mode before each static draft read and holds if it changes. Each owner draft-write preflight also checks native live mode before reading the current turn or sending a pick. Ordinary settings, roster and draft reads remain available in email mode. These checks add a throttled settings export to each observation; static-file requests alone are exempt from MFL's API limits. A concurrent commissioner setup change between preflight and POST remains an upstream race; do not change draft mode while owner dispatch is enabled. See [the rehearsal runbook](MFL_REHEARSAL_RUNBOOK.md) for current read-only evidence and launch gates.

## Owner queue contract

With `football` and `mfl_read` permissions, the owner can read `mfl_read {"type":"localDraftQueue"}` and return:

```json
{
  "type": "football",
  "causalId": "own-queue-v1",
  "command": {
    "type": "mflLocalDraftQueue",
    "expectedVersion": 0,
    "playerIds": ["14319", "14320"]
  }
}
```

This stores a versioned ranked preference list for that owner and host version. It does not upload a native MFL draft list, prove player eligibility, authorize an automatic pick, or spend FAAB. Duplicate IDs and stale versions are rejected. Queue actions commit through the fenced football outbox; acknowledgment verifies the original request against the persisted local receipt. Replay cannot create another version. Another owner cannot read this private queue. The owner reads the current draft and player availability, then independently returns the existing exact MFL draft action when appropriate.
