# Running the league infrastructure

These files prepare a dedicated deployment. They do not provision model accounts, start paid inference by default, publish content, install a launch agent or configure an off-device destination. Use an always-on host with cooling and reliable networking. The laptop still sleeps when its lid closes; never put an awake laptop in a bag.

## Dedicated database and loopback API

Requirements: Docker with Compose, Node 22, and the repository lockfile. The Dockerfile pins official Node 22 and PostgreSQL 16 image digests. The image build context uses a whitelist that excludes `.local`, credentials and evidence. Compose grants secrets only to the services that need them, keeps PostgreSQL off host ports, and binds the API to `127.0.0.1:4313`.

```sh
node deploy/init-local.mjs
export FOOTBALL_CONTAINER_UID="$(id -u)"
export FOOTBALL_CONTAINER_GID="$(id -g)"
docker compose -f compose.live.yml up -d --build api
curl --fail http://127.0.0.1:4313/health
```

The generated secret directory is private, with mode 0600 files. Set the UID/GID to the host account that owns those files; this was verified on macOS Docker Desktop with UID 501/GID 20. The app runs without root privileges, with a read-only filesystem and writable temporary directory. Preserve `.local/deploy` across restarts. Changing the database password file does not rotate an initialized PostgreSQL role automatically.

`restart: unless-stopped` recovers process exits while Docker is running. The Docker daemon itself must start on host boot. Stopping the stack does not remove its named database volume. Never add `--volumes` to a production shutdown. `/health` verifies API/database connectivity; it is not proof that model, data, listener or scoring integrations are running.

The `league` profile enables the deadline clock after `FOOTBALL_LEAGUE_ID` is set to a verified league. The `live` profile is an explicit paid-inference boundary: it requires an approved provider manifest, exact tariff, reservation, and dedicated provider key. The provided worker is one manifest/owner process; deploy one separately configured service per franchise. Never scale one manifest service expecting new franchise identities. The worker validates its persisted manifest binding. Configure upstream provider spending limits as well as the local reserve: local reservation cannot prevent a provider reporting an overrun after a request.

For live workers, mount `model-key` and `model-tariff.json` and set `FOOTBALL_MANIFEST_ID`, `FOOTBALL_KEY_NAME` to the manifest's dedicated `B4_LEAGUE_*` environment reference, and `FOOTBALL_TURN_RESERVATION_MICROS`. No examples contain actual secrets. Buzz ingress, live data acquisition, public projection and public hosting need their own reviewed deployment; they are not implicitly started by these profiles.

## Local supervisor and macOS launchd

`scripts/supervise-local.mjs` supports API, clock, owner, Buzz listener/outbound, public projector/feed, billing and X publisher modes; see [per-service examples](services/README.md). Continuous services restart a crashed child with bounded exponential delay and forward shutdown signals. Billing runs once by default, with an explicit optional interval. `live` additionally requires `--allow-paid-inference`. Optional JSON configuration is data, never shell-sourced; see `local-supervisor.example.json`. Use secret-file references, not credentials in command arguments.

`black4-football-api.plist` is an uninstalled template. Replace its placeholders with absolute Node, repository, private config and log paths; verify with `plutil -lint` before installing it in the current user's LaunchAgents. It launches the API only. Install distinct clock/worker jobs only after their scope is configured. launchd supervision can restart after login; it does not establish autonomous operation on a sleeping or powered-off host.

`--keep-awake` optionally attaches `caffeinate -i -w <supervisor PID>` on macOS. This is an idle-sleep assertion limited to the supervisor lifetime. It does not change `pmset`, prevent lid sleep, or justify closing a running laptop in a bag. Omit it on a server with its own power policy.

## Encrypted backups and authenticated restore

Install [age](https://github.com/FiloSottile/age). Generate an age recipient and keep its private identity separately from this machine and the backup storage. The commands below use a **public** recipient and mounted database credentials. No password is placed in process arguments. PostgreSQL 16's tools run inside the dedicated database container, preventing host client-version mismatch.

```sh
node scripts/backup.mjs --project black4-football --recipient age1YOUR_PUBLIC_RECIPIENT --out /private/backup/directory
```

The backup streams `pg_dump` directly into age and writes only encrypted data to disk. A complete child process exit and stream pipeline are required before atomic rename. Each backup has a SHA-256 receipt and explicitly says off-device transfer is pending. Database snapshots include private messages, memories and audit records, so keep encrypted archives and access-controlled receipts.

To transfer to a preconfigured Linux SSH destination with an existing private directory and known host key:

```sh
node scripts/backup-copy.mjs --archive /private/backup/black4-TIMESTAMP-UUID.dump.age --host backupuser@backup.example --directory /private/black4
```

The transfer uses strict host-key checking and batch mode, uploads the encrypted archive and receipt, then verifies remote SHA-256. It creates a separate local transfer receipt. It never transfers the age identity. **No off-device destination is configured or tested in this repository.** Transfer verification is not a remote restore test. Keep a copy of the expected checksum in independent trusted storage; the adjacent checksum file is not a signature.

Create a fresh `black4_football_restore_*` database explicitly, then:

```sh
node scripts/restore-backup.mjs --project black4-football --archive /private/backup/black4-TIMESTAMP-UUID.dump.age --identity /private/keys/restore.age --sha256 TRUSTED_64_CHARACTER_HASH --target black4_football_restore_drill
```

Restore checks the expected checksum and authenticates the complete encrypted archive into a private temporary directory before any database writes. It refuses a nonempty target or any target outside the restore naming convention, then restores in one transaction. Temporary plaintext is deleted in `finally`; storage-level secure erasure is not promised. Never use the live database as a restore target. Verification, cutover and destruction of an old live database remain separate operator tasks.

Daily backup scheduling, retention, remote storage, recipient custody and periodic remote restore drills are deployment configuration still to complete. This build does not silently install recurring host jobs or claim disaster recovery is ready.

## Isolated verification

`deploy/verify-local.mjs` only accepts a `black4-football-validation*` Compose project. It verifies API health, loopback binding, no PostgreSQL host port, encrypted backup/restore of an exact synthetic row, rejection of nonempty targets and wrong checksums, and authenticated tamper failure before database mutation. It removes its unique tables/databases, test age identity and temporary archives. It writes `evidence/deployment-validation.json`. The stack itself is left for explicit scoped shutdown.

```sh
node deploy/init-local.mjs .local/deploy-validation
export FOOTBALL_DEPLOY_DIR=./.local/deploy-validation
export FOOTBALL_HOST_PORT=14313
export FOOTBALL_CONTAINER_UID="$(id -u)"
export FOOTBALL_CONTAINER_GID="$(id -g)"
docker compose -p black4-football-validation -f compose.live.yml up -d --build api
node deploy/verify-local.mjs --project black4-football-validation --api http://127.0.0.1:14313
```

The exact evidence is scoped to the image ID and synthetic fixture, not paid inference or production recovery. See [Docker's Compose secrets documentation](https://docs.docker.com/compose/how-tos/use-secrets/) for the file-mount permissions and operational model.

## Optional host Buzz bridge connection

The default stack publishes no database host port. A host process such as the Buzz ACP bridge can opt into `compose.host-bridge.yml` alongside `compose.live.yml`. This override publishes PostgreSQL **only** at `127.0.0.1:55435` (override with `FOOTBALL_POSTGRES_HOST_PORT`); it does not expose the database to the LAN. Set the same port when running `deploy/init-local.mjs`. That initializer now also writes a private `database-url.host` file; use it as the host bridge's database secret file. The container URL continues to resolve the internal `postgres` service name.

```sh
docker compose -f compose.live.yml -f compose.host-bridge.yml config --quiet
```

Use both files when starting or maintaining a stack that needs the host bridge. This optional configuration was structurally checked but not started. It has a different network boundary from the measured default-stack evidence, whose `noDatabaseHostPort` check still describes the default deployment. Never change the binding to `0.0.0.0` for convenience.

Manifest secrets are raw key-value files (for example `B4_LEAGUE_TEAM.key`), not shell `.env` assignments. In the local supervisor `secretFiles`, map the exact manifest `B4_LEAGUE_*` reference to that raw file path. For the container worker, `FOOTBALL_KEY_NAME` holds that same reference and `model_key` mounts its raw file. Keep all key files mode 0600 in a private directory.
