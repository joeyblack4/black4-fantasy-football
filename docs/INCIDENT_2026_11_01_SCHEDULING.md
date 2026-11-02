# Sunday appointment delay — November 1, 2026

The league Mac hibernated after its battery depleted. All processes on that host, including PostgreSQL, the dispatcher and the native owners, stopped progressing until power was reattached. Durable appointments survived but could not execute on time. Sunday deliveries were approximately 4 hours 49 minutes to 12 hours 50 minutes late.

## Evidence

- macOS power log: October 31 at 05:01:40 PDT, `Low Power Sleep`, battery 1%; November 1 at 16:48:54 PST, wake from hibernate due to `acattach/UserActivity`, AC power, battery 1%. The reported sleep duration was 132,434 seconds. The apparent wall-clock difference includes the daylight-saving transition.
- Dispatcher log: last pre-sleep cycle at `2026-10-31T12:01:39.191Z`; first post-wake cycle at `2026-11-02T00:49:10.076Z`. Backlog deliveries began around `00:50Z`.
- The dispatcher retained PID 90055, originally started October 22. This was host suspension, not a dispatcher process crash or an appointment timezone calculation failure.
- Existing keep-awake service used `caffeinate -s`, whose system-sleep assertion applies on AC. There was no independent pre-deadline check to catch the sleeping host.
- A separate Qwen Sunday occurrence remained `started` after Buzz dead-lettered its native batch at `2026-11-02T01:05:19Z` for hard-cap timeout. It needed honest failure reconciliation before Monday work could proceed. Process liveness alone did not reveal this blockage.

## Repair and verification

The user-owned keep-awake LaunchAgent was backed up and reloaded with the versioned `deploy/black4-football-keepawake.plist`, using `caffeinate -is`. Readback verified the loaded arguments and both idle-system-sleep and system-sleep assertions under the new PID. No owner runtime was restarted. The league Mac was on AC at 100% charge during verification. No privileged `pmset` settings were changed.

The read-only `scripts/native-schedule-health.ts` command checks power, dispatcher freshness, overdue appointments including those not materialized, uncertain delivery and stalled execution. Its first production run correctly reported the Qwen blockage while the dispatcher was healthy. Regression cases cover the actual suspension/backlog and stalled-execution failure modes. Alarms do not authorize automatic completion or replay.

The four AI owners with Monday starters were asked to qualify their own scheduling path with a short one-time read-only appointment and verify their own Monday pregame appointment. Football decisions, native models and spending limits remain theirs. The operator checks actual PostgreSQL delivery and execution timestamps plus original native responses and fresh league read receipts; an accepted appointment alone is insufficient.

A one-time Codex heartbeat in the existing chat independently checks Monday health at 09:00 PST and every fifteen minutes during the 15:00–17:15 PST pregame window. Its task is to repair infrastructure faults, surface blockers, and verify actual native pregame execution before the `2026-11-03T01:15Z` kickoff. It stops after proven completion or reports any remaining failure at kickoff. This is incident supervision, not a default recurring owner reminder.

Monday execution remains future work until actual receipts exist. Both hosts require reliable power; the independent local follow-up also requires Codex to remain open. Neither caffeinate nor durable scheduling can operate an empty battery, closed sleeping laptop, or powered-off host. Native execution can also fail independently of delivery and must be verified at the deadline.
