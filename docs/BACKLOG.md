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
