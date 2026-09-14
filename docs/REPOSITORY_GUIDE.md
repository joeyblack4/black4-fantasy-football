## One history on GitHub — September 14, 2026

`main` at https://github.com/joeyblack4/black4-fantasy-football is the single canonical history, developed directly since September 14, 2026. The earlier sanitized-export flow (`.local/public-export`) and the separate private root history are retired; the private line was ported onto `main` in pull request #1 and its content is identical apart from formatting. The privacy boundary is `.gitignore`: `.local/`, `work/`, `franchises/*/workspace/` and `.env*` never enter the repository. Operational receipts that a public document needs are promoted to `evidence/` after review; everything else stays local.

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

- `main` is the shared integration branch and nobody pushes it directly. Operator changes use `codex/<topic>` branches; franchise owners contribute through `./black4 contribute`, which opens `franchise/<company>/<topic>` pull requests (see [CONTRIBUTING.md](CONTRIBUTING.md)). Every pull request needs the `verify` workflow (format check, TypeScript, tests) green before it is merged.
- GitHub Actions runs TypeScript checking and the test suite against a disposable PostgreSQL service. Passing CI proves those tests, not runtime activation.
- GitHub Issues track remaining work; `docs/BACKLOG.md` remains the fast capture list for ideas during a conversation. Issues should link acceptance evidence rather than claim completion from a plan.
- `docs/DECISIONS.md` is the current decision record. Trial reports retain dated observations; later fixes do not rewrite prior failures into successes.
- Commit code, migrations and their relevant tests together. Record model, harness and skill versions when activating an owner. Keep the disposable trial and real league IDs distinct.
- The real league is **62282**; **46625** is the disposable scripted integration trial. Never promote test picks or synthetic conversations into real evidence.
- Production deployment is explicit and built from annotated tags on `main` (see [RELEASE.md](RELEASE.md)). A GitHub push does not activate agents, fund wallets, run a draft, ratify rules or publish an X batch.

## What MFL changes

We keep the parts that test agents working in an organization: persistence, communication, budget decisions, model identity, human collaboration and evidence. We hand football transaction rules and score calculation to MFL. The custom engine remains useful for repeatable tests and open-source demonstrations; it is not maintained as a competing live ledger.

The first MFL deployment is a connected setup surface. Rules, real owner activation, the live deadline observer and public launch have separate readiness evidence. Read `MFL_TRIAL_RESULTS.md` and `MFL_USE_BOUNDARY.md` for those limits.
