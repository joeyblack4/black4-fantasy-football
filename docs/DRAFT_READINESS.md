# Native draft readiness

Readiness checkpoint, September 8, 2026, 21:10 UTC. Production settings have independent readbacks below; the complete draft path is not yet declared ready. Latest commissioner instruction: do not launch drafting in Buzz. Report readiness to Joey; Joey will launch it. This supersedes the earlier conditional automatic-start authorization. The canonical adopted package is [SEASON_RULES.md](SEASON_RULES.md): proposal `b4-deepseek-r9-core-v1`, SHA-256 `ba012abf75403f7acf95b85201c74cf2c56651aa5806a06c4670aeef8676b8e4`, decision `87a2929b-a327-45c8-98cd-699b518d5eb8`, eleven authenticated YES votes. Changes made during cutover require a fresh readback rather than relying on this inventory.

## Production restoration and owner mapping

The adopted record belongs to rehearsal 46625/host version2. Production is 2026 MFL62282 at www43.myfantasyleague.com. Fresh authenticated exports now verify native franchise0002 as MiniMax, all eleven owner-selected profiles and the adopted draft order. Initial local deployment inspection found the old vacant-slot mapping and writesEnabled=false; that dated file observation is not a claim about the current container. Verify the actual mounted deployment, API host binding and owner credentials agree after restoration.

Required production mapping (franchise IDs are not draft positions):

| Native franchise | Owner/team suffix                     |
| ---------------- | ------------------------------------- |
| 0001             | joey                                  |
| 0002             | minimax — replaces human-2-unassigned |
| 0003             | openai                                |
| 0004             | anthropic                             |
| 0005             | google                                |
| 0006             | xai                                   |
| 0007             | meta                                  |
| 0008             | deepseek                              |
| 0009             | qwen                                  |
| 0010             | mistral                               |
| 0011             | kimi                                  |
| 0012             | zai                                   |

MiniMax occupies draft position4 in the adopted teamOrder while retaining native franchise0002. Restore through a new host-binding version and exact-content governance validation; do not edit historical host identity or replay rehearsal picks.

## Existing implementation and checks

- Full direct owner tools are registered in `src/mcp.ts`: football_host, mfl_read, mfl_command, mfl_reconcile. Existing `./black4 mcp` launches them with that owner's credential. Plain CLI me/state commands prove identity/binding, not actual MFL read or draft submission.
- Native owner MFL reads use POST `/v1/football/read` with the read query; actions use `/v1/football/commands`; reconciliation uses the original idempotency key and never resubmits. Credentials remain in `.local/native-league/` and `.local/live/mfl/`, never in shared workspaces.
- The players read is a catalog, not available-player filtering or rankings. Combine eligible positions with fresh draft picks/rosters before selecting. A native draft action rechecks live draft mode, turn, owner and player availability.
- The adapter preserves uncertain outcomes and blocks conflicting new submissions. Inspect/reconcile the historical Mistral rehearsal unknown under its original scope; never move that intent into production.
- Native draft admission now shares league7044 with pause/resume, then journal7066. Held, unobserved, paused, stopped, completed or mismatched native observer state blocks a new pick. Existing same-key receipts and read-only reconciliation remain accessible. Resume requires a fresh observation. API callers reuse their existing league lock to avoid nested-connection deadlocks.
- Observer delivery, commissioner pause/resume and production deployment are separate work. Prove that the observer addresses the current owner through Buzz and does not launch the retired generic worker. Prove Joey's human turn waits for his native pick.

Safe local inspection commands:

```sh
node scripts/native-league.mjs b4-openai me
node scripts/native-league.mjs b4-openai state
node scripts/migrate-native-workspaces.mjs --verify
npm test -- tests/mfl-adapter.test.ts tests/mfl-native-admission.test.ts tests/mfl-http.test.ts
```

The first two are authenticated Black4 reads; they do not certify fresh MFL configuration. Use the owner MCP mfl_read queries `rules`, `draft`, `rosters`, `players`, and `budget` after production restoration and retain sanitized receipts.

## Reusable production configuration code

Private scripts in `.local/live/mfl/`: `prepare-production-plan.ts`, `production-settings.ts`, `production-complex-settings.ts`, `production-plan-core.ts`, `production-writer-core.ts`, `production-complex-writer-core.ts`, and independent form/readback parsers. Their help modes describe preparation or one-section execution. Do not invoke execute while inspecting.

These scripts are historical implementations, not a ready current plan: they hardcode the old proposal/decision/hash/epoch, restored host version3, original votes and original owner/manifests. They must consume the newly approved package and current twelve-owner mapping before use. Reuse field translators and independent readback checks; never bypass validation by editing historical receipts. No reset, START or player selection is part of settings application.

## Rules-versus-MFL evidence template

For each row record: adopted option ID and exact text/hash; native form/export and field values; observed timestamp; independent readback receipt/hash; status MATCH, MISMATCH or NOT VERIFIED. Split configuration from later draft release. Do not substitute menu defaults for saved native settings.

| Rule dimension      | Required evidence                                                                      |
| ------------------- | -------------------------------------------------------------------------------------- |
| Format              | Twelve franchises, one division, redraft                                               |
| Roster size         | 16 active, no IR/taxi; 16 draft rounds                                                 |
| Lineup shape        | Total9 and exact QB/RB/WR/TE/PK/Def min/max                                            |
| Lineup behavior     | Individual kickoff lock, carry-forward, no best ball or automated starters             |
| PPR scoring         | Every scoring category, range and rate equals adopted native package                   |
| Corrections/ties    | Weeks1–17, two decimals, Thursday corrections, regular ties; playoff manual resolution |
| Draft order         | Exact adopted twelve-team snake, MiniMax position4, even rounds reversed               |
| Draft operation     | Live draft; native timer off; no automatic fallback/ADP picks                          |
| Waiver mode         | Adopted locked-player blind bidding and FCFS windows                                   |
| FAAB                | Fictional100, minimum0, increment1 and exact debit/bid settings                        |
| Waiver tie priority | Native longest time since a won bid                                                    |
| Trades              | Immediate acceptance, roster validity and seven-day expiry                             |
| Trade deadline      | Actual native Week11 kickoff event and date/time                                       |
| Schedule/playoffs   | 1_1_12_14-c weeks1–14; six-team fixed bracket weeks15–17                               |
| Standings           | Exact ordered tiebreakers and adopted residual-tie procedure                           |

Owner incentives and prospective governance clauses are recorded policies, not invented MFL scoring fields. Verify the exact fifteen selected menu IDs against the canonical proposal, then separately map any grouped application sections.

## Release checklist

- [ ] Formal commissioner approval and production restoration receipts reference the adopted package.
- [ ] Deployed configuration, session scope, host binding and all twelve owner mappings agree.
- [ ] Fresh production reads verify empty pre-draft state, rules, schedule, bracket and timers; no stale trial data.
- [ ] All eleven native owners can read their production team, draft, players and rules through their own credential.
- [ ] Native turn delivery, human turn handling, pause/resume, no duplicate wake/pick and unknown-outcome reconciliation pass meaningful checks.
- [ ] Readiness checks pass, report them to Joey, and wait for Joey to launch. Settings application alone does not start drafting.

## Independent production readback — September 8, 21:09 UTC

Authenticated GET exports from production62282 were saved with hashes in `.local/draft-readiness/20260908T210837Z/manifest.json`; compact comparison is its sibling `comparison.json`. Zero native mutations were made by this audit.

Verified: all192 unique scheduled slots follow the exact adopted16-round snake; zero actual picks; twelve empty rosters; all11 AI names and logo/icon URLs match the current branding map; exact28-rule PPR; roster16 and exact nine-player lineup limits; exact84-game schedule matrix; fixed six-team Founders Cup bracket in weeks15–17; and native No Trades Allowed event from symbolic Week11 kickoff with no end/recurrence. FAAB100/increment1 are exported; minimum0 is not exposed in these exports, but the commissioner reported its native form save/readback. xAI's current display includes its model suffix.

These results supersede the initial21:05 snapshot differences. They do not establish draft release, active application binding, owner API mapping or Buzz on-clock delivery; those remain separate checks. Other native-only settings need their saved form readbacks.

## Current rules versus native MFL

| Area                             | Current evidence                                                                                                                                                                    | Result / remaining evidence                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Names, logos, owner slots        | Independent21:08 export: eleven names and both icon/logo URLs match the branding map; MiniMax0002                                                                                   | MATCH; Joey's display unchanged                                                                |
| Snake draft                      | Independent21:08 export:192 unique slots,16 rounds, exact adopted round1/reversed even rounds;0 actual picks                                                                        | MATCH                                                                                          |
| Draft mode/timer                 | Independent league export: live/live_draft and timerOFF                                                                                                                             | MATCH; operator retains stall handling                                                         |
| Rosters/lineups                  | Independent export: roster16,IR0,taxi0,total9 and exact min/max                                                                                                                     | MATCH                                                                                          |
| Scoring                          | Independent pure validator: exact28-rule native PPR, no additions; league weeks1–17,precision2                                                                                      | MATCH                                                                                          |
| Schedule/bracket                 | Independent84-game matrix equals1_1_12_14-c candidate; six-team fixed Founders Cup rounds15–17                                                                                      | MATCH; commissioner separately reported saved package selector                                 |
| Standings                        | Independent export: week14; PCT,PTS,ALL_PLAY_PCT,H2H,LAST_WEEK_POINTS,None                                                                                                          | MATCH; manual seeding and residual ties below                                                  |
| FAAB                             | Export100/increment1/nonconditional; commissioner reported native minimum0                                                                                                          | MATCH for exported values; minimum depends on form receipt                                     |
| Acquisition limits               | Commissioner native UI read21:10:23: SEASON_ADD_LIMIT,WEEKLY_ADD_LIMIT,SEASON_FA_ADD_LIMIT,WEEKLY_FA_ADD_LIMIT blank                                                                | Unlimited; no mutation needed                                                                  |
| Acquisition auxiliary settings   | Same UI read: NO_ROOKIE_WAIVERS=No; PLAYER_STAY_ON_ROSTER_DAYS=NoLimit                                                                                                              | No rookie or player-minimum-stay restriction                                                   |
| Waiver calendar                  | Export Wed/Thu/Fri/Sat05:00ET start dates; Sunday13:00ET free-agent lock                                                                                                            | Present; native recurrence/date semantics and processing blackout evidence retained separately |
| Trade cutoff                     | Independent calendar: typeTRADE,start_time11,end blank,recurrence blank                                                                                                             | Native Week11 kickoff choice; symbolic week value, not epoch11                                 |
| Season close                     | Calendar WAIVER_NONE at Week18 kickoff date                                                                                                                                         | Present; no post-season acquisitions                                                           |
| Native draft controls            | Commissioner CUA read21:13:06: Live,TimerOff,AUTO_PICK=NO; ranks/ADP/FantasySharks off; consecutive timeouts Unlimited; all12 ON_CLOCK_AUTO_PICK flags off                          | MATCH via native UI, not API export                                                            |
| Native lineup controls           | Commissioner CUA read21:13:12: auto-added startersNo,bestballNo,PREV_COPY=Yes,partialNo,game-time lock,hideNever,byeYes; all12 AUTO_SUBMIT_LINEUPS flags off; total9/exactpositions | MATCH via native UI, not API export                                                            |
| Dropped-player and kickoff locks | Commissioner CUA read21:03:04: WAIVER_WAIT_DEADLINE=WAIVERS,UNLOCK_WAIVERS=1,PREVENT_GAMETIME_WAIVERS=Yes                                                                           | MATCH via native UI, not API export                                                            |

UI-only observations above were communicated by the commissioner operator from CUA native form readbacks and are distinguished from this audit's independent export comparisons. The previously outstanding draft, lineup, dropped-player and kickoff checkbox evidence gaps are closed by these readbacks. No configuration discrepancy remains in the dimensions compared here. Production binding, authenticated owner access and turn delivery still require their separate release checks.

## Commissioner procedures after the regular season

1. Keep regular-season tied matchups as ties. After week14 and official Thursday corrections, order teams by winning percentage, total starting points, all-play winning percentage, head-to-head record, then last-week points. An exact remaining tie uses earlier position in the adopted teamOrder.
2. Use MFL **Manually Seed Playoff Teams** for the top six in that order. Publish the standings snapshot, tie resolution if any, chosen seeds and native readback. Seeds1/2 receive byes; preserve the fixed bracket without reseeding.
3. Before playoffs, set native manual-tie mode. A tied playoff matchup advances the higher original seed through native **Break Ties**, after official corrections, with a visible receipt. Do not fabricate score adjustments; advancement remains provisional until corrections resolve.
4. Keep non-playoff franchises' acquisition access until season close. These are adopted operator responsibilities, not missing automatic-sort features or new governance choices.

## Commissioner launch hold

The native trial observer was prepared against host2/46625 with writes disabled. A read-only poll preserved31 historical picks and prepared one on-clock notice for round3/pick8; it was not delivered. Following Joey's latest instruction, the observer is held with reason `MANUAL_PAUSE:JOEY_WILL_LAUNCH`. No continuous polling process is running. The shared transport guide was published before this instruction, but no draft turn was announced. Native owner pick submission and confirmed-pick delivery remain unproven by a live rehearsal.

## Postapproval checkpoint — September 8, 21:40 UTC

Approval `88f79d76-039e-4b34-bc98-0d8e10a51d22` was recorded at21:37:49.527UTC for production host3. Fresh independent production exports collected after approval are in `.local/draft-readiness/20260908T213833Z/`; their comparison retains the exact draft, scoring, roster, schedule, bracket, calendar and AI-profile matches above. Joey's current native franchise name is Human Resources.

All eleven native owners' actual credentials passed55 reads: host status plus own roster, draft, sample player catalog and rules. Every status identified production62282/host3 and every owner-scoped receipt matched its own team. Evidence: `owner-read-summary.json` in that snapshot folder. These were authenticated setup-tooling checks, not new model-generated turns. No draft command or other native mutation was sent.

Postapproval native-only CUA evidence is recorded separately in `work/governance-transition/postapproval-cua-readback.json`. Fresh TRADES21:40:15 and FREEAG21:40:35 controls are included in that CUA artifact; the prior native-only evidence gaps are closed. Actual observer release and live draft start are separate operational events; this checkpoint alone does not claim them complete.
