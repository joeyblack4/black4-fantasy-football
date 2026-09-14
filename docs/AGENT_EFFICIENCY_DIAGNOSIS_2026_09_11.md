# Why the league agents use so many tokens

**Internal diagnosis and content-series brief, September 11, 2026.** This records observed behavior in our configured league runtimes, not a benchmark of model intelligence or universal product defaults. No content was published and no fleet settings were changed during this audit. Moonshot's output-limit repair happened immediately before it.

The defensible finding is that our operating setup can turn a small request into substantial model traffic. Several costs compound: native instructions and tools, Buzz's injected context, persistent session history, repeated tool/model calls, and permissive waking and execution controls. The oversized Moonshot output allowance was a separate failure: it blocked generation without consuming that requested output.

## What actually happened

| Finding                                               | Evidence                                                                                                                                                                                                                                                                                                         | Responsibility and consequence                                                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output allowance was mistaken for context capacity    | Moonshot's first failed call declared `maxTokens: 1048576`; OpenRouter rejected an effective 131,072-token request against credits covering 119,369.                                                                                                                                                             | Native Kimi fallback plus our missing output setting. Fixed with `max_output_size = 16384`; no budget increase.                                                                                         |
| Native agent startup is substantial even without Buzz | A standalone Kimi connectivity check used 20,641 input tokens, including 768 cached, and 38 output tokens. It received no Buzz channel context. Its logged tool set contained 25 definitions, serialized to 70,850 characters; its native system prompt contained 19,036 characters.                             | Native runtime baseline. A full coding agent carries capabilities a simple acknowledgement does not use. Token accounting does not expose the exact allocation between each instruction/tool component. |
| Buzz repeatedly appends standing context              | In one Moonshot session, 17 delivered prompts each carried the same 14,951-character Base, 539-character System, and 2,300-character core-memory blocks. Sixteen turns completed and one was cancelled. Duplicate copies beyond the first amounted to 284,640 of 339,119 delivered prompt characters, about 84%. | Observed Buzz-to-native integration behavior. This is avoidable duplication in the delivered text, not proof of an 84% bill reduction.                                                                  |
| A message-count limit does not bound context size     | Observed Moonshot thread blocks reached 86,736 characters. Another 83,911-character block, following a completed turn, contained 68,060 characters of exact message text already present in earlier thread blocks in that session.                                                                               | Buzz thread-context packaging. The observed 13-message blocks are consistent with a root plus a 12-message tail. Long messages still make a large payload.                                              |
| Session reuse compounds the payload                   | The 17-prompt session recorded 143 successful model-usage events; request history grew from 3 to 299 messages, and input reached 188,735 tokens on a call.                                                                                                                                                       | Native history/tool loop plus session lifecycle. Multiple calls are normal for research and drafting; their number alone is not evidence of waste. Repeated context makes each later call heavier.      |
| A configured timeout is not necessarily active        | All eleven latest startup logs report `max_turn=7200s`, `idle_timeout=900s`, `max_turns_per_session=0`. Managed records still contain `turn_timeout_seconds: 320`. Inspected Buzz source explicitly says that old field is deprecated and ignored.                                                               | Runtime configuration and verification. Two hours is the observed maximum turn; 320 seconds is not an enforced promise. Idle timeout and total duration are different controls.                         |
| Social work can expand execution                      | Startup logs show mention subscription, one execution slot, `meh=Steer`, and no proactive session rotation. Ten owners accept mentions from anyone; Qwen is owner-only after containment. Native traces contain “What you were working on” and newly arrived-message sections.                                   | Buzz event handling plus our admission policy. Not every channel post wakes every owner, but mentions and broadcasts can create many paid turns, and new messages can extend ongoing work.              |

Character sizes are exact measurements of the recorded strings, or JSON serialization where specified. They are **not token counts**. Usage figures are native-reported counters, not independently settled invoices.

## Is Buzz sending the whole channel every turn?

That is not what we observed. Joey's 113-character top-level message to Moonshot arrived with platform instructions, owner instructions, core memory, a canvas revision pointer, routing metadata, and the triggering event. It contained no automatic channel-history block. The inspected Buzz context-fetch function returns no conversation history for an ordinary top-level channel message; thread replies and DMs follow different paths.

There are nevertheless two separate kinds of repetition:

1. A model request may include the existing session history again. That is normal for this style of model API. Cache reads can reduce its price. Persistent sessions do not make historical context free.
2. Our observed integration also adds another copy of standing instructions and previously seen thread messages to that existing history. That increases what later requests carry. Sending instructions once per session prevents multiple copies; it does not remove the original instructions from all subsequent provider calls.

Across the inspected Moonshot main-session traces, 39 sessions contained 93 accepted prompts. Thirty-four included thread-context blocks. Within-session repeated standing blocks totaled 942,870 delivered characters. This covers available history, not a fixed-workload experiment; failures and cancellation are included and some retransmission can be necessary.

The native layer adds its own system instructions, tool definitions, workspace context and prior tool results. In the failed-message case, the logged native system prompt alone was 20,962 characters, separate from the Buzz-delivered sections. We cannot allocate the bill to those components exactly without request-level provider tokenization and price evidence.

## What the other owners show

The accounting snapshot captured 526 sources and normalized 8,192 retained usage records across eleven franchises. The following slice starts September 10 at 00:00 UTC and ends at the snapshot cutoff on September 11, approximately 19:13 UTC. It is a coverage report, not a ranking. Owners did different amounts and kinds of work. Historical operator diagnostics within franchise workspaces may be included.

| Owner     | Observations and unit  | Known input, millions | Known output, thousands | Cache-read share of known input |
| --------- | ---------------------- | --------------------: | ----------------------: | ------------------------------: |
| OpenAI    | 20 calls               |                 0.697 |                     1.6 |                           76.8% |
| Anthropic | 53 calls               |                 3.858 |                    30.7 |                           87.3% |
| Google    | 297 message aggregates |                19.145 |                   154.9 |                           82.2% |
| Mistral   | 22 session aggregates  |                68.782 |                   426.9 |                           89.4% |
| xAI       | 17 turn aggregates     |                11.355 |                    90.2 |                           90.3% |
| Moonshot  | 126 calls              |                10.588 |                   117.6 |                           89.1% |
| MiniMax   | 207 calls              |                11.140 |                   124.2 |                           94.1% |
| Qwen      | 1,171 calls            |               146.255 |                 1,536.6 |                           95.2% |
| DeepSeek  | 87 calls               |                 7.779 |                   112.5 |                           95.7% |
| Meta      | 189 calls              |                11.109 |                    98.7 |                           77.5% |
| Z.ai      | 142 calls              |                24.921 |                    41.6 |                           83.7% |

Some native formats omit a cache category; sums retain known components and the machine-readable report preserves missing categories as unknown. Mistral session totals and xAI turn totals can cross the time boundary. Do not divide those aggregates as though each is one provider call. Deduplicated streaming records differ from raw ledger row counts. Coverage is not proven complete, and configured versus observed model identities can differ; the JSON retains observed identities.

The useful finding is the large volume of input relative to output, with much of it cached. It does not establish that all input was unnecessary. Caching discounts depend on provider and model; a cache hit is not the same as a free request. [OpenRouter prompt-caching documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

Qwen's containment provides a descriptive comparison. In this parser's retained history before September 10 at 19:00 UTC, 2,330 deduplicated calls averaged 124,235 known input tokens; 15 later calls averaged 51,015. The workloads, observation periods, memory, helper availability and waking rules changed together. This is not a controlled savings percentage. Its prior dollar incident and separately verified whole-turn canary remain in [the September 10 field note](AGENT_BUDGET_FIELD_NOTE_2026_09_10.md).

## What to repair, in order

| Priority | Change                                                                                                                                                                                                    | Proof required before calling it fixed                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Verify the deployed Buzz binary and repair repeated standing-context delivery. Keep one versioned copy per actual native session; refresh when instructions change or session reconstruction requires it. | Two successful prompts in the same native session contain one standing copy, and a new session receives it. Repeat with a failed turn, cancellation and compaction.                           |
| 2        | Bound automatic context by size as well as count. Deliver unseen thread events; include a compact summary or durable retrieval reference for older/oversized content.                                     | A long thread cannot grow the automatic payload beyond the configured allowance, while owners can still retrieve full evidence. Preserve required new instructions without silent truncation. |
| 3        | Use explicit task boundaries and queue unrelated arrivals. Reserve steering for genuine corrections to the active task.                                                                                   | An unrelated second message waits durably and runs once; an urgent correction is still delivered; failed tools and uncertain transactions are not blindly repeated.                           |
| 4        | Configure supported total-duration, call/tool and spend controls in each native runtime; retire misleading legacy fields from operator status.                                                            | Inspect actual launched settings, exercise cancellation, include helpers and post-reply work in usage, and verify cleanup. A config file or running PID alone does not pass.                  |
| 5        | Make the tool catalog and retrieved results economical. Prefer native deferred discovery where supported; retain full native capability and link to large outputs.                                        | Compare the same task with full versus deferred context. Preserve successful tool selection and task completion. Do not silently remove tools from one owner to improve a token chart.        |
| 6        | Separate persistent identity/memory from indefinitely growing task transcripts. Compact completed work and stale tool output, preserving commitments, rules and unresolved actions.                       | A restarted/compacted owner retains its obligations and can retrieve supporting records. Measure both the compaction cost and later requests.                                                 |
| 7        | Protect season participation inside the existing wallet and expose per-task spend.                                                                                                                        | Discretionary conversation cannot exhaust capacity reserved for essential league work. No model substitution, additional money, default football advice or operator-selected lineups.         |

The inspected Buzz checkout already contains standing-context and delivered-event deduplication code. That is a candidate implementation to qualify, not evidence it is active: the observed runtime payload still contains duplicates. We must resolve the binary/version or session-state mismatch rather than simply copying settings or claiming an upgrade solved it. Broad runtime changes have not been deployed by this audit.

Use the same operational guarantees for every owner: clear queues, durable access, visible budgets, recoverable state and usable tools. Native implementations can differ. Qwen's current owner-only waking and denied helpers are disclosed containment differences, not proof of a perfectly equal final setup.

## How to prove improvement

Freeze representative tasks and compare old and repaired context construction offline first. Then run a small, capped set of the same tasks with the same model and tools: a brief reply, a reply requiring earlier thread evidence, a roster-rules lookup, and a multi-step research task. Include a long-thread case, an interrupt, an exhausted discretionary budget and a failed tool. Use read-only league actions during validation.

Record completed task, correctness, latency, model calls, uncached input, cached input, output/reasoning, tool-result size, helper work, retries, whole-turn cost and operator intervention. Reconcile at turn completion, including work after the visible answer. Log task and event IDs so duplicate delivery can be distinguished from distinct attempts. Report cost per successful task and failure rate together. No savings or quality comparison is claimed yet.

Anthropic's published guidance supports compact, relevant context, selective retrieval and clearing old tool results, while warning that aggressive compaction can lose important information. Our measured failures are local evidence; that guidance supplies design options, not validation of our repair. [Context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

## Content-series brief

**Series thesis:** Giving an agent a job and a budget is only the beginning. The operating environment determines what it reads, how often it wakes, how long it keeps working and whether it can still do tomorrow's job.

1. **The agent that could not afford to answer.** Show the oversized output allowance and the successful 16,384-token setting. Explain reservation versus actual usage. Business analogue: an oversized authorization request can block a small job despite remaining funds.
2. **The answer was short. The preparation was not.** Show the separate 20,641-input/38-output connectivity test, the native tool catalog, and repeated Buzz instructions. Business analogue: repeatedly loading the whole operating manual to answer a small question. Explain what context is useful and what repetition is avoidable.
3. **The five-minute limit that was actually two hours.** Show the deprecated 320-second field beside observed 7,200-second runtime settings. Business analogue: a spending or execution policy that exists on paper but is not enforced in operations.
4. **Can we make it cheaper without making it worse?** Publish the controlled task results after repair. Include missed obligations, recovery and human work alongside cost. This episode is pending evidence.

These are briefs, not scheduled posts. A first draft opening for the company series:

> We gave eleven AI owners fantasy teams and operating budgets. One stopped answering a simple message. Another had already needed spending controls before the season got going. The logs showed how much the setup mattered: oversized response allowances, repeated instructions and conversations that kept growing. Before blaming the models, we had to inspect the machinery around them.

Claims to avoid: “Kimi spent 131,072 tokens on a reply”; “Buzz sends the entire channel on every turn”; “all agents are inefficient”; “cached input is free”; “we cut costs 84%”; “the cheapest observed franchise is the best model”; or “the fleet is fixed.” None follows from this audit.

## Reproduction and evidence

The read-only collector and analysis scripts are in `work/runtime-efficiency-20260911/`. They reuse the prior native accounting parsers, add Qwen's isolated home, and scope database records to franchise workspaces and their descendants. The collector stores an accounting-only projection; the prompt-size analyzer emits section headings, lengths and hashes rather than private message content.

Private output root: `/Users/joey/Documents/Codex/2026-09-11/league-runtime-efficiency/`. Key artifacts are `analysis/summary.json`, `analysis/fleet.csv`, `analysis/kimi-prompts.json`, `analysis/kimi-sources.json`, and `analysis/case-evidence.json`. Source hashes, sizes, record locators and null-category counts accompany the measurements. Source files were read at different instants; these are not an atomic snapshot of all running agents.

Inspected Buzz source: `/Users/joey/.codex/worktrees/buzz-black4-anyone-access`, commit `f815cc9b404fab30018f7eaf9df4ac4c061c7c17`; `crates/buzz-acp/src/pool.rs` (conversation context and session rotation), `queue.rs` (prompt construction), `config.rs` (limits), and `desktop/src-tauri/src/commands/agent_models_update.rs` (deprecated timeout). Observed league executable SHA-256: `bf3ce58ed505d95a181a0f3fa10c19ae2c72a9d1c7d8fa0076226926ee3ccfdc`. Source-to-binary equivalence has not been established.

Moonshot's original failure, isolated canary and configuration change are documented in [Kimi runtime repair](KIMI_RUNTIME.md). During this audit, a subsequent owner-triggered native session also emitted requests with `maxTokens: 16384` and successful usage records. This confirms live adoption of the setting, not completion of that owner's new task.
