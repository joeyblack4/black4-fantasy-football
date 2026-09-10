# Prompt cache policy

The common driver capability policy uses five-minute ephemeral caching for pinned `anthropic/*` models served by the exact `anthropic` endpoint. Other routes receive no new hint. Default canaries remain unchanged; an explicit `promptCaching: "anthropic-5m"` test includes the parameter and rejects unsupported routing. `promptCaching: "disabled"` opts out.

[OpenRouter's official caching documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching), reviewed September 8, 2026, documents top-level `cache_control`, five-minute writes at 1.25 times uncached input, and returned cache read/write token counts. Supported behavior is not proof of actual hits.

The reservation estimate applies the named 1.25 input cache-write factor before the existing safety margin. It assumes no cache discount. Actual reported cost remains authoritative; unavailable cost stays held. Request diagnostics record the policy actually sent, and usage diagnostics preserve missing token counts as null/unknown. A reported zero remains zero.

The policy changes neither model/provider pins, fallback prohibition, read tools, turn limits, nor wallets. Every deployment requires its own review. Synthetic transport tests establish protocol/accounting behavior; measured savings require actual scoped usage evidence and cannot be inferred from this source or catalog prices.
