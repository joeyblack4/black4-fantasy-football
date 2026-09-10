# Final model and harness selection

September 8, 2026. Decision requested by Joey after the Buzz audit and explicit permission to simplify company/harness combinations. **Select seven company-native harnesses plus Goose for Meta, Z.ai and DeepSeek.** Keep the ten model companies. The only additional change from the preceding lineup is DeepSeek Harness → Goose.

## Final field

These model names are the existing staged assignments, not new authenticated provider-request identifiers. No model replacement is selected.

| Company   | Assigned model       | Selected harness |
| --------- | -------------------- | ---------------- |
| OpenAI    | GPT-6 Astra          | Codex            |
| Anthropic | Claude Fable 5.1     | Claude Code      |
| Google    | Gemini 3.8 Flash     | Gemini CLI       |
| xAI       | Grok 4.6             | Grok Build       |
| Meta      | Muse Spark 1.3       | Goose            |
| DeepSeek  | DeepSeek V4 Pro 0813 | Goose            |
| Qwen      | Qwen 3.8 Max 0902    | Qwen Code        |
| Mistral   | Mistral Medium 3.5   | Vibe             |
| Kimi      | Kimi K3              | Kimi Code        |
| Z.ai      | GLM 5.3              | Goose            |

Use Buzz as the only intended human interface. Model, harness, serving provider and version are separate fields. Native ACP or maintained Codex/Claude transport adapters preserve their native cognition; the three Goose entries use Goose cognition directly. Do not nest a company harness behind a second Goose reasoning loop.

## Alternatives considered and decisions

| Alternative                 | Current primary evidence                                                                                                                                                                                                                                                                    | Decision                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek + DeepSeek Harness | The [official repository](https://github.com/deepseek-ai/deepseek-harness) labels it a rapidly changing developer preview and explicitly anticipates compatibility-breaking changes. Its [architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/) does expose ACP. | Replace with Goose. This is a maintenance-risk decision, not a claim that its native agent performs worse. Reuse the already selected Goose provider/tool/session integration.                                                                                                 |
| GLM + OpenCode              | Z.ai provides a [dedicated setup guide](https://docs.z.ai/devpack/tool/opencode); OpenCode documents [native ACP](https://opencode.ai/docs/acp/).                                                                                                                                           | Credible but not selected. Z.ai also lists [Goose as supported](https://docs.z.ai/devpack/tool/others). An additional harness increases our qualification surface without demonstrated league benefit.                                                                         |
| GLM + Claude Code           | Z.ai documents [Claude integration](https://docs.z.ai/devpack/tool/claude).                                                                                                                                                                                                                 | Do not select. Goose already serves this role; mapping Claude's helper-model defaults to GLM creates another configuration obligation.                                                                                                                                         |
| MiniMax + OpenCode          | MiniMax's [quick start](https://platform.minimax.io/docs/token-plan/quickstart) includes OpenCode; OpenCode has a [MiniMax provider](https://opencode.ai/docs/providers/#minimax).                                                                                                          | Do not replace an existing company. This is a viable competitor, but I found no evidence that changing company, model assignment and provider onboarding would make this league easier than the selected Goose route. No comparative fantasy-football benchmark was run.       |
| Meta Llama + Goose          | Goose supports [Ollama and OpenAI-compatible providers](https://goose-docs.ai/docs/getting-started/providers/).                                                                                                                                                                             | Keep assigned Muse Spark. Llama is an available research direction, not a necessary compatibility repair: Goose also documents a direct Meta provider. Local Llama would add hardware/model-serving qualification; hosted Llama still requires an exact provider/model choice. |
| Muse Code / ZCode bridges   | The preceding source audit found MSP translation needed for Muse and no verified vendor automation contract for ZCode.                                                                                                                                                                      | Defer both. No bespoke native-protocol project is part of the selected lineup.                                                                                                                                                                                                 |
| Goose for all ten           | Goose's provider breadth makes this a plausible consolidation option.                                                                                                                                                                                                                       | Do not select. It would discard the user's preferred native-company behavior for seven franchises with documented ACP routes. The selected three exceptions address concrete complexity without making every competitor the same harness.                                      |

The selection balances company fidelity with operating simplicity. It is not a finding that Goose outperforms the alternatives. It reduces the number of distinct cognition runtimes from nine to eight and avoids the preview-specific DeepSeek integration.

## Inference routes and remaining qualification

Goose documents Meta and OpenRouter provider support. Use direct Meta API for Muse Spark first; use Goose's OpenRouter provider for GLM and DeepSeek first so existing league provisioning can be assessed for reuse. Keep exact model/provider restrictions, disable fallback and reconcile per-franchise costs. OpenRouter remains inference transport; Black4's generic OpenRouter cognition loop is not restored. No new coding-plan purchase is assumed or required by this choice.

All ten exact provider mappings and account entitlements still require verification. In particular, Grok Build's default cognition, coding-plan aliases for Qwen/Kimi/Mistral, and Goose's older static Muse default must not silently replace the assigned model. A standard ACP route proves an integration contract, not that the selected account can run the exact model. Choosing a different company would not remove that verification requirement.

The lineup decision is closed for implementation. Do not continue shopping for harnesses or expand the field. Pin versions and perform setup, exact-model/tool/billing canaries, then complete the common Buzz integration. If a concrete qualification failure prevents a selected combination, report that failed operation and evidence before changing the recorded assignment; do not represent a failure as successful access to another model.

## Recorded state

The resolver now selects profile `buzz-compatible-v2`. Its ten immutable staged workspaces preserve the prior company, model, team and credential-reference identities. Earlier workspace revisions and historical provider/action receipts remain intact. No operating database change, native model call, installation, authentication, Buzz send or production draft activation is performed by this decision.

Verification passed: TypeScript compilation and 20 focused tests across two files for the selector/preparation revision. Independent read-back confirmed all ten staged configs and unchanged model/company identities. Full end-to-end Buzz qualification remains outstanding.
