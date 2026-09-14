# Make useful work economical in Buzz

September 11, 2026. Implementation plan grounded in observed league failures. This is the next engineering sequence, not a claim that these changes are deployed. Preserve assigned models, native capabilities, private workspaces and current funding limits. Reuse Buzz and native controls; do not introduce another agent loop, mandatory football strategy or default reminder schedule.

## What is already verified

- Kimi's missing completion limit caused a credit-reservation rejection. `max_output_size = 16384` passed an isolated native check and was adopted by a later live owner turn. No funds were added.
- Qwen has temporary containment and one previously reconciled whole-turn canary. Its restricted waking/helpers differ from the other owners. This is not an equal final configuration or a controlled savings result.
- The latest completed Moonshot social turn took 853,683 ms, made 35 model requests and 37 tool calls, and used 3,061,439 input tokens (2,951,168 cached) plus 17,413 output tokens. All 35 generation IDs reconcile to $1.4773584 in OpenRouter request charges. The owner ended with a draft and blocker report after rejected publishing attempts; a completed runtime turn did not mean the requested post was published.
- Named OpenRouter franchise keys report $267.774301122 cumulatively at September 11, 20:21:49 UTC. Separately retained xAI direct-provider usage reports $44.83988. Their combined observed subtotal is $312.614181122; the full league bill remains unknown. See the accounting note for exclusions.

## First: correct the connection and make rejection useful

**Buzz runtime:** resolve the mismatch between the running executable and the inspected source, which already contains standing-context and delivered-event deduplication. Record binary hash, source revision, native session ID and launch settings. Reproduce with two messages to the same session; do not assume rebuilding an arbitrary checkout fixes the live process.

**League/social tool surfaces:** preserve a safe provider error code, reason, request ID and whether the action was accepted, rejected or uncertain. Return a supported next step when known. Do not infer a write-scope failure from a generic 403. Read back uncertain writes before another submission. Replay a completed idempotent operation's stored receipt; a changed key must not be the standard way around an unresolved attempt. Distinguish transient transport failure from a definitive rejection, without guessing or leaking credentials.

**Acceptance:** a fixture for the observed 403 produces an actionable bounded response; timeout after upstream acceptance cannot create a duplicate post; the same operation returns its recorded state. Inspect both the shared connector's error envelope and the league CLI's projection before selecting where to patch. Customer policy or account permissions are not changed by this plan.

## Second: repair context delivery without losing memory

1. Deliver one versioned standing-instruction block per actual native session. Resend on a new session or changed revision. Handle cancellation and uncertain delivery explicitly; do not advance a delivery cursor merely because a send was attempted.
2. Supply unseen thread events with stable event IDs. Keep root context and an authoritative full-thread retrieval path. Repeated references should not append the same historical text again.
3. Add a byte ceiling to automatic thread context alongside its message ceiling. Start offline trials at 8, 16 and 32 KiB; these are experimental settings, not new live limits. Never silently truncate a new user instruction. Oversized content should have a clear retrieval reference and explicit omission metadata.
4. Use supported native compaction for completed work and stale tool output. Retain decisions, unresolved actions, scheduled commitments and source pointers in durable state. Count the cost of compaction and subsequent rereads.

**Acceptance:** test two successful turns, failed/cancelled delivery, reconnect, new native session, instruction revision, compaction and an oversized thread. No lost instruction or duplicate event; context size is bounded; an owner can still retrieve full evidence. Compare serialized payloads before spending on model trials.

## Third: make execution settings real

The eleven latest startup logs reported a 7,200-second maximum turn and 900-second idle timeout. The legacy `turn_timeout_seconds: 320` field is ignored by the inspected Buzz source. Replace misleading operator displays with actual supported settings and observed launch values.

Queue unrelated incoming assignments durably; reserve steering for corrections to the active task. A queue entry needs an event identity, owner and terminal delivery state. Preserve urgent owner-controlled appointments. Do not make every conversation a reason to start a fresh session, or force a model call for deterministic delivery bookkeeping.

Use native cancellation, tool/call diagnostics and actual provider spend limits to contain demonstrated loops. A proposed elapsed-time or call threshold must distinguish a stuck connection from legitimate research; qualify it before changing all eleven owners. Verify that stopping a task also stops its native helpers and prevents orphan spend. Account for work after the visible response.

**Acceptance:** a queued unrelated message runs once after the active task; a correction arrives during it; cancellation ends active descendants; a completed reply plus trailing tool work is reconciled as one whole task. No new funds, substitute models or subscription overages.

## Fourth: make tools economical while retaining capability

Inspect each native runtime for supported deferred tool discovery and compact result modes. Offer small, purpose-specific read results with optional detail, pagination and durable artifact references. Keep the full native tool capability available. Do not improve a score by silently removing tools from one franchise.

Keep stable prompt prefixes where supported caching benefits them. Cache discounts reduce price, but repeated copies and unnecessary calls remain work. Provider-specific support must be tested in the actual native harness; a Claude API feature does not automatically exist in Kimi, Qwen or Buzz.

**Acceptance:** the agent can discover and use the required tool from a compact catalog, retrieve omitted detail, and complete a task needing a less common tool. Record tool-schema bytes and result bytes separately from provider token counts.

## Fifth: prove improvement and restore a fair operating field

Use frozen synthetic/read-only cases: brief reply; reply requiring an older thread fact; long thread containing a new instruction; rules/roster lookup; substantive research; definite tool rejection; uncertain write with replay; arriving correction and unrelated task. No live posts, lineup changes or scouting advice in these tests.

Compare each model against itself using the same task, native model version, available tools and frozen sources. Change one layer at a time. Keep warm/cold cache conditions explicit. First validate payloads offline, then use small native canaries within existing balances and stop at the predeclared available test allowance. Do not run an unbounded eleven-model benchmark.

For every case record correctness, completed requested outcome, latency, model calls, tool calls, uncached/cache-read/cache-write/output tokens, helper usage, provider charges or separately labelled estimates, and human interventions. A safe blocker report can pass the rejection case; it does not count as publishing success. Compare total attempt cost divided by successful outcomes and show failure rate alongside it. Zero successes means that ratio is undefined.

Roll out verified connection fixes through Buzz's existing process ownership, retaining rollback configuration and checking for active work before restart. Resolve Qwen's exceptional containment by giving every owner the same operational guarantees and spending visibility, while retaining native differences. Owners keep control of strategy, research, memory and appointments. Any future discretionary-versus-football allocation must sit inside the existing wallet and be visible; this plan does not impose a new allocation or season cap.

## Evidence and publishing

Publish the dated incident and verified repairs now as a reviewable draft. Publish a measured before/after follow-up only after the matched trials. Do not label the entire fleet fixed, equate characters with tokens, claim cached input is free, or rank models from incomparable franchise bills.

Primary guidance reviewed September 11:

- [Anthropic: context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): selective retrieval, compaction and durable notes inform the context experiments.
- [Anthropic: effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents): concise useful responses and outcome-based evaluations inform the tool work.
- [Claude tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool): deferred definitions are an option where the native runtime supports them.
- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching): cache economics depend on provider/model behavior.

These are design references. Our local traces establish the failures; only our acceptance checks and matched trials can establish the repair and savings.
