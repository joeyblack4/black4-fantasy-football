# Black4 Fantasy Football backlog

Updated: September 7, 2026. Capture new notes here as they arrive. This is a local Markdown backlog; no external Linear issues have been created.

The current priority is Buzz activation and the protocol repair already underway. Ten AI franchise records have been created in Buzz, as reported by the coordinating task; record creation does not establish a working model turn. The website work below is explicitly **not urgent** and follows that activation work. This document authorizes no publishing, purchases, new accounts or fabricated franchise identities.

| ID       | Work                                                                              | Priority                                         | Status                                         |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| B4FF-001 | Bring the football website into Black4's actual visual system                     | After Buzz activation                            | Backlogged; implementation brief below         |
| B4FF-002 | Model logos enter from the right and drop into their places as the reader scrolls | With B4FF-001                                    | Backlogged; current rail does not do this      |
| B4FF-003 | Use `Team Name - Model Name` for AI franchise display names                       | At identity confirmation; apply across surfaces  | Requirement recorded; do not invent team names |
| B4FF-004 | Make the football community show only its intended franchise participants         | Community clarity; preserve existing work agents | Backlogged; scoped evidence recorded           |

## B4FF-001 — Black4 brand alignment

**User note:** The football website feels like a different brand. Match the actual Black4 style guide and current site.

**Source inspection:** September 7 code review of the sibling `black4-site-football` worktree, branch `codex/football-launch`. This was a source audit, not a new browser or live-site verification. References:

- [Canonical brand guide](../../black4-site-football/docs/brand-guide.md)
- [Main homepage](../../black4-site-football/app/page.tsx) and [shared design tokens](../../black4-site-football/app/globals.css)
- [Football page](../../black4-site-football/app/fantasy-football/page.tsx) and [football styles](../../black4-site-football/app/fantasy-football/football.css)

**Observed mismatch:** Black4's main page uses a quiet document frame: fixed left index, roughly 660px reading width, near-white paper, black ink, restrained headings, the existing roulette-four mark and plain section titles. Football currently introduces its own 1440px layout and horizontal navigation, cream `#f8f8f2` paper, green-tinted ink, a desktop headline reaching 140px, numbered section labels and large tinted sections. Its custom text wordmark also bypasses the existing mark. Shared fonts and a logo rail alone do not make those layouts the same brand.

**Implementation brief:** Reuse the document structure, type scale, spacing tokens, navigation and wordmark/logomark components. Keep football tables, receipts and franchise material as identifiable work artifacts within that frame. The guide permits color and soft elevation inside those artifacts; it does not call for a separate themed page shell. Use the current CSS tokens rather than copying approximate values. The guide and source differ in some motion comments and rail breakpoint descriptions: resolve against actual behavior and the user's requested choreography during implementation.

**Acceptance criteria:**

- [ ] Football visibly belongs to the current Black4 site when the two pages are compared side by side.
- [ ] Shared page/ink/type/spacing/mark conventions replace the independent football shell; no redesigned Black4 mark.
- [ ] Clear Black4 attribution and the route to a business conversation remain present. Football content still explains the experiment plainly.
- [ ] Colored model marks and league UI stay within work artifacts; the surrounding document stays restrained.
- [ ] Real, synthetic, stale and unavailable data remain distinguishable. The redesign invents no results, conversation excerpts or activation claims.
- [ ] Browser review covers desktop, tablet and phone widths, keyboard navigation and reduced motion; record comparison screenshots and build/lint results before calling it complete.

## B4FF-002 — Scroll-controlled logo arrival and placement

**User note:** Model logos should slide in from the right, then drop into place as the user scrolls.

**Current behavior:** [StackRail](../../black4-site-football/components/stack-rail.tsx) translates a repeated vertical stream and highlights the mark nearest a `[data-stack-mark]` franchise row. It does not move that mark from the right margin into the franchise's final position. [Orchestration](../../black4-site-football/components/orchestration.tsx) already provides a relevant site pattern: scroll progress drives staggered right-to-left translation, a small vertical offset, final placement and reversal. Its runtime scales the scene for narrow screens; reduced motion receives a static composition.

**Implementation brief:** Adapt the existing choreography to the franchise artifact instead of adding another animation library or an autoplay effect. Define a stable final logo slot beside each franchise. Use scroll progress to first bring its tile in from the right and then settle it downward into that slot. Coordinate the rail's visibility so arrival does not leave a confusing duplicate. Continue using [LogoTile](../../black4-site-football/components/logo-tile.tsx) and the existing logo manifest/pipeline; do not fabricate, recolor or manually replace trademarks.

**Acceptance criteria:**

- [ ] Each of the ten competing model marks has a clear right-side origin and a final franchise position; highlighting alone does not satisfy the request.
- [ ] Entry and downward placement are visibly distinct parts of one scroll-controlled motion; scrolling back reverses it. No timer-driven reveal or autoplay.
- [ ] The same experience fits phone and tablet layouts without covering names, controls or the reading column.
- [ ] Reduced motion renders all marks directly in their final positions. Content remains readable before hydration and if animation cannot run.
- [ ] Missing official artwork uses an honest text fallback. Model names remain accessible without depending on animation or color.
- [ ] Validate first, middle and final scroll positions in both directions, including resize and stale/unavailable league data. No accumulating scroll listeners or horizontal overflow.

## B4FF-003 — Franchise naming

**User requirement:** `Team Name - Model Name`.

The current [franchise list](../../black4-site-football/app/fantasy-football/league-feed.tsx) leads with developer names and “Franchise identity forthcoming.” Keep that honest pending state until the owner has actually chosen its identity.

**Acceptance criteria:**

- [ ] Once confirmed, AI franchise display names use the owner's chosen team name followed by `-` and its assigned model name in Buzz, league UI and website disclosures.
- [ ] The model name comes from the verified assignment, not merely the serving provider's brand. Provider, harness and bridge versions remain separate disclosures.
- [ ] Model upgrades update the displayed model suffix and preserve the dated assignment history. Stable franchise IDs do not change with a display-name edit.
- [ ] Two human franchises are labeled as human owners; do not attach an invented model to them.
- [ ] Existing Buzz records are updated after identity confirmation; do not create duplicate franchises to fix names.

## B4FF-004 — Football-only community visibility

**User note:** Remove the non-football SEO Analyst, Signal and Storekeeper entries from the football experience without affecting work agents elsewhere.

**Current evidence:** [Scoped membership and catalog receipt](BUZZ_SCOPED_MEMBERSHIP_RECEIPT.md). The three definitions were absent from the explicit football relay member snapshot, observed Channels tabs and catalog visible to a league identity. They appear in the global local Agents/persona catalog. A supported per-community filter for that global list was not established in the installed UI. No removals were needed for these three on the evidence obtained, and no deletions or unshares were performed. The observed SEO entry was v2; do not silently treat it as the user's referenced v3.

**Boundary:** Same-owner delegation means absence from the explicit member snapshot is not an access-denial guarantee. Enforce the exact private-channel participant set and football runtime bindings independently of what the global sidebar displays. Scoped catalog unsharing, explicit relay membership and global definition deletion are different operations.

**Acceptance criteria:**

- [ ] The football view clearly distinguishes its ten franchises and human owners from global work-agent definitions; implement or verify a supported per-community visibility filter before claiming one exists.
- [ ] Preserve all business definitions, keys, memberships, schedules and runtimes outside the football scope. Do not use global persona deletion/archive to declutter this view.
- [ ] The private founding-convention channel contains only the verified intended football participants, and archive/listener/outbound permissions reject other identities even when they share Joey as owner.
- [ ] If a non-football identity is found in an actual football channel or scoped catalog later, remove only that specific scoped participation/share through a supported operation and independently read it back.
- [ ] Show effective delegation/permission limits honestly; do not label a hidden global row or an absent explicit membership row as proof that access was revoked.
- [ ] Keep setup names temporary until each real owner chooses its name; retain the required `Team Name - Model Name` format without duplicating franchises.

## Adding later notes

Append the next stable B4FF ID with the user's note, priority, status, relevant evidence and observable acceptance criteria. Preserve completed entries and link their verification evidence. Keep this as the notes backlog unless Joey explicitly asks to move it elsewhere.

## September 8 runtime findings — observed during real onboarding/convention

Website implementation remains with the separate website task. These are infrastructure findings from actual local owner runs; listing an item does not claim a fix or authorize new subscriptions.

| ID       | Work                                               | Priority                                            | Evidence and acceptance                                                                                                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4FF-005 | Provider cooldown across new wakeups               | Before unattended season operation                  | DeepSeek received three upstream429 failures on separately triggered turns. Preserve uncertain charges; a per-franchise/provider cooldown should coalesce new work without losing deadlines or changing model. Prove a new message cannot bypass the cooldown and a deadline alert still fires.                                                 |
| B4FF-006 | Anticipate full-turn reservation needs             | Before broad unattended work                        | Anthropic exhausted conservative reservation headroom after useful reads, preventing a final decision. Measure input/context growth and reserve safely before inference; preserve the wallet ceiling, billable failures and exact request/model identity. Do not weaken the cost bound just to finish.                                          |
| B4FF-007 | Durable memory history and bounded working notes   | Next harness iteration                              | OpenAI's working memory approached32768bytes and an atomic action batch failed. Sharedr9 adds capacity context and model-authored full-batch repair, with existing caps and contents preserved. Add tested owner-controlled compaction backed by versioned retained history; verify recovery across restart and attribution of compaction cost. |
| B4FF-008 | Direct read receipt to model call linkage          | Evidence-quality improvement                        | All ten owners have real native MFL rules receipts, but current journal attribution to provider jobs also uses same-owner temporal correlation. Persist the returned native receipt ID in the bounded provider tool diagnostic, with job/fence and exact source scope. Do not retroactively manufacture links for prior reads.                  |
| B4FF-009 | Separate claimed consensus from recorded decisions | Ongoing evaluation                                  | Several owners described a YES or identical candidates while authoritative ballots remained zero or draft orders/policies differed. Premature vote attempts were rejected. Public state and reviewer cards must use canonical hashes/ballots; preserve the original misleading claim and rejected receipt as evidence.                          |
| B4FF-010 | Record convention maintenance fairly               | Implemented in sharedr9; live pause/resume verified | Actual pause and common procedural extension are separately receipted. Proposal/vote hashes stay unchanged; paused writes, scheduling and disclosure are fenced. Six-minute maintenance plus an explicit ten-minute recovery extension occurred before any ballot; no extra votes, turn allowance or spend ceiling was granted.                 |
| B4FF-011 | Complete off-device recovery proof                 | Before sustained operation                          | Encrypted backup was successfully restored to a separate local database and checked for expected identities and validated constraints. Off-device encrypted copy and remote restore remain unverified; never label the local restore as off-device recovery.                                                                                    |

- **Operator broadcast delivery:** an unmentioned Buzz channel post is archived but does not wake every owner. Add explicit league-scoped broadcast fanout or put critical common guidance into each durable owner job. Preserve operator attribution even when a managed agent connection transports the announcement. Evidence: voting clarification event1a639fe1b8d7dcbb00f8cc2591f6cb0de49ee292233cda18fb85de08fb24f0ae, zero inbound deliveries to three confused owners.
- **Current-turn and ballot semantics:** show that displayed usage includes the current reserved turn, and immutable ballots are per proposal. Preserve the original three owners' mistaken final-review claims and any later guided recovery as distinct experiment evidence.

## September 8 real-model draft rehearsal findings

- **B4FF-012 — Preserve accepted rules across phase changes:** implemented in r11. A stopped convention previously removed its accepted rules from owner context. The exact prepared decision/proposal/menu is now transactionally bound to the disposable trial, exposed identically to all owners and rejected if evidence/host changes. Full464-test suite passed before deployment. This is provisional rehearsal context, not production ratification.
- **B4FF-013 — Record submitted context digests:** store the prepared-rules snapshot and complete submitted request/context hash with each inference receipt. Current r11 execution-path checks and bound snapshots establish context construction, but the request body itself is not independently persisted. Do not retrofit a claimed request-body digest onto historical calls.
- **B4FF-014 — Expose and recover from tool batch limits:** DeepSeek's first actual draft-turn job ended `PROVIDER_TOOL_LIMIT` before any pick. The common driver accepts at most four tool calls per model response. A single explicitly recorded recovery explained the existing limit without choosing a player or changing model, tools or budgets. Implemented in common r12 after nine verified trial picks: explicit initial/runtime-status limit and one bounded oversized-batch correction with zero requested reads executed. All472 tests pass. Live rehearsal resumed with the same models and budgets; sustained recovery evidence remains pending. Preserve failed turns and r11/r12 boundary.
- **B4FF-015 — Native form field and receipt validation:** native MFL SELECT values must remain explicit (for example third-place bracket `No`, not an omitted checkbox). A schedule save whose follow-up page failed was reconciled through the actual schedule export; a first playoff attempt had no installed effect before a corrected, separately reviewed attempt. Preserve both, with no blind POST retries or fabricated native success.

- **B4FF-016 — Publish accurate model/harness disclosures and implement the MFL public feed:** the sanitized public projection currently supports the custom engine and deliberately rejects MFL. No released snapshot is available for the current league. Its model fields also omit canonical model identity, stable team mapping and the separately recorded deployed harness patch/source digest. Add an approved disclosure-only producer with all twelve seats (humans have no model/harness), exact active assignments and exact reviewed deployment provenance; retain immutable base manifest version and separately label the sanitized public Git commit. Then implement native MFL game projection with scope, freshness, rehearsal/production and licensed-data boundaries before claiming a game-ready public feed. Do not expose the private authenticated API, bypass the MFL guard, or infer current patch from an unrelated latest receipt. A private r11 review preview is prepared; nothing was published.

- **B4FF-017 — Measure draft prompt cost and cache behavior:** First Anthropic trial turn cost$1.119670 across three calls;94.2% was input cost. Its first-pick rate fails the$15 full-rehearsal forecast. Preserve original calls and distinguish current component byte measurements from unavailable historical full-request/token attribution. A common r13 candidate preserves the complete native journal and exact draft order while compacting empty future slots in model context, advertises only already-permitted trial draft/queue output branches, and adds narrowly supported five-minute Anthropic caching with worst-case write pricing. Test and deploy only at a recorded pause; require actual returned cache/billing evidence and a renewed per-franchise forecast before clearing further rounds. Do not enlarge caps or claim savings from a smaller byte count alone.

- **B4FF-018 — Preserve failed-request routing and retry evidence:** A pinned DeepSeek request at native3.2 returned upstream429 with no body generationID, usage or cost. The driver did not persist response X-Generation-Id/Retry-After/rate-limit headers, preventing the documented header-to-generation reconciliation path and an exact cooldown. Preserve bounded allowlisted header diagnostics on future failures; treat missing fields as unknown. Four historical/current429s retain$12 of unresolved holds; no failed native action is being replayed.
- **B4FF-019 — Separate covered billing uncertainty from uncertain actions:** Rehearsal currently blocks every new reservation when any prior cost is unresolved, even when its full worst-case hold already counts against the cap. Assess an audited, narrowly scoped admission policy for an exact429/no-action call with its full hold retained and sufficient headroom. Never release the hold, guess zero, raise caps, ignore an uncertain native effect, or silently admit a second new unknown failure. This remains a proposed repair, not current permission.
- **B4FF-020 — Advertise argument applicability accurately:** The common object-root function schema flattens the MFL read union, making fields such as limit appear globally available even though the strict runtime accepts limit only for players. Rejected limit arguments were observed, but their chosen operation type was not retained in safe diagnostics. Add clear schema-owned applicability guidance without accepting unsupported native parameters or attributing an unrecorded type to an owner.

### R14 checkpoint — 2026-09-08 12:44 UTC

B4FF-018 and B4FF-019 are implemented and deployed in common r14 (519 tests/54 files and build passed). Future error responses preserve bounded validated HTTP generation/request IDs and Retry-After evidence; synthetic transport/database tests prove the pointer remains pending until independent generation metadata reconciles it. No new live error-header recovery has yet been observed. An authenticated commissioner acknowledgment now covers only DeepSeek's exact first-call429 reservation without changing its uncertain status or $3 hold. Any additional unreviewed uncertainty still blocks. One separately identified recovery job is running; no completed pick or settlement is claimed here. Provider cooldown across unrelated incoming wakeups (B4FF-005) remains separate unfinished work.

B4FF-017 has actual r13 cache evidence and two completed Anthropic samples costing $0.756569 and $0.461828. The latter followed explicit operator feedback on economics; do not characterize it as unprompted optimization. These small samples fit the current per-owner trial forecast but do not guarantee the full draft.

## Owner profile autonomy — September 8, after goal pause

- **B4FF-021 — Owner-controlled franchise profiles:** Joey wants owners to manage their own team name, avatar/logo, bio, colors and franchise presentation. Existing owner-authored brands/local names are committed, but Buzz profile and managed-agent labels remain unsynchronized. Installed Buzz CLI supports current-identity name/avatar/about updates; owner-managed definition edits currently open Desktop Save forms. Implement a common franchise-scoped profile tool with durable versioned receipts, metadata-preserving updates and independent readback across Buzz profile, managed label and MFL franchise where supported. Preserve stable pubkey/team IDs and factual assigned-model suffix; branding authority does not change model/key/budget/other franchises. Do not invent or replace owner-created assets. Respect existing public-content approval for public website/X publication. Test one actual profile before claiming autonomous sync. Goal and draft remain paused; this entry records scope, not implementation or live profile changes.

- **B4FF-022 — Conversation independent of football execution:** Joey authorized easy whole-team collaboration while the draft stays paused. Implement opt-in human broadcast in the existing private founding channel, targeted mentions/replies, canonical deduplication, and a separate conversation-only runtime with server-enforced action restrictions and existing franchise/model/budget attribution. Initial activation failed the first real human broadcast because disabled-owner checks blocked the path. Services stopped. R2 fix frozen and focused tests pass, but not deployed or verified live. Finish as Step1 of DRAFT_TONIGHT.md; see TEAM_COLLABORATION.md.
