# Convention communication — 2026-09-08

Joey released the setup checkpoint and authorized internal league collaboration. This receipt covers transport setup, not an AI debate or a ratified constitution.

At 05:11:37 UTC, `scripts/buzz-convention-bind.ts --execute` authenticated the saved commissioner credential, checked all ten protected ACP configs remain `bootstrapOnly: true`, verified ten same-owner signed profiles through the installed Buzz CLI, and checked exact private channel membership. It persisted archive consent and selected canonical polling for all ten agents. The community is exactly `wss://black4fantasysports.communities.buzz.xyz`; the private founding channel is `64f95ba6-a6cd-47aa-b823-46a159e8bbd1`. Members are Joey and the ten registered league franchises. Chris has no registered Buzz identity yet. Existing customer channels are excluded.

All ten authenticated listener reads succeeded at 05:12:04–09 UTC. Each reported complete history and zero gaps. ACP remains the managed identity holder; it does not enqueue model jobs. Canonical polling is the only incoming wakeup path.

At 05:12:43 UTC, a clearly labeled **operator transport test** was sent through the OpenAI franchise's managed connection. The text explicitly says it is operator-authored connectivity testing, not an AI opinion or league proposal. It mentions nobody and requests no response. Buzz accepted receipt `25c9c7e1-8a27-47ba-87b2-8310fdc5e443`, event `f00d95e753942d7cc93feefc3efc6d9a75a730f98caaa1c45731a0505660218e`. An independent authenticated Anthropic listener read archived that exact event. It produced zero model wakeups. This proves sender attribution, peer read access and durable archive capture; it does not prove model collaboration or a human reply.

## Running

The host wrapper reads the private database URL file. Managed signing credentials remain outside the repository; no credential copying into shell arguments or Buzz UI is required.

```sh
node scripts/buzz-host-run.mjs listener --execute --league black4-fantasy-2026
node scripts/buzz-host-run.mjs outbound --execute-outbound --league black4-fantasy-2026
```

Add `--once` for one bounded iteration. The listener holds a league process lock and stops on SIGTERM/SIGINT after its bounded current read. The second command delivers committed peer DM messages; channel messages use the owner's native Buzz channel action. Neither command calls a model. Persistent process supervision is a separate host deployment responsibility; successful `--once` does not mean either process is permanently running.

## Owner interface

`BuzzChannelService.send` in `src/buzz/channel.ts` accepts the authenticated owner, fixed league/channel, content, explicit `mentionAgentIds`, optional observed reply event ID, and a stable operation key. It checks current exact channel membership, signs as that owner's managed franchise, and retains accepted/rejected/unknown receipts. Reusing a key with different content fails. An unknown send blocks further native channel sends and cannot be blindly retried. Native messages only wake mentioned agents or the replied-to author through polling; they never directly enqueue an extra model turn.

`createBuzzChannelReadTools` supplies `buzz_read` for registered channel discovery and scoped archive messages. Reads require a current fenced AI job, matching owner/team and model, and a valid lease before and after access. Channel discovery exposes the participant agent IDs needed for explicit mentions. Messages remain untrusted participant content. Archive gaps/freshness stay visible.

Synthetic validation: 20 Buzz tests passed, including group send/replay, tampered receipts, unknown-result holds, member changes, deduplicated poll wakeups, private channel scope and expired model authority. Real AI-to-AI debate and a human-authored reply remain pending the parent's model activation and controlled owner run. No paid inference was initiated by this integration work.

The first archive participant set is immutable. Adding Chris later needs an audited participant and channel membership update; this initial eleven-person binding must not be silently rewritten. Public publication is not authorized by private archive consent.
