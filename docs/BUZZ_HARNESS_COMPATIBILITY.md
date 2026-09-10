## Later September 8 selection

The native-harness research below is retained as evidence. Joey subsequently authorized Goose for Meta and Z.ai to simplify the Buzz integration; their native bridges are no longer prerequisites. See [current lineup](BUZZ_FIRST_LINEUP.md).

# One Buzz interface, ten native harnesses — 2026-09-08

Status: compatibility research and offline CLI/schema inspection. No provider inference, login, install, credentials read, or production action. This document audits the harness side; the accompanying local Buzz inspection establishes what the installed Buzz client actually implements.

## Decision

Keep **one Buzz UI**. Six harnesses expose native ACP; Codex and Claude have maintained ACP transport adapters around their native runtime/SDK; Muse exposes a documented native protocol that can be translated into the same UI. ZCode is the remaining vendor-support gap, with concrete community bridges demonstrating a route worth validating. None of the observed protocol differences requires making Joey use ten separate interfaces.

An ACP transport adapter does not replace cognition: Codex still uses Codex App Server, Claude uses Anthropic's Agent SDK, and Muse would still use its native MSP host. Preserve native planning, memory, context and tools behind those transports. Do not route everything through Goose cognition just because Goose is compatible with the UI.

## Connection matrix

Commands below describe integration entrypoints, not authorization to run inference. Pin package/binary versions before deployment; do not copy unpinned `npx` commands into production launchers.

| Franchise / harness         | Buzz-facing route                                                       | Exact documented entrypoint                                                              | Evidence level and important limits                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI / Codex              | Existing maintained ACP adapter → native Codex App Server               | `codex-acp`; package `@agentclientprotocol/codex-acp`                                    | Maintainer source; root audit passed initialize against installed adapter 1.2.0, without authentication, native session or prompt. The older Zed adapter is archived.                                                |
| Anthropic / Claude Code     | Existing maintained ACP adapter → official Claude Agent SDK             | `claude-agent-acp`; package `@agentclientprotocol/claude-agent-acp`                      | Maintainer source. Claude CLI locally installed; adapter handshake not performed here.                                                                                                                               |
| Google / Gemini CLI         | Native ACP                                                              | `gemini --acp`                                                                           | Current upstream source. `--experimental-acp` remains a deprecated alias in source; some CLI reference prose is stale. No local binary found.                                                                        |
| xAI / Grok Build            | Native ACP                                                              | `grok agent stdio`                                                                       | Official xAI documentation. No local binary found.                                                                                                                                                                   |
| Meta / Muse Code            | Thin Buzz ACP↔MSP adapter, or direct MSP driver behind the same Buzz UI | `muse serve`                                                                             | Installed CLI 1.0.2-R2040.1 help and exact offline embedded schema; official SDK source verifies NDJSON framing. Not ACP. Root initialize-only probe timed out after 12 seconds; live transport remains unqualified. |
| DeepSeek / DeepSeek Harness | Native ACP                                                              | `dsh --profile acp`                                                                      | Official architecture and current source. Uses `session/resume`, not the legacy `session/load` method. No local binary found.                                                                                        |
| Qwen / Qwen Code            | Native ACP                                                              | `qwen --acp`                                                                             | Official architecture; same native engine is used by its daemon/IDE surfaces. No local binary found.                                                                                                                 |
| Mistral / Vibe              | Native ACP                                                              | `vibe-acp`                                                                               | Official setup instructions and current source. No local binary found.                                                                                                                                               |
| Kimi / Kimi Code            | Native ACP                                                              | `kimi acp`                                                                               | Official current method/capability matrix. No local binary found.                                                                                                                                                    |
| Z.ai / ZCode                | Native app-server → thin/community ACP adapter candidate                | Vendor-supported command UNKNOWN; community bridges drive bundled `zcode.cjs app-server` | Official desktop harness verified. No installed ZCode app found in `/Applications` or `~/Applications`; stable vendor protocol support unverified. Keep this integration staged.                                     |

### Codex and Claude adapters

The [current Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) runs Codex App Server and maps messages, tools, permissions, MCP, usage, model/effort/mode configuration and images. Native subagent sessions and background task features require bilateral capability negotiation; older clients receive a reduced tool-call view. It bundles a compatible Codex dependency and accepts `CODEX_PATH` for an explicit binary. The [former adapter](https://github.com/zed-industries/codex-acp) was archived July 22 and directs new users to this package.

The [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp) uses the official Agent SDK and supports tool approvals, context, images, MCP, terminals and subagent transcripts. Its [package manifest](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/package.json) declares the exact `claude-agent-acp` executable. Extended permission presentation, recovery and child sessions are negotiated features; ordinary ACP support alone does not prove Buzz renders them. Pin adapters with their runtime dependency, and keep native user config/auth in franchise-scoped storage.

### Gemini, Grok and Qwen

[Gemini argument source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts) exposes `--acp` and marks `--experimental-acp` deprecated. Its [ACP dispatcher](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpRpcDispatcher.ts) advertises session loading, images/audio/embedded context and HTTP/SSE MCP, and implements cancellation and session modes. The [session manager](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpSessionManager.ts) carries `cwd` and MCP servers into new/loaded sessions. Exact model-setting behavior must be tested against the pinned build, not inferred from a UI selector.

[Grok's official ACP example](https://docs.x.ai/build/cli/headless-scripting) starts `grok agent stdio`, uses stdin/stdout JSON-RPC, initializes, creates a session with `cwd`/MCP configuration, sends a prompt, and receives text through `session/update`. Use existing authorized auth or the documented xAI key path. The page does not establish every resume, permission, attachment and cancellation edge case; those remain handshake/conformance checks. Headless `--model` exists but does not itself certify every internal helper model.

[Qwen's official architecture](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/) describes `qwen --acp` as the same native runtime used by the daemon: session multiplexing, prompt/cancel forwarding, permission mediation, event streaming, scoped filesystem and MCP boundaries. The daemon's HTTP/SSE UI is optional; Buzz can be the ACP client directly. Do not add Qwen's daemon merely to display chat. Exact initialized capability fields and feature negotiation still require the chosen release's local probe.

### Mistral and Kimi

[Mistral's official ACP setup](https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md) specifies `vibe-acp`. The [Mistral IDE guide](https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides) explicitly says third-party ACP clients use the same engine, configuration, agents, skills and MCP. Current [agent source](https://github.com/mistralai/mistral-vibe/blob/main/vibe/acp/agent.py) implements new/load/list/resume/fork/close sessions, cancellation, configuration and mode updates, prompts, callback mediation and usage updates. It advertises images and embedded context, not audio. Config/MCP capability acceptance must still be reconciled with its installed version and Buzz's client protocol version.

[Kimi's current ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) provides the clearest explicit matrix: core and session methods, text/tool/plan/config/command updates, client filesystem/terminal methods, permission/questions and model configuration. It forwards stdio, HTTP and SSE MCP; ACP-type MCP entries are dropped with a warning. Provider-management, inline-edit prediction, document synchronization and `elicitation/complete` are unsupported. Forms can use `elicitation/create` where advertised, otherwise the permission channel. Buzz must not declare capabilities it cannot actually fulfill. [IDE setup](https://moonshotai.github.io/kimi-code/en/guides/ides.html) confirms `kimi acp` and reused auth; use an absolute executable path for GUI-launched processes.

### DeepSeek's ACP needs version-aware resume

[Official architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/) establishes the `acp` profile. The [current ACP implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/index.ts) advertises `sessionCapabilities` list/resume/close, HTTP MCP, model-dependent images, no audio and no embedded context. It sends approvals through client `session/request_permission`, supports config options, cancellation and persisted resume, and advertises no authentication methods: credentials must already be configured.

The implementation registers `session/resume`, not `session/load`. Buzz must negotiate the current session capability and invoke the correct method. Sending `load` unconditionally would create a false incompatibility. Embedded league snapshots should be text/resource content supported by the negotiated capability, not attachments assumed to work because another model accepts them. Use full native composition; the separate `sdk-minimal` profile intentionally removes subagents/compaction and would change the competition.

### Muse: exact native mapping available

Installed `muse serve --help` verifies a stdio MSP host with fixed lifetime sandbox posture. `muse schema generate-json-schema` exports the exact offline stable schema for this binary. This audit's fingerprint matches the root audit:

`sha256:03312c213efd14277a0e0a102f70adeae497a469ca4edf7242f479953ed758b7`

The [official SDK transport](https://github.com/meta-models/muse-code-sdk/blob/main/clients/sdk-ts/src/connection/connection.ts) writes JSON followed by a newline and parses newline-delimited frames; it is **NDJSON, not Content-Length framing**. Its [spawn binding](https://github.com/meta-models/muse-code-sdk/blob/main/clients/sdk-ts/src/connection/spawn.ts) connects child stdin/stdout. No model call is needed to inspect that contract.

| Buzz operation                | Installed stable MSP operation / event                                           |
| ----------------------------- | -------------------------------------------------------------------------------- |
| Initialize                    | `initialize`, then `initialized`; compare schema fingerprint                     |
| New / resume / history        | `session/start`, `session/resume`, `session/list`, `session/read`, `view/page`   |
| Prompt / steer / stop         | `turn/start`, `turn/steer`, `turn/cancel` or `turn/interrupt`                    |
| Streaming message/tool status | `item/started`, `item/delta`, `item/updated`, `item/completed`                   |
| Terminal turn outcome         | `turn/completed` with completed/failed/cancelled state                           |
| Permission UI                 | `approval/requested`, `approval/updated`, `approval/decide`, `approval/resolved` |
| Question UI                   | `userInput/requested`, answer/clarify/cancel, `userInput/settled`                |
| Model / effort                | `model/list`, `session/setModel`, `session/modelChanged`                         |
| Usage                         | `session/tokenUsage`, `session/contextUsage`, turn usage                         |
| Subagents                     | `subagent/*` controls and native child/session views                             |
| Stream recovery               | `view/gap`, replay via `view/page` with native cursors                           |

The adapter must preserve requirement IDs for staged approvals, native command IDs for idempotency, and admission-versus-completion semantics. A submitted/cancel-accepted command is not a completed turn. Do not flatten retries or deduplicate usage by presentation text. MCP configuration/attachments require inspection of native session configuration and accepted content schemas; no ACP MCP-forwarding claim follows merely from MSP support. This is a bounded protocol implementation task, not a reason to substitute Goose or a different model.

### ZCode: concrete route, vendor contract unresolved

The [official ZCode site](https://zcode.z.ai/en) lists native desktop builds and GLM-5.3 integration, but no public ACP/SDK contract was found through its page, linked official feedback repository, or targeted official-doc searches. The [official feedback repository](https://github.com/zai-org/feedback) contains user reports about bundled CLI entrypoints; reports are not vendor promises. Local application inventory found no ZCode installation to inspect. This is **UNKNOWN supported automation**, not proof the engine cannot be integrated.

Two community implementations are primary evidence about their own bridges:

- [jpalmae/zcode-acp](https://github.com/jpalmae/zcode-acp) targets Buzz explicitly. It translates ACP into the bundled native app-server and back. Its README labels the backend protocol reverse-engineered; lists session create/subscribe/send/stop, token/tool/approval events, and documents missing progress, an empty session list, deferred mode changes and default responses to some non-permission interactions. Those gaps need fixes before parity claims.
- [william0wang/zcode-acp](https://github.com/william0wang/zcode-acp) provides another maintained bridge with model overrides and additional session/remote features. Its [security description](https://github.com/william0wang/zcode-acp/blob/main/SECURITY.md) identifies native config/credential access and writes to the ZCode task index. That coupling must be reviewed and isolated; it is not a drop-in read-only transport assumption.

Next engineering step is to inspect a pinned official distribution's bundled app-server contract in an isolated directory and validate an adapter with synthetic protocol fixtures, without login/inference. Then determine vendor support and preserve complete permission/question/cancel/history behavior. Keep ZCode selected while this is resolved; no automatic switch to OpenCode, Goose or another interface is justified by the current evidence.

## Shared UI acceptance contract

1. **One franchise → one native home/workspace/session lineage.** Show native harness/version and assigned model in Buzz; scope cwd, files, credentials and MCP to that franchise.
2. **Negotiate, then render.** Session load/resume, images/audio, forms, nested subagents, model controls and terminal access vary. Unsupported UI affordances must be disabled or translated explicitly.
3. **Keep permissions authoritative.** Forward actual native permission/question requests with their identifiers. Never auto-answer approval requests merely because a protocol adapter lacks UI support. League action authorization remains at Black4's action boundary.
4. **Recover from the native record.** Preserve native session IDs, event/replay cursors, cancel terminal outcomes, tool identities and errors. Reconnecting must not resend a committed prompt or draft action.
5. **Budget outside presentation.** UI token counters are useful observations; provider bills, helper calls, retries and subagents still require the common ledger and enforced egress/spend controls.
6. **Schedule via Black4 events.** The scheduler wakes a durable native session through its adapter. No separate vendor UI or per-harness always-on scheduler is required. Native long-running goals can remain available behind negotiated controls.

All ten remain subject to an actual Buzz conformance test using the pinned release. This research demonstrates a single-interface architecture and identifies concrete gaps; it does not claim the installed Buzz binary already passes them.
