# Durable owner runtime: early build

The runtime is PostgreSQL state plus disposable workers. The model is invoked only when work is due. An owner can store private memory, schedule and cancel its appointments, and send a peer a message. The message and recipient wakeup are committed in the same transaction; a process crash cannot commit one without the other. This is **local engine messaging**, not proof that a message reached Buzz.

`RuntimeStore` is an internal trusted command layer. HTTP/MCP/CLI transports must bind actors from verified credentials. `createAgent`, `ingestEvent`, `snapshot`, `claim`, billing reconciliation, and worker methods are operator/internal methods; never give them directly to franchise models. `scheduleSelf`, `cancelSelf`, `sendMessage`, and `agentSnapshot` take the authenticated actor separately from request input. Model output action objects cannot choose an actor or a different model.

`runOne(store, driver, workerId, {leaseMs,maxCostMicros})` claims one job matching `driver.model`, reserves its maximum estimated cost, runs the driver with bounded private state, validates output, then atomically applies actions and settles the recorded spend. A supervisor must run this repeatedly on an always-on machine. An external event adapter must deduplicate and route source events. The local code does not provision cloud hosting or subscribe to licensed news.

## Durability and permissions

- One active leased turn per franchise, PostgreSQL owner locks and row claims. Expired claims increment a fencing token; stale workers cannot commit actions.
- Deduplication uses `(agent,causalId)` plus canonical payload fingerprints. Same key with changed intent fails.
- Up to ten output actions per turn. A two-owner conversation contains at most 24 messages. Memory has 100 keys and 32 KiB aggregate content; appointment backlog is limited to 1,000.
- Incoming messages, model-produced replies, appointments, private memory changes, dispatch times, and costs have separate receipts. The transcript is not a provider's hidden chain of thought.
- Private memory, recent messages, and pending commitments are loaded only for the claimed owner. Commissioner archive access must be separated from competing-human access.
- Completion is one transaction. A failed later action rolls back earlier local sends, appointments, memory, and budget settlement from that result.
- Known-zero invocation failures can retry, up to three attempts. Unknown provider failures retain reserved money for reconciliation. Expired running turns also retain uncertain reservations; retries cannot silently regain potentially spent money.
- A provider reporting cost above its reservation is recorded as actual spend and freezes the owner without applying output actions. The preflight wallet is not a provider-side spending guarantee. Require conservative maximum output/context estimates and upstream spending caps before paid use.
- Provider cost observations are saved even after a lease expires. A completed external model request can cost money despite a crash, and fencing cannot undo it.

## Drivers and proof scope

`TestDriver` is explicitly synthetic and makes no network or model calls. Runtime fixtures prove software coordination, persistence and atomicity; they do not prove autonomous model initiative, model quality, or Buzz delivery. Each completion receipt records driver name, model and synthetic status.

A real provider driver implements `AgentDriver` from `index.ts`; its returned output must satisfy `DriverResultSchema`. Never let an owner-provided `costMicros` stand in for provider usage. A real adapter must derive that field from provider billing or trusted token/rate metadata. No automatic model fallback is supported.

`npx vitest run tests/runtime*.test.ts` includes an OS-process SIGKILL after a committed claim/reservation, followed by recovery. `npx tsx src/runtime/soak.ts` runs a 30-minute synthetic timer/message/recovery loop and writes `evidence/runtime-soak.json`. `RUNTIME_SOAK_MS` can shorten the test. The soak uses an isolated test schema and drops only that schema on normal completion.

## Next integration work

1. Run supervised workers on an always-on host with restart policy, secrets mounts, health checks and backups.
2. Deliver Buzz messages through an outbox adapter with external idempotency/read-back. Local sends alone are not Buzz delivery receipts. Failed or uncertain external sends must remain visibly pending.
3. Run the football dispatcher continuously alongside model workers. The implemented football outbox invokes the league command layer with persisted authority and stable idempotency, then atomically records the verified receipt and recipient wakeups. A network mutation cannot be made atomic with a runtime transaction merely by calling it inside that transaction.
4. Route authenticated external news to interested owners and separately record source latency, queue latency, provider latency and mutation latency.
5. Add immutable model-upgrade records with no in-flight turn. The initial model is pinned; `createAgent` rejects attempts to overwrite it.
6. Add operator retry/reconciliation UI and verify permissions independently. The runtime deliberately does not silently reopen dead jobs or release uncertain costs.

## Human franchise owners

Migration `008_runtime_humans.sql` adds a durable `ai`/`human` identity kind and backfills previously bound human teams. A human's inbound message job has status `awaiting_human`; no worker may claim it, even if its model label matches an AI driver. Reading the inbox through GET does not produce a read receipt. An authenticated manual reply proves interaction, marks the original delivered/responded, completes its inbox job and records `human.replied`. Human inbox items count toward the same 200-message pending limit.

The internal send path checks league bindings, including model-returned actions: if either identity is bound, both must belong to the same league. An unbound pair is permitted for isolated synthetic fixtures; a non-synthetic worker additionally refuses an unbound identity before invocation. The per-conversation cap cannot bypass the recipient's total inbox limit by opening new conversations.

`ObservedCostError(message, costMicros, generationId?)` lets a real adapter report a billable response whose content or model identity failed validation. That reported charge is retained with the generation reference and accounted on failure; it is not treated as a free failed request. An overrun freezes the franchise. `RetryableUnknownCostError` permits bounded recovery after a timeout while retaining its uncertain reservation.

The soak report includes the SHA256 of `index.ts`, `worker.ts`, `football-schema.ts` and `football-outbox.ts`, duration, isolated schema, final/completed flags, counts, and an explicit synthetic scope label. Evidence from a running earlier version must not be represented as validation of later changes. Runtime tests separately cover the actual OS-process kill; soak lease-expiry injection is a simulated disconnected worker, not repeated OS kills.

## Football action integration

Migration `010_runtime_football.sql` and `FootballOutbox` connect model decisions to authoritative football operations. An action is `{type:'football', causalId, command:{type:'setLineup', week:1, slots:{RB:'player-id'}}}`. The nested command schema supports only owner operations: draft picks and queues, lineups, trade proposals/acceptance/cancellation/rejection, waiver submissions/cancellations, and free-agent adds. It rejects supplied actor, league ID, idempotency key, commissioner operations, unknown fields, and wrong-league players or trade peers before queueing.

`RuntimeStore.complete` inserts the outbox record within the fenced action/budget transaction and does not call the league engine. `FootballOutbox.dispatchOne` derives owner/team/league from persisted binding records, verifies they still match the queued authority, executes `LeagueService.execute` with stable key `runtime-football:<outbox UUID>`, checks the resulting receipt against the engine's own receipt table, and atomically acknowledges delivery plus result wakeups. Trade counterparties receive their own result wakeup, allowing a subsequent owner turn to accept or reject the proposal without a coordinating human prompt.

The integration tests drive a fully synthetic propose → counterparty wake → accept sequence and verify actual roster changes in the isolated test league. They also test replay after an injected interruption between engine commit and acknowledgment, concurrent dispatcher claims, forged receipts, stale model claims, authority injection, failed ownership and scope. This is software execution proof, not evidence of actual model football skill.

Every live supervisor must supply `allowedAgentIds` to both `runOne` and `FootballOutbox.dispatchOne`. Matching a model ID alone is insufficient to bind a worker to a league. An empty scope claims no work. Omitted scope is useful for isolated synthetic fixtures and commissioner-operated local development only.

Outbox retries preserve the same engine command key. Five failed attempts deadletter the action. Ordinary league validation failures are terminal and wake the owner with the failure, so a new decision can fix the problem. A failed action never produces a success receipt. The pending outbox is limited to 100 commands per owner.

## Priorities and same-model staff

Migration `013_runtime_franchise.sql` persists urgent, normal and background queue priorities. Trusted source/deadline adapters may enqueue urgent events. Owner-created appointments can request only normal or background priority; a peer writing “urgent” in a message does not promote that message. Claims select the highest-priority due work, then oldest due work, while retaining per-franchise turn serialization and fencing. Priority does not interrupt an already-running model call; urgent response latency remains bounded by the current turn and provider timeout until a coordinated preemption policy is implemented.

A `delegate` action supplies only causal ID, staff role and task. It cannot choose a model, credentials, alternate franchise or separate budget. Staff jobs use the same franchise model and wallet, default to background priority, and have durable parent relationships. At most four staff jobs may be pending/running per owner and four may originate from a parent turn. Staff cannot recursively delegate or mutate football, public drafts, services or peers. They report in their result summary and may store namespaced notes; a successful or terminally failed staff job wakes its owner to make the next decision. `StaffDecisionSchema` gives real provider adapters the corresponding report-only structured output contract.

These staff jobs are bounded delegated turns within a franchise, not separately credentialed workers or parallel reasoning identities. They preserve the one-live-leased-turn-per-franchise rule. They have not yet been validated with paid model calls.
