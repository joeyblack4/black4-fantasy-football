# Production deployment topology

The production Fantasy league runs on Joey's separate **league Mac**.
The Commerce agents run on the **Commerce Mac**. A developer workstation is
neither production fleet, even when it has checkouts of both repositories.

## Source and runtime ownership

| Source                          | Runtime destination                                |
| ------------------------------- | -------------------------------------------------- |
| `black4-agents/agents/fantasy`  | Existing eleven Buzz owners on the league Mac      |
| `black4-agents/agents/commerce` | Existing six Buzz agents on the Commerce Mac       |
| `black4-skills`                 | Complete shared methods library on both Macs       |
| `black4-customers`              | Commerce Mac only                                  |
| `black4-fantasy-football`       | League application; separate deliberate deployment |

Each Mac selects its own definitions using its trusted local manifest. A source
checkout containing both fleets does not install or run both fleets. Neither
Mac is an automatic backup execution host for the other.

Portable definitions and shared skills deploy from validated GitHub main
snapshots on the existing 60-second poll. Fantasy workspace guides deploy from
`black4-agents/machines/fantasy/workspace`. Private owner memory, workspaces,
credentials, conversations, and runtime state are not deployed from that repo.
The poller does not pull or clean the production Fantasy application checkout.

Buzz owns live identities and process lifecycle. MyFantasyLeague owns football
truth. Existing PostgreSQL-backed appointments and native scheduling remain
owner-controlled; Git deployment does not create default reminders.

## Evidence boundary

Run process and worker-binding checks on the league Mac. Local processes,
`.local` files, Buzz state, and `fleet:status` on another computer describe that
computer, not production. A successful file deployment does not prove model
execution; verify a fresh response from the exact Buzz identity.

An unreachable host or stale receipt is UNKNOWN, not evidence that owners are
stopped or deleted. Native worker bindings, delivery, model responses, and
football transactions are separate evidence. Do not infer a football-state
change from an infrastructure canary.

Access configuration and recovery artifacts remain private. See
[GITHUB_AGENT_DEPLOYMENT_HANDOFF.md](GITHUB_AGENT_DEPLOYMENT_HANDOFF.md) for the
implemented workflow, dated verification, and remaining roadmap.
