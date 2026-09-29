# Meta Mesh native Muse migration — September 28, 2026

Joey authorized replacing Goose with Muse Code for Meta Mesh as the first step of the native-harness sweep. Keep `b4-meta`, its Buzz identity, `muse-spark-1.3`, league ownership, workspace, owner strategy and existing spending limits. This supersedes the September 8 decision to defer Muse for this franchise only.

## Current status

**Prepared; production takeover pending account login and live validation.** Muse Code 1.4.1-R4380.1 and the pinned `@bex-co/muse-code-acp` 0.7.0 transport are installed on the league Mac. Its live registry still selects Goose. The proposed registry and launcher changes are in the `codex/meta-muse` worktree; they have not been activated.

The existing Goose failure is provider billing verification. Muse uses a separate browser sign-in in its own configuration directory. No subscription purchase, funding, limit increase or payment change was performed. Subscription eligibility and real model execution remain unverified until the account login is completed. The old PAYG key remains private for rollback; the Muse environment removes it and inherited gateway overrides.

## Connection

Buzz → existing `native-harness.mjs b4-meta` → pinned ACP adapter → native `muse exec --json`.

Use the adapter's explicit `exec` backend so native Muse owns each complete headless turn, including its tools, planning and helpers. Native session IDs persist between turns. The small `muse-native` launcher selects Muse's existing `--yolo` posture under the owner charter and excludes unrelated personal instructions/skills. Project instructions and project skills remain available. No alternative model or API fallback is installed.

Native state is franchise-local under `.local/franchise-runtimes/native-live/b4-meta/muse/{config,data,state}`. `MUSE_AUTH_PATH` points into that configuration directory. The workspace stays `franchises/meta/workspace`; existing personality, research, league commands and shared-skill references remain in place. Goose's separate state and history are retained, not represented as imported Muse conversations.

The native binary is pinned by path/version and its observed macOS ARM64 SHA-256 in `config/muse-runtime.json`; the transport dependencies are locked in `tooling/muse/package-lock.json`. Do not point production at the self-updating launcher. The adapter is an unofficial community transport, not Meta's agent implementation. Native execution remains Meta's Muse Code.

## Verification completed

- `node --test tests/muse-launch.test.mjs`: credential separation, preservation of native auth/memory/settings, and literal argument forwarding pass.
- `node tests/muse-acp-smoke.mjs` on the league Mac: real Muse executable with the **synthetic echo provider** passes ACP initialization, streamed output, two consecutive turns, adapter exit/restart, loading the same native session and another completed turn.
- These checks make **no Meta inference calls** and establish no live subscription, tool execution, Buzz delivery, or football outcome.

## Remaining activation

1. Complete native Muse login in the franchise-specific environment. Do not copy subscription credentials into Goose or a generic API client.
2. Run a bounded real `muse-spark-1.3` turn using that account and the existing workspace: verify authenticated own-team reads and native tool execution without changing a lineup, schedule or roster. Inspect native receipts; do not treat adapter labels as model or billing proof.
3. Update only Meta's entry in the production registry and add the Muse hook to the existing production launcher, preserving its unrelated local changes. Update the canonical Meta instructions in `joeyblack4/black4-agents` from Goose to Muse Code; inspect the reconciler before triggering its fleet restart.
4. Have Buzz retire the old Meta runtime and start the new one. Preserve deliberate stops and avoid concurrent Goose/Muse owners. Browser or native-app control requires Joey's explicit computer-use go-ahead.
5. Verify the same Buzz identity, current native process/model, authenticated league reads, and a fresh delivered reply. An earlier discarded request is not automatically replayed. Keep token/cost coverage explicit: the transport does not provide verified provider billing; old Goose accounting records remain historical.

References: [Muse headless operation](https://dev.meta.ai/docs/muse-code/extending), [subscription scope](https://dev.meta.ai/docs/muse-code/subscriptions), [adapter source](https://github.com/bex-co/muse-code-acp).
