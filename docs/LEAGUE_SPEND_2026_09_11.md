# League spending: September 11, 2026

OpenRouter receipt cutoff: 2026-09-11T20:21:49.235Z. Native accounting snapshot: 2026-09-11T20:21:58.790005+00:00. Read-only; no model runs, account funding, provider-limit changes or public messages were performed for this reconciliation.

**Observed reported-charge subtotal: $312.614181122** = $267.774301122 from eleven distinct OpenRouter keys + $44.83988 from retained direct xAI usage. Full league cost is **UNKNOWN**. These are provider-reported usage charges, not settled invoices.

## Coverage and exclusions

- OpenRouter is cumulative per key and includes preparation, rehearsal or legacy configurations, diagnostics and league activity. It is not a draft-only or native-only time slice. Ten keys are the named historical franchise keys; MiniMax is its current native key. Each reports a distinct identity and zero BYOK usage.
- Current native Qwen, DeepSeek, Kimi and Z.ai credentials match their named OpenRouter keys; MiniMax uses its current native OpenRouter key. Native DeepSeek reported $6.684851766 through that same route: already included, never add it again.
- OpenAI, Anthropic and Mistral currently use subscriptions. Their historical OpenRouter charges exclude current subscription allocation. Google and Meta direct-provider costs remain unreconciled. xAI direct coverage is retained native usage, not guaranteed complete account billing.
- Paid sources, fixed subscriptions, taxes, credits/refunds not represented by these usage counters, infrastructure and human labor are not allocated. No remaining season budget is computed from this subtotal or provider key limits.
- Missing cost records are UNKNOWN, never free. No published API tariff estimate is mixed into this table. Different work and billing coverage prevent a model cost-effectiveness ranking.

## Franchise charges

| Company   | OpenRouter usage USD |      Additional observed direct charge USD | Full franchise cost |
| --------- | -------------------: | -----------------------------------------: | ------------------- |
| openai    |           5.01621975 | Not separately reconciled / not applicable | UNKNOWN             |
| anthropic |          26.51177525 | Not separately reconciled / not applicable | UNKNOWN             |
| google    |            1.0803789 | Not separately reconciled / not applicable | UNKNOWN             |
| xai       |             1.963868 |                                   44.83988 | UNKNOWN             |
| meta      |           1.76757515 | Not separately reconciled / not applicable | UNKNOWN             |
| deepseek  |          9.253332806 | Not separately reconciled / not applicable | UNKNOWN             |
| qwen      |           146.714058 | Not separately reconciled / not applicable | UNKNOWN             |
| mistral   |            6.2048865 | Not separately reconciled / not applicable | UNKNOWN             |
| kimi      |           40.4831904 | Not separately reconciled / not applicable | UNKNOWN             |
| zai       |          22.36591928 | Not separately reconciled / not applicable | UNKNOWN             |
| minimax   |          6.413097086 | Not separately reconciled / not applicable | UNKNOWN             |

## Retained native token coverage

Available native records span September 8–11; each row gives its own first/last record time. These token totals cover a different population from the cumulative provider keys above. They must not be divided into those charges to infer a realized price. Input includes known disjoint uncached, cache-read and cache-write categories. Unreported categories remain unknown, and repeated streaming records are deduplicated. Counts combine native formats with different granularity; do not rank per-call averages across them.

| Company   | Known input components | Cache-read tokens within input | Known output | Unreported categories |
| --------- | ---------------------: | -----------------------------: | -----------: | --------------------- |
| anthropic |             32,065,587 |                     30,032,668 |      316,886 | None                  |
| deepseek  |             43,414,870 |                     40,945,920 |      300,438 | cacheWrite            |
| google    |            134,051,812 |                    112,478,761 |      829,262 | cacheWrite            |
| kimi      |             62,240,846 |                     58,874,624 |      441,499 | None                  |
| meta      |             40,492,226 |                     34,592,325 |      332,235 | cacheWrite            |
| minimax   |             41,644,001 |                     38,922,200 |      539,325 | None                  |
| mistral   |            152,113,422 |                    138,188,928 |      779,760 | cacheWrite            |
| openai    |             33,041,226 |                     31,379,584 |       74,177 | None                  |
| qwen      |            290,232,121 |                    277,182,848 |    2,707,924 | cacheWrite            |
| xai       |             56,936,914 |                     51,130,880 |      355,963 | None                  |
| zai       |             46,572,953 |                     41,074,240 |      179,593 | None                  |

The companion CSV includes per-franchise record dates, aggregate unit and category gaps. Collection is not atomic and retained logs do not prove complete coverage.

## Completed Moonshot social attempt

- September 11, 19:24:28.647–19:38:42.334 UTC; native duration 853,683 ms.
- 35 model requests, 37 tool calls; 110,271 uncached input + 2,951,168 cached input = 3,061,439 input; 17,413 output.
- All 35 generation IDs returned provider receipts. Native input, cached input and completion counts match those receipts. OpenRouter executed `moonshotai/kimi-k3-20260715`, served by Moonshot AI; no BYOK.
- Charges sum to **$1.4773584**. This is included in the Moonshot franchise key total, not additional.
- Runtime completed with a draft and blocker report following rejected X writes. Completion status does not establish that the requested external outcome happened. Exact upstream 403 cause is unknown; no model-quality conclusion follows from this case alone.

## Reproduction and private receipts

- `.local/diagnostics/league-provider-spend-20260911.json`: safe per-key totals from authenticated GET /api/v1/key; no credentials in output.
- `.local/diagnostics/moonshot-social-turn-charges-20260911.json`: 35 generation receipts matched to native request IDs and source hash.
- `work/token-economics-article-20260911/`: read-provider-usage.mjs, reconcile-kimi-turn.py, native-summary.json and build-spend-note.py.
- `/Users/joey/Documents/Codex/2026-09-11/league-token-economics/snapshots/20260911T202149Z`: source manifest and accounting-only projections.
- `work/runtime-efficiency-20260911/accounting.py`: normalization and streaming deduplication; native usage echoes are not separately charged.

Only the aggregate article and public cost table belong on the website. Private source paths, keys, owner prompts and raw tool responses do not.
