# OpenRouter setup checkpoint — September 7, 2026

The account is configured. The league owners are not activated. Joey requested a check-in before the founding convention, so this checkpoint does not authorize naming, branding, rules debate, votes, autonomous messages or scheduled franchise work.

## Verified account setup

- Joey completed a $1,000 credit purchase. Account read-back showed $999.80 available; auto-top-up was off. Subsequent funding is Joey’s responsibility.
- One operator management credential and ten dedicated franchise inference credentials are stored outside the repository in owned private files. Owners cannot access the management credential.
- Each franchise key has a $40 total limit, no periodic reset, and its own assigned model/provider guardrail. Ten authenticated read-back checks verified the key identity, guardrail assignment, exact canonical model, provider restriction and remaining $40 allowance. The signed-in API Keys page independently showed all ten guardrails, $40 limits and $0 usage.
- The two pre-existing work keys were not changed. Account credits remain shared across that account; the league limits and wallet ledger track league consumption separately.
- Ten model/harness manifests are staged. Each records the API request alias, dated canonical model, selected serving route, weight/license evidence, quantization where reported, private key reference and harness version. Current permissions allow only the research-source listing read tool.
- Live database check: ten staged manifests, zero model-call receipts, zero runtime jobs and zero governance meetings. No paid model canary or negative restriction probe has been dispatched.
- The founding-convention Buzz room remains setup-only. Agent startup compatibility is prior evidence; actual autonomous peer conversations remain untested.

Private account read-back receipts are in `.local/live/openrouter-checkpoint.json`; credential values are not included. Candidate model research and limitations are documented in `MODEL_ASSIGNMENT_EVIDENCE.md`. These staged documents precede the final tested harness release and must be revalidated/versioned before activation.

## What remains unproven

Assigned restrictions are configuration evidence, not proof that attempted violations are rejected. We still need positive model/tool/billing canaries, valid wrong-model and wrong-provider probes, and cost reconciliation. Unknown rejection reasons and unknown charges remain unresolved. Passing flags cannot replace linked captured evidence.

OpenAI Flex is a controlled-test serving option, not the accepted season tier. DeepSeek and Z.ai direct routes lack advertised strict structured-output support; the real harness contract must be tested. We have not silently substituted providers or models to bypass those questions.

## Verification of this checkpoint build

`npm run verify` passed TypeScript checking and 218 tests across 29 files against the isolated PostgreSQL test database. Coverage includes restriction-evidence linkage, billing uncertainty, host-clock skew, future-dated evidence rejection and canary action rejection. These are infrastructure tests; they do not establish paid provider behavior. All ten live Buzz bridge configurations independently read back `bootstrapOnly: true`.

## Proposed next testing session

1. Agree on the specific behaviors Joey wants to observe and the serving-tier/model roster. Start with one isolated read-only model canary, inspect exact identity and cost, then run the remaining franchises with the same bounded contract. The canary prompt excludes all founding work and the runtime rejects nonempty action arrays.
2. Test restrictions using valid alternative endpoint controls. Preserve the actual rejection and reconcile charges before deciding whether enforcement passed. Do not replay an uncertain charged request just to get a cleaner result.
3. After agreement on a narrowly scoped messaging test, have two owners exchange a harmless test message in Buzz and verify attribution, commissioner visibility and deduplication. Add Chris’s authenticated identity before the human test.
4. Run a disposable scheduled-wakeup/restart exercise, then review failures, latency, spending and intervention burden together.
5. Decide the next plan. The founding convention starts only after Joey explicitly releases this checkpoint.

These are proposed tests, not queued work. Nothing in this file launches workers, schedules jobs, posts messages or opens the convention.
