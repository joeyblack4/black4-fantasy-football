# MFL trial: data and privacy validation

**Scope:** disposable 2026 league **46625**, `www43.myfantasyleague.com`, twelve placeholder franchises. September 8, 2026 UTC. Independent checks used no cookie, API key, account credentials, browser session or write endpoint. Authenticated observations below were read from the coordinating task's existing private receipts. No other league was queried.

## Observed boundary

The coordinating task saved and reopened both native settings at `csetup?L=46625&C=REPSEC`:

- “Prevent non-league members from accessing league?” — Yes (`ADULT_CONTENT_Yes`).
- “Prevent non-league members access to league reports?” — Yes (`PRIVATE_Yes`).

| Observation time (UTC)               | Unauthenticated read                                                                                | Actual result                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 04:06:38, coordinating task receipt  | `export?TYPE=league&L=46625&JSON=1`                                                                 | HTTP 200; league configuration and twelve placeholder franchise IDs/names/waiver ordering. Returned franchise records did not contain owner names/email addresses. |
| 04:06:39, coordinating task receipt  | `export?TYPE=rosters&L=46625&JSON=1`                                                                | HTTP 200; twelve empty roster shells. The later independent populated-roster check below establishes public roster visibility.                                     |
| 04:06:39, coordinating task receipt  | `export?TYPE=liveScoring&L=46625&JSON=1`                                                            | HTTP 200 with application error: live scoring unavailable until the season starts. No usable score observation.                                                    |
| 04:10:09–04:10:14, independent check | `pendingWaivers`; `transactions&COUNT=1`; `weeklyResults&W=1`; `playerScores&YEAR=2025&W=1&COUNT=1` | Every request returned HTTP 200 with an application-level login-required error. No pending claims, transactions, results or player scores were returned.           |
| 04:10:32, independent check          | `/2026/home/46625`                                                                                  | Redirected to this league's login page.                                                                                                                            |

At **04:18:02.129957 UTC**, one additional anonymous read of `export?TYPE=rosters&L=46625&FRANCHISE=0011&JSON=1` returned Franchise `0011` with players `13589`, `14319` and `16594`, all status `ROSTER`. Player `13589` is the coordinating task's drafted Josh Allen pick, independently confirmed by its draft/static-file/roster read-back. **Populated roster contents are public despite both privacy settings.** This observation occurred during a scripted disposable draft fixture, not agent/model activity. Receipt: `.local/research/platform-selection/mfl-trial-46625-populated-roster-public.json`.

Evidence: `.local/research/platform-selection/mfl-trial-46625-read-check.json` and `mfl-trial-46625-privacy-check.json` in the same directory. The independent receipt records request URLs, retrieval times, response hashes and sanitized error summaries.

**Interpretation:** the settings are effective for the homepage and tested protected reports. They do not make every API endpoint confidential. The [official request reference](https://api.myfantasyleague.com/2026/api_info?STATE=details) marks transactions, pending waivers and scoring reports as restricted, while the league, rosters and liveScoring entries lack that private-league restriction annotation. This explains the observed distinction at the documented endpoint-contract level; no MFL backend implementation was inspected. Do not claim an exact internal cause or a complete privacy audit.

`Cache-Control: private` in the coordinating task's responses is a cache instruction, not evidence that authentication was required. Our adapter must inspect the response envelope for `error` even when HTTP status is 200. Unavailable or denied scores remain **UNKNOWN**, never zero.

## Historical scoring replay

The request reference documents `playerScores` with a separate `YEAR` argument and week/player/count filters. A minimal authorized next read is the current trial's endpoint:

`https://www43.myfantasyleague.com/2026/export?TYPE=playerScores&L=46625&JSON=1&YEAR=2025&W=1&COUNT=1`

The unauthenticated attempt was denied. A subsequent authenticated request for the same league/year/week and `PLAYERS=13589,13116` completed at **04:17:22.072259 UTC**. Both player entries had `score:""` and `isAvailable:"0"`. Private receipt `99578185-6b66-4285-a917-e0d843efcba5` in `.local/mfl/receipts.jsonl` records the actual HTTP 200 payload. **This candidate did not produce a usable historical replay.** Missing scores remain UNKNOWN; the endpoint's documented YEAR capability alone does not establish available historical results in this new trial. The cause of unavailable values was not established. This request keeps the trial's current league context. Do not substitute `/2025/...L=46625`, which could identify someone else's historical league.

The `RULES` recalculation option is documented only for the current year and current week. Consequently, historical values must not be represented as independently recalculated under a newly edited trial scoring system without further evidence. `weeklyResults&W=YTD` is also documented for authorized historical leagues, but this new trial's exported history contains only 2026.

If a different, explicitly authorized historical source later returns available scores, it can supply a clearly labeled **historical final-score replay** for parsing, player mapping and displayed totals. A single historical snapshot cannot prove live update latency, event order, recovery from feed interruption or stat-correction handling. Those require an actual in-progress observation stream or explicitly synthetic correction fixtures. MFL does not provide raw NFL player stats through this API under its [general API terms](https://api.myfantasyleague.com/2026/api_info).

## Authenticated scoring rules and identity caveat

The coordinating task's `rules` export completed at **04:17:23.345613 UTC** with an actual scoring payload (receipt `ab95063f-55bf-4144-88ae-325706695801`). It includes reception event `CC`, multiplier `*1`, range `0-99`, consistent with the configured PPR trial, plus offensive and defense rules. A returned rules document verifies configuration data, not usable historical/live scores or ratification of the eventual league constitution.

The authenticated `abilities` request with `F=0002&DETAILS=1` completed at **04:17:24.610963 UTC**, but returned `abilities.franchise.id="0001"` (receipt `6bba212e-8a40-44f5-a240-3a375e66e41d`). The request reference documents `F` selection for commissioners and says owners' requests ignore it. **Requested identity is not proof of effective identity.** This mismatch is not proof that Franchise 0002's abilities were checked, nor does it alone identify whether the cause is session context or endpoint behavior. Enforce returned franchise identity and independently verified write/read-back targets before granting delegated actions.

## Remaining acceptance checks

- Treat roster player IDs/statuses as public host data; the anonymous populated-roster check is complete. Do not rely on MFL's privacy toggles to hide a franchise roster.
- Verify authenticated pending-data reads and enforce franchise-specific projections; a commissioner connection must never expose other franchises' pending bids to an owner model.
- Resolve the `abilities` target mismatch before treating that endpoint as a delegated permission check.
- Obtain a separately authorized available historical dataset and verify season/week, scoring basis and player mapping before calling replay usable. The tested YEAR=2025 candidate is unavailable.
- Observe actual live changes and corrections before claiming live scoring integration verified. No inference, background owner work, publication or production league activation follows from this receipt.
