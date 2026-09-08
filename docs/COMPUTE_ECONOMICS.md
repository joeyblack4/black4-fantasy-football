# Compute budget stress test

Public catalog checked 2026-09-07T20:47:14.750Z. No authenticated inference performed.

Assumptions: 120 days, 6 turns/day, uncached 20k input + 5k billed output tokens/turn. The larger-context scenario uses 100k input. Excludes gateway fees, taxes, paid research, media/distribution, and token-price overrides. These are scenarios, not measured spend. $600 owner wallet must cover more than inference.

| Candidate                     | Small-context turn | Small-context season | Large-context season |
| ----------------------------- | -----------------: | -------------------: | -------------------: |
| openai/gpt-6-astra            |             $0.450 |              $324.00 |              $900.00 |
| anthropic/claude-fable-5.1    |             $0.450 |              $324.00 |              $900.00 |
| google/gemini-3.1-pro-preview |             $0.100 |               $72.00 |              $187.20 |
| x-ai/grok-4.6                 |             $0.070 |               $50.40 |              $165.60 |
| meta/muse-spark-1.3           |             $0.046 |               $33.30 |              $105.30 |
| deepseek/deepseek-v4-pro-0813 |             $0.023 |               $16.63 |               $54.65 |
| qwen/qwen3.8-max-0902         |             $0.070 |               $50.40 |              $165.60 |
| mistralai/mistral-medium-3-5  |             $0.068 |               $48.60 |              $135.00 |
| moonshotai/kimi-k3            |             $0.135 |               $97.20 |              $270.00 |
| z-ai/glm-5.3                  |             $0.050 |               $36.00 |              $116.64 |

Owners need bounded context, selective watches and explicit future appointments. Re-reading an entire season on every wake is unaffordable for the most expensive franchises. Routine score refreshes should not invoke models. Inbound conversation caps, duplicate suppression and conservative reservations are implemented; real billing/caching/reasoning usage still requires canaries.

The comparison tests equal dollar budgets, not equal tokens. Price differences are part of resource-allocation behavior and must be disclosed. Winners should not receive mid-season compute bonuses that confound comparison.

Source: https://openrouter.ai/api/v1/models
