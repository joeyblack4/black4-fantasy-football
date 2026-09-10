# MFL authenticated trial results

September 7, 2026 Pacific (September 8 UTC). Disposable league **46625**, host **www43**, season **2026**. [Trial home](https://www43.myfantasyleague.com/2026/home/46625).

**Recommendation: continue with MFL as the leading integration path, still unpaid. Core franchise transactions passed. Full season readiness has not passed.** Actual live scoring, automated waiver awards, session renewal, the human phone flow and complete schedule configuration remain open checks. Keep the founding convention paused until the supported host rules and remaining pre-convention tests are reviewed.

## What actually ran

One commissioner account authenticated through MFL's documented HTTPS POST login. Its session was used by a local, league-bound API helper. Eleven of the twelve placeholder franchises have no linked external user accounts. Those unclaimed franchises successfully drafted, submitted lineups, acquired players and traded through explicit franchise-targeted API operations.

This establishes that **ten separate MFL accounts or persistent owner browsers are unnecessary for the tested commissioner-delegated path**. It does not establish that owners have individually authenticated with MFL. Native transaction attribution can say commissioner; Black4 must retain the actual model owner's signed decision and action receipt.

All decisions were scripted synthetic fixtures. No model inference, owner naming, governance, paid subscription, public publication or actual league activation occurred. FAAB was fictional currency, not an operating-wallet expense.

## Acceptance evidence

Private receipts are in ignored `.local/mfl/receipts.jsonl`, keyed by UUID; raw response artifacts remain private. These are authenticated integration tests, not agent behavior.

| Test                         | Actual outcome                                                                                                                                                      | Selected receipt                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Complete live draft          | 192 successful picks across twelve franchises; final read contained sixteen players per franchise and 192 unique player IDs                                         | Final pick `8d1434cf-a9b0-4c68-b0c6-52f251401419`; roster audit `a93777f6-8b7d-4d0c-aab8-b9c768df3b12`                 |
| Wrong turn / old pick replay | Both rejected; no replacement pick applied                                                                                                                          | `cbb2ab2d-ec73-43fa-af0e-c5d04d599422`, `e7ccc8cb-b843-4317-b6be-d681e51ab287`                                         |
| Lineups                      | Two unclaimed franchises submitted valid eight-player lineups; weeklyResults independently confirmed starter IDs                                                    | Final post-trade read `e581d091-26ed-424f-a531-eb1f69cdeb50`                                                           |
| Invalid lineup               | Unowned player and invalid position/count submission rejected                                                                                                       | `1b3cc54b-707b-4f41-bc0b-afafb30c4b43`                                                                                 |
| FCFS add/drop                | Franchise 0002 added 9064 and dropped 16809; independent roster read confirmed both changes                                                                         | `1cbce475-d294-4dc2-995f-20ff89f830ce`, `ac34307b-3019-4577-a94a-92664debdb62`                                         |
| Duplicate acquisition        | Franchise 0003 could not acquire the already-owned player; its roster remained intact                                                                               | `057e7386-f1bb-47fd-9c68-aeb61e3febad`, `a75f8040-25f2-4162-82b8-0b544e49c4e9`                                         |
| Dropped-player hold          | Immediate FCFS acquisition of the recently dropped player rejected as locked                                                                                        | `69823835-f23e-46ac-b3cc-8ed027b0fefb`                                                                                 |
| FAAB create/edit/cancel      | Bid 7 created, replaced by 9, independently read, then canceled                                                                                                     | `884ca9f6-3a08-4e57-9ead-a1414b16f9b6`, `66e94410-8645-428b-b09e-46b3c9fd0cd1`, `2932df0b-c613-4e97-9892-d37c33f67321` |
| FAAB budget guard            | Bid 101 rejected against balance 100; previous bid 9 remained intact                                                                                                | `4890bd10-0fb1-462b-af2f-51e4f0d248cb`, `e2c29374-f640-413e-9cf8-e88efa4a024e`                                         |
| Private bid selection        | Reads for the targeted franchise returned its own pending request; other tested franchises returned empty, and later competing bids returned their distinct amounts | `0d7d0c8a-ce70-4ee0-b1bd-e2bc7d807db6`, `cf36980a-858b-4ad3-9ef3-396f47506169`                                         |
| Trade offer and accept       | Trade 1001 swapped 13589 and 17466 between 0011 and 0002; no further commissioner approval with this configuration                                                  | `730b4dfd-fe7b-4b9c-8ad2-9ccdc766887c`, `129348b0-9d74-4ea8-98f0-602ec00fc8a5`, `ebdf5259-d790-4279-af6e-422040748ae0` |
| Unauthorized trade response  | Third franchise 0003 could not accept the offer                                                                                                                     | `8cb7647a-2853-4fdd-87cc-d25206bdb90c`                                                                                 |
| Reject / revoke trade        | Recipient rejected 1002; originator revoked 1003; final pending-trade read empty                                                                                    | `de82dd01-9c18-4adb-adc2-eeff0a4aeb7c`, `a291a80f-c651-4271-bf96-941e78f0e274`, `a6d89a02-db68-4637-80f7-8bc91abac70c` |
| Scoring configuration        | Actual PPR rules exported, including yardage/TD/interception multipliers                                                                                            | `ab95063f-55bf-4144-88ae-325706695801`                                                                                 |

The duplicate acquisition test was sequential, not a simultaneous race test. Invalid pregame lineups are not proof of enforcement after kickoff. The complete draft did not test timed owner queues or AI responses: its timer was intentionally disabled and picks were scripted.

## Waiver processing: remaining gate

Two competing requests for player 7836 were submitted: Franchise 0002 bid 7/drop 17082; Franchise 0003 bid 11/drop 16806. The native **Manually Process Waivers** page displayed both requests and preselected the 11 bid. This was a commissioner review form, not proof of an unattended auction solver.

Clicking Process Blind Bids opened a confirmation. The confirmation attempt timed out in browser control (`Emulation.setFocusEmulationEnabled`); subsequent Chrome reconnection also failed. We did not repeat the write. Independent reads showed player 7836 unowned, both bids still pending and balances still 100. Thus **no award or winning-budget deduction was verified**.

Both requests were then canceled through the API. At 04:31:57–58 UTC, both pending-bid reads were empty (`d999e493-a3d8-48d7-af4d-4cfc9afca3a7`, `1f6adef3-e7d0-43e5-b1df-ed491bd7a05b`). Final roster read `a4f20f80-b85f-4d44-b6fe-61e15427c872` still had sixteen players per franchise and no owner of 7836. Do not confirm an old browser waiver form: reopen it against fresh requests for the next test.

Automatic waiver processing remains **No** in this disposable test league. All players are globally locked after the controlled FAAB-window setup, and recently dropped players also have individual holds. The successful FCFS test used a preceding explicit global unlock. These are test fixtures, not proposed real-league defaults. Complete a scheduled award test, verify the winning debit and losing balance, and verify the configured unlock/relock cycle before calling acquisitions unattended.

## Data and scoring conclusion

MFL documents calculated league fantasy scores through `liveScoring`, `playerScores` and `weeklyResults`. That supports a league matchup board without purchasing a separate raw NFL feed. Raw NFL statistics and third-party news are not exported through this API; independent research subscriptions are a separate concern. See the [official API overview](https://api.myfantasyleague.com/2026/api_info) and [request reference](https://api.myfantasyleague.com/2026/api_info?STATE=details).

The actual trial returned **live scoring unavailable until the season starts**. An authenticated 2025 week-one request returned empty scores with `isAvailable=0`; it did not provide historical replay. We have not measured live latency, score corrections, player locks at kickoff or recovery after interrupted live polling. A 30–60 second local poll would not guarantee a 30–60 second upstream update.

The [current purchase page](https://home.myfantasyleague.com/purchase/) lists Custom at **$109.95** and a free trial extending into the regular season. We can observe the opening game before purchase; check the trial's exact payment deadline in the account. No payment has been made.

## Adapter requirements learned from the trial

1. Bind the authenticated Black4 franchise to a fixed MFL franchise ID in trusted code. Models cannot supply commissioner credentials, change league IDs or select another franchise. A server-side commissioner session has broader authority than any model should receive.
2. Give every model the same narrow football tools. The model chooses football actions; deterministic code handles HTTP, formats, authentication and receipts. No browser skill advantage is needed for these tested actions.
3. Retain leading zeros in IDs. Normalize singleton-versus-array JSON shapes. Imports can return XML despite JSON=1; HTTP 200 can contain an application error. Parse before acknowledging success.
4. Read lineups through weeklyResults; roster status ROSTER does not establish starter selection. Read back trades, bids and acquisitions from their appropriate authority before reporting completion.
5. Draft live state comes from the documented fast static draft file; delayed draftResults cannot be used as the current turn clock. Reconcile round/pick/franchise before submission; do not use destructive bulk draft imports for individual picks.
6. The `abilities` request for F=0002 returned effective franchise 0001. Do not trust that endpoint as a franchise-specific permission grant until resolved. Tested targeted write/read receipts, not a supplied parameter alone, establish scope.
7. Commissioner private reads can access pending bids; project only the requesting owner's data into model tools. MFL's privacy toggles do not hide all endpoints: populated rosters remain publicly readable. Keep strategy, private conversations and credentials in Black4 storage. See [data/privacy evidence](MFL_DATA_VALIDATION.md).
8. Persist an intent before each external write; on timeout reconcile authoritative state before any retry. Current trial receipts are a local journal, not proof that the production queue/outage handling is integrated.
9. Cache common data and throttle centrally. MFL documents variable unregistered limits and optional client registration for higher limits. Twelve franchises and the public site should share cached reads. Never put private keys in public page URLs or call MFL directly from the public browser.
10. Test session expiry and reauthentication. The saved cookie worked across fresh processes; password was discarded. This is not yet unattended seasonal credential renewal. The temporary local login server was shut down after validation.

## Platform comparison

| Choice                          | Evidence and work remaining                                                                                                                                                                                                                                                       | Recommendation                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| MFL + common API connector      | Real draft, lineup, add/drop, FAAB-request and trade paths passed with one account. Bundled calculated scores documented; live behavior and scheduled awards remain unverified. Need production adapter, cache/event polling, authentication recovery and host configuration.     | Preferred path; remain on the free trial through the remaining checks.                                                       |
| Our engine + cheaper data       | Existing mechanics are substantial, but feed mapping, pre-draft scoring gate, recurring weekly operations, standings and playoffs remain work. A $39.99/month feed is a candidate, not verified field coverage or a finished league.                                              | Fallback if hosted gates fail; materially more season-engine responsibility. See [source audit](CUSTOM_ENGINE_READINESS.md). |
| Yahoo / ESPN browser automation | No authenticated unattended write trial passed. Yahoo's current application page says read access only; older write examples do not establish new write access. Browser fallback needs owner sessions or proven delegation, reauth, durable intent/read-back and DOM maintenance. | Least attractive under this deadline. A shared browser driver could equalize model access, but adds operational fragility.   |

Yahoo source: [current developer access](https://sports.yahoo.com/developer/access/), fetched and retained privately. No Yahoo/ESPN account or league was created in this evaluation.

## Next gates before real owners begin

- [ ] Reconnect Chrome, reopen the trial's current state, finish a scheduled FAAB processing/debit test and acquisition-window cycle. No pending test bids should be carried forward accidentally.
- [ ] Configure and validate a disposable head-to-head schedule; inspect standings/playoff/correction options and turn only supported choices into the constitution menu. The trial still flags its schedule as invalid/unselected.
- [ ] Exercise Joey's and Chris's ordinary owner access on phones. Chris has not been invited or authenticated. Rehearse human/agent trades through the intended common interface.
- [ ] Integrate the proven endpoint contracts into the trusted harness and durable action queue; test model-to-franchise isolation, expired sessions, unknown writes and recovery. Keep actual model owners paused until the agreed checkpoint.
- [ ] During the opening live game, measure available scoring snapshots, source age, score changes, corrections and game-time lock behavior. Unavailable scores remain UNKNOWN.
- [ ] Review the final host-compatible rules and readiness evidence with Joey before commencing the founding convention. Do not present these disposable choices as owner-ratified rules.

MFL supplies football state and league operations. Black4 still supplies model/harness identity, persistent wakeups, Buzz collaboration, budgets, human controls, public brand and research evidence. Selecting MFL does not by itself make an owner continuously operational.
