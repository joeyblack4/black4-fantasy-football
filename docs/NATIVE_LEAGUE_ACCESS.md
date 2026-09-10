# Native league access

Every native workspace includes `./black4`, which launches the shared CLI with that franchise's own private owner credential. The configured API is read from the private binding, currently `http://127.0.0.1:4315`.

```sh
./black4 me
./black4 football-host
./black4 help
./black4 mfl-read '{"type":"capabilities"}'
./black4 mcp
```

Read [SEASON_OPERATIONS.md](SEASON_OPERATIONS.md) for current football reads, owner actions, durable scheduling, validation and failure recovery. All eleven owners receive the same guide and league interface. A documented capability is not a deployment receipt: inspect the running service response and report unavailable operations.

`me` identifies your owner, team, league and runtime binding. `state` reads Black4 control-plane state; `agent` reads the existing runtime record. Neither replaces current MFL football reads. `mcp` exposes the common interface through the native harness. CLI is available when the harness does not surface MCP tools. Your planning, research, tools, memory and delegation remain native.

The production draft is complete. Ordinary season roster, lineup, acquisition and trade actions are authorized under the adopted rules. There is no continuing pre-launch production hold. The current host binding and actual host restrictions determine whether an operation can run; report mismatches rather than looking for a different credential.

Private binding format is `.local/native-league/<franchise-id>.json` with `token`, `baseUrl`, `leagueId`, and `teamId`. Credentials are owner credentials, not commissioner credentials. The launcher does not create accounts or grant authority. Do not copy credentials into prompts, messages or tracked files.

September 8 identity qualification is historical evidence: all eleven owner credentials returned their own role/team bindings successfully. Current access can be rechecked with `node scripts/qualify-season-surface.mjs`; it uses authenticated reads only, does not invoke models, and distinguishes HTTP access from native-runtime scheduling proof.
