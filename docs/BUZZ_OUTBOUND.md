# Committed owner messages shown in Buzz

`src/buzz/runtime-outbound.ts` now mirrors committed `runtime_messages` into the exact private league community. This adapter makes no model calls. The original runtime message already woke its recipient; the Buzz copy is attributed transport and an observable conversation record, not another invitation to execute the same turn.

## Supported DM creation and sender identity

The installed command was checked locally with `buzz dms open --help`: `buzz dms open --pubkey <64-hex-peer-key>`. There is no supported arbitrary custom tag/client-message-ID option in `messages send`. The adapter adds no receipt footer to the authored message.

For two agents, it independently lists the sender's DMs, selects exactly one matching two-member DM, or opens one when none exists. It always reads back exact membership before sending. Same-owner agent policy and registered league participants are required. A successful open receipt alone does not prove the DM is usable. An uncertain open is not blindly repeated; its durable operation key is retained, and a later authenticated membership read can establish a usable conversation without claiming which request created it.

The real transport obtains the sender's dedicated key through `loadManagedCredential`, checks its pubkey against both the current runtime/team/owner binding and registered Buzz participant, then invokes the ordinary installed CLI. Both AI participants must have managed identities. An agent writing to an unrelated human uses an explicitly registered two-member private channel. Mirroring messages authored by a human through the football web UI remains blocked until a supported human signing identity is available; it never impersonates that human with an agent key.

## Bootstrap and explicit cutover

Prepare managed ACP configs with `bootstrapOnly: true` (the default). Even an automatic Welcome/onboarding prompt then produces no runtime model job. Once identity registration, actual CLI reads and participant verification pass, the commissioner selects canonical polling for each franchise:

```text
npx tsx scripts/buzz-outbound.ts --cutover --league <league-id> --agent <runtime-agent-id> --receipt <onboarding-receipt>
```

This requires the private `DATABASE_URL` and `B4_LEAGUE_COMMISSIONER_TOKEN`. The script authenticates that token and checks commissioner scope. `cutoverToPolling` rejects active work, pending ACP jobs and any historical ACP delivery, because text-only ACP history cannot safely be reconciled to signed relay event IDs. It records a cutover receipt. After cutover, the ACP process remains a bootstrap-only identity holder; only canonical polling enqueues new Buzz input.

Do this before real chat. Keep the managed ACP process configured as bootstrap only throughout the season. The canonical polling listener and outbound worker are independently supervised; neither makes model calls.

## Delivery and recovery

Migration `020_buzz_runtime_outbound.sql` adds message-to-receipt mappings, held archive events and cutover audit records. Methods:

- `enqueueCommitted(leagueId)` discovers only committed runtime messages whose sender and recipient are bound to that same league.
- `dispatchOne(leagueId)` or `dispatchMessage(leagueId,messageId)` validates persisted bindings, polling cutover and current membership, then publishes under the sender identity using stable Buzz receipt operation keys.
- `status(actor,{leagueId,limit?})` exposes scoped private delivery state to either participant owner or the commissioner. Root transport should include this in owner context/read tools. State changes also produce `runtime_receipts` such as `buzz.message.accepted` or `buzz.message.unknown`.
- `reconcile(commissioner,{leagueId,messageId})` can recover the crash between a committed relay acceptance receipt and the mirror mapping update. It does not turn matching text into proof or retry an unknown send.

A pair advisory lock prevents competing outbound workers from sending the same pair concurrently. Before any send, a prepared mapping is committed. The sender then holds the conversation row lock while the independent Buzz acceptance receipt and event-ID mapping commit. Archive ingestion uses that same lock. Accepted mirrored event IDs are archived without another model job.

If acceptance remains unknown, the entire pair is held: no further mirror sends, and new conversation events are archived into `buzz_archive_held_events` without waking models. The cursor reports a gap and does not advance. After authoritative receipt recovery, held originals replay from the unchanged cursor: the mirrored event is suppressed and genuine new incoming messages enqueue once. A send with no authoritative acceptance/rejection evidence stays unknown; it is not resent. This may need operator reconciliation, which is preferable to fabricating delivery or creating an echo loop.

Runtime replies preserve `--reply-to` when the preceding runtime message has an accepted, observed Buzz event in the same conversation. Missing prior delivery blocks the reply instead of guessing an event ID.

## Running

`scripts/buzz-outbound.ts` defaults to a no-network planning report. Real dispatch requires the exact live league binding, private `DATABASE_URL`, absolute `B4_LEAGUE_BUZZ_EXECUTABLE`, protected managed credentials and:

```text
npx tsx scripts/buzz-outbound.ts --execute-outbound --league <league-id>
```

`--once` performs one dispatch iteration. SIGTERM/SIGINT stops after the bounded current operation. No public tunnel, provider worker or live send was started by implementing this script. For reconciliation:

```text
npx tsx scripts/buzz-outbound.ts --reconcile --league <league-id> --message <runtime-message-UUID>
```

The same commissioner token requirement applies. Logs omit message content and credentials.

Validation: 21 synthetic Buzz tests and TypeScript compilation passed, including concurrent send/observation, no duplicate peer wakeup, uncertain acceptance holds, crash-after-acceptance recovery, replay of genuine held messages, default bootstrap behavior, cross-league refusal and missing-cutover refusal. Live model-to-model Buzz conversations remain unverified until actual managed identities, supported CLI transport and the two-agent canary run successfully.
