# MFL use boundary

## September 14, 2026 — public scoreboard decision

Joey decided to publish the league's own scoreboard on black4.ai: weekly matchups, team scores, standings, and every franchise's starting lineup and bench with player names and fantasy points. This supersedes the link-only operating decision below for the authorized league 62282 only.

Scope of what is published: derived league facts for our twelve franchises (team totals, per-player fantasy points and game status, lineup slots, records). Not published: raw MFL payloads, player news or injury text, projections, other leagues, or anything reachable only with owner credentials (pending bids, trades, budgets). The site never calls MFL; a host-side publisher (`scripts/public-scoreboard.ts`) reads through the existing authenticated adapter with the same spacing and throttle handling as owner reads, derives the snapshot (`src/publication/scoreboard.ts`), and writes it to Cloudflare KV. The page carries one attribution line ("Scoring by MyFantasyLeague.") and no link to MFL.

This remains an implementation decision by the league operator, not a written clearance from MFL. If MFL objects, the publisher is stopped and the KV key deleted; the page then shows "unavailable".

## Original review — September 7, 2026

Checked September 7, 2026 Pacific. This is an implementation decision based on the published documents, not a guarantee of legal clearance or a special agreement with MFL.

The [MFL developer terms](https://api.myfantasyleague.com/2026/api_info) explicitly provide an API for applications and permit broad use subject to restrictions. The [request reference](https://api.myfantasyleague.com/2026/api_info?STATE=details) documents authenticated franchise-targeted operations, including the paths exercised in our trial. The reviewed developer page does not state a blanket prohibition on AI-controlled owners or require an independent external account for every commissioner-managed franchise. We have not received a separate written determination about this experiment.

Our implementation is limited to our authorized league and owners. It uses supported endpoints, caches common data, spaces requests, obeys rate-limit responses and keeps session credentials in the trusted connector. It does not harvest unrelated leagues, bypass rules, scrape paid content, collect unauthorized user information, or call MFL directly from a third-party webpage's JavaScript. Raw NFL stats and third-party news are not provided by the API.

The [general website terms](https://home.myfantasyleague.com/terms.html) separately limit Material to personal/noncommercial use and restrict third-party redistribution without written permission, including whether or not money changes hands. The [acceptable-use policy](https://home.myfantasyleague.com/use.html) also restricts unauthorized content and spam. The broad developer permission and narrower general wording leave a real ambiguity for a Black4-branded external scoreboard. Absence of paid admission or ads does not itself settle that ambiguity.

**Current operating decision:** use the documented API to operate the authorized league. Publish Black4's original software, franchise assets, approved original conversations and experiment commentary. Link to the MFL-hosted scoreboard; do not mirror MFL score tables, player news or raw payloads publicly while redistribution permission is unresolved. This lets development and private league operations proceed without claiming the unresolved external display is cleared. No sales discussion, support message, agreement or payment was submitted during this review.

The repository's MIT license covers Black4's reusable code and original synthetic fixtures. It grants no rights to MFL data, trademarks, model weights or third-party services. Reusers obtain their own accounts and comply with applicable terms.

Retained source HTML is private under `.local/research/platform-selection/mfl-*-current.html`. It is evidence for the review, not part of the open-source distribution.
