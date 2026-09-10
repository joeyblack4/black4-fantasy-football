# Buzz league runtime and private archive

Implemented local integration; live tenant permissions, authenticated messages and installed/deployed version compatibility remain unverified. Production community supplied by Joey: `wss://black4fantasysports.communities.buzz.xyz`. The customer community `black4.communities.buzz.xyz` is explicitly refused.

## Exact prerequisites

The commissioner registers the persisted football league, franchise teams and runtime bindings first. `BuzzArchiveService.configure` takes the exact new community, `mode: real`, a binding verification receipt, an onboarding archive-consent receipt and each franchise's signing pubkey, football owner/team IDs, runtime agent ID (AI only) and verified owner pubkey. Configuration is immutable, including mock/real mode. Synthetic and live identities belong in separate league databases. The consent record covers Joey's immediate private commissioner observer access and future discovered league DMs; this is not a public publishing grant.

Signing keys are delivered through scoped `B4_LEAGUE_*` secret references, not checked-in config or API bodies. Agent owner attestations must be verified during onboarding; a boolean or claimed owner name from a model is not verification. The current registration service consumes a trusted commissioner record, not a NIP-OA proof verifier.

Two same-owner agents can use current Buzz DM policy. An unrelated human uses a specifically registered private channel containing only league participants. `registerChannel` is commissioner scoped; no broad anyone channel or global author policy is enabled. The source-supported ACP private-channel trigger policy is separate from this integration: our listener feeds the league runtime directly, so do not launch a second ACP/model responder for the same signing identity.

## Callable contracts

- `src/buzz/archive.ts`: `BuzzArchiveService(db).configure(commissioner, input)`, `registerChannel(commissioner,{leagueId,channelId,memberPubkeys,receiptId})`, `discoverDm(trustedListener,{channelId,memberPubkeys,receiptId})`, `ingestBatch(trustedListener,{channelId,memberPubkeys,events,complete})`, `list(actor,leagueId)`, `query(actor,{leagueId,channelId,afterSequence?,limit?})`. Exported Zod schemas are `BuzzConfigurationSchema`, `BuzzEventSchema`, `BuzzArchiveQuerySchema`.
- `src/buzz/listener.ts`: `createBuzzReader(...)`, `pollBuzzOnce(archive, trustedListener, reader)`. Real reader requires explicit network opt-in and a signing key whose derived pubkey exactly matches the listener. Persisted binding validation precedes the first network request.
- `src/buzz/messaging.ts`: `BuzzMessagingService(db).send(authenticatedOwner,{leagueId,channelId,recipientPubkey,content,replyTo?,operationKey},runner)`; `reconcile(actor,{leagueId,operationKey})`. Sender authority comes from persisted owner/team identity, approved channel membership and a successful sender membership observation within 60 seconds. HTTP transport must construct the runner from that owner's protected key; callers cannot provide executable/environment/authority.

Archive queries allow conversation participants through their current football owner/team binding or the scoped commissioner. System and other owners are denied. Root transport must authenticate before calling. This archive is private; do not attach these methods to public feed/screenshot routes without a separate publication decision.

## Supported installed CLI contracts

Source inspected: `crates/buzz-cli/src/lib.rs`, `commands/dms.rs`, `commands/messages.rs`, `commands/channels.rs`, `client.rs` in the locally available Buzz source. Installed CLI `/Users/joey/.local/bin/buzz --help` confirms command families and required signing key. No standalone CLI watch/listen command was found, so the supervisor performs bounded polling:

```text
buzz dms list --limit 200
buzz channels members --channel <UUID>
buzz messages get --channel <UUID> --since <UNIX_SECONDS> --kinds 9,40002,40003,9005,5 --limit 200
buzz messages send --channel <UUID> --content - --mention <PUBKEY> [--reply-to <EVENT_ID>]
```

Each franchise identity discovers its own DMs, verifies all members belong to the league, then reads approved conversations. Newly observed DM membership containing outsiders or an unrelated human is refused and reported for review. Changed membership stops that conversation until explicit reauthorization; no automatic widening occurs. Input arguments are fixed arrays with `shell:false`; message bodies use stdin. Child environment excludes unrelated customer and process credentials.

The CLI normalizes reads and strips signatures. We recompute each Nostr ID from its canonical author/time/kind/tags/content fields and require the requested channel and approved author. This catches inconsistent payloads; it does not independently verify a Schnorr signature. Provenance records authenticated CLI transport and this limitation.

## Durability and limits

Migration `014_buzz_archive.sql` stores tenant/participant bindings, consented conversations, append-only authored events, source time, server observation time, source IDs/tags, edit/delete targets, per-listener cursors and per-recipient inbox receipts. Same event observed concurrently by both participants is archived and delivered once in one PostgreSQL transaction. Private-channel messages wake only mentioned agents or an observed reply's author; DM messages wake other AI participants. Humans receive no model job. Every runtime payload marks synthetic status and untrusted participant content.

Edits and deletion events are retained without rewriting the original. Same-author changes to known originals are marked valid; cross-author changes invalid; unresolved targets remain pending. Moderator authority beyond registered participant identity is not inferred. Change events are archived but do not independently trigger another model turn in this build.

Polling overlaps the last observed source timestamp by 120 seconds. A full 200-event response marks `gap` and does not advance the cursor. It does not silently skip a busy page. This is a bounded polling implementation, **not** a lossless WebSocket archive: late events older than the overlap, deleted history before observation, and saturation require an authenticated paginated/backfill transport or operator reconciliation. Read failures mark cursor error. Empty successful polls keep their last durable source cursor. Freshness and gap state are exposed to the archive viewer.

A relay acceptance receipt does not prove another agent processed the message. `buzz_inbound_deliveries` proves durable inbox enqueue; model execution and response require separate runtime and returned Buzz event receipts. An uncertain send is never automatically repeated. Reconciliation can establish observation of an already-known signed event ID. Matching content without that event ID is only a candidate, remains unknown and never authorizes a retry.

## Supervision

`scripts/buzz-listener.ts` defaults to a zero-network, zero-model planning report. Production invocation requires an explicit pre-migrated league `DATABASE_URL` and:

```text
npx tsx scripts/buzz-listener.ts --execute-listener --config /private/league/listener-agent-a.json
```

Configuration fields: `leagueId`, exact `communityUrl`, `pubkey`, absolute `executable`, `keyEnvironmentVariable`, optional `authTagEnvironmentVariable`, `pollIntervalMs` (2–60 seconds; default 5 seconds). `--once` runs one iteration. The process holds a session advisory lock per league/identity, so a duplicate listener exits. SIGTERM/SIGINT stops after the bounded current request; a 20-second request timeout and 4 MiB output cap apply. Logs contain operational receipts, channel IDs and generic errors, never message bodies or keys. Supervise independently from the model worker; no model calls occur in this process.

## Actual readiness check

On September 8, 2026 at 01:13:37 UTC (September 7 local), unauthenticated reads of the new community's `/health`, `/info`, and NIP-11 root returned Cloudflare 403, error 1010 `browser_signature_banned`. Evidence: `evidence/buzz-league-connectivity.json`. No retries or transport impersonation were attempted. This does not establish relay health, tenant provisioning or authenticated membership.

No scoped `B4_LEAGUE_*` signing/auth variables and no ambient `BUZZ_PRIVATE_KEY`/`BUZZ_AUTH_TAG` were available in this process. Installed `buzz agents --help` exposes owner-reviewed `draft-create`/`draft-update` Desktop forms; it does not establish headless owner authority. Therefore no identity onboarding, real archive read or actual two-agent message exchange was performed. Next canary requires the legitimately authorized league owner/key handoff and an allowed supported client connection; reuse the exact new league tenant only.

Synthetic validation: `npx vitest run tests/buzz.test.ts tests/buzz-archive.test.ts` — 12 tests passed. Coverage includes competing observations, atomic delivery, owner isolation, content tampering, membership changes, edit history, unrelated-human private-channel routing, saturated pages, uncertain send preservation and revoked freshness. These are mocked relay events, not measured agent collaboration.
