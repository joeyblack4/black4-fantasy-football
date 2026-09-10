# MyFantasyLeague API feasibility — September 7, 2026

**Update:** authenticated trial results now supersede the untested status in this initial document. See [MFL_TRIAL_RESULTS.md](MFL_TRIAL_RESULTS.md): core transactions passed, season readiness remains incomplete, no purchase or actual owner activation.

**Verdict: documented technical fit for a controlled trial; not yet an authenticated or public-launch approval.** Core owner actions and calculated live fantasy scores are documented. A separate raw NFL feed is not technically required to run this league and follow its fantasy matchups. Public redistribution permission remains unresolved because MFL's developer terms and general website terms use materially different language.

No account, purchase, external write, model call or founding-convention work was performed for this audit. Ten owners remain staged. Sources below were read from official public pages; original HTML is retained in ignored `.local/research/platform-selection/`.

## Price, scores and presentation

- The current homepage advertises a standard Custom league for **$109.95** and a no-card trial. This is the league service price, not a separate monthly raw-stat license. Verify the exact season/checkout total before payment. [Pricing](https://home.myfantasyleague.com/) · [Trial](https://home.myfantasyleague.com/get-started)
- MFL includes live scoring in its league features; its API access is described as free. `liveScoring` returns current franchise scores, game seconds remaining, players yet to play and players currently playing. `DETAILS=1` includes nonstarters. `playerScores` provides player fantasy totals for the selected league and week. These totals use the host's scoring system. [Feature list](https://php01.myfantasyleague.com/wp-new/feature-list/) · [API reference](https://api.myfantasyleague.com/2026/api_info?STATE=details)
- **Raw NFL player statistics and third-party player news are expressly excluded from API exports.** MFL's own website can display information its API cannot redistribute. A fantasy scoreboard can report a team's score increasing or a player adding fantasy points; that alone cannot establish the exact play, yards, touchdown type or injury that caused it. Rich play-by-play commentary and fast injury research are separate capabilities. [Developer terms](https://api.myfantasyleague.com/2026/api_info)
- The older official feature list describes roughly 90-second site scoring updates and a separate GameDay experience at roughly 30 seconds. These are product descriptions, **not a current API latency guarantee**. API docs give no fixed live-score update interval or service guarantee. Polling every 30–60 seconds is our proposed starting policy, subject to throttling; it does not make upstream data equally fresh.
- Actual NFL game score/status uses the documented static `fflnetdynamic2026/nfl_sched_<week>.json` path. Do not use `nflSchedule` to follow games in progress. Static schedule files are described separately as updated every 15 minutes in the reference; this is distinct from fantasy `liveScoring`. [FAQ 1135](https://api.myfantasyleague.com/2026/support?FAQ=1135)
- MFL can remain the football backend. The planned Black4 site can retain its own brand, team pages, conversations and matchup presentation. Do not iframe or recreate the whole MFL interface. Public score projection is technically possible but remains subject to the permission issue below.

## Required owner actions

All rows below establish documentation coverage, not passing authenticated tests. Source: [2026 request reference](https://api.myfantasyleague.com/2026/api_info?STATE=details).

| Owner capability                             | Documented operation                                                          | Important constraint                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Read rules, player pool, roster and schedule | `league`, `rules`, `players`, `rosters`, `freeAgents`, `schedule`, `calendar` | Cache static data; retain string IDs and leading zeros.                                                                       |
| Make current draft pick                      | `live_draft`, `CMD=DRAFT`, `PLAYER_PICK`, `FRANCHISE_PICK`, `ROUND`, `PICK`   | Commissioner franchise selection validates the current pick; it cannot move the pick to a different owner/round.              |
| Set lineup                                   | `import TYPE=lineup`, `FRANCHISE_ID`, week, starters                          | Test locks and eligibility under commissioner impersonation.                                                                  |
| Add/drop free agents                         | `fcfsWaiver`, `FRANCHISE_ID`                                                  | Test acquisition windows, roster limits and competing claims.                                                                 |
| Standard waiver requests                     | `waiverRequest`, `FRANCHISE_ID`                                               | Default appends; explicit replace or empty-round clear changes semantics.                                                     |
| FAAB submit/edit/cancel                      | `blindBidWaiverRequest`, `FRANCHISE_ID`                                       | Conditional rounds differ; `REPLACE` replaces, empty `PICKS` clears the round.                                                |
| Offer a trade                                | `tradeProposal`, `FRANCHISE_ID`                                               | Counterparty, offered/received assets and expiry are explicit.                                                                |
| Accept/reject/revoke trade                   | `tradeResponse`, `FRANCHISE_ID`, `TRADE_ID`                                   | Recipient accepts/rejects; originator revokes. Both decisions need genuine owner receipts.                                    |
| IR moves if included in rules                | `ir`, `FRANCHISE_ID`                                                          | Do not offer until trial verifies league settings and eligibility.                                                            |
| Team name and image metadata                 | Commissioner `franchises` import                                              | Use `OVERLAY=1`; restrict our wrapper to approved own-franchise presentation fields. Never overwrite contacts or permissions. |
| Matchup/season results                       | `liveScoring`, `weeklyResults`, `leagueStandings`, playoff exports            | Preserve corrections and unknown values; no double-counting cumulative snapshots.                                             |

The native private draft-list, watchlist, trade-bait and poll-vote operations do **not** document equivalent commissioner franchise selection. They need not block launch: owner-authored queues and watches remain in Black4; negotiations and governance remain in Buzz/Black4. Do not claim all MFL owner features are covered by one credential.

Scoring and roster choices can be verified through exported rules/settings. This audit did not establish an API for every commissioner setup screen. Apply supported ratified choices through the operator UI where necessary, then read back and hash the actual host configuration. Do not start the constitution until the platform checkpoint clears.

## Draft timing and session architecture

The ordinary `draftResults` export may lag up to 15 minutes and is unsuitable as the draft-turn clock. MFL explicitly documents live draft files on the league's actual host:

- `/fflnetdynamic2026/<league>_LEAGUE_draft_results.xml`
- `/fflnetdynamic2026/<league>_LEAGUE_draft_status.xml`

Its live-draft guide recommends polling about every five seconds and says these static requests do not count toward the API limits. Status may initially return 404. Use the correct league host; static files do not redirect. [FAQ 935](https://api.myfantasyleague.com/2026/support?FAQ=935)

Never use the bulk `draftResults` import for individual picks: it replaces draft results. Commissioner pause/resume/skip/undo remain operator-only, not owner tools. Verify timeout behavior so MFL never substitutes a house ranking for an exhausted owner queue.

One protected commissioner login supports all core owner writes above. Ten AI email accounts and continuously open browser sessions are **not structurally required** by the docs. Authentication is HTTPS POST login followed by the protected `MFL_USER_ID` cookie. The export API key cannot authorize writes or commissioner requests. Actual session lifetime and renewal still need trial evidence. [Authentication and limits](https://api.myfantasyleague.com/2026/api_info)

Our trusted connector must map the authenticated Black4 franchise to a fixed MFL franchise ID. Never accept an arbitrary target identity from model text. Models receive neither the cookie nor a generic commissioner request tool. Commissioner exports can contain owner contact details and everyone's pending transactions; project each owner's permitted fields before tool delivery.

Use one shared read collector, cache unchanged results, and deliver common snapshots to owners and the approved public projection. Do not multiply polling by ten owners or visitor count. API limits vary by IP/host; optional self-service client registration and SMS verification raise limits, without a documented sales gate. Back off on 429s.

No provider idempotency keys or conditional-write guarantees were found. Persist and serialize intents, then reconcile uncertain responses against pending requests, transactions and rosters. Never blindly resend an ambiguous trade offer or appended waiver request. A commissioner credential may bypass ordinary owner restrictions; test and enforce owner-equivalent rules rather than assuming impersonation automatically ensures fairness.

## Public display permission: unresolved

The [developer page](https://api.myfantasyleague.com/2026/api_info) grants broad free data use subject to listed restrictions. The [general terms](https://home.myfantasyleague.com/terms.html), effective June 1, 2024, restrict their defined Material to personal/noncommercial use and restrict third-party website distribution without prior written consent. The documents do not clearly resolve how those provisions apply to our sponsored Black4 presentation of our own league's calculated scores.

This is a concrete conflict in published wording, not a finding that MFL charges extra for a live-score API, and not proof that publishing our league scores is prohibited. Do not represent commercial republication as verified. No commercial discussion or permission request has been initiated. If public permission cannot be established from an applicable existing grant, keep MFL-hosted score viewing as a possible temporary path for Joey to assess; do not silently replace the requested Black4 live scoreboard with that compromise.

## Trial acceptance and decision

1. Create a disposable private Custom league under an authorized commissioner identity; confirm included live scoring and checkout term without payment.
2. Bind two test franchises through the single connector. Perform draft, lineup, add/drop, FAAB create/replace/clear, and offer/accept/reject/revoke trades. Independently read back every outcome.
3. Reject another franchise's target, late/wrong-turn draft pick, locked player move, excess FAAB, illegal roster and unauthorized trade response. Confirm no commissioner overrides silently permit them.
4. Simulate process restart and lost response; demonstrate reconciliation without duplicate transactions. Test expired-session handling and rate-limit backoff.
5. Inspect league and player fantasy-score payloads against the host UI, including completed-week totals and corrections. Observe a real live game before claiming measured latency; preseason/offseason payload reads cannot prove live behavior.
6. Verify live draft files and mobile human access. Test a timeout with only owner-authored queues and pause on exhaustion.
7. Resolve the public-display permission question before publishing an external MFL score feed.

The API coverage supports proceeding to this trial. The remaining questions are behavior under authenticated permissions, measured data freshness and publication scope—not missing basic draft/trade/lineup endpoints. Until those are resolved, MFL remains the leading candidate, not an activated dependency.
