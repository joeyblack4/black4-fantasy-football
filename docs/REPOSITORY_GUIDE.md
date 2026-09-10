## Public source snapshot — September 8, 2026

The first MIT infrastructure snapshot is published at https://github.com/joeyblack4/black4-fantasy-football, commit `fc5048bc344e8e0d38509cd91b48247eebdd98de` on `main`. The 260-file clean export passed TypeScript and421 tests. Application source matches the frozen r6 code; five documentation copies omit private deployment evidence. This is infrastructure publication, not public release of the league conversations or a completed autonomous-season claim.

The canonical development checkout retains private operational history. The public Git checkout is `.local/public-export/repo`; its explicit allowlist and copy/scan receipts sit alongside it. Future public updates must refresh reviewed source files into that checkout and verify the export. Pushing the canonical private branch would disclose historical operational documents even if their current versions were removed.

# How the project is organized

This repository is the reusable league operating system. The public marketing page stays in the existing `black4-site` repository so it uses Black4's actual components and brand. We do not copy customer repositories, credentials or production datasets into this project.

| Location                                                  | Responsibility                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mfl/`                                                | Typed MFL adapter, franchise binding, verified external receipts and operator-only credential loader. MFL owns real rosters, draft, acquisitions and scoring. |
| `src/league/`, `src/scoring/`, `src/data/`                | Existing synthetic football engine and feed experiments. Host guards prevent this engine from becoming a second authority for an MFL league.                  |
| `src/runtime/`                                            | Durable jobs, wakeups, memory, same-model staff and action dispatch. Unknown external writes are held for reconciliation.                                     |
| `src/providers/`                                          | Exact model/provider manifests, restricted inference keys, cost accounting and reconciliation.                                                                |
| `src/buzz/`                                               | League communication transport, archive and delivery receipts. Buzz carries messages; it does not own football state.                                         |
| `src/governance/`, `src/franchise/`                       | Constitution process, franchise identity, expense requests and original content approval. Host setup is not ratification.                                     |
| `src/api.ts`, `src/client.ts`, `src/cli.ts`, `src/mcp.ts` | Authenticated interfaces shared by people and model harnesses. Actors are derived from credentials, never supplied as authority in the request body.          |
| `src/publication/`, `public/`                             | Approved public-data projection plus local commissioner/human controls. MFL third-party score redistribution currently stays disabled.                        |
| `skills/mfl-owner/`                                       | The versioned football operating instructions shared by every owner. Enforcement remains in code.                                                             |
| `migrations/`                                             | Ordered PostgreSQL schema changes, applied transactionally. Add a new migration rather than changing one already deployed.                                    |
| `scripts/`, `deploy/`, `compose*.yml`                     | Entry points, supervised services, containers and backup/restore. Secrets are external files.                                                                 |
| `tests/`                                                  | Isolated synthetic and boundary tests. They do not invoke paid model accounts or prove actual live-game behavior.                                             |
| `docs/`                                                   | Decisions, architecture, backlog, operational runbooks and clearly labeled trial findings.                                                                    |
| `evidence/`                                               | Reviewed, sanitized evidence intended for the source repository.                                                                                              |
| `.local/`                                                 | Ignored private credentials, raw trial responses, account receipts and machine-specific configuration. Never publish it.                                      |

## Working agreement

- `main` is the shared integration branch; changes use `codex/...` branches and reviewed pull requests.
- GitHub Actions runs TypeScript checking and the test suite against a disposable PostgreSQL service. Passing CI proves those tests, not runtime activation.
- GitHub Issues track remaining work; `docs/BACKLOG.md` remains the fast capture list for ideas during a conversation. Issues should link acceptance evidence rather than claim completion from a plan.
- `docs/DECISIONS.md` is the current decision record. Trial reports retain dated observations; later fixes do not rewrite prior failures into successes.
- Commit code, migrations and their relevant tests together. Record model, harness and skill versions when activating an owner. Keep the disposable trial and real league IDs distinct.
- The real league is **62282**; **46625** is the disposable scripted integration trial. Never promote test picks or synthetic conversations into real evidence.
- Production deployment is explicit. A GitHub push does not activate agents, fund wallets, run a draft, ratify rules or publish an X batch.

## What MFL changes

We keep the parts that test agents working in an organization: persistence, communication, budget decisions, model identity, human collaboration and evidence. We hand football transaction rules and score calculation to MFL. The custom engine remains useful for repeatable tests and open-source demonstrations; it is not maintained as a competing live ledger.

The first MFL deployment is a connected setup surface. Rules, real owner activation, the live deadline observer and public launch have separate readiness evidence. Read `MFL_TRIAL_RESULTS.md` and `MFL_USE_BOUNDARY.md` for those limits.
