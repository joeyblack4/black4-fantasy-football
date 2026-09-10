# Franchise harness research — 2026-09-08

Status: public-source and local executable inspection; no inference, account creation, credentials inspection, provider configuration, or league action. Sources were checked September 8, 2026. A documented harness is not a verified franchise runtime. Exact access, model identity, complete cost accounting, and isolation remain acceptance gates.

## Selection

Current evidence materially changes the referenced conversation: **Meta has Muse Code, DeepSeek has DeepSeek Harness, and Z.ai has ZCode.** Do not default these franchises to another company's harness merely because the earlier conversation missed their native products. ZCode's supported unattended integration remains unresolved; OpenCode is its documented fallback candidate.

| Franchise | Primary harness                              | Status and integration surface                                                                                                                                                                                                               |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | Codex                                        | First-party; installed CLI; `exec` and app-server, MCP.                                                                                                                                                                                      |
| Anthropic | Claude Code                                  | First-party; installed CLI; print mode / Agent SDK, MCP.                                                                                                                                                                                     |
| Google    | Gemini CLI                                   | First-party; documented headless JSON / streaming JSON, MCP.                                                                                                                                                                                 |
| xAI       | Grok Build                                   | First-party; documented headless JSON / streaming JSON and ACP.                                                                                                                                                                              |
| Meta      | Muse Code                                    | First-party; installed CLI; JSONL `exec`, MSP stdio `serve`, published TypeScript SDK.                                                                                                                                                       |
| DeepSeek  | DeepSeek Harness (`dsh`)                     | First-party open-source developer preview; headless, SDK and ACP profiles.                                                                                                                                                                   |
| Qwen      | Qwen Code                                    | First-party open-source; headless JSON / stream JSON, resumed project sessions, MCP.                                                                                                                                                         |
| Mistral   | Vibe Code CLI                                | First-party; programmatic JSON / streaming output, MCP.                                                                                                                                                                                      |
| Kimi      | Kimi Code CLI                                | First-party; noninteractive print / stream JSON, ACP and local server.                                                                                                                                                                       |
| Z.ai      | ZCode, pending supported automation contract | First-party official GLM harness; current public page establishes desktop distributions. Stable supported headless launch/auth/MCP contract is UNKNOWN. OpenCode is an officially documented exception candidate if this gate cannot be met. |

This table is a research selection, not an assertion that any of the ten can operate the league today.

## Existing assignments must remain explicit

`docs/MODEL_ASSIGNMENT_EVIDENCE.md` records the following OpenRouter proposal and frozen identities. This research did not query the live franchise database and does not upgrade that document's proposal label to current activated roster. These are not automatically valid direct-provider request IDs.

| Franchise | Existing documented request model | Existing serving slug  |
| --------- | --------------------------------- | ---------------------- |
| OpenAI    | `openai/gpt-6-astra`              | `openai/flex`          |
| Anthropic | `anthropic/claude-fable-5.1`      | `anthropic`            |
| Google    | `google/gemini-3.8-flash`         | `google-vertex/global` |
| xAI       | `x-ai/grok-4.6`                   | `xai/zdr`              |
| Meta      | `meta/muse-spark-1.3`             | `meta`                 |
| DeepSeek  | `deepseek/deepseek-v4-pro-0813`   | `deepseek`             |
| Qwen      | `qwen/qwen3.8-max-0902`           | `alibaba`              |
| Mistral   | `mistralai/mistral-medium-3-5`    | `mistral/zdr`          |
| Kimi      | `moonshotai/kimi-k3`              | `moonshotai/mxfp4`     |
| Z.ai      | `z-ai/glm-5.3`                    | `z-ai/fp8`             |

Keep direct request model, returned model, provider, endpoint, precision/service tier, harness version, and internal helper models separate. An OpenRouter guardrail and canary do not certify a new direct-provider route. Subagents, compaction, web research and approval judges can introduce additional models or charges. The existing one-assigned-model rule must be enforced or explicitly revised, never silently bypassed by a native harness default.

## Source-backed setup and constraints

### OpenAI / Codex

Local read-only evidence: `codex-cli 0.148.0`; executable `/Users/joey/.nvm/versions/node/v22.22.2/bin/codex`. `codex --help` exposes `exec`, `mcp`, `mcp-server`, `app-server`, login and resume. `codex exec --help` establishes stdin prompts, `--model`, `--cd`, config profiles and sandbox modes. This verifies installed interfaces, not credentials or exact Astra/Flex access. Use a franchise-specific configuration/state location and explicit model; do not inherit Joey's personal tools or credentials automatically. Account/key and billable usage attribution must be verified separately.

### Anthropic / Claude Code

Local CLI `2.1.258` exists at `/opt/homebrew/bin/claude`. Official [programmatic execution documentation](https://code.claude.com/docs/en/headless) establishes `claude -p`, structured output and continued sessions. The [model configuration documentation](https://code.claude.com/docs/en/model-config) is the contract for exact model selection. Configure a dedicated franchise API credential or supported account authorization; subscription access must not be equated with the assigned direct model or measurable per-franchise cost. Audit helper/subagent models and fallbacks before any model call.

### Google / Gemini CLI

Official [headless reference](https://geminicli.com/docs/cli/headless/) specifies prompt/non-TTY operation, JSON output with usage statistics, and streaming events including initial model/session metadata. [Authentication](https://geminicli.com/docs/get-started/authentication/) supports cached sign-in, Gemini API keys or Vertex AI for headless use. Joey's exact requirement is either a dedicated Gemini key with assigned-model access or a Vertex project/region and credential authorized for the selected model. Vertex/global OpenRouter evidence does not establish equivalent direct credentials, endpoint or pricing. No `gemini` binary was found in the inspected shell PATH.

### xAI / Grok Build

Official [headless / ACP documentation](https://docs.x.ai/build/cli/headless-scripting) specifies `grok -p`, `--model`, `--cwd`, named/resumed sessions and plain/JSON/streaming-JSON outputs; ACP uses `grok agent stdio`. Headless auth accepts existing local authentication or `XAI_API_KEY`. Pin the binary and disable automated updates for repeatability. [Settings](https://docs.x.ai/build/settings) show **`grok-build` as default cognition and `grok-4.6` as a separate web-search model**. Therefore the assigned Grok 4.6 franchise cannot inherit defaults without a model-policy decision. Joey needs scoped xAI account/API access; exact ZDR/service-tier equivalence remains unverified. No `grok` binary was found on PATH.

### Meta / Muse Code

The [Meta developer landing](https://ai.meta.com/llama/) advertises Muse Code and Meta Model API. Its search-indexed content was readable; direct retrieval redirected to `developer.meta.com/ai` and failed in the research fetcher. `dev.meta.ai` returned a login-required page. Stronger implementation evidence is the official [Muse Code SDK repository](https://github.com/meta-models/muse-code-sdk): TypeScript `@muse-code/sdk`, Node 20+, Muse Session Protocol, developer preview. The [official cookbook](https://github.com/meta-models/meta-model-cookbook/tree/main/04_muse_code) documents durable logs, replay, approvals and isolated subagent worktrees.

Local `muse` is already installed at `/Users/joey/.local/bin/muse`, version `1.0.2-R2040.1`. Read-only help verifies:

- `muse exec --json --prompt-file <path> --model <id> --workspace <path>`; `--api-key-stdin`, session UUID, maximum model steps, disable web tools, exclude foreign personal context, and explicit approval controls.
- `muse serve` exposes MSP over stdio; host sandbox posture is fixed at launch.
- `muse auth set --provider <provider> --api-key-stdin` stores supplied credentials. No credential was supplied or inspected.
- `--provider echo` exists for a clearly synthetic local adapter test. It is not Meta inference proof.

Exact direct identifier corresponding to Muse Spark 1.3, account entitlement, MCP setup, server-authoritative usage and approval-judge model identity remain unverified. Muse's native harness is the primary candidate; Goose is a compatibility option, not the default replacement.

### DeepSeek / DeepSeek Harness

The [official repository](https://github.com/deepseek-ai/deepseek-harness) establishes DeepSeek's own MIT-licensed `dsh` harness, currently developer preview. [Architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/) documents `headless`, `sdk`, `sdk-minimal`, `acp`, and `web` profiles; SDK integrations use the same launch architecture. The [Python SDK guide](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk) uses explicit workspace, `DSH_HOME`, `DEEPSEEK_API_KEY`, provider and model configuration. **Do not select `sdk-minimal` just for easier integration:** it omits native compaction, subagents and other features and pins broad local execution permissions. Prefer the full native profile within externally enforced isolation.

Joey needs a DeepSeek platform API credential and exact dated Pro model access. Direct [API documentation](https://api-docs.deepseek.com/) lists aliases including `deepseek-v4-pro`; this does not establish that the alias is permanently the assigned `0813` revision. No `dsh` executable was found on PATH. The [official Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) remains a supported fallback (`https://api.deepseek.com/`, Responses protocol), but the existence of `dsh` removes the earlier rationale for making Codex mandatory for DeepSeek.

### Qwen / Qwen Code

[Headless documentation](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/) covers JSON/stream JSON and project-scoped resumed sessions. [Authentication](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) recommends Alibaba ModelStudio. The old Qwen OAuth free tier was discontinued April 15, 2026; `qwen auth` was removed. Configure an explicit provider/model in isolated settings and use the matching regional Standard API, Coding Plan or Token Plan credential. They use different endpoints and model catalogs. A subscription's coder default does not prove Qwen 3.8 Max 0902 access. OpenRouter is supported as a provider, demonstrating that native cognition and inference routing are separate choices. No `qwen` executable was found on PATH.

### Mistral / Vibe Code CLI

[Programmatic mode](https://docs.mistral.ai/vibe/code/cli/work-with-cli) supports `vibe --prompt`, turn caps and JSON/streaming output. It defaults to an auto-approve agent; explicitly restrict tools and enforce containment. Its `--max-price` uses configuration prices, which Mistral says may be stale or missing: it cannot enforce the league's hard budget. [Configuration](https://docs.mistral.ai/vibe/code/cli/configuration-reference) supports `VIBE_HOME`, explicit provider/model aliases and agent-specific models. [MCP](https://docs.mistral.ai/vibe/code/cli/mcp-servers) supports stdio and HTTP/static credentials; OAuth MCP servers are currently unsupported. [Authentication](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles) supports browser sign-in and `MISTRAL_API_KEY`. Joey needs the matching account/key and exact Medium 3.5 route; default coder selection and indicative cost are insufficient. No `vibe` executable was found on PATH.

### Kimi / Kimi Code CLI

[Getting started](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html) documents Kimi Code OAuth device flow or a Kimi Platform key. [Provider configuration](https://moonshotai.github.io/kimi-code/en/configuration/providers) distinguishes native Kimi from other compatible protocols. **An exported `KIMI_API_KEY` alone does not configure the provider:** current docs require a credential field/config source. A selected `-m` value names a configured alias whose upstream model must be checked. [Command reference](https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html) documents print/stream-JSON, step/retry caps and ACP; confirm flags against the installed version because docs are transitioning from `kimi-cli` to `kimi-code`. Joey needs direct K3 entitlement and an approved secure config binding; the managed `kimi-for-coding` model cannot silently replace K3. No `kimi` executable was found on PATH.

### Z.ai / ZCode

The [official ZCode page](https://zcode.z.ai/en) explicitly calls it the GLM-5.3 harness, advertises direct GLM optimization and ships macOS, Windows and Linux distributions (3.11.2 at inspection). It also advertises **GLM-5.3-Flash for multimodal work**; this is a concrete single-model policy issue. The inspected official page does not provide a supported headless protocol. Public issues in the official feedback repository discuss CLI packaging, but user issue reports are not proof of a supported interface. Keep native automation capability UNKNOWN pending installed vendor documentation/source inspection.

If the native automation gap is confirmed, the [official OpenCode integration guide](https://docs.z.ai/devpack/tool/opencode) provides a credible exception: `opencode auth login`, choose Z.AI or its distinct Coding Plan provider, enter an account API key, explicitly select GLM, and configure MCP tools. Do not assume those provider plans or keys are interchangeable. No `opencode` executable was found on PATH in this inspection; ZCode application installation was not inventoried.

## Meta/Llama open-source options and Goose

There are genuine open-source Llama agent options, but historical links need correction. [Llama Stack's repository](https://github.com/llamastack/llama-stack) now redirects to OGX; its [announcement](https://ogx-ai.github.io/blog/from-llama-stack-to-ogx) describes the move from a Meta-model origin to a model-agnostic stack. OGX exposes server-side tool orchestration/MCP through Responses and can use local or hosted inference. The old [Meta llama-agentic-system](https://github.com/meta-llama/llama-agentic-system) redirects to `ogx-ai/llama-stack-apps`, archived April 28, 2026. Do not start a new production runtime on that archived application or describe OGX as a current exclusive Meta CLI.

[Goose's official site](https://block.github.io/goose/) documents a general-purpose open-source agent with MCP, API/CLI, multiple providers including Ollama/OpenRouter, and ACP provider support. It is now under the Agentic AI Foundation. These are credible Llama-compatible building blocks; they do not make Llama the same model as the repo's Muse Spark assignment. Separate the questions: company fidelity (Muse Code), open-weight Llama experimentation (explicit model change), and routing compatibility (Goose/provider-specific verification). Local Buzz integration findings belong in the accompanying Buzz inspection; upstream features do not prove Buzz exposes them.

## What Joey actually needs to unblock

1. Dedicated franchise credential/account authorization for the selected route where not already established. This inspection intentionally did not read secrets or infer that installed CLIs are signed in.
2. Confirm exact direct models and helper-model policy, including service tiers/precision and the Muse 1.3, DeepSeek 0813, Qwen Max 0902 and Kimi K3 mappings. Preserve current identities until a reviewed change.
3. For ZCode, establish an officially supported unattended invocation and model pinning before choosing an exception.
4. Supply any needed paid-account access through the vendor's normal secure setup; no credentials in repo, prompts, screenshots or research files. No purchase or subscription has been made.

Engineering can proceed without those accounts: protocol contracts, workspace isolation, pinned manifests, launch plans, parser fixtures, receipts and synthetic adapter tests. Live canaries require a budget-controlled credential path that records all cognition—including retries, helper models and subagents—and cannot bypass league action permissions. Production draft actions remain disabled.
