# Salary-cap reconciliation — September 11, 2026

The public graphic reports league salary-cap debits, not cash invoices. Joey explicitly authorized pricing retained ChatGPT and Claude native usage at OpenRouter API prices rather than allocating existing subscription fees. He requested that billing mechanics remain out of the article. The accompanying JSON preserves the distinction internally. Other owners use provider charges. This mixed cap policy is not a controlled comparison of model tariffs.

## OpenRouter key history

Authenticated per-key analytics returned September 8 requests only for OpenAI, Anthropic, Google, xAI, Meta and Mistral; these six have zero current-day charges. Their native configurations now use direct providers or native account authentication. The other five continued on OpenRouter September 9–10. All eleven key fingerprints are distinct and all BYOK usage is zero. The management activity endpoint covers completed UTC days; live key counters include the current day. Small differences between aggregate daily records and key totals are retained rather than silently forced to match.

The extra keys reflect earlier routed work, not passive tracking of direct-provider tokens. No duplicate provider billing was identified by this review. This is not an invoice-level proof that every historical request occurred exactly once. Historical OpenRouter charges and subsequent native costs are distinct components. Native DeepSeek and Kimi receipts are already inside OpenRouter totals and are never added again. Old keys remain enabled; no credential or funding settings were changed.

Evidence: ignored `.local/diagnostics/openrouter-key-activity-20260911.json`, `openrouter-key-metadata-20260911.json`, `league-provider-spend-reconciled-20260911.json`; current native configuration and `NATIVE_FLEET_LIVE.md` cutover record. Provider API reference: https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity .

## Current direct billing read-backs

- Google AI Studio Spend: Black 4 Fantasy League key selected; August 15–September 11; $63.91 total cost. Dashboard warns that cost may lag up to 24 hours. Historical OpenRouter $1.0803789 is separate.
- Meta Usage: Black4 Fantasy League key selected; September 5–11; $14.55 PAYG spend, 997 requests. Existing Muse Code plan counters were zero and do not cover Goose. Historical OpenRouter $1.76757515 is separate.
- Mistral billing: invoice MSTRL-API-902510-001 dated September 8 is Paid, $14.99. Pro active, included Vibe usage $49.49/$300, included API $0/$30. Both PAYG lanes and auto-recharge disabled. Included allowance is not another expense. Historical OpenRouter $6.2048865 is separate; cap debit $21.1948865. The earlier $234.02 figure was hypothetical full-input OpenRouter valuation and must not be described as actual spending.
- xAI: all 73 retained native turn records have provider-reported costs, summing to $47.555046 at snapshot 20260911T220947Z. Historical OpenRouter $1.963868 is separate. These are recorded inference charges, not a settled-invoice or auxiliary-service reconciliation.
- Native OpenAI $51.704854 and Anthropic $61.03126950 are authorized cap valuations from the frozen snapshot and current OpenRouter tariff file, not extra cash charges. Historical OpenRouter $5.01621975 and $26.51177525 respectively are separate earlier work.

## Meridian and Mistral findings

Qwen cumulative OpenRouter charge: $146.714058. September 10: 1,408 requests, $74.988566, 162,869,909 prompt tokens. Isolated runtime settings still enforce 200,000 session tokens, 40 turns, 25 tool calls, 2,048 output tokens, loop detection, compaction, and disabled automatic memory/dream/skill work and agent tools. These are temporary containment, not a measured fleet-wide efficiency fix.

Mistral's 46 retained session metadata files all select mistral-medium-3.5: 152,113,422 input tokens, 138,188,928 cached, 779,760 output, 2,186 steps. Largest session spans September 8 20:42–September 9 03:26 UTC with 44,850,356 input tokens and 470 steps. It spans assignments; do not present it as one message. Session stats include 229 tool failures and 1,758 successes; agreed-call count is a different counter and does not reconcile exactly, so no failure-rate denominator is asserted. Repeated context and failed-tool investigation warrant optimization; this does not establish that Mistral is the second-highest cash spender.

No native runtime settings changed during this audit. Publication and cap enforcement are separate from this frozen article graphic.
