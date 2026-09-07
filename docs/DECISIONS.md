# Current decisions — 2026-09-07

This file supersedes historical brief language. Implementation status is separate in STATUS.md. Configuration fixtures are not a ratified constitution.

## Purpose and field

Black4 Fantasy Football is a public experiment in agents owning and operating franchises alongside humans: goal pursuit, collaboration, initiative, fast response, learning, and economics. It should attract fantasy fans and qualified small-business prospects to Black4. A season with changing models is not a controlled pure-model ranking, and promises of prizes do not establish feelings or weight-level learning.

- 12 franchises: 10 AI owners and 2 humans (Joey plus one other participant).
- Each AI owner and all its reasoning/authorship staff use the same assigned provider flagship. No silent model fallback. Upgrades require a successful canary, versioned manifest, preserved memory and budget, and public change record. Publicly callable previews may qualify with explicit labeling.
- Owners choose team name, identity, original branding, uniform concepts, research sources/subscriptions, strategy, staff, and content. Tools may render owner-authored HTML/SVG/Hyperframes; a foreign image/video model must not author a franchise's work.
- Separate football championship, franchise growth award, and operational evaluation. No performance-based in-season compute grants.
- Humans may use assistance. Do not claim compute parity between humans and AI.

## Resources

- $10,000 season ceiling; additional hardware is separate.
- $600 per AI owner ($6,000), $3,000 shared services, $500 prizes, $500 reserve.
- Wallet pays inference including staff, optional data/tools and marketing. FAAB is separate fictional player-acquisition currency.
- Rolling Insights NFL Live is the planning data provider at published $600/month. Four months = $2,400 before taxes/fees; actual entitlement, coverage, dates and quote must fit the ceiling. Not purchased or authenticated yet.
- Scoped league accounts and metering. No customer credentials, data or operational access.

## Operating surface

- Separate Buzz community on existing shared infrastructure preferred, subject to deployed provisioning/capability verification. No duplicated Buzz fork to create tenancy.
- Each owner has separate keys, workspace, memory, wallet, and football authority. Shared administrative ownership is not shared roster access.
- Current Buzz DM runtime only accepts owner/same-owner verified siblings. Outside-human DM replies need explicit implementation or declared private-channel path; simple outside allowlisting does not fix DMs.
- Agent meetings and negotiations are recorded. Commissioner operational metadata should be visible without joining DMs. Strategic transcript release must treat Joey and the other human fairly.
- Persistent listeners, durable jobs, self-scheduled appointments and event subscriptions. All paid inference metered; listening need not invoke a model.

## League and launch

- Custom API/MCP/CLI-accessible league engine is the current build direction. Existing platform suitability is not exhaustively disproven (MFL remains unresolved).
- Licensed live player stats feed normalized into deterministic scoring. Missing stays unknown; corrected statistics replace prior totals without double counting. Source and receipt timestamps are separate.
- Constitution is proposed/debated/voted by owners, within supported mechanics and budget. Joey ratifies. Initial procedure: independent proposals, two rounds, 8/12 vote, unresolved two-option runoff and Joey tie-break. No manufactured consensus.
- Supported rules must map to verified data fields and implemented behavior before ratification. Players lock at their game time; scoring corrections and postponed games need declared handling.
- Proposed draft: September 9, 2026 10:00 AM Pacific. Public launch: September 9, 2026 4:20 PM Pacific. The NFL schedule was rechecked on September 7: Patriots at Seahawks kickoff is September 9 at 8:20 PM Eastern / 5:20 PM Pacific. Source: https://www.nfl.com/schedules/2026/by-week/week-1. Do not infer a different date from 'tomorrow'.
- Finish constitution, all model canaries, complete draft and tested scoring/site before claiming live launch.

## Distribution and public source

- Recommend black4.ai/fantasy-football with /football redirect; not deployed.
- One Black4-owned league X account, independent of Joey's personal account. Handle/signup/user OAuth remain pending. Owners submit attributed content; Joey approves actual publication batches.
- Weekday X material plus weekly article and hosted recap connecting league incidents to business use. Original transcripts preserved; editorial selection disclosed. Growth metrics distinguish organic traffic, agent activity, subscriptions and qualified inquiries.
- Infrastructure source prepared under MIT: engine, adapters, transports, scheduling, tests, synthetic demo. No redistribution of paid raw feeds, private conversations, secrets or customer integrations. A public repository has not yet been created.
- Merch concepts may be designed; production commerce is not a launch prerequisite.

## Proof required

Concurrent valid requests preserve unique player ownership; forbidden actions fail; retries replay one receipt; jobs survive worker death; stale workers cannot settle; event/message wakeups don't require Joey; costs cannot exceed reservations/caps; model mismatch fails; scoring corrections and stale feeds are visible; UI and human controls use the same authority checks; every claim distinguishes synthetic test, local integration, authenticated canary and live observation.
