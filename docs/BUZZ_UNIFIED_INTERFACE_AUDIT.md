## Later September 8 decision

Joey authorized easier Buzz-compatible combinations, including Goose. The active lineup now uses Goose for Meta and Z.ai; custom Muse MSP and ZCode bridges described below are deferred. The audit remains evidence of the earlier native-only proposal. See [current lineup](BUZZ_FIRST_LINEUP.md).

# Buzz unified interface audit

2026-09-08. Decision: retain Buzz as the preferred shared interface and qualify it against the ten native runtimes. The audit found concrete integration routes, but **zero of ten migrated franchises has passed the complete Buzz → native harness → Black4 tools → Buzz reply path**. This is a feasibility decision, not a fleet-readiness claim.

## What one interface means

Joey should address a franchise, see its current job and tool activity, answer an approval or question, stop work, and return after a restart within Buzz. Each franchise should keep its company's native planning, memory, tools and subagents in an isolated workspace. Black4 should own league state, event identity, job admission, budgets, permissions, actions and receipts.

Buzz accepts custom external ACP commands; its built-in harness menu is not a company allowlist. Goose is one compatible harness, not a mandatory layer for every model. Running a model through Goose may provide one UI, but it changes the cognition harness and therefore does not satisfy company fidelity by itself. A transport adapter around a native runtime preserves that distinction.

## Compatibility result

| Companies                                  | Route into Buzz                                                      | Current proof                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Google, xAI, DeepSeek, Qwen, Mistral, Kimi | Six native ACP entrypoints                                           | Upstream documentation/source; those CLIs were not found locally. No full Buzz test.                                                          |
| OpenAI, Anthropic                          | Maintained ACP adapters around Codex App Server and Claude Agent SDK | Native CLIs installed. Codex adapter 1.2.0 initialize passed; Claude adapter unprobed. No authenticated session or inference.                 |
| Meta                                       | Muse Code native MSP host, with a thin translation into Buzz         | Installed CLI and offline schema verified. Initialize-only probe had no response within 12 seconds. Adapter not implemented or qualified.     |
| Z.ai                                       | ZCode native app-server, with a bridge to Buzz                       | Community implementations exist, including one targeting Buzz. No vendor-supported automation contract verified and no local ZCode app found. |

The Meta route is a company-native Muse route, not evidence that Muse accepts every Llama model. A strict Llama assignment would require separate model/provider qualification. The full companion matrix records commands, source links and feature differences.

Primary references: [Codex ACP](https://github.com/agentclientprotocol/codex-acp), [Claude ACP](https://github.com/agentclientprotocol/claude-agent-acp), [Gemini ACP source](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts), [Grok headless integration](https://docs.x.ai/build/cli/headless-scripting), [DeepSeek ACP source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/index.ts), [Qwen architecture](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/), [Vibe ACP](https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md), [Kimi ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp), [Muse SDK](https://github.com/meta-models/muse-code-sdk), [community ZCode bridge](https://github.com/jpalmae/zcode-acp).

## Gaps that must be closed

1. **Approval handling.** Inspected Buzz ACP source automatically selects `allow_once`; matching markers exist in both local ACP binaries. That is not a verified human approval. The league gateway must deny or broker privileged requests, with exact-operation receipts. Interactive approval cards require actual UI integration.
2. **Model identity.** Buzz continues with the default when requested model selection fails. The league gateway must reject the run before a prompt if assigned identity cannot be established, including native helper models. A dropdown selection is insufficient.
3. **Restart recovery and stop.** Buzz's native session map is in memory and it does not call native load/resume. Persist session IDs and journal cursors outside that map. A stop or lease loss must cancel the native process tree and revoke tool access; already incurred or uncertain cost remains recorded.
4. **One execution and reply path.** Today's league ACP bridge queues work and calls no model; the separate worker constructs OpenRouter cognition. Preserve one canonical message ingester and one fenced job. Connect the selected native supervisor there. Native progress belongs in the observer; approved replies use the existing receipt/outbox path once.
5. **Isolation and accounting.** A separate working directory does not isolate native home, global config, secrets or child processes. Native processes must not inherit host database credentials or Buzz signing keys. Enforce provider budgets across retries and native subagents; missing usage is unknown.
6. **Feature negotiation.** Buzz's inspected prompt path sends text only. Some native harnesses provide images, forms, terminals and subagent views that Buzz does not presently forward or render. These need explicit mappings; shared chat alone does not establish full feature parity.

The source checkout and installed binaries have different provenance; the source audit records hashes and separates source findings from matching artifact markers. Actual UI behavior still requires qualification against a pinned build.

## Concrete implementation sequence

The existing staged workspaces and native-driver boundary are the foundation. The next change should build one synthetic complete path before enabling a provider:

1. Add the trusted native supervisor behind existing job claims, with persistent run/session mapping, cancellation, scoped tools and a durable event journal. Use a deterministic fake native process first.
2. Project that journal into Buzz with replay cursors, tool status, errors and terminal outcomes. Preserve canonical event IDs and outbox deduplication; do not add a second responder for the same franchise.
3. Add fail-closed model selection, exact-operation approval brokerage and child-cost accounting. Prove duplicate delivery, restart, revoked lease, wrong model, changed approval arguments and unknown billing cannot cause another action.
4. Qualify Codex first using its installed adapter, then apply the same contract to the other seven ACP routes. A protocol handshake must precede an isolated read-only model canary and its attributable billing receipt.
5. Implement Muse's native MSP translation and diagnose its failed handshake. Evaluate a pinned ZCode distribution and bridge without interpreting community support as vendor support.

Draft actions remain held throughout these steps. The companion league bridge audit contains thirteen concrete synthetic acceptance cases.

## Decisions and setup blockers

No interface switch is justified by this audit. Most gaps can be addressed in a league gateway and per-harness adapters. Approval cards and richer attachments may require Buzz client work. If Buzz cannot pass the agreed workflow without disproportionate maintenance, compare another shared client against those specific failed cases; another ACP interface will not by itself solve ZCode's undocumented native contract, model identity or billing.

Joey does not need to choose another interface or buy ten accounts yet. Before each paid canary, resolve its exact native model availability, compatible account/API authentication, budget attribution and isolated credential configuration. Existing authentication was not exercised, so account readiness remains unknown. ZCode distribution/access and vendor automation support, plus Muse transport startup, are concrete unresolved items. Do not invent credentials or silently substitute a model/harness to get a green test.

## Verification and boundaries

- Reviewed the local Buzz source/artifacts, league ingress/worker/outbox boundary, and upstream native protocol sources.
- Codex ACP initialize succeeded; Muse MSP initialize timed out. Neither probe sent a native prompt, authenticated or created a session. The Muse cleanup attempt returned an OS permission error; a subsequent process check found no surviving probe/serve process.
- No provider inference, Buzz send, runtime activation, operating-database mutation or draft action occurred during this audit. No production code changed in this audit, so the previously passed 588-test implementation suite was not rerun.
- Detailed evidence: `BUZZ_INTERFACE_SOURCE_AUDIT.md`, `BUZZ_HARNESS_COMPATIBILITY.md`, `BUZZ_LEAGUE_BRIDGE_AUDIT.md`, and initialize JSON receipts under `work/buzz-interface-audit/`.
