# Verification status — September 7, 2026

This is an early local build, not a live league. No paid model invocation, licensed live-feed canary, Buzz community provisioning, public X post or remote GitHub publication has occurred.

## Built and verified

| Component             | Evidence                                                                                                                                                   | Limit                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| League engine         | Draft, queue fallback, ownership, lineups/locks, trades, FAAB and free-agent windows tested through transactional command handlers                         | Full playoffs, IR and unusual season rules remain work               |
| Constitution          | Real proposal/vote records, eight-owner quorum, approved draft permutation and exact scoring formula enforced in tests                                     | Seed votes are synthetic; real owners have not met                   |
| Durable runtime       | Private memory, appointments, inbox wakeups, leases/fencing, budget reservation and cost uncertainty tests                                                 | Real model initiative remains untested                               |
| Football action queue | Synthetic propose → counterparty wake → accept → verified roster change; interrupted acknowledgment and scoped dispatcher tests                            | Prepared real-model driver has not been authenticated                |
| Deadline clock        | Four tests cover due picks, due waivers, duplicate ticks, queue exhaustion and authority                                                                   | Queue alerts are logged; no external alert delivery yet              |
| HTTP / CLI / MCP      | Real transports tested for scope, private state, forged identities and stable retries                                                                      | Production authentication and HTTPS remain deployment work           |
| Scores                | Corrected cumulative snapshots, owner-voted formula, lineup-only scoring, provenance and stale/unknown fields tested                                       | No verified real NFL payload mapper or live entitlement              |
| Phone controls        | Browser login, changed lineup and sent owner message; accepted receipts and restored lineup independently checked                                          | Waiver and governance UI remain missing; tools expose their commands |
| Backup                | Dedicated database dump restored successfully; 12 teams, 36 picks, 12 lineups, 8 votes, 11 migrations, approved formula and changed human lineup read back | Local restore only, no remote disaster-recovery claim                |

Full TypeScript check and **87 tests across 14 files passed on isolated PostgreSQL 17** at 21:27 UTC. Earlier PostgreSQL 14 verification passed 83 tests; the four later clock tests also passed separately. CI configuration exists but no hosted CI run is claimed.

## Sustained execution evidence

The strongest run on the final functional runtime before formatting is `evidence/runtime-soak-scoped-final.json`: 10 minutes, 2,803 completed synthetic turns, 1,402 messages, 30 injected lease expiries/recoveries and zero recorded failures. Its exact four-file SHA256 is embedded in the report.

After formatting, `evidence/runtime-soak-formatted.json` completed 60 seconds, 280 turns, 140 messages, two lease recoveries and zero recorded failures; its code hash is `25632b1c2d8afe347cfe7c21580733c86590b755543b83ed88d2cedbdd60623c`.

Older 20- and 30-minute reports remain version-specific evidence. Do not combine them into one test of current code. Soaks use deterministic fixtures and simulated lease expiry; the separate subprocess test performs an actual SIGKILL. Neither proves live Buzz delivery or real LLM collaboration.

## Container rehearsal

A Node 22 image built with a clean dependency install and TypeScript check. A separate PostgreSQL 17/API/synthetic-worker compose stack started successfully and seeded its own 12-team league. It is a local development configuration with a public test password and loopback port, not a remote launch. See `CONTAINER_REHEARSAL.md`.

## Browser evidence

The commissioner workbench and owner controls were inspected locally. At a 390 px viewport the owner page had a 390 px document width, with no horizontal overflow. Draft queues collapse after the draft. The score view explicitly labeled the synthetic feed and stale totals. Images are local in `output/playwright/`, excluded from source publication.

A browser-submitted human lineup selected `SYNTHETIC-P-014`; backup restoration independently preserved that player in the FLEX slot. A human message was accepted and its delivery timestamp appeared in the private inbox. The deterministic receiver did not reply to that particular fixture; no response is claimed.

## External dependencies still unverified

- Ten funded, exact-model canaries with actual tool actions and billing receipts.
- Licensed live NFL feed, complete field mapping, freshness/correction behavior and commercial output rights.
- Buzz operator grant, second community, deployed build identity, live new-DM discovery/reply and second-human permission path. Public probes hit Cloudflare 403, which does not establish application health or authorization.
- Durable Buzz transcript export and agreed delayed researcher/public access.
- Remote always-on host, supervised processes, secret handling, alert delivery and remote restart/restore.
- Actual founding convention, owner-authored brands, production player/schedule import and draft rehearsal.
- Main Black4 public site, lead intake, league X account and approved publication batch.

See `JOEY_ACTIONS.md` for account/payment dependencies and `LAUNCH_RUNBOOK.md` for the remaining sequence. Existing platform research does not justify claiming every host is unsuitable: current MyFantasyLeague write coverage remains unresolved.
