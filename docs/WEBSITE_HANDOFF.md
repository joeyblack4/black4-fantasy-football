# Black4 Fantasy Football — website assignment

Prepared September 7, 2026, Pacific. This is the handoff for the independent website agent. Read the current files before editing: backend integration is progressing concurrently. Do not treat earlier launch plans or existing preview copy as evidence that a feature is live.

## Your assignment

Finish the public Black4 Fantasy Football experience in the existing Black4 website codebase. Bring the current football page into the actual Black4 brand system, implement the requested scroll choreography, and prepare the site for real approved league content. Own website implementation, responsive and visual QA, accessible motion, content structure, metadata, and website-side integration. Deliver a rendered result for Joey to review before production publication.

The infrastructure agent continues MFL, provider identity, persistence, Buzz, budgets, authentication, and the league repository. You do not need to rebuild any of that. Do not activate owners, run the convention, start a draft, or modify live league state from the website task.

## Find the existing work first

| Surface                            | Location / current observation                                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main website repository            | `/Users/joey/black4-site` — `main`, observed HEAD `ffabaad`, with extensive uncommitted brand and measurement work. Preserve it.                                                        |
| Existing football website worktree | `/Users/joey/Documents/ChatGPT/Gaming/black4-site-football` — branch `codex/football-launch`, observed HEAD `825839f`, clean at handoff. It belongs to the same website Git repository. |
| Current football preview           | `http://127.0.0.1:4325/fantasy-football/` — existing static preview; rebuild before assuming it reflects source changes.                                                                |
| League infrastructure repository   | `/Users/joey/Documents/ChatGPT/Gaming/black4-fantasy-football`                                                                                                                          |
| Infrastructure GitHub              | `https://github.com/joeyblack4/black4-fantasy-football` — repository created; initial source push is in progress in the infrastructure task.                                            |
| Real MFL league                    | `https://www43.myfantasyleague.com/2026/home/62282` — newly created, private, 12 empty franchises.                                                                                      |
| Disposable MFL trial               | League `46625` — scripted test draft and transaction evidence. Never present it as the real competition.                                                                                |

Read `/Users/joey/black4-site/CLAUDE.md`, `docs/brand-guide.md`, and `docs/brand-assets.md`. Compare the main checkout's current shared components with the football worktree: the latter may predate today's brand refinements. Use an isolated `codex/...` branch/worktree as appropriate; do not reset, clean, overwrite, or blindly cherry-pick unrelated changes. Reuse the football implementation and selectively reconcile current brand components rather than starting another unrelated site.

The main repo also has a draft about an earlier fantasy draft-room personal project under `docs/drafts/side-quests-2026-09-07.md`. That is a separate project. Do not conflate its completed events or results with this new AI-owner league.

## Why this project exists

Black4 is using a fantasy league to investigate whether agents can operate inside an organization. Football gives people something familiar and entertaining to follow. Joey wants to attract fantasy fans, small-business owners, talent, and capital, and turn actual findings into interest in Black4's work.

The questions are concrete:

- Can owners pursue a season-long goal without Joey repeatedly prompting and coordinating them?
- Can they initiate useful conversations, negotiate, honor commitments, and collaborate with other agents and humans?
- Can they react quickly and correctly to new information, including injuries and approaching deadlines?
- Can they allocate finite money, measure outcomes, learn from mistakes, and change subsequent behavior?
- Can they run a franchise as a business: choose an identity, build a brand, create content, and grow an audience?

Football wins, marketing outcomes, and operational reliability are separate measures. Winning one season does not prove superior intelligence or readiness to run a customer business. Fast wrong actions are failures, too. The site should make the experiment inviting without overstating what has been demonstrated.

## Confirmed decisions

- Name: **Black4 Fantasy Football**.
- Canonical path: **`https://black4.ai/fantasy-football/`**. `/football` redirects there. No separate subdomain or new brand shell.
- League public X identity: **`@black4fantasy`**. One league account with attributed franchise voices. Do not claim posting is connected until verified.
- **12 franchises: ten AI owners, Joey Sterling, and Chris Schaaf.** Joey is also commissioner.
- Developer seats: **OpenAI, Anthropic, Google, xAI, Meta, DeepSeek, Qwen, Mistral, Moonshot/Kimi, and Z.ai**. These are not a license to invent the exact active flagship identifier.
- Every franchise and its staff use the same assigned model. Model upgrades produce dated records. Developer, exact model, serving provider, harness, and Buzz bridge are different fields.
- AI display names become **`Team Name - Model Name`** after owners choose their names. Before that, clearly labeled developer seats / identity pending. Do not invent names, logos, uniforms, strategies, rivals, or owner quotes for them.
- Each AI has a **$600 season operating wallet** for inference, optional data, and approved expenses. FAAB is separate fictional player-bidding money. Compute is the equivalent of an operating salary cap; it is not player payroll.
- Total planned season ceiling: **$10,000**: $6,000 franchise wallets, $3,000 shared services, $500 prizes, $500 contingency. A ceiling is not money already spent.
- Agents choose supported constitution rules, draft procedure, rewards, and last-place consequences through debate and authenticated voting. Eight approvals plus Joey's ratification. Nothing is ratified yet.
- Scheduled target: Tuesday September 8, 2026, 10 AM Pacific draft; Wednesday September 9, 4:20 PM Pacific pre-kickoff release. These are targets subject to readiness, not evidence of completion. Recheck with Joey/current infrastructure status before public launch; avoid a permanently stale countdown.
- Private league Buzz community: `wss://black4fantasysports.communities.buzz.xyz`. This is an internal transport address, not a public join CTA.
- Public materials require Joey's approval of the exact content batch. Commissioner observation of private league discussions is disclosed; observation does not authorize public publication of every DM.
- Reusable league infrastructure is intended for MIT open source. Secrets, raw paid data, and private conversations remain excluded.

## Current state and important platform change

**MyFantasyLeague now owns real football state:** draft, rosters, lineups, acquisitions, trades, rules enforcement, and score calculation. We are not launching our separate custom football engine or buying the previously proposed $600/month feed as the default.

The new real league `62282` has been connected through authenticated read-only API calls. All 12 empty rosters were returned and mapped to local owners. Setup defaults are not a constitution. Football writes are disabled during this checkpoint. The existing scripted trial tests are integration evidence, not autonomous franchise activity.

Joey explicitly paused real owner work before the founding convention to test the system. Respect that checkpoint. No real owner-selected identities, constitution, team performance, or real agent conversation should be manufactured to fill the website.

MFL's supported league API and broader website/data terms differ. External republication of its scores/news has not been cleared. **For the initial public website, link to MFL for hosted football results; do not scrape, embed by workaround, or mirror its data.** The current real league is private, so verify the visitor experience and label any link requiring league access. Do not claim an unrestricted public live scoreboard already exists. The infrastructure agent owns resolving that access/data boundary.

## Visual direction — this is the central design correction

Joey's feedback: the current football page looks like an entirely different brand. He wants the same right-side tech icon pattern as the main site, with each model's logo sliding in from the right and dropping into place as its team comes into view.

Reuse Black4's current design system:

- Quiet document frame, shared navigation/index, roughly 660px prose measure, familiar typography and spacing.
- Current paper/ink/accent tokens and approved Black4 wordmark/logomark; use the actual components and supplied assets. Do not redraw the mark or retain a custom text imitation.
- Instrument Sans; JetBrains Mono for numeric UI. Plain section titles, no numbered editorial headings or visible “chapter” labels.
- League tables, franchise identities, conversation evidence, and costs can be carefully made work artifacts in the page. They can use the approved wider measure, color, and artifact elevation. The surrounding frame remains restrained.
- No independent sports-dashboard shell, giant 140px headline, new cream/green palette, generic AI gradients, robot imagery, or random decorative cards.

Current football files:

```
app/fantasy-football/page.tsx
app/fantasy-football/football.css
app/fantasy-football/league-feed.tsx
app/fantasy-football/league-board.tsx
app/fantasy-football/league-inquiry.tsx
```

Shared references: `app/page.tsx`, `app/globals.css`, `app/layout.tsx`, `components/doc-nav.tsx`, `components/doc-spy.tsx`, `components/brand-logo.tsx`, `components/stack-rail.tsx`, `components/orchestration.tsx`, `components/logo-tile.tsx`, and `scripts/logo-manifest.mjs`.

### Required logo choreography

The existing football rail translates a repeated vertical logo stream and highlights the mark nearest a franchise row. **Highlighting alone does not satisfy Joey's request.**

Adapt the homepage's existing scroll-controlled orchestration pattern. Each model tile has a visible origin in the right rail and a reserved final slot in its franchise artifact. As the reader scrolls, it travels inward, then settles downward into that slot. Reverse scrolling reverses the movement. Coordinate rail visibility to avoid confusing duplicate tiles.

Use scroll progress, not autoplay, timers, or an unrelated animation library. All ten participating model marks should work on desktop, tablet, and phones. Reserve the reading/control space; no horizontal overflow or obscured text. Reduced motion gets the completed static arrangement. Names remain available without animation, color, or successful image loads.

The rail should focus on actual league technology and participating models. Show MFL, Buzz, OpenRouter, and verified operating tools where appropriate; remove irrelevant customer commerce tools from the football-specific rail. Preserve the homepage rail and scene behavior. Use the existing logo manifest/refresh pipeline and `LogoTile` Dock treatment; use text if real artwork cannot be sourced. No invented trademark stand-ins, endorsements, or recoloring.

## Content and information architecture

Implement a coherent document with progressive detail, not a dense wall of implementation terms:

1. **Introduction:** ten AI owners, two humans, one Black4 experiment; what people can follow and why it matters.
2. **The league and franchises:** all 12 owners; chosen identities when available; exact model and harness disclosures; budgets; hosted football access and truthful setup status.
3. **What we are testing:** independent useful work, response time, collaboration, resource allocation, learning, and brand operation.
4. **Rules and transparency:** constitution pending/ratified state, model upgrades, human interventions, participant observation, methodology, and open-source infrastructure.
5. **Field notes and conversations:** approved authentic excerpts and incident articles as they become available. A thoughtful empty state now is preferable to synthetic banter.
6. **Black4 connection:** “Start a conversation” and “Follow the league.” Explain the business parallel through concrete examples: injury/news response and changing demand; lineup deadlines and operating commitments; compute allocation and campaign spending. These are questions we are testing, not established customer ROI.

Each franchise eventually needs its own name, brand/logo/uniform artifact, owner/model/harness record, football status, operating costs, approved content, and findings. Build for real dynamic identities without requiring them to exist today. Do not make 12 fake profile pages to demonstrate completeness.

The editorial plan is one daily league observation and one weekly Black4 article about an actual incident and its business implication. Provide a maintainable route through the site's existing writing system (`lib/blog.ts` and `/blog/<slug>`) or a small league notes collection consistent with it. No need to write nonexistent findings now.

## Data integration contract and independence

The website is **Next.js 15 / React 19 / TypeScript, static export, plain CSS, Cloudflare Static Assets**. Keep that architecture. No database, provider keys, server actions, or privileged football APIs in the site.

The existing football feed provider reads `NEXT_PUBLIC_FOOTBALL_FEED_URL`, polls every 15 seconds, and marks snapshots stale after 45 seconds. It has a typed `LeagueFeed`/`ModelDisclosure` interface. Preserve useful validation and failure behavior, but this is the earlier custom-engine feed contract, not a ready MFL public endpoint.

In the infrastructure repo, `src/publication/projection.ts` currently refuses MFL projection (`MFL_PUBLIC_PROJECTION_NOT_ENABLED`). Do not bypass that guard or use the private API on port 4315 as a public feed. A `NEXT_PUBLIC_...` value must be safe for anyone to read.

Build separate presentation states for forming, unavailable, stale, rehearsal, and verified published content. Unknown scores/costs are null/unknown, not zero. A failed fetch must not leave “live” badges on stale material. Local fixtures are fine for clearly labeled development previews; exclude them from published claims.

Propose any additional sanitized public fields in a website-owned contract document or TypeScript type. Infrastructure owns implementing and approving the producer. The intended disclosure fields include stable franchise ID, owner-chosen name, exact model ID/version, developer, serving provider, harness ID/version, Buzz bridge version, open-weight status, license, activation date, and upgrade history. Unknown values stay unknown. Model metadata alone does not prove successful Buzz collaboration.

Approved conversations need authentic speaker identity, team/model version, timestamp, context, and an original event/excerpt reference. Render safe text and allow screenshot-quality cards from approved events; no unrestricted HTML or private archive access. Aggregate observed costs must distinguish unresolved billing and wallet limits.

## Leads, analytics, and publication

Reuse the current site contact/measurement implementation, including its consent behavior. The main checkout has newer uncommitted measurement work; inspect it before copying the older football inquiry form.

- Capture league, franchise, and campaign attribution where available without private participant data.
- Show success only after actual form acceptance; retain input and an actionable failure state on failure.
- Use staging/validation-only submissions for routine QA. Coordinate any deliberate production test with the infrastructure task so Joey receives one labeled test, not duplicates.
- Track useful actions such as follow clicks, league interest, and successful business inquiries. Do not invent measured engagement, qualified leads, subscribers, or revenue.
- Add correct canonical metadata, social share metadata/art, sitemap inclusion, and `/football` redirect. Use the existing brand/logo for initial share assets; franchise art must await owner creation/approval.
- No X posts, mailing sends, or production site deployment until Joey approves the rendered/exact public result. Preparing the complete reviewable package is in scope.

## Delivery and acceptance

- The football page and homepage visibly belong to one brand, using the latest approved assets.
- All ten model tiles travel from the right and drop into their slots with scroll, reversing correctly. Reduced motion and keyboard/mobile use work.
- Human names are exactly **Joey Sterling** and **Chris Schaaf**; AI names stay pending until authentic.
- Model, provider, harness, and bridge remain distinct public disclosures.
- MFL is the selected host. No copy promises the retired custom engine/feed, unrestricted public live scores, completed convention, or active autonomous season without current evidence.
- Public pages expose no private community transcript, key, queue, session, customer record, or raw vendor feed.
- Build and lint pass; check redirect behavior using the Cloudflare-compatible preview. Compare screenshots at desktop, tablet, phone, and at first/middle/final animation positions in both scroll directions.
- Verify missing feed, slow/error feed, stale timestamps, reduced motion, image fallback, and form failure. Keep live API tests separate from synthetic UI fixtures.
- Return branch/worktree, changed files, preview URL, screenshots, checks, remaining integration needs, and a concise rendered publication package for Joey.

## Further source context

In the infrastructure repo, read `docs/BACKLOG.md` (especially B4FF-001/002/003), `docs/DECISIONS.md`, `docs/EXPERIMENT_PROTOCOL.md`, `docs/REPOSITORY_GUIDE.md`, and `docs/MFL_USE_BOUNDARY.md`. Earlier dated plans may be superseded by the selected MFL architecture and the explicit pre-convention pause. Keep your website backlog in a Markdown file or the website's established tracker; don't silently create another project or overwrite the infrastructure backlog.
