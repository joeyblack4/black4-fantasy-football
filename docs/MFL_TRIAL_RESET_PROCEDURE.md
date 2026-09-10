# Disposable MFL46625: observed native reset forms

Inspected September8,2026,07:42–07:44 UTC. **No reset, roster clearing, draft setting save, pick or inference was performed.** The only authorized state change was entering Commissioner mode on Joey's existing account for disposable league46625. The native header independently showed `joeyblack4: Commissioner` and `Black4 API Trial - Disposable`. The original `.local/mfl/session.json` was left unchanged; the inspection's separate cookie jar and raw forms remain private.

Scope is exactly `https://www43.myfantasyleague.com/2026/` with league46625. Do not substitute real league62282. This is a reviewed procedure for later execution **after the rules candidate is agreed**, not an instruction to reset now.

## Verified native defaults — no save needed to preserve them

The observed [General Draft and Timer Setup](https://www43.myfantasyleague.com/2026/csetup?L=46625&C=DRAFT) form uses `action="csetup"`, `method="post"`, name `draft`.

| Field                                     | Observed selection       | Meaning                                                                      |
| ----------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `DRAFT_KIND`                              | `live`                   | Native live draft                                                            |
| `DRAFT_TIMER`                             | `OFF`                    | No automatic pick deadline                                                   |
| `AUTO_PICK`                               | `NO`                     | Skip if no suitable player in the native owner lists                         |
| `CONSECUTIVE_TIMEOUT_LIMIT`               | `0`                      | Unlimited; no automatic-on-clock promotion after a finite number of timeouts |
| `ON_CLOCK_AUTO_PICK_0001` through `_0012` | Every checkbox unchecked | None of twelve franchises automatically picks as soon as on clock            |
| `DRAFT_PLAYER_POOL`                       | `Both`                   | Veterans and rookies                                                         |
| `DRAFT_FORCE_FULL_ROSTER`                 | `No`                     | Does not force saving required-position slots automatically                  |
| `DRAFT_LIMIT_HOURS`, `DRAFT_LIMIT_MINS`   | `8`, `00`                | Dormant timer value; timer remains OFF                                       |
| `LIVE_DRAFT_CONFIRMATION`                 | `No`                     | Current native pick-popup preference                                         |

Other `AUTO_PICK` choices are `ranks` (Fantasy Sharks rankings), `ADP`, and `fantasysharks` (Draft Coach); none is selected. The observed form says selection checks the owner's Work List, then My Draft List, before the chosen empty-list fallback. TimerOFF is not proof of empty native lists or a cleared personal “I'm Away” flag. The [official in-process draft help](https://api.myfantasyleague.com/2026/support?CATEGORY=Draft%20%26%20Auction&SUBCATEGORY=Draft%20-%20In%20Process) identifies the live-room “I'm Away” checkbox as another automatic-selection control; inspect the room after reset. This audit verifies configuration, not a timed expiration experiment.

If later approved rule choices require changing this form, refresh it first and preserve untouched controls. Native hidden fields include `form_name=draft`, `LEAGUE_ID=46625`, `C=DRAFT`, and a fresh `input_expires` value. Submit button is `SUBMIT=Save Draft Timer Settings`. Do not reuse saved expiration values or invent replacement fields. Reopen the form and compare selected controls after saving.

## Observed restart form

[Revert Draft](https://www43.myfantasyleague.com/2026/csetup?L=46625&C=REVDRAFT) is available despite the completed draft. It explicitly says the draft is over and warns that reverting cannot be undone.

Form: `action="csetup"`, `method="post"`, name `revdraft`.

| Field           | Later restart target                               |
| --------------- | -------------------------------------------------- |
| `form_name`     | `revdraft`                                         |
| `LEAGUE_ID`     | `46625`                                            |
| `DISPLAY`       | `LEAGUE`                                           |
| `C`             | `REVDRAFT`                                         |
| `input_expires` | Fresh value from the reopened form; never hardcode |
| `ROUND`         | `1`                                                |
| `PICK`          | `1`                                                |
| `DROP_PLAYERS`  | `Yes`                                              |
| `SUBMIT`        | `Revert Draft`                                     |

The submit control has a native confirmation for an irreversible operation. Do not submit it while rules alignment remains pending. Before the eventual reset, preserve the current native static draft XML, rosters, transaction state, configuration, and canonical database backup with hashes. Then perform one explicit reset and independently read static draft history and all twelve rosters. A successful response alone is insufficient.

Reverting picks with `DROP_PLAYERS=Yes` may not establish that post-draft FCFS acquisitions or traded-player residue are absent. The disposable trial previously tested those operations. **Count actual remaining roster players after reverting.** Do not assume all 192 scheduled draft slots disappear: unfilled scheduled slots may remain, with no `player` attribute. Require zero completed picks, the reviewed first round/pick/franchise and no `over=1`.

## Observed residual-roster clearing form

The Commissioner Setup menu directly links [Clear Rosters](https://www43.myfantasyleague.com/2026/csetup?L=46625&C=CLEARROST). Its warning says it drops all players from selected franchises, including IR/taxi, and cannot be undone.

Form: `action="csetup"`, `method="post"`, name `clear_rosters`. Native fields include `form_name=clear_rosters`, `LEAGUE_ID=46625`, `C=CLEARROST`, fresh `input_expires`, `CLEAR_FIDS_0001` through `_0012` with corresponding four-digit values, `CONFIRM`, and `SUBMIT=Clear Selected Rosters`. The page requires `CONFIRM=YES`. `CHECK_ALL` is a UI convenience; explicit selected franchise fields identify the actual targets.

Only use this separate operation if independent post-revert roster reads show residue, and only for the reviewed disposable franchises. Refresh the form immediately before any approved submission. Afterward verify all twelve native roster counts, not just the local cached roster. This audit did not establish how clearing affects historical lineups, transaction logs or accounting; those are separate rehearsal-fixture checks.

## Order and owner-list limits

[All-round Draft Order Setup](https://www43.myfantasyleague.com/2026/csetup?L=46625&C=DRAFTORD) currently has no form: MFL says the draft has already started and points to the one-round order option. Reopen it after the reviewed reset before preparing any order write. No guessed order field names are provided here.

[Set Draft Preferences](https://www43.myfantasyleague.com/2026/csetup?L=46625&C=DRAFTPREF) is owner-only. Under the original Franchise1 session it returned “Draft order not set”; under commissioner mode it says owners only. The global auto-pick configuration above is verified, but individual owner-list/away state is not. No extra owner account or privilege was created.

## Private receipts and continuation

- `.local/live/mfl/trial-native-forms.json`: inspected role, exact scope, form fields and response hashes; raw form expiration values remain private.
- `.local/research/platform-selection/mfl-trial-commissioner-{DRAFT,REVDRAFT,DRAFTORD,DRAFTPREF,CLEARROST}-20260908.html`: observed native pages.
- `.local/mfl/commissioner-inspection.cookies`: protected inspection cookie jar; never copy into an owner tool or public artifact.
- [Rehearsal runbook](MFL_REHEARSAL_RUNBOOK.md): same canonical database/wallet gate, trial host version, operator-labeled human stand-ins, stop/reconcile/restore sequence.

The runtime's planned `RehearsalRuntime.arm` gate requires an explicit epoch, expected host version, trial config reference, cap and operator evidence. Its software acceptance does not reset MFL or prove these native settings. Keep both the native reset and runtime activation disabled until their separate prerequisites pass.
