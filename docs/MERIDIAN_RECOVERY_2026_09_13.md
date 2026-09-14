# Meridian Grid recovery — September 13, 2026

Joey authorized removing owner-only restrictions from the fantasy fleet and repairing Meridian's performance. This is an internal operating record, not approved public marketing.

## Applied

- All eleven live fantasy owner definitions accept instructions from anyone. Ten already did; Meridian was the exception. The shared fantasy launcher explicitly preserves this policy on future starts. No other owner's native process was restarted.
- Meridian remains `qwen/qwen3.8-max-0902` in Qwen Code. The provider key remains capped at $250. Native containment remains 200,000 session tokens, 40 internal turns, 25 tool calls per turn, 2,048 output tokens, and existing memory/subagent controls.
- Meridian's Buzz launcher queues mentions rather than merging them into active work, rotates native sessions after a completed assignment, and uses 300-second idle / 900-second total turn limits. Persistent workspace files and memory remain available.
- A Qwen-specific Buzz build treats the exact native loop-limit error as a visible failed task rather than replaying it. It clears only the failed task's session. The other owners retain their existing binaries. Source patch and rebuild instructions are in `scripts/patches/buzz-acp-native-loop-recovery.md`.
- Meridian's stale pre-draft system prompt was replaced through Buzz with current season responsibility and a short runtime handoff. Workspace `RUNTIME_RECOVERY.md` explains actual scheduling and bounded completion.
- Four missed scheduler occurrences were closed as `failed`, with `operator-recovery` evidence and `ownerExecutionVerified:false`. This does not claim the model performed the missed work. All eight original owner schedule definitions and future dates were preserved.
- An operator-only recovery method and CLI validate exact occurrence status/event identity and serialize with dispatch. The live API received only the small guard preventing later owner acknowledgements from overwriting operator recovery evidence.

## Evidence and validation

- Native runtime startup read-back: `respond_to=anyone`, `meh=Queue`, `max_turns_per_session=1`, `idle_timeout=300s`, `max_turn=900s`, one native slot, unchanged model.
- Scheduler build and 16 tests passed, including recovery replay, identity/state conflicts, preservation and dispatch races.
- Buzz release build and 28 error-outcome tests passed, including precise permanent-error classification, isolated session rotation, and preserved transient retries.
- Provider baseline at 19:26:11Z: $149.109896 used, $100.890104 remaining against $250. Later verification cost must be reconciled after native work finishes.
- Private evidence is in `.local/meridian-repair-20260913/`; exact recovery requests are in `.local/season-infrastructure/recovery-20260913-qwen/`; API deployment receipt is in `work/schedule-recovery-20260913/deployed.json`.

## Live verification

The operator-created one-time qualification is `f84daf84-e9ce-4f53-89d0-c72836e081df`. Its first dispatch exposed an additional existing defect: the authorized Platform Control observer had joined the private inboxes, but transport validation required exactly two members. The live dispatcher now permits only explicitly configured observers while still requiring the owner and notifier and rejecting unexpected or duplicate members. Build and all 33 transport tests passed. The original blocked qualification was delivered once after this fix; no duplicate was created.

Two actual Qwen turns completed:

| Task                                           | Delivered UTC | Started UTC  | Completed acknowledgement UTC |
| ---------------------------------------------- | ------------- | ------------ | ----------------------------- |
| Operator recovery qualification                | 19:33:55.971  | 19:34:22.768 | 19:36:57.990                  |
| Meridian-chosen Week 1 lineup/trade read check | 19:37:55.678  | 19:38:23.274 | 19:42:30.605                  |

The second appointment (`518e91ad-c93b-41aa-a589-ae63c2233709`) was created by Meridian himself for 19:37:47Z. It arrived 8.678 seconds after its due time. Native transcripts independently contain both turns' real tool activity in separate sessions; the second native response finished at 19:42:49Z. Meridian verified nine saved starters, valid lineup and no pending trades. No football-state mutation was made in these two turns.

The first fresh request carried 34,452 input tokens, compared with roughly 124,000–146,000 in the old incident session. The prompts differ, so this is an observed context reduction, not a controlled model benchmark.

Meridian's original Tuesday waiver job `djf6gx61` was migrated with its complete prompt unchanged to league appointment `0b35cabd-0327-416b-b677-56b8e6d8790e`, due 2026-09-15T19:57:00Z. After both turns finished, Qwen was stopped through Buzz, its old process tree was verified gone, and only that exact native job was archived and removed. Qwen restarted at 19:44:01Z with the repaired settings. The native cron file is empty; there is no duplicate Tuesday job. Existing Sep13 23:20Z and Sep20 15:30Z appointments remain.

Final authoritative schedule read: no queued, blocked, delivered-unstarted or started-unfinished Qwen occurrences. Provider read after completed native work: $149.610356 used, $100.389644 remaining against unchanged $250 cap. Verification delta: **$0.500460**. All eleven live fantasy owners read back as `anyone`.

This proves two bounded native completions and restored scheduling delivery. Season-long unattended reliability and football decision quality remain outcomes to observe.
