# Agent budget field note: keeping an autonomous owner in the game

**Status:** Internal draft. Evidence captured September 10, 2026. Not approved for publication and not a live-change authorization.

**Remediation status:** A bounded Qwen runtime was installed and restarted at 2026-09-10 19:00 UTC under an explicitly approved intervention. This note remains an internal record; the remediation does not authorize publication.

## The short version

Part of this experiment is learning how much human involvement autonomous agents actually require. Qwen supplied a useful answer much earlier than expected.

The agent did not spend heavily because one answer was unusually expensive. A permissive native configuration allowed a small number of human and agent mentions to become thousands of provider calls. Long-running sessions kept carrying large histories, tool results, skills and memory into the next request. Subagents and automatic memory work multiplied that activity. The OpenRouter key limit eventually became the only effective brake.

The human job is therefore not merely to provide an API key and get out of the way. Someone must decide what the agent may spend, what work deserves that spend, how long a task may continue, what happens when several requests arrive together, and how the agent stays capable of essential work when its discretionary budget is gone.

That is not a reason to abandon autonomy. It is part of learning how to operate it.

## Evidence snapshot

Source boundary: OpenRouter account activity and the local Qwen usage ledger were inspected read-only. Provider charges are authoritative for cash. The local reconstruction covers only its recorded window and remains separately labeled.

- OpenRouter showed **$143.60** used on the Qwen key against a **$150** provider-key limit and approximately **329 million tokens**.
- The local ledger recorded **2,794 requests across 94 sessions** from September 8 at 17:34 UTC through September 10 at 16:51 UTC.
- Those requests contained **315.8 million input tokens** and **3.3 million output tokens**.
- Average input was approximately **113,000 tokens per request**; the largest recorded request contained approximately **519,000 input tokens**.
- Approximately **95.1%** of recorded input was cached. Cached input was discounted, not free.
- The local tariff reconstruction was approximately **$125.93** for its covered window. The difference from the provider total is outside that local reconstruction and must not be silently attributed.
- Qwen has consumed approximately **23.9% of its $600 season operating ceiling** before other possible tools, charges or unresolved costs are considered.
- A fresh MFL read at **2026-09-10 18:06 UTC** showed a complete nine-player Week 1 lineup for Qwen. This establishes near-term lineup state, not future participation or decision quality.

## Intervention applied

- Qwen was stopped through Buzz before configuration changed; no other franchise runtime was stopped.
- Its runtime now uses a repo-local, isolated `QWEN_HOME`. Five relevant franchise-memory files are present; the fifth, `reference/web-news-fetch-access.md`, was restored after Qwen identified the omission during the canary. Old chats, subagent histories and unrelated global Qwen state were not copied.
- Enforced settings cap a session at 200,000 tokens and 40 turns, cap each turn at 25 tool calls, cap generated output at 2,048 tokens, re-enable loop detection, compact at 15% of the context window and clear oversized or idle tool results.
- Managed automatic memory, dreams and skill generation are disabled. The `agent` and `list_agents` tools are denied, so the model cannot multiply work through subagents.
- Buzz parallelism remains one and only Joey can send instructions to the runtime. Ordinary channel chatter can no longer wake it.
- The OpenRouter key was raised once from **$200 to $250 total** only after the bounded runtime was live. Provider read-back returned **$146.166544 used** and **$103.833456 remaining**.
- Starting the new runtime did not increase provider usage. No synthetic test prompt was sent solely to prove the fix, and no league write or lineup change was made.
- The first real owner-turn canary completed at 2026-09-10 19:18 UTC using 8 of the 25 allowed tool calls. Provider usage moved from **$146.166544** before the turn to **$146.372252** at reply-send time: **$0.205708** for the bounded wake, verification and reply.
- Qwen independently verified the isolated runtime and live limits. It incorrectly inferred that one subagent level remained available by inspecting `maxSubagentDepth` without inspecting the separate `permissions.deny` list; the live policy denies both `agent` and `list_agents`, so those tools remain unavailable.

This is verified configuration, provider-cap containment and one successful bounded owner-turn canary. One turn is not season-long proof. The remaining gaps are dollar reservation by task class, protected scheduled participation wakes and guaranteed queueing instead of in-flight prompt merging.

## What failed in the setup

1. The native Qwen process was launched directly, while the older Black4 worker settings that named a per-turn reservation and 6,000-token output ceiling did not govern it.
2. Qwen was not given an isolated `QWEN_HOME`, so it could see broad user-level state rather than a deliberately small franchise runtime.
3. Qwen's installed defaults permit unlimited session turns, a very large effective tool budget, subagent nesting to depth five, automatic memory extraction and consolidation, and skipped streaming loop detection.
4. The persistent session accumulated context instead of closing a bounded assignment and carrying forward a compact owner record.
5. Buzz's fallback behavior merged new steering into an in-flight task when native steering was unavailable. New work could therefore extend an already-expensive session.
6. The provider key limit capped total loss, but it offered no weekly pacing and no protected capacity for lineup, waiver, trade or injury work.

## Operating policy we need

### Preserve participation before discretionary autonomy

Every franchise keeps the same assigned lead model. Do not silently downgrade or substitute a cheaper model. Split its operating allowance into two lanes that still reconcile to one franchise wallet:

- **Participation reserve:** usable only for deadline and roster work such as lineups, waivers, trades, injury response and commissioner-required league operations.
- **Discretionary envelope:** conversation, broad research, marketing, experiments, background memory work and owner-initiated projects.

Exhausting the discretionary envelope should put the owner into a conservation mode, not remove it from the league. The reserve must be inaccessible to background loops and ordinary channel chatter.

### Enforce limits outside the model

The Black4/Buzz boundary should reserve spend before a turn, record the assigned lane, reconcile provider-observed usage afterward and queue work when the applicable envelope is unavailable. Prompts may explain the budget, but prompts are not the enforcement mechanism.

Minimum controls for each externally triggered turn:

- one active turn per franchise;
- a fixed provider-call and tool-call ceiling;
- a wall-clock deadline with verified cancellation;
- a cumulative dollar ceiling, including helpers and memory agents;
- bounded tool-result content;
- no nested subagents by default;
- no automatic memory or skill-generation work in the participation lane;
- new messages queued or coalesced rather than merged into the active context;
- a fresh task session or compact structured handoff instead of indefinite transcript reuse.

### Apply the installed Qwen controls

Qwen Code already exposes useful controls. The Qwen-specific qualification should use an isolated `QWEN_HOME` and test conservative settings for `model.sessionTokenLimit`, `model.maxSessionTurns`, `model.maxToolCallsPerTurn`, `model.maxSubagentDepth`, `model.skipLoopDetection`, `generationConfig.samplingParams.max_tokens`, context cleanup and managed auto-memory. Its `--bare` mode is a promising way to avoid global discovery, but it must first be tested with an explicit minimal football/personality context so cost reduction does not erase the franchise.

These native settings are circuit breakers. The authoritative season and per-lane dollar budgets still belong in Black4's control plane.

## Proposed rollout

1. Do not raise Qwen's provider-key limit while the current unbounded configuration is live.
2. Temporarily stop discretionary Qwen wakes. Preserve its existing Week 1 lineup and use a controlled same-model participation turn only if a material football event requires one.
3. Patch and test Qwen first: isolated state, compact explicit context, no background memory, no subagents, bounded tools/output/context and fresh task sessions.
4. Add Black4 reservation and reconciliation at the native ACP boundary, with separate participation and discretionary lanes.
5. Prove three cases before reopening ordinary Buzz traffic:
   - a broad assignment ends within its call, time and dollar limits;
   - a second message is queued rather than merged into active work;
   - an exhausted discretionary envelope cannot consume the participation reserve, while a real deadline wake can still use the assigned Qwen model.
6. Run the same bypass audit for every native franchise. Qwen exposed the problem first; it should not be treated as proof that the rest of the fleet is protected.
7. Add operator alerts at envelope thresholds and record every human intervention, including setup time, diagnosis time, pauses, budget changes and recoveries.

## Website piece direction

### Working title

**The AI owner spent four weeks of budget in two days**

### Working thesis

We wanted to know how much human work it takes to keep autonomous agents operating. One of the first lessons was that autonomy does not eliminate management. It changes the work. Instead of making every decision, the human designs the boundaries, watches the economics, repairs the operating environment and makes sure one ambitious agent cannot spend itself out of the season.

### Story movement

1. Open with the $143.60 screenshot and the honest reaction: this got expensive fast.
2. Explain that the token budget is the league's salary cap. Qwen used almost a quarter of its season ceiling before Week 1 was underway.
3. Show why the obvious explanation—"Qwen is expensive"—was incomplete. The configuration turned a handful of requests into thousands of calls carrying huge histories.
4. Describe the human intervention: diagnose, preserve the lineup, stop discretionary waste, build a protected participation reserve and make the controls enforceable outside the model.
5. Connect it to a small business. Giving an agent authority without workload, budget and recovery design is like giving a new department a company card but no operating plan.
6. End with the experiment's useful tension: the goal remains maximum practical autonomy, but autonomy that cannot survive its own spending is not operational autonomy yet.

### Publication requirements

- Refresh provider totals and timestamps immediately before publication.
- Decide whether exact provider/model/key costs are public; do not expose credentials, private prompts or private Buzz conversations.
- Keep provider charges, reconstructed local costs, competition-resource value and the $600 season ceiling distinct.
- Report later remediation results separately from this diagnosis. The first real bounded turn and provider read-back passed; label it as one canary rather than proof of durable season-long containment.
- Record Joey's actual setup and intervention time before making a claim about the human-management burden.
