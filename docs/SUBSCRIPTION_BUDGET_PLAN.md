## Governing update — fast and loose

Joey requests maximum native autonomy and minimal implementation complexity. [Operating principle](OPERATING_PRINCIPLE.md) supersedes earlier custom approval, helper-allowlist and broad capability-gating plans. Enforce actual spend caps and subscription limits; reference-priced resource estimates are reporting only. Keep account separation, duplicate prevention and the explicit draft hold. Roster: seven native harnesses, two Goose, Z.ai on OpenCode.

# Subscription-backed franchises and budget accounting

September 8, 2026. Joey requested using his existing Codex and Claude subscriptions to reduce incremental spending. This changes the authentication and accounting plan, not the selected native harnesses or the production-action hold. This is a design amendment; no credentials, account settings, authentication, model calls or billing migrations were changed.

## Subscription-first authentication

- OpenAI: qualify the selected Codex runtime with ChatGPT subscription login, isolated league state and the assigned lead model. OpenAI documents both subscription login and headless authentication, while recommending API keys as the general automation default. Follow its supported native account flow; do not turn the session credential into a generic model API key. [Official authentication](https://developers.openai.com/codex/auth/).
- Anthropic: qualify supported Claude Code subscription authentication for the exact Buzz/native adapter. Claude Code documents subscription OAuth, while the Agent SDK separately restricts offering subscription login/rate limits through third-party products. Native CLI login support and the user's existing Buzz use do not by themselves establish qualification of this new SDK-backed unattended league route. If that route is unsupported, report the specific restriction and leave the franchise staged; do not silently bill an API key. [Claude authentication](https://code.claude.com/docs/en/authentication), [SDK integration scope](https://code.claude.com/docs/en/agent-sdk/overview).
- Omit API-key overrides, alternate provider credentials and paid fallback from subscription-only launch environments. Never modify the user's global credentials or retail-edge deployment to enforce this. Establish private native auth storage through the supported login flow; do not mount a personal home or its unrelated sessions/tools into a franchise.
- Verify the selected account tier, lead model, native helper access, allowance/reset visibility and paid-overage behavior before a canary. Tier information has been requested from Joey; no new subscription purchase is assumed. An unavailable model is a blocker, not permission to silently change the roster.

## Two separate ledgers

1. **Cash ledger:** actual incremental API/tool/service charges, purchased usage credits, upgrades and other experiment spending. Existing subscriptions are recorded as shared prepaid resources; their known fixed fees are shown separately, without charging the entire fee again to the league or inventing a per-call allocation. Incremental inference cash may be zero only when the included subscription route and absence of paid overage are verified. Otherwise cash status is unknown. Fixed fees, if not supplied, remain unknown.
2. **Competition resource ledger:** token usage by model and category, including cached tokens, reasoning/output and helpers where exposed, valued at a versioned reference tariff for all ten franchises. Display this as estimated resource consumption, not an invoice. Use the existing $600 franchise ceiling as the resource allowance, with non-inference tools/services charged at actual cost. Do not add actual inference charges again to that same resource ledger. Independently retain the $600 per-franchise cash ceiling and the overall season cash ceiling.

For each operation retain the auth/billing mode, native run/session and child IDs, model/provider, usage evidence, tariff version, resource debit and independently verified cash status. A CLI dollar estimate must never become a settled provider charge. Claude explicitly distinguishes subscription inclusion from its locally calculated token-price estimate. [Cost reporting](https://code.claude.com/docs/en/costs).

Unknown usage, absent prices and unattributable calls stay unresolved; they do not receive a zero resource debit. Preserve historical invoices and receipts unchanged. Start the new resource ledger at the runtime cutover and carry forward existing cash spending/holds; historical resource backfill is optional only where evidence supports it and is labelled reconstructed.

## Account limits and spending controls

- Subscription limits can be shared with Joey's ordinary work and existing Buzz agents. Keep account-wide remaining allowance separate from league-attributed session consumption. Never attribute an account-wide usage delta entirely to the league while other work is active.
- Monitor supported allowance/reset signals. Pause and queue on a provider limit; resume at the reported reset. No automated purchases, top-ups, usage-reset redemption, API fallback or model downgrade.
- Use one active owner turn per subscription-backed franchise. Apply the fleet concurrency cap and bounded turn/tool/helper limits. Reserve resource budget before work and reconcile it against native usage; qualify conservative bounds/cancellation before claiming a hard cap. An unenforceable resource meter is a readiness blocker.
- Before unattended admission, verify that the league cannot drain purchased overage credits from a shared account. If native controls cannot isolate included usage from paid credits, keep unattended operation blocked and give Joey the exact account setting or scoped-account alternative needed. Do not disable paid features globally without his instruction.
- These controls limit league consumption; they cannot reserve provider capacity against unrelated applications using the same subscription. Show that limitation in Buzz and keep deadline risk visible.

## Implementation changes and acceptance

Extend runtime configuration with explicit subscription/API billing mode and fallback disabled. Split the driver result into usage/resource evidence and actual cash evidence; the current verified-cash-only driver is insufficient for prepaid access. Persist immutable reference tariffs and replay-safe resource reservations/debits separately from the existing cash wallet. Reuse existing job fences, receipts and uncertain-outcome semantics.

Add tests proving that subscription selection cannot pick up ambient API keys, list-price estimates never settle cash charges, included usage still consumes resource budget, helpers are counted once, missing usage remains held, limit/reset events pause and recover without replay, shared-account deltas are not treated as franchise usage, and account limits never trigger a paid fallback.

The initial $5-per-franchise/$50-total qualification cap applies separately to incremental cash and reference-priced resources. Subscription use therefore saves real cash while remaining bounded during qualification. All model/harness and production-draft gates from the accepted architecture continue to apply.
