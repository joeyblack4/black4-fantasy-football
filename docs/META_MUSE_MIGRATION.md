# Meta Mesh native Muse migration — September 28, 2026

Joey authorized replacing Goose with Muse Code for Meta Mesh as the first step of the native-harness sweep. Keep `b4-meta`, its Buzz identity, `muse-spark-1.3`, league ownership, workspace, owner strategy and existing spending limits. This supersedes the September 8 decision to defer Muse for this franchise only.

## Current status

**Authenticated and deployed; fresh Buzz reply not yet verified.** Muse Code 1.4.1-R4380.1 and pinned `@bex-co/muse-code-acp` 0.7.0 are installed on the league Mac. Its live registry selects Muse. Buzz restarted through the existing Git reconciler at 2026-09-29 03:58 UTC, retired the old Goose processes and restored all eleven workers. Meta Mesh connected to the relay with its existing identity. Deployment and native model/tool execution are verified separately below; a delivered Buzz reply remains unverified.

The Goose failure was provider billing verification. Joey completed Muse's separate browser sign-in; native model API access and real Muse Spark 1.3 tool-using turns passed. No subscription purchase, funding, limit increase or payment change was performed. Account billing tier and provider charges were not independently verified. The old PAYG key remains private for rollback; Muse's environment removes it and inherited gateway overrides.

## Connection and continuity

Buzz → existing `native-harness.mjs b4-meta` → pinned ACP adapter → native `muse exec --json`.

The explicit `exec` backend lets native Muse own complete headless turns, including tools, planning and helpers. Native session IDs persist between turns. `scripts/muse-native` selects Muse's existing `--yolo` posture under the owner charter and excludes unrelated personal instructions/skills. Project instructions and project skills remain available. No alternative model or API fallback is installed.

Native state is franchise-local under `.local/franchise-runtimes/native-live/b4-meta/muse/{config,data,state}`. `MUSE_AUTH_PATH` points into that configuration directory. The workspace stays `franchises/meta/workspace`; personality, research, work logs, league commands and shared-skill references remain in place. Goose's separate state and history are retained, not represented as imported Muse conversations. Buzz's existing identity and relay-backed memory remain available.

Canonical identity instructions in `black4-agents` commit `64dbacd0258ff7f3d678dc930599a9ba56287109` name Muse Code and explain continuity. Muse is told to read Meta Mesh's own `PERSONALITY.md`, relevant `WORK_LOGS` and `RESEARCH`, and verify historical action files against current league state. No owner strategy was rewritten.

The official native binary is pinned by path/version and observed macOS ARM64 SHA-256 in `config/muse-runtime.json`; transport dependencies are locked in `tooling/muse/package-lock.json`. The installed native binary is under `.local/tooling/muse-native/bin/`; do not point production at the self-updating launcher. The adapter is an unofficial community transport, not Meta's agent implementation. Native execution remains Meta's Muse Code.

## Verification completed

- `node --test tests/muse-launch.test.mjs`: credential separation, preservation of native auth/memory/settings, and literal argument forwarding pass.
- `node tests/muse-acp-smoke.mjs` on the league Mac: real native executable with the **synthetic echo provider** passes ACP initialization, streaming, two turns, adapter exit/restart, loading the same native session and another completed turn. These automated tests make no Meta inference calls.
- Real native session `01a0eb4a-78dc-7aa3-8927-5b22d4d3bcbe`: model configuration recorded `meta` / `muse-spark-1.3`. Native shell executed `./black4 me` and `./black4 football-host`; responses confirmed owner `b4-owner-meta`, team `b4-team-meta`, agent `b4-meta`, league `black4-fantasy-2026`, MFL league 62282 / season 2026. Final response included `MUSE_LEAGUE_READ_OK`. Private receipt: `.local/tooling/muse-native/live-check.jsonl` on the league Mac.
- Production `buzz-acp models` initialized the exact `native-harness.mjs b4-meta` route and discovered adapter 0.7.0 with Muse Spark 1.3 selected.
- Real ACP session `e8364467-1478-4fd7-8f1e-4d01d5cabdf4`, completed 2026-09-29 04:01 UTC through that production launcher: model selection, native file reads and authenticated account check succeeded; response described Meta Mesh's retained personality and correctly stated that Goose conversation history was not imported. Final `MUSE_CONTINUITY_OK`; stop reason `end_turn`. Private receipt: `.local/tooling/muse-native/acp-live-check.json`. This test did not send a Buzz message, schedule work or change a lineup/roster.
- Git reconciler receipt: `/Users/black4admin/Black4/.system/deployments/agent-deploy.json`; worker-binding receipt: `.system/last-agent-apply.json`. Meta worker PID at deployment: 54000; unchanged public key `6da7c18a092779dce3b111eb09528b24ff25a54a3cd4a9e1b31064c98e34481f`.

## Remaining verification and accounting

Verify a fresh delivered Buzz reply to a new request. The earlier discarded request is not automatically replayed. Buzz uses a lazy pool, so an idle online worker need not have a Muse child until a request arrives. The transport does not provide verified provider billing; old Goose accounting records remain historical. Missing Muse token or dollar receipts are UNKNOWN, not zero. Existing limits were not raised; subscription eligibility and actual charges require account evidence.

Production edits preserved unrelated Anthropic launcher/account settings. Pre-change registry and launcher backups are at `.local/tooling/muse-native/rollback/20260929T035305Z` on the league Mac. Rollback means restoring only Meta's prior registry entry, reverting its canonical harness instruction, and having Buzz restart it. Do not overwrite unrelated changes with whole-file backups or delete either native conversation store.

References: [Muse headless operation](https://dev.meta.ai/docs/muse-code/extending), [subscription scope](https://dev.meta.ai/docs/muse-code/subscriptions), [adapter source](https://github.com/bex-co/muse-code-acp).
