# Model assignment proposal — September 7, 2026

This is public metadata research for controlled model tests, **not an activated league roster**. The OpenRouter catalog was fetched at `2026-09-08T03:10:39Z` (September 7 Pacific). Public endpoint records, exact supported parameters, tariff overrides, source hashes, and alternatives are in private `.local/live/proposed-model-assignments.json`. No API keys were read, no inference was requested, and no account, runtime, or franchise state was changed by this research.

| Franchise | Proposed exact OpenRouter model | Proposed serving slug  | USD / million input / output | Weight evidence                             |
| --------- | ------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------- |
| OpenAI    | `openai/gpt-6-astra`            | `openai/flex`          | 5 / 25                       | UNKNOWN publication/license                 |
| Anthropic | `anthropic/claude-fable-5.1`    | `anthropic`            | 10 / 50                      | UNKNOWN publication/license                 |
| Google    | `google/gemini-3.8-flash`       | `google-vertex/global` | 0.75 / 3.75                  | UNKNOWN publication/license                 |
| xAI       | `x-ai/grok-4.6`                 | `xai/zdr`              | 2 / 6                        | UNKNOWN publication/license                 |
| Meta      | `meta/muse-spark-1.3`           | `meta`                 | 1.25 / 4.25                  | Release describes weights as future roadmap |
| DeepSeek  | `deepseek/deepseek-v4-pro-0813` | `deepseek`             | 1.32 / 3.96                  | Published, MIT                              |
| Qwen      | `qwen/qwen3.8-max-0902`         | `alibaba`              | 2 / 6                        | Exact Max weights/license UNKNOWN           |
| Mistral   | `mistralai/mistral-medium-3-5`  | `mistral/zdr`          | 1.5 / 7.5                    | Published, Modified MIT                     |
| Kimi      | `moonshotai/kimi-k3`            | `moonshotai/mxfp4`     | 3 / 15                       | Published, Kimi K3 License                  |
| Z.ai      | `z-ai/glm-5.3`                  | `z-ai/fp8`             | 1.4 / 4.4                    | Published, GLM-5.3 License                  |

These are advertised token tariffs for the selected endpoint, before relevant long-context tiers, cache charges, additional provider services, or funding fees. The JSON preserves all returned pricing fields. Explicit zero values are retained; missing information stays unknown. None of these amounts is measured spend.

## Selection evidence and choices

- **OpenAI:** [GPT-6 Astra announcement](https://openai.com/index/gpt-6-astra/) identifies the current flagship. [Reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode) explains that Pro mode performs more model work at standard token rates. OpenRouter lists Astra Pro as the same underlying Astra with Pro mode. The operator selected **Flex only for controlled tests**; its latency and availability tradeoff is unmeasured, and the season operating tier is pending review. Flex exceeds its base tariff above 272,000 prompt tokens: input 10 / output 37.50 per million.
- **Anthropic:** [Fable 5.1](https://www.anthropic.com/claude/fable) is its most capable generally available model; Mythos remains separately gated. The developer also describes safety-related model substitution. Exact response and generation model receipts must reject substitution rather than count another model as Fable.
- **Google:** The [September 2 Gemini 3.8 announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/) describes its strongest reasoning and coding release. This proposal replaces the old script candidate `gemini-3.1-pro-preview` with `gemini-3.8-flash`. The recommendation follows the capability release, not the Pro/Flash suffix alone.
- **xAI:** [Grok 4.6 release](https://x.ai/news/grok-4-6) and [model documentation](https://docs.x.ai/developers/models/grok-4.6) support the current model and tool-enabled use. The proposal uses the advertised standard ZDR endpoint, avoiding an implicit priority-tier selection.
- **Meta:** [Muse Spark 1.3 release](https://research.meta.ai/blog/introducing-muse-spark-1-3) describes improved sustained agent and coding work. It puts open weights on the future roadmap. Do not transfer Llama's weight license or open-weight label to Muse Spark.
- **DeepSeek:** [Official pricing/model definitions](https://api-docs.deepseek.com/quick_start/pricing/) identify `DeepSeek-V4-Pro-0813`; [the developer release](https://api-docs.deepseek.com/zh-cn/news/news260813/) supports this Pro revision. Newer experimental Flash vision models do not automatically replace its general owner role.
- **Qwen:** [Alibaba's current model list](https://www.alibabacloud.com/help/en/model-studio/models) recommends Qwen 3.8 Max; [official pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) and [supported search models](https://www.alibabacloud.com/help/en/model-studio/web-search) identify the exact `0902` snapshot. Separate Qwen open releases do not establish this Max snapshot's license.
- **Mistral:** [Medium 3.5 documentation](https://docs.mistral.ai/models/mistral-medium-3-5-26-04) calls it a frontier model optimized for agents and coding. [Mistral pricing](https://mistral.ai/pricing/api/) still labels older Large 3 the general-purpose flagship. Medium 3.5 is therefore a task-specific recommendation, with the ambiguity retained rather than claiming universal superiority.
- **Kimi:** [K3 release](https://www.kimi.com/en/blog/kimi-k3) and [actual weights release](https://www.kimi.com/news/kimi-k3-open-source) support the current model. The direct Moonshot endpoint advertises **MXFP4**. An explicit `deepinfra/bf16` alternative advertises 2.85 / 14.25 per million; it changes the serving provider and precision and is not approved automatically.
- **Z.ai:** [GLM-5.3 documentation](https://docs.z.ai/guides/llm/glm-5.3) identifies its latest flagship and always-on reasoning. Only `low`, `high`, and `max` effort are documented; disabling reasoning is unsupported. The direct route advertises FP8.

## Routing and request compatibility

The request identifier and frozen guardrail version are **separate fields**. [OpenRouter's model schema](https://openrouter.ai/docs/guides/overview/models) defines `id` for API requests and `canonical_slug` as its permanent identity. The proposal uses `model`/`catalogAlias` for the request and `canonicalModel` for the guardrail. Public single-model lookup for OpenAI's alias returned 200 with the dated canonical binding; lookup by the dated canonical returned 404, while its catalog-linked dated endpoints route returned 200. That is no basis for replacing the chat request identifier with the dated slug. Authenticated guardrail read-back remains the operator's separate evidence.

| Request model                   | Frozen canonical model                  |
| ------------------------------- | --------------------------------------- |
| `openai/gpt-6-astra`            | `openai/gpt-6-astra-20260903`           |
| `anthropic/claude-fable-5.1`    | `anthropic/claude-fable-5.1-20260831`   |
| `google/gemini-3.8-flash`       | `google/gemini-3.8-flash-20260902`      |
| `x-ai/grok-4.6`                 | `x-ai/grok-4.6-20260810`                |
| `meta/muse-spark-1.3`           | `meta/muse-spark-1.3-20260902`          |
| `deepseek/deepseek-v4-pro-0813` | `deepseek/deepseek-v4-pro-20260813`     |
| `qwen/qwen3.8-max-0902`         | `qwen/qwen3.8-max-20260902`             |
| `mistralai/mistral-medium-3-5`  | `mistralai/mistral-medium-3.5-20260430` |
| `moonshotai/kimi-k3`            | `moonshotai/kimi-k3-20260715`           |
| `z-ai/glm-5.3`                  | `z-ai/glm-5.3-20260816`                 |

These suffixes are OpenRouter identifiers, not inferred developer release dates. If an alias later points at a different canonical model, the frozen guardrail should reject it until a reviewed upgrade. Exact receipt behavior still needs controlled tests.

[OpenRouter's routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection) distinguishes a base provider slug from a full endpoint slug. A base such as `openai` matches its endpoint family; `allow_fallbacks: false` alone does not make it an exact standard-tier pin. The proposal uses advertised slash endpoints where appropriate and records known nested/sibling ignores. Base-only routes still require catalog revalidation: today's ignore list cannot guarantee protection from a future variant. No speculative provider slugs were invented.

Every proposed endpoint advertises `tools`, `max_tokens`, and `response_format`. **DeepSeek's direct endpoint and Z.ai's direct endpoint omit `structured_outputs`.** JSON output support does not prove strict JSON Schema behavior. Their same-model alternatives advertising all four parameters are listed separately in the private proposal; neither endpoint selection nor relaxed schema handling is implicitly approved.

Fable's metadata is inconsistent: its parameter list omits `tool_choice`, while its separate `supports_tool_choice` object advertises all modes. GLM explicitly reports `none`, `required`, and named-function forcing unsupported; Qwen reports required/named forcing unsupported. The compatible request plan omits unnecessary `tool_choice` and removes tools entirely on the final bounded response call. Controlled tests must verify the actual tool/result/schema behavior; metadata alone is not a pass.

## Published-weight receipts

Only public model metadata and license text were fetched from the developer repositories; no weight shards were downloaded or executed. Exact repository revisions and license file hashes are preserved privately.

| Model                | Pinned developer license source                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek V4 Pro 0813 | [MIT at 72e1d323](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813/blob/72e1d3230f6c080a530b0a1d46f8eb4602340597/LICENSE)           |
| Mistral Medium 3.5   | [Modified MIT at 22b2b868](https://huggingface.co/mistralai/Mistral-Medium-3.5-128B/blob/22b2b868a15677cfa6061277ed2f653d1349a9ab/LICENSE) |
| Kimi K3              | [Kimi K3 License at f831ab66](https://huggingface.co/moonshotai/Kimi-K3/blob/f831ab66814297da540d832a5235f8e904f29d06/LICENSE)             |
| GLM-5.3              | [GLM-5.3 License at aca966e4](https://huggingface.co/zai-org/GLM-5.3/blob/aca966e4e02791568aa6a4ced368624b3d897f42/LICENSE)                |

Published weights and named licenses are distinct from permissive open-source status, legal conclusions, and proof of the exact hosted build. This report makes no equivalence claim between different quantizations or providers.

## Checkpoint boundary

All ten model IDs and serving slugs are grounded in current public records and ready as **inputs to scoped negative and positive connectivity tests**. Account-specific access, key isolation, model restrictions, provider restrictions, strict schema behavior, actual billed identity, and latency remain unverified here. Raw endpoint status values are recorded without interpreting them as authenticated callability. Reasoning settings and season operating tiers remain unselected.

This research starts no founding convention, names, debate, autonomous owner work, subscriptions, publication, or model activation. The next checkpoint is configured accounts plus controlled test receipts for the user's review.
