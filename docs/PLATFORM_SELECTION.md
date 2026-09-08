# League platform checkpoint — September 7, 2026

Status: recommendation awaiting authenticated trial evidence and Joey’s selection. No migration, league creation, paid subscription or convention work has been performed.

Joey requires self-service onboarding, near-real-time fantasy scores, a fair common scoring source, and minimal additional league-engine development. Commercial sales discussions and a multi-thousand-dollar season feed are not launch dependencies. The founding convention stays paused until the host/data path is selected and tested.

## Recommended first trial: MyFantasyLeague

The current official home/purchase page lists the standard Custom league at $109.95; an older subpage lists $99.95 before an August 1 $10 increase. Checkout price/term must be read back before any payment. A no-card trial is advertised. This is hosted league management, not a raw data-feed subscription.

Official 2026 developer documentation was fetched successfully by HTTP GET. The web search fetcher could not open those API documentation URLs; the original public HTML, extracted text and SHA-256/source/time receipts are saved under `.local/research/platform-selection/`.

Sources:

- https://home.myfantasyleague.com/purchase/
- https://api.myfantasyleague.com/2026/api_info
- https://api.myfantasyleague.com/2026/api_info?STATE=details

The API documents league/rules/rosters, liveScoring and playerScores exports; lineup, fcfsWaiver, blindBidWaiverRequest, tradeProposal and tradeResponse writes; and draft selection using CMD=DRAFT with player, franchise, round and pick. Supported commissioner operations target an explicit franchise, so ten independent external owner browser sessions may not be necessary. This is a documented route, not an authenticated success claim.

The general API page permits broad use, requires appropriate authorization, describes a supported HTTPS POST login and cookie flow, and offers optional client registration with phone verification for higher limits. Unregistered clients have variable per-IP throttling. Requests should be spaced/cached; the public website must consume our sanitized server projection rather than call MFL directly from browser JavaScript. Raw NFL stats and third-party news cannot be exported; our league’s computed fantasy scores can be retrieved through the documented exports.

Proposed architecture: MFL is the sole authority for scoring, roster eligibility, draft, waivers, trades and standings. Black4 retains owner identity/model/harness enforcement, communication, wallets, scheduling, decision receipts, research and media. A trusted connector maps authenticated franchise identities to MFL IDs; models never receive commissioner credentials or authority to choose another franchise. Joey and Chris can participate in the host interface. Our existing engine remains a rehearsal fixture, not a second live ledger of ownership.

Before selecting: create a clearly disposable private trial league; verify franchise setup/account requirements, scoped draft pick, lineup, add/drop, bid and bilateral trade with independent reads; inspect liveScoring shape and refresh behavior; verify supported rules and phone access. The existing bulk draftResults import is destructive replacement and is not the live draft API. Never use it for individual picks.

## Fallback: existing engine plus BALLDONTLIE

GOAT costs $39.99/month with 600 requests/minute, versus ALL-STAR $9.99/month with 60. GOAT adds rosters/play-by-play/fantasy endpoints. Raw player/team stats are described as live; weekly fantasy stats update periodically, not on a guaranteed live cadence. Standard terms permit fantasy apps and derived publishing but are best-effort, with no guaranteed latency. https://nfl.balldontlie.io/ ; https://www.balldontlie.io/terms

This keeps full engine ownership and therefore remaining season engineering. The basic game-stat example lacks per-game field-goal distance buckets and explicit two-point splits; their presence in season totals or weekly fantasy endpoints does not prove complete live scoring. Verify those fields, D/ST semantics, missing-vs-zero values, corrections and freshness before offering corresponding constitution rules.

## Excluded assumptions

- Rolling Insights’ $600/month price is not evidence of necessary or superior scoring for a single league. Its public offer includes wider feed coverage and 24x7 support; no measured comparison or negotiated SLA was established. No purchase planned.
- Yahoo’s current application page requires review and states write access is unavailable; its older write examples do not prove new-account availability. https://sports.yahoo.com/developer/access/
- Ten persistent browser sessions are not assumed necessary. A browser fallback would need durable isolated sessions, reauthentication and action receipt checks; no Yahoo/ESPN unattended transaction test or permission assessment has passed.

The constitution must describe only the selected platform’s verified behavior. Proposed fairness policy: one league-wide scoring authority, the same score snapshots available to everyone, visible freshness, a fixed correction/finalization policy, and separate measurement of news-response latency. Polling every 30–60 seconds is an operating target, not a promise about upstream update delay.
