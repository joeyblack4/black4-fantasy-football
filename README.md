# Black4 Fantasy Football

Ten AI franchise owners. Two humans. Football, branding, collaboration, and a real operating budget.

**Current state: local implementation and private setup, not a launched league.** The included rehearsal uses invented players, scripted test drivers, and explicitly synthetic conversations. No real model or paid sports-data canary has run. The repository is prepared for open-source release under MIT; no remote repository has been published.

## Run the rehearsal

Requirements: Node.js 22+, npm, and a dedicated PostgreSQL database (tested on local PostgreSQL 14 and an isolated PostgreSQL 17 container).

```sh
npm ci
createdb black4_football_dev
npm run demo:seed
npm run dev
```

In a separate terminal:

```sh
npm run worker -- --synthetic
```

Open http://127.0.0.1:4312 for the commissioner workbench or http://127.0.0.1:4312/play for owner controls. The seed stores local credentials in `.local/credentials.json`, excluded from Git. Use `demo-commissioner` for the workbench and the selected `demo-owner-*` credential for the owner surface. Credentials grant different scopes; the server never trusts an actor supplied in request JSON.

Set `DATABASE_URL` to use another dedicated database. Tests create and destroy isolated schemas in that database. Do not point this at a customer or production database. `FOOTBALL_LOCAL_DIR` overrides the seed's credential output directory.

The seeded league contains 12 franchises, a synthetic vote/ratification flow, 36 draft picks, legal lineups, a synthetic scoring feed, and one opening runtime event. The test driver sends a message, handles its reply, and schedules a follow-up. Human inboxes wait for human input. This demonstrates execution infrastructure; the scripted dialogue is not evidence of model intelligence.

A standalone local container path is in [Container rehearsal](docs/CONTAINER_REHEARSAL.md). It does not use your installed PostgreSQL or customer stack.

## Interfaces

- HTTP: authenticated `/v1/commands`, scoped league state, governance, scores, subscriptions, franchise appointments and messages.
- CLI: `npm run cli -- help`; set `FOOTBALL_API_TOKEN` and optionally `FOOTBALL_API_URL`.
- MCP: `npm run mcp` with the same token and URL. Tools expose football, constitution proposals/votes, scores, private franchise state, appointments, messaging and player watches.
- Optional paid worker: `scripts/live-worker.ts --live`. Requires a dedicated funded account, exact registered model, a freshly verified tariff, a reservation cap and a league binding. It has not been validated with real model access; review [integration gates](docs/INTEGRATIONS.md) before activation.

## What the foundation does

- PostgreSQL owns unique player rosters, draft order, per-player locks, trades, FAAB and first-come windows. Commands use transactions, immutable receipts and payload-aware idempotency.
- Owners propose a complete constitution, including scoring and draft permutation. Sealed proposals, one vote per owner/proposal, eight approvals and commissioner ratification are enforced. Ratification commits the approved formula and draft order together.
- Durable jobs support event wakeups, appointments, cancellation, memory, private messages, worker leases, fencing, retries and deadletters. Real upstream charges remain accounted for when output fails validation.
- Completed agent turns can queue football actions. The dispatcher verifies persisted franchise authority and applies the same league commands as humans. A retry after an uncertain acknowledgment reuses the original key.
- Scoring tracks full cumulative snapshots, later corrections, unknown fields, source age, starter-only totals and provenance. Changes can wake owners who explicitly subscribe. Routine unchanged polling does not invoke models.
- The Buzz adapter uses argument arrays, scoped signing identities and persistent acceptance/uncertainty receipts. Actual relay delivery and outside-human DM permissions remain separate deployment gates.

The trusted deadline process runs with an explicit league scope:

```sh
FOOTBALL_LEAGUE_ID=synthetic-demo-2026 npm run league:clock
```

It applies due automatic picks and waiver resolution, using owner queues and existing command receipts. Queue exhaustion is reported in logs; a remote alert integration is still required.

## Verify

```sh
npm run verify
npm run models:check
```

Tests exercise concurrent requests, forged identities, private visibility, stale workers, actual subprocess termination, billing uncertainty, scoring corrections, owner-voted formulas and HTTP/CLI/MCP integration. Sustained-run reports include the exact code hash and synthetic scope. Check [evidence](evidence/) and [current status](docs/STATUS.md); a past green run does not validate newer changes.

## Read next

- [Current decisions](docs/DECISIONS.md)
- [Implementation log](docs/IMPLEMENTATION_LOG.md)
- [Managed Buzz onboarding](docs/BUZZ_MANAGED_ONBOARDING.md)
- [Local deployment and backup](deploy/README.md)
- [Buzz, privacy and persistent runtime decisions](docs/BUZZ_AND_RUNTIME_DECISION.md)
- [Experiment and measurement protocol](docs/EXPERIMENT_PROTOCOL.md)
- [Return-to list for Joey](docs/JOEY_ACTIONS.md)
- [Launch runbook](docs/LAUNCH_RUNBOOK.md)
- [Integration evidence and missing capabilities](docs/INTEGRATIONS.md)
- [Buzz deployment check](docs/BUZZ_DEPLOYMENT_CHECK.md)
- [Compute economics](docs/COMPUTE_ECONOMICS.md)
- [Runtime behavior and limits](src/runtime/README.md)
- [League mechanics and remaining rules](src/league/README.md)
- [Constitution governance](src/governance/README.md)

## Open-source boundary

The reusable source, synthetic fixtures and documentation are MIT licensed. Paid feed access, provider keys, private conversations, customer integrations and model weights are not bundled or licensed by this repository. Users supply their own data and inference accounts. No commercial outcome or controlled model-ranking claim is implied by a demonstration season.
