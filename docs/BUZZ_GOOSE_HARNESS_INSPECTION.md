## Later September 8 decision

Joey explicitly authorized Goose substitutions to simplify Buzz integration. Select Goose for Meta and Z.ai; the earlier restriction below is superseded for these two entries. Source findings and unverified-access labels still apply. See [current lineup](BUZZ_FIRST_LINEUP.md).

# Buzz and Goose inspection — September 8, 2026

Read-only local source/configuration inspection and official provider documentation. No model calls, signing-key reads, message sends or customer-infrastructure changes were used for this inspection.

## Findings

Goose 1.48.0 exists at `/Users/joey/.local/bin/goose`. Local source is `/Users/joey/.buzz/.scratch/goose-source`; Buzz source is `/Users/joey/.buzz/.scratch/buzz-source`. The global Goose config has extensions, but no provider or model configured. Codex, Claude Code, Codex ACP and Goose are on PATH; Gemini CLI, Claude ACP and Ollama were absent from the inspected PATH. This does not exclude app-bundled installations. Muse Code was separately verified installed.

Goose can use OpenRouter, Ollama and OpenAI-compatible providers for Llama, and its current Meta provider is documented for Muse Spark. This is transport compatibility, not proof of the assigned model's access or Meta-native cognition. Its other mode delegates cognition to an external harness through ACP while exposing extensions as MCP servers. Prefer a direct Buzz-to-native-ACP path when available; avoid adding an unnecessary Goose agent loop above a first-party harness.

Sources: [Goose providers](https://goose-docs.ai/docs/getting-started/providers/), [Goose ACP providers](https://goose-docs.ai/docs/guides/acp-providers/). The maintained Codex bridge is `@agentclientprotocol/codex-acp`; local Goose setup text still contains an older deprecated package name and must not be copied blindly.

## Existing football identities

Buzz desktop metadata contains two setup cohorts for the ten football companies, 20 records total, with two distinct pubkeys per company. They describe `black4-owner-loop-*`, `unactivated/<company>`, provider null and runtime PID null. One cohort has empty agent commands and autostart false; another launches Node with autostart true. The descriptors have empty relay URLs. This is not evidence of duplicate running responders or authenticated native models.

Preserve and reconcile canonical pubkey + relay + league membership before runtime migration. Do not create a third cohort or another outbound responder. The league's `src/buzz/managed-acp.ts` already governs ingress modes and durable ACP delivery. Keep identity/ingestion separate from cognition.

## Useful source anchors

Relative to Buzz source:

- `crates/buzz-acp/src/config.rs`: default Goose command is `goose acp`; direct Codex/Claude ACP support.
- `crates/buzz-acp/src/acp.rs`: launches external processes with persona environment, creates sessions with absolute workspace, MCP servers, system prompt and title.
- `desktop/src-tauri/src/managed_agents/agent_env.rs`: uses environment clearing for managed launches.
- `desktop/src-tauri/src/managed_agents/readiness.rs`: provider/model/credential configuration checks. Configuration readiness is not an inference canary.
- `desktop/src-tauri/src/managed_agents/runtime_types.rs`: identity includes pubkey and relay plus lifecycle receipts.

Relative to Goose source:

- `crates/goose/src/config/paths.rs`: `GOOSE_PATH_ROOT` relocates configuration, data, state and agent/plugin definitions. A separate working directory alone does not isolate them.
- `crates/goose/src/acp/provider.rs`: external harness command, environment, workspace and MCP integration.
- `crates/goose/src/providers/codex_acp.rs`: Goose auto mode can map to no approvals and unrestricted sandbox mode; do not inherit it into league execution.
- `crates/goose/src/agents/subagent_task_config.rs`: subagents receive model/provider and workspace configuration.
- `crates/goose/src/providers/toolshim.rs`: optional tool interpretation can invoke a separate model. Review all helpers, defaults and fallbacks against the franchise model rule.

## Boundaries still unverified

No scoped native credential has been qualified. An ambient Anthropic key variable exists, but its ownership and validity were not established or its value read; it was not reused. Directory preparation is not tenant containment. Goose compatibility is not grounds to displace newly identified first-party Muse Code, DeepSeek Harness or ZCode. Use Goose only when a concrete native capability gap and the substitute's exact model/budget/tool behavior are documented.
