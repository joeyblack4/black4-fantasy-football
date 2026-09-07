# Integration validation and remaining launch gates

Verified 2026-09-07. This is an early local build. No live league messages, paid data calls, community provisioning, production deployment, or account purchases were performed by this work.

## What now runs

- `src/data/index.ts`: replaceable feed contract; strict cumulative stat snapshot input; deterministic scoring using integer milli-points; explicitly missing fields produce `null` points; scoring-version receipts; optional defense points-allowed tiers.
- `StatsService`: PostgreSQL history and current projection, serialized per feed/game/player stream. Exact replay is a no-op; reused revision with different payload is rejected. Older deliveries are retained but never replace newer totals. Corrections replace cumulative totals; they are not added to the old score. New revisions with older source timestamps are rejected. Production adapters must establish real revision semantics before use.
- `data_events`: transactional change events written with applied snapshots. Dispatch integration still needs its own acknowledgement/cursor; this table alone does not wake agents.
- `src/data/fixtures.ts`: wholly synthetic player/game fixture and explicit synthetic feed. This is not real NFL data and must remain labeled in every demo.
- `src/data/rolling-insights.ts`: actual documented NFL HTTP request contract with injected fetch for deterministic tests. Live requests include no-cache headers and a timestamp cache buster. Query credentials and provider errors are not logged. Redirects are rejected. The client returns unnormalized payload evidence; it does not claim a verified NFL field mapper.
- `src/buzz/index.ts`: validated DM/send plans using argument arrays and stdin, trusted peer/membership checks, optional explicitly enabled CLI runner, key-to-actor binding, durable operation receipts. No execution happens on import or plan creation.
- Duplicate concurrent Buzz operations invoke the runner once. An interrupted or ambiguous attempt remains prepared/unknown and requires relay reconciliation; it is never automatically resent. Relay acceptance is not evidence of recipient wakeup or response.

Validation command: `npx vitest run tests/data.test.ts tests/buzz.test.ts`. Tests run against isolated PostgreSQL schemas using `tests/helpers.ts`; they do not touch Buzz or DataFeeds. Typecheck: `npx tsc --noEmit`.

## Live NFL data: current evidence

Planning provider: Rolling Insights DataFeeds NFL Live. Current official price page lists $600/month for NFL Live; four months costs $2,400 before fees/tax. Verify the dates required through postseason and actual checkout quote; do not assume a trial covers commercial launch. Paid-service terms permit commercial use of API outputs, but do not establish a right to redistribute the underlying paid feed as an open dataset.

Official evidence:

- [DataFeeds pricing](https://rolling-insights.com/datafeeds/price-plans/)
- [Terms of service](https://rolling-insights.com/terms-of-services/)
- [Vendor integration page](https://rolling-insights.com/datafeeds/datafeeds-sports-ai-skill/)
- [Official developer repository](https://github.com/Rolling-Insights/sports-datafeeds-by-rolling-insights-skill)
- [REST reference](https://github.com/Rolling-Insights/sports-datafeeds-by-rolling-insights-skill/blob/production/references/rest-api-reference.md)
- [NFL endpoint matrix](https://github.com/Rolling-Insights/sports-datafeeds-by-rolling-insights-skill/blob/production/references/sport-endpoints.md)
- [Payload shape notes](https://github.com/Rolling-Insights/sports-datafeeds-by-rolling-insights-skill/blob/production/references/sport-shapes.md)

The public REST reference establishes:

| Need                    | Documented request                                          |
| ----------------------- | ----------------------------------------------------------- |
| Base                    | `https://rest.datafeeds.rolling-insights.com/api/v1`        |
| Authentication          | Query parameter `RSC_token`, held only by trusted transport |
| NFL schedule            | `GET /schedule/YYYY-MM-DD/NFL`                              |
| Live game stats         | `GET /live/YYYY-MM-DD/NFL`                                  |
| Player identity catalog | `GET /player-info/NFL`                                      |
| Injuries                | `GET /injuries/NFL`                                         |
| Depth charts            | `GET /depth-charts/NFL`                                     |
| Play by play            | `GET /play-by-play/NFL?game_id=...`                         |

The public NFL shape notes only mention optional DraftKings fantasy fields. They do **not** establish the full player box-score layout, source revision identifier, correction behavior, inactive-versus-zero semantics, or precise update latency. The general `data` wrapper is documented; actual NFL items need inspection after authentication. Do not implement aliases guessed from other sports. Do not use vendor DraftKings points as the league's constitution score.

The NFL endpoint matrix documents injuries and depth charts. Existence does not prove fast injury reporting, so news latency must be measured independently.

### Data account/canary backlog for Joey

1. Create or authorize Black4's account at [API Locker](https://accounts.rolling-insights.com/register), retrieve an NFL-capable RSC token into a secret store, confirm paid commercial entitlement/quote and dates. No token in chat or git.
2. Read player-info and schedule with the trusted transport; record redacted endpoint/status receipts and field inventory. Catalog every draftable player and DST with unambiguous source-to-canonical identity. No fuzzy name matching at transaction time.
3. Retrieve one real NFL box-score payload and identify all supported constitution fields: passing/rushing/receiving yards and TDs, catches, interceptions thrown, fumbles lost, two-point conversions; kicker distance buckets and DST components if those roster positions are offered. Unknown fields block the corresponding rule choice.
4. Determine whether zero means a confirmed zero and how absent players are represented. Preserve null/absent until the provider semantics justify zero.
5. Establish source version or updated timestamp semantics. If none exists, poll serially per game with a durable locally assigned observation sequence and do not allow overlapping requests to reverse cumulative state. Record source timestamp separately from receipt timestamp; unknown source time must remain unknown in public latency reporting. The normalized schema accepts null sourceAt and returns unknown freshness alongside the snapshot. Never fill it with receipt time and call it source time.
6. Replay a real game's snapshots privately; independently verify sample offense/K/DST scores and a correction against the ratified scoring configuration. A final game may still receive a later stat correction; final in this build labels provider game state, not permanently locked fantasy standings.
7. Measure live-game freshness, rate limits, retry-after behavior, outages, postponed games and correction windows. Source failover requires an explicit canonical mapping and reconciliation, not an automatic mix of feeds.
8. Validate public display/data licensing scope and retention. Keep raw paid evidence in private storage; public demo fixtures remain synthetic.

## Buzz source findings

Read-only source inspected at `/Users/joey/.codex/worktrees/buzz-black4-anyone-access`. Its AGENTS, relevant vision documents and TESTING instructions were read. No Buzz code was modified. The installed CLI's `dms open --help` and `messages send --help` confirmed option names.

| Finding                                                                                                                                                                                                     | Source                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Multi-community provisioning uses `POST /operator/communities`, NIP-98 and deployment-level `RELAY_OPERATOR_PUBKEYS`; empty list disables it. `create_only:true` avoids owner rotation on an existing host. | `crates/buzz-relay/src/handlers/community_provisioning.rs`                                  |
| CLI programmatically opens DM with 1-8 other pubkeys (9 total), emits normalized event result and DM ID.                                                                                                    | `crates/buzz-cli/src/commands/dms.rs`                                                       |
| DM trigger gate accepts owner or cryptographically verified same-owner sibling. Explicit external allowlist and anyone modes do not bypass DM hardening.                                                    | `crates/buzz-acp/src/lib.rs`, `author_allowed`                                              |
| Runtime subscribes to membership notifications and discovers newly joined conversations.                                                                                                                    | `crates/buzz-acp/src/lib.rs`, `subscribe_membership_notifications`, dynamic membership loop |
| Runtime observer events exist but are owner scoped; no complete durable league audit viewer was established.                                                                                                | `crates/buzz-acp/src/observer.rs`                                                           |

Ten independent franchise signing identities can share one verified Black4 operator owner for the existing sibling DM policy. Football roster/budget authority is still independently enforced in our tools. The second human cannot trigger agent DMs under current hardening unless that human is the agent owner. Private negotiation channels with approved external-author allowlists are a supported alternative, or Buzz needs a specific externally approved peer-DM permission change. Never set `anyone` and assume this solves DM permissions.

Our Peer and channel membership inputs are **trusted, verified metadata contracts**, not proof verifiers. They must be populated by an authenticated registration/canary layer before production; never accept these fields in a model tool request. The local checks test league policy, not NIP-OA cryptographic verification.

### Second-community deployment canary

1. Verify deployed relay image supports multi-community provisioning, the operator key is authorized, the intended host/DNS/TLS routes to the shared relay, and `create_only:true` succeeds once with a read-back of the resulting tenant ID. A source capability is not a deployed permission.
2. Create two dedicated franchise identities and a human test identity inside that tenant; give them no customer credentials or channel access. Verify cross-community reads/writes fail.
3. Verify owner delegation cryptographically and register the trusted owner/peer metadata; launch two isolated runtimes with the same-model-only configuration and bounded budgets.
4. Owner A opens a new DM with B while B is already listening, sends one unique canary, and gets a B response without Joey participating. Collect opening event, send acceptance, membership discovery, inbound author decision, wakeup, response and consumption cost receipts.
5. Demonstrate the second human negotiation path. Test the current DM rejection and supported private-channel trigger deliberately; do not call human collaboration ready from agent-to-agent success.
6. Kill and restart B between receipt and response. Reconcile signed relay history and pending durable inbox events. Confirm one logical response, not a duplicate message.
7. Trigger one self-created appointment and one injury/news event with identical monitoring access; record source/receipt/queue/inference/action timestamps separately.
8. Establish private strategy archive with declared participant consent and delayed researcher access. The receipt table here stores operation metadata only; it does not secretly archive DMs. Capture actual authored events for screenshot cards rather than inventing reconstructed dialogue.

### Hosting choice

Use the existing relay deployment for another community if operator authority and host routing pass. Run league workers and PostgreSQL in an isolated service namespace with restart policy, persisted workspaces and restricted secret scope. Buzz presence reflects conversational availability, not a durable obligation queue. Do not depend on Joey's laptop or disable its sleep. A healthy worker must recover after host restart and service replacement.

## Existing fantasy platform check

Sleeper's [public API documentation](https://docs.sleeper.com/) is explicitly read-only. Yahoo's [developer documentation](https://sports.yahoo.com/developer/docs/) describes roster and transaction writes, but a supported live draft-pick mutation has not been established. MyFantasyLeague remains a plausible candidate: its [official developer announcement](https://myfantasyleague.wordpress.com/2008/08/06/developer-api/) supports read/write APIs, but current exhaustive write coverage was not verified by bounded research. No claim that all existing platforms are unsuitable is justified.

Keep custom-engine decision for instrumented API/MCP/CLI-first operations and open-source reuse, while treating scoring coverage and league correctness as actual engineering obligations. Do not switch to scraping an undocumented UI as the default integration.

## Open-source boundary

Ship original engine/runtime/adapters/tests, synthetic fixtures, local setup and replaceable provider contracts. Keep Black4 customer infrastructure, keys, private league negotiations and paid raw datasets out of the public repository. Calling Buzz as an external CLI avoids copying its implementation; review licenses before embedding upstream code. This research read vendor documents but did not install or execute the vendor skill scripts.

## Added league scoreboard and fast-reaction bridge

`src/scoring/index.ts` now joins the actual league's required lineup slots to mapped game snapshots and computes starter-only totals. Configuration requires a scoped commissioner, a ratified constitution, setup status, one matchup per team, valid canonical players and immutable season scoring rules. Exact configuration replay succeeds; changed configuration fails. Output carries constitution version, scoring version, configuration hash, every stat snapshot/revision, source/observation timestamps, synthetic labels and known subtotal separately from a complete score. Missing starter data, empty slots, stale live snapshots and unknown source time cannot produce a final matchup winner. Final provider game status remains revisable if a later correction arrives. A deterministic twelve-team round-robin generator is verified for eleven complete rounds and all 66 unique pairs.

Future active-season weeks can now be configured with the already frozen season scoring rules and feed, verified unstarted schedules, and complete matchup coverage. Current/past weeks cannot be introduced late. `addPlayerGameMapping` provides scoped commissioner additions/corrections with a reason, idempotency key, expected mapping version and durable before/after receipt. It requires independently imported future scheduled timing, refuses absent/postponed/bye/final/locked timing, and rejects any old or new game mapping with observed stat evidence. Its stream locks coordinate with ingestion so an observation cannot race this check. This command changes no roster or schedule records. A post-lock provider-ID error deliberately requires a separate exceptional reconciliation design; it cannot be silently rewritten here.

`src/data/dispatcher.ts` now bridges `data_events` to durable runtime inboxes. Owners can subscribe only the runtime identity bound to their persisted league/team/owner identity and only to a player cataloged in that league. Data-change events fan out only to enabled matching subscriptions, using stable `data-event:<event-id>` causal IDs. Repeated or concurrent delivery, including a crash after inbox insertion but before acknowledgement, creates one logical job. Downward corrections create another event. Unchanged cumulative stats refresh the latest observation without creating an event/model turn. The dispatcher is a callable component; a deployed supervision loop and production feed adapter remain to be wired.

The bridge transports metadata and snapshot references, not a licensed raw-data dump. Runtime job payloads explicitly retain synthetic status and separate source from observation time. Subscription history and delivery receipts persist. Current delivery receipts prove inbox enqueue, not completed model processing or a trade/lineup action; those require runtime and league action receipts.

The command `npx vitest run tests/data.test.ts tests/buzz.test.ts tests/scoring.test.ts tests/data-dispatcher.test.ts` passed 20 tests on isolated PostgreSQL schemas after this addition. Tests use synthetic data and a simulated Buzz runner; they prove no actual model or public network performance.

The constitutional vote now covers the scoring formula itself: governance proposals include validated ScoringRules, content hashes include those coefficients, and ratification persists the approved formula. Scoreboard configuration, exact configuration replay, and scoreboard reads all require that formula to match the ratified record. Legacy rows with no voted formula remain unresolved; migration does not invent historical votes.

## Existing-host follow-up — verified September 7, 2026

**MyFantasyLeague remains unresolved, not ruled out.** Its [official developer announcement](https://myfantasyleague.wordpress.com/2008/08/06/developer-api/) explicitly documents league exports and update/import APIs. Official replies describe live franchise scores and real-time NFL schedules, while distinguishing them from raw player statistics. This is historical evidence from 2008, not verification of the current contract. Attempts to retrieve [2026 API details](https://api.myfantasyleague.com/2026/api_info?STATE=details), the base API-info page and the current API landing page returned research-tool retrieval errors; those errors establish neither API availability nor absence.

| MFL requirement                                          | Current evidence                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Draft picks through supported API                        | Unknown: current authenticated endpoint/parameters and draft modes not verified                        |
| Set lineups                                              | Unknown: current endpoint and owner-scoped authentication not verified                                 |
| Waiver/FAAB submissions and cancellations                | Unknown: current endpoint, deadlines and bid semantics not verified                                    |
| Propose/accept/reject trades                             | Unknown: current endpoint, authority and trade lifecycle not verified                                  |
| Live league scores                                       | Historical official support; current response fields, refresh cadence and correction semantics unknown |
| Live raw player stats                                    | Historical official reply excluded raw stats; current capability unknown                               |
| Black4 public/commercial display and automated-agent use | Current terms and licensing unknown                                                                    |

A current MFL contract and a disposable test league could change the hosting decision: verify owner-scoped writes and read-back receipts for all four transaction families, plus score/correction access and commercial display rights, before concluding that a custom engine is necessary. No account, signup or authenticated request was made in this check.

**FantasyPros has an official MCP research integration.** Its [connection guide](https://support.fantasypros.com/hc/en-us/articles/55212611981851-How-do-I-connect-to-the-FantasyPros-MCP-Server), updated September 1, 2026, gives `https://api.fantasypros.com/mcp` with account OAuth. This is a viable optional research surface for franchises; league-specific functions require a supported league synced into FantasyPros.

The [official tool catalog](https://support.fantasypros.com/hc/en-us/articles/55238312588571-What-tools-are-available-in-the-FantasyPros-MCP-Server), also updated September 1, documents rankings, ADP, projections, player statistics, injuries, schedules, rosters and league analysis. Premium synced-league tools recommend start/sit choices, trades and waiver moves. No draft-pick submission, lineup mutation, waiver execution or trade execution tool is documented. `resync_league` refreshes rosters after a move on the host; `set_active_league` selects conversational context. Neither is a sports transaction. This catalog also does not establish a low-latency live box-score feed, correction contract or latency SLA.

FantasyPros' separate [API access policy](https://support.fantasypros.com/hc/en-us/articles/49749297704475-How-do-I-request-access-to-the-FantasyPros-API), updated August 5, 2026, reserves free access for nonproduction personal use and HOF production access for personal noncommercial applications. Business/organizational use and redistribution require a commercial agreement. Do not budget Black4's public experiment as a personal HOF API subscription or assume MCP account access grants public data redistribution rights. MCP business-use and publication scope must be confirmed separately. No FantasyPros connection or purchase was made.
