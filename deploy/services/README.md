# Reviewable host service configurations

These templates are not installed or active. Copy each selected example to a private operator directory, replace identifiers and absolute paths, and inspect its plan before starting it. Secret files contain raw values followed by an optional newline, not `.env` assignments. Never paste a key into `environment`.

```sh
FOOTBALL_SUPERVISOR_CONFIG=/absolute/private/path/service.json \
node scripts/supervise-local.mjs SERVICE --print-plan
```

The plan prints the fixed script/arguments, restart policy, environment key names and secret reference names. It does **not** read secret values, start a child, contact a service or claim credentials are callable. Paths in examples are intentionally unresolved placeholders. Use distinct private log paths and host service labels per franchise/process.

| Service mode        | Example                          | Additional execution flag                 | Behavior                                                                                                        |
| ------------------- | -------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `api`               | `api.example.json`               | None                                      | Private HTTP API, continuous                                                                                    |
| `clock`             | `clock.example.json`             | None                                      | Scoped league deadline/event dispatcher, continuous; `--once` supported                                         |
| `live`              | `owner.example.json`             | `--allow-paid-inference`                  | One exact active franchise manifest; continuous; `--once` supported                                             |
| `buzz-listener`     | `buzz-listener.example.json`     | `--allow-buzz-reads`                      | Real scoped relay listener and durable archive; continuous; `--once` supported                                  |
| `buzz-outbound`     | `buzz-outbound.example.json`     | `--allow-buzz-sends`                      | Dispatches already durable franchise peer messages; continuous; `--once` supported                              |
| `public-projector`  | `public-projector.example.json`  | None                                      | Refreshes the sanitized public projection in the private database; continuous; `--once` supported               |
| `public-feed`       | `public-feed.example.json`       | None                                      | Loopback public-data reader with a separately provisioned SELECT-only credential; continuous                    |
| `billing-reconcile` | `billing-reconcile.example.json` | `--allow-billing-reconciliation`          | One metadata/accounting pass and exit, including on failure; no inference or automatic activation               |
| `billing-reconcile` | `billing-periodic.example.json`  | `--allow-billing-reconciliation --repeat` | Explicit 15-minute interval after each pass; configurable from one minute to one day                            |
| `x-publisher`       | `x-publisher.example.json`       | `--allow-public-publishing`               | Requires explicit enabled setting, scoped user token and exact approved batches; continuous; `--once` supported |

`synthetic` remains available for isolated fixtures, with `--once` support. It is not a model-owner substitute.

Continuous services restart when their process exits, with exponential delay up to 60 seconds. Billing is intentionally a one-shot unless `--repeat` and `repeatIntervalMs` are both present. `--once` makes supported modes terminate after the child exits and propagates its exit code; it never silently schedules another attempt. `--once` and `--repeat` cannot be combined.

For a one-shot launchd job, do **not** reuse the API template's unconditional `KeepAlive=true`: the outer supervisor would relaunch it. Use an operator-reviewed scheduled launchd definition with KeepAlive disabled, or use the explicit periodic billing mode in a persistent host job. Nothing in this directory installs either option.

## Credential and authority boundaries

- The supervisor launches only the fixed script map through Node/tsx; it accepts no arbitrary shell command or child argument pass-through. Its working directory is the repository, independent of the invoking directory.
- The child receives selected OS settings and reviewed service variables. It does not inherit the calling shell's customer credentials, OpenRouter management key, `NODE_OPTIONS`, or arbitrary `B4_LEAGUE_*` variables. Existing host launch configs must explicitly map raw secret files; inherited secret values alone are no longer sufficient.
- Private database credentials use `secretFiles.DATABASE_URL` or an explicit `DATABASE_URL_FILE`. An explicit `secretFiles.DATABASE_URL` wins over an inherited URL-file setting. There is no implicit development database fallback in the supervisor.
- Owner/billing inference references must match the manifest's exact `B4_LEAGUE_*` key reference. `B4_LEAGUE_OPENAI_INFERENCE` is only an example name. No management credential is accepted. One owner process is one manifest/franchise; do not scale a single config to create other owners.
- Public feed accepts only `FOOTBALL_PUBLIC_DATABASE_URL` through its secret mapping and receives no private database URL. The database role's SELECT-only grants still require independent provisioning/verification. The supervisor does not create that role or expose a public network listener; the feed script binds loopback.
- The X template defaults to `FOOTBALL_X_PUBLISHING_ENABLED=false`. After explicit account/operator activation, the setting and `--allow-public-publishing` must both be present. The publisher still requires immutable exact-batch approval; a supervisor flag cannot approve content.
- Buzz outbound uses managed signing identities referenced by persisted league bindings. It has no inference key or commissioner token in its example and does not perform registration, account creation or ingress cutover.
- Buzz listener uses `serviceConfig`, shown in `buzz-listener-service.example.json`. Replace the verified pubkey, executable and private paths. Its embedded league must match the supervisor league, and its signing/auth references must exactly match the supplied secret-file names. Configure the identity's supported ingress mode first; do not run a competing polling path alongside managed ACP ingress. The supervisor does not change ingress mode.

The original optional `--keep-awake` behavior remains a scoped idle assertion while the supervisor is alive. No global power setting, launchd installation, tunnel or new service was changed by preparing these configurations.

## Verification performed

All nine configured service plans were parsed without reading their placeholder secret files or starting child processes. Five isolated mocked process checks covered one-shot failure propagation with no retry, the explicit periodic interval, paid-inference gating before secrets/spawn, public-feed credential isolation and daemon restart delay. Syntax and formatting checks passed. These are supervisor behavior checks, not live Buzz/X/provider compatibility or service uptime evidence.
