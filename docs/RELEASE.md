# Releasing the league services

Every production artifact is built from an annotated tag on `main`, so the running code can always be traced to a commit.

## What runs today (September 14, 2026)

- **API** (`black4-football-api-1`, Docker, `127.0.0.1:4315`): image `black4-football:yahoo-timing-20260913`, a chain of `work/*/Dockerfile` overlays applied to the `season-20260909-r3` base. The compose project references eleven files, four under the ignored `work/` and three under `.local/`. Its adapter code is the September 13 Yahoo-timing change, which is now on `main` (PR #2).
- **Season dispatcher** (`ai.black4.football.season-dispatcher`, launchd): runs a frozen copy under `.local/season-infrastructure/season-20260909-r3-host/`, equal to `main` before PR #3's `failOccurrence` addition.
- **Public scoreboard publisher** (`ai.black4.football.public-scoreboard`, launchd, to be installed): `scripts/public-scoreboard.ts` from a tagged checkout.

## Convention

1. Tag: `git tag -a api-YYYYMMDD-rN -m "…" && git push origin api-YYYYMMDD-rN`. One tag per release; the same tag is used for host-side scripts.
2. Build the API image from the tag, never from the working tree, and stamp it:
   ```sh
   TAG=api-20260916-r1
   git archive --format=tar "$TAG" | docker build --file deploy/Dockerfile \
     --label org.opencontainers.image.revision="$(git rev-parse "$TAG^{commit}")" \
     --label org.opencontainers.image.version="$TAG" -t "black4-football:$TAG" -
   ```
3. Pin the image in the tracked `compose.release.yml` (`services.api.image: black4-football:<tag>`); keep secrets and machine paths in `.local/*/compose.*.yml`. Deploy with the usual compose file list plus `-f compose.release.yml`, then `node deploy/verify-local.mjs`, then write `evidence/releases/<tag>.json` (tag, commit, image digest, compose files, migrations applied, health).
4. Host-side scripts (dispatcher, scoreboard publisher) run from `git archive <tag> scripts src package.json config | tar -x -C .local/season-infrastructure/<tag>-host/`; point the launchd plist at that directory and record the tag in `deployed.json`.
5. `work/` overlays are for emergencies only. An emergency change must land as a pull request within 24 hours and the tag rebuilt; `work/` keeps receipts, not source of truth.
6. Provenance check anyone can run: `docker inspect black4-football-api-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'` must equal `git rev-parse <tag>^{commit}`.

## First cutover

Planned for Tuesday, September 15, 2026, after the Monday night game: tag `main` (which now contains the deployed Yahoo-timing adapter, the schedule-recovery work and the scoreboard publisher), rebuild the API image from the tag, restart `api` with `compose.release.yml`, move the dispatcher and the scoreboard publisher to the tagged checkout, and record the receipt. Until then the running services are unchanged.
