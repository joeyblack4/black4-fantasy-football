**Final decision:** this lineup now includes DeepSeek + Goose. See [final selection and alternatives](FINAL_HARNESS_SELECTION.md).

# Buzz-first franchise lineup

September 8, 2026. Joey explicitly authorized adapting franchises to what Buzz supports, including model + Goose, to reduce integration work. This supersedes the earlier requirement to build Muse MSP and ZCode bridges before proceeding. Keep ten AI franchises and their existing model/company identities; change the selected harness for three franchises.

| Company   | Selected cognition harness       | Change                                     |
| --------- | -------------------------------- | ------------------------------------------ |
| OpenAI    | Codex                            | Retain                                     |
| Anthropic | Claude Code                      | Retain                                     |
| Google    | Gemini CLI                       | Retain                                     |
| xAI       | Grok Build                       | Retain                                     |
| Meta      | Goose + assigned Muse Spark 1.3  | Replace Muse Code; defer MSP bridge        |
| DeepSeek  | Goose + assigned DeepSeek V4 Pro | Replace developer-preview DeepSeek Harness |
| Qwen      | Qwen Code                        | Retain                                     |
| Mistral   | Vibe                             | Retain                                     |
| Kimi      | Kimi Code                        | Retain                                     |
| Z.ai      | Goose + assigned GLM 5.3         | Replace ZCode; defer app-server bridge     |

Buzz remains the common interface. Goose owns cognition for its three entries: planning, tools, memory and delegation. Other entries retain their native cognition. Label each entry as model + harness + serving provider; this evaluates complete agent systems, not a controlled comparison of models alone. A later controlled Goose-versus-native comparison would require the same model and workload.

## Provider routes

Goose's [official provider documentation](https://goose-docs.ai/docs/getting-started/providers/) lists a direct Meta provider (`META_MODEL_API_KEY`) and OpenRouter (`OPENROUTER_API_KEY`), alongside OpenAI-compatible custom providers. Local source confirms Meta's declarative provider and OpenRouter's configurable request parameters. This establishes integration routes, not current access to the exact assigned releases.

- **Meta:** qualify Goose's direct Meta provider first. Existing assignment is Muse Spark, not Llama. Obtain a franchise-scoped Meta Model API credential and verify the exact Muse Spark 1.3 request ID and access. The inspected Goose static default is an older Muse model; never accept that default as a substitute.
- **DeepSeek:** qualify the assigned V4 Pro 0813 model through Goose’s OpenRouter provider, preserving exact model/provider restrictions and billing. This avoids adding the rapidly changing native preview harness.
- **Z.ai:** qualify Goose's OpenRouter provider first so existing league provisioning can be assessed for reuse. Pin the assigned GLM 5.3 model and serving provider with fallbacks disabled. Verify that the selected Goose request path carries these parameters and billing evidence. A direct Z.ai custom provider is optional if the routed path fails qualification; no separate ZCode account is required for this selection.

OpenRouter serving a model inside Goose does not reinstate Black4's generic `OpenRouterDriver`. The supervisor selects Goose as the cognition owner. No automatic model/provider fallback is authorized by this preference change.

## Implemented locally

`leagueHarnessSelection` separates the competition's Buzz-first selection from the research catalog of each company's first-party harness. Inventory and preparation use this selection and record an explicit exception reason for all three Goose entries. Existing immutable workspaces are preserved; the revised profile lives under `.local/franchise-runtimes/buzz-compatible-v2/` with all ten owners separately staged. Preparation from the previous local snapshot preserves model, canonical identity and credential references; it is not a fresh operating-database inventory or activation.

No native launch or provider credential is created by these changes. Exact provider model and harness version remain unqualified. The observation/action holds, existing budgets and receipts still apply.

## Next implementation

Proceed with the common Buzz job/supervisor/tool/reply path and qualify Codex and Goose early. Goose uses its native ACP entrypoint; set separate `GOOSE_PATH_ROOT` and workspaces, scope extensions, and prevent helper-model/default-provider drift. Keep the previously identified approval, model-selection, session-recovery and billing fixes. These are shared control-plane work, not custom company protocol projects.

If another native combination proves disproportionately difficult, prefer an explicitly recorded Buzz-supported harness substitution or model change over another custom bridge. Do not silently change a running franchise or its historical receipts. This lineup is prepared, not an authenticated or deployed fleet; production draft actions remain held.
