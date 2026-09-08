# Read-only draft readiness

Run the report against an explicitly selected database and league:

```sh
DATABASE_URL_FILE=/absolute/private/path/database-url.host \
FOOTBALL_LEAGUE_ID=black4-fantasy-2026 \
node --import tsx scripts/readiness.ts
```

`DATABASE_URL` is also supported through the process environment, never a command-line argument. The CLI does not fall back to the development database. It does not read model secrets, call a provider, migrate, create jobs, reconcile charges, send messages or activate anything. PostgreSQL runs the inspection in a repeatable-read, read-only transaction with a five-second statement timeout.

Output is JSON with `readyForDraft`, `missingGates`, individual gate status/evidence and a separate filesystem evidence inventory. Exit code **2** means at least one draft gate is missing, failed or unknown. Exit code **0** would mean all implemented draft evidence checks pass, not permission to start the draft or a guarantee of current provider uptime. A missing/unreachable database produces an unknown result rather than a success with empty counts.

The current reporter deliberately cannot produce an all-green live-launch claim: the repository still lacks machine-verifiable import provenance and current worker/clock/bridge heartbeat evidence. Those gates stay unknown until the corresponding evidence interfaces exist. There is no force-ready flag or editable JSON override.

## What is checked

| Gate group              | Required evidence                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database and field      | Current migration names recorded; exact league in setup; ten AI/two human teams; one matching runtime identity per team                                                                                     |
| Human owners            | Two non-placeholder human identities and their own unrevoked owner credentials. Availability still needs operator confirmation                                                                              |
| Model identity          | Ten distinct approved developer manifests, each active and matching the enabled runtime owner's exact model                                                                                                 |
| Guardrails and canaries | Latest assignment, wrong-model, wrong-provider and key-limit checks all pass with nonsynthetic evidence; exact generation/model/provider/cost canary for each active manifest                               |
| Accounting              | No uncertain runtime/service reserves, unreconciled provider calls or discrepancy alerts; owner wallets retain headroom. An unused wallet is not proof of upstream funded credits                           |
| Governance              | Immutable proposal hash, eight authenticated owner yes-votes, closed voting window, current capability version, matching scoring/rules hash and consumed commissioner ratification                          |
| Players and queues      | Enough non-placeholder player rows with positions; valid private queue per owner and its command receipt. AI queue contents must match a delivered football action from a nonsynthetic completed owner turn |
| Buzz                    | Real community/consent binding; matching owners; real ACP/relay inbox deliveries; reciprocal peer messages with a linked reply independently observed in the real archive                                   |
| Owner runtime           | Each AI completed a recent nonsynthetic owner turn, separately from its provider canary                                                                                                                     |

Guardrail/provider canary and owner-turn freshness defaults to **24 hours**. `FOOTBALL_READINESS_MAX_EVIDENCE_AGE_SECONDS` can set 60 seconds through seven days; the report exposes the chosen bound. A recent observation does not prove a worker remains running.

## Explicit verification gaps

- **Player provenance:** `league_players` currently has no authenticated vendor identity/import verification receipt. Its row count and the mapper's structural coverage report cannot establish a verified live player pool. The gate remains missing/unknown.
- **Service liveness:** there is no durable, scoped heartbeat registry for worker, clock, bridge and alert delivery. Old restart tests or owner turns do not substitute for current service evidence.
- **Live scoring:** source-dated nonsynthetic rows are counted as context only. Authenticated semantics, independent score/correction reconciliation, entitlements, quotas and public display rights remain unknown here.
- **Off-device recovery:** the local encrypted restore test is real but scoped to synthetic local fixtures. It is not evidence of off-device key custody or recovery of this live league.
- **Public release:** website deployment, exact approved content, X authorization and intake delivery are separate release checks and do not become green from draft readiness.
- **Discrepancy closure:** billing alerts are append-only and currently lack a reviewed closure record; this report conservatively keeps them blocking. It never adjusts a wallet to make the gate pass.

The filesystem inventory hashes known evidence files and labels them historical or synthetic/local. It never evaluates their prose as instructions or treats file presence as a live pass. A migration-name match also does not prove that a historical migration's SQL bytes were unchanged; the existing migration registry stores names only.

## Observed dedicated league snapshot

Checked `2026-09-08T02:12:43.900Z` against `black4-fantasy-2026` using its private host database URL file. `readyForDraft: false`; **14 required gates unresolved**. No state was changed.

| Gate                  | Observed status |
| --------------------- | --------------- |
| `database`            | pass            |
| `schema`              | pass            |
| `league`              | pass            |
| `field`               | pass            |
| `human_owners`        | missing         |
| `runtime_bindings`    | pass            |
| `active_models`       | missing         |
| `provider_guardrails` | missing         |
| `provider_canaries`   | missing         |
| `billing`             | pass            |
| `governance`          | missing         |
| `player_pool`         | missing         |
| `player_pool_source`  | missing         |
| `owner_queues`        | missing         |
| `buzz_binding`        | missing         |
| `buzz_participants`   | missing         |
| `buzz_ingress`        | missing         |
| `buzz_peer_canary`    | missing         |
| `owner_runtime`       | missing         |
| `service_liveness`    | unknown         |
| `live_scoring`        | unknown         |
| `offdevice_recovery`  | unknown         |
| `public_release`      | unknown         |

The snapshot contains 12 seats and 12 matching runtime bindings, with 10 AI seats and two human seats. The confirmed human display names are Joey Sterling and Chris Schaaf. Chris still lacks an authenticated owner credential and Buzz mapping. Stable seat/runtime/owner IDs remain unchanged; placeholder checks inspect display names only. There are zero valid active manifests, zero players (192 needed under the provisional 16-player roster), zero saved queues and zero Buzz participants. No recorded uncertain costs exist because inference has not started; this is not a compute funding or live-agent readiness claim.

This is a dated snapshot. Rerun the CLI for current state, especially after onboarding, model activation, governance, roster imports or worker deployment. Keep output private if owner identifiers should not be public. Redirecting output to a file is an operator choice; the CLI itself writes only stdout.
