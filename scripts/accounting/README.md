# Repeatable league token economics

This read-only workflow values retained native token usage at a frozen OpenRouter model catalog. It never runs an agent, changes its provider or funds an account. API-equivalent estimates are reporting, not invoices or another automatic cap.

1. Capture current usage outside the live repository:

```sh
python3 scripts/accounting/collect.py --repo . --out /Users/joey/Documents/Codex/league-token-economics/snapshots
```

2. Use the returned snapshot directory. To reproduce the September 11 prices, use the committed tariff file. To take new prices, use a **new** tariff path and add `--refresh-tariffs`; never overwrite a published snapshot.

```sh
python3 scripts/accounting/token_economics.py \
  --snapshot /absolute/path/returned/by/collector \
  --tariffs config/token-economics-tariffs-20260911.json \
  --out /absolute/private/path/to/report
python3 -m unittest discover -s scripts/accounting -p 'test_*.py'
```

The report saves per-record calculations, a franchise CSV and source/tariff hashes. Repeating the command with the same snapshot and prices produces identical output. Collection preserves original categories; repeated streaming records and native usage echoes are deduplicated. Helpers remain attached to their franchise and whole-turn work is included where retained.

## Valuation policy

- Use the executed native model, mapped explicitly to its OpenRouter model ID. Do not substitute a configured label when the trace reports another model. A missing model can be resolved from other records in the same session only if they consistently identify one model; record this resolution.
- Price uncached input, cache reads, reported cache creation and output separately. Claude's reported one-hour versus five-minute cache creation gets its respective rate. Reasoning is counted once according to the native format.
- The catalog is a reproducible comparison quote, not evidence of the provider actually serving a request or the route's historical price. Do not silently reprice a published historical comparison with new rates.
- Where OpenRouter advertises no cache-read discount, use its ordinary input rate and flag that policy. In this snapshot Mistral's quote omits its native Vibe cache discount. The resulting OpenRouter reference value is higher than the native harness estimate; neither is a subscription invoice.
- Apply context tiers to per-call counters. Where the native data is a multi-call aggregate and cannot establish each call's tier, report a range. Never price an entire multi-call turn as one long request. xAI has this limitation in the September 11 snapshot.
- Missing input, cache-read or output counts remain unknown. Unreported cache-creation categories remain explicitly unreported and excluded from this inference-only reference, not fabricated zeros. Cache storage, tools/search, fixed subscriptions and human time are outside this metric.
- Preserve lower/upper values and unknown-record counts. Do not publish a known subtotal as a complete estimate if a franchise has unpriced records. All September 11 retained records were valued, with category exclusions and xAI's range disclosed.

The $600 season budget is Joey's policy. A reference value as a percentage of $600 is a comparison, not a verified remaining cash balance. Existing OpenRouter keys are not proof that a native application currently uses them.
