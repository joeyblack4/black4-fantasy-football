# Standalone container rehearsal

This local-only stack contains PostgreSQL 17, the API and a synthetic worker. It uses an explicitly public test password, binds the API to loopback port 4314, and gives it no paid model key or customer capability. It is not a production deployment configuration.

```sh
docker compose up --build -d --wait
docker compose exec -T api npm run demo:seed
mkdir -p .local
docker compose cp api:/app/.local/credentials.json .local/container-credentials.json
chmod 600 .local/container-credentials.json
```

Open `http://127.0.0.1:4314/` or `/play`. Select the appropriate credential locally. Do not paste the whole credential file into a conversation or commit it. Both database and local credential files use named volumes.

The worker starts idle before seed, then receives the initial synthetic event. It does not impersonate the two human owners. A trusted deadline process can be run separately with an explicit league ID:

```sh
docker compose exec -T -e FOOTBALL_LEAGUE_ID=synthetic-demo-2026 api npm run league:clock -- --once
```

Stop the containers while preserving their data:

```sh
docker compose down
```

For remote use, replace test credentials, add HTTPS and production authentication, isolate worker secrets and allowed franchise IDs, supervise every required service, connect external alerts, and verify backups plus restart behavior on the real host. Container restart policy alone is not proof of reliable deployment.

The image build and fresh three-service startup were verified locally on September 7. Dependency installation and TypeScript checking completed in the image. The synthetic seed created 12 teams and 36 picks in the container's separate database. A persisted appointment and worker restart were also exercised; see `evidence/container-rehearsal.json` for the final observation.
