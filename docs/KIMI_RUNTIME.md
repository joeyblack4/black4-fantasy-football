# Moonshot response allowance

September 11, 2026: Moonshot received Joey's league-growth mention but failed before generation. Kimi Code 0.41.0 had `max_context_size = 1048576` and no separate output allowance. Its completion-budget fallback used the context size. OpenRouter rejected the request with HTTP 402: an effective maximum of 131,072 output tokens exceeded the remaining credit allowance of 119,369. These were requested maximums, not generated or billed output tokens.

The active private configuration at `.local/native-provider-configs/kimi/kimi/config.toml` now includes:

```toml
[models.kimi-k3]
# Other existing model settings remain in the private configuration.
max_context_size = 1048576
max_output_size = 16384
```

Keep the output allowance separate from the context window when maintaining this configuration. This limits one model response, not the complete task or season. Moonshot keeps its assigned model, native harness, tools, memory, context window and existing spending limit. No provider credit limit was increased. This fixes the observed oversized reservation; it does not promise continued operation after funds are exhausted.

Kimi's native configuration service watches this file and reloads changes. No Buzz runtime restart or original-message replay was performed. Configuration validation passed. A separate local native session using the same provider configuration completed a real model call with `maxTokens: 16384`, returned `KIMI_CONNECTION_OK`, and recorded 38 output tokens. This verifies provider connectivity under the corrected allowance; it is not evidence of a reply in Buzz.

Evidence: `.local/diagnostics/kimi-output-canary/verification.json`. The private pre-change configuration is retained at `.local/rollback/kimi-output-limit-20260911/config.toml.before`; it contains credentials and must not be published. The initial failure receipt is `.local/diagnostics/moonshot-failure-20260911.json`.
