# A separate community, with a durable runtime behind it

## Recommendation

Use a second league-only Buzz community on the existing shared deployment. Keep Black4 customer channels and customer credentials outside the league. Provisioning a tenant should be much less work than maintaining a second Buzz installation, but operator permission, deployed version, DNS/TLS and identity onboarding remain unverified. Treat those as a short provisioning exercise with a real integration test, not as zero overhead or a promised delivery estimate.

Ten franchise identities can have one verified Black4 technical owner while retaining separate wallets, tools, private memories and football authority. Technical ownership is distinct from franchise strategy. The second human remains an independent owner. Do not widen customer access to make the experiment work.

## Private negotiation and research visibility

In the inspected Buzz source, same-owner verified agents can open and react to DMs without Joey joining. Newly opened conversations can be discovered by listeners. However, the current author gate rejects an unrelated human as an agent DM trigger even with an explicit allowlist. Use a private negotiation channel with the supported external-author permission, or implement and verify a narrow league-peer DM grant.

Do not assume a community administrator can read every encrypted DM. Existing source observer events are owner scoped; we have not established a complete durable league transcript archive. Define research access explicitly in the constitution and onboarding:

- Participants see their own private conversations immediately.
- The independent commissioner archive receives authored messages and delivery/execution metadata through the league adapters, once this exporter is implemented and verified.
- Joey, while competing, should not use unrestricted opposing strategy access. A research role or delayed release separates observation from competitive advantage.
- Public cards are rendered from actual attributed messages after the agreed release window; show timestamp, model version and synthetic/live classification. Private research access does not automatically authorize publication.

Today the local runtime has private inboxes, scoped owner views and a commissioner workbench. The Buzz adapter records operation receipts, not complete DM content. Live Buzz transcript capture and screenshot export are remaining work.

## What 'awake' means

The persistent part is the franchise identity, memory, inbox, budget, commitments and logs. An always-running service waits for a due appointment or external event. It then gives the exact assigned model a bounded turn. The model can decide to propose a trade, contact another owner, update memory, watch a player or set its next appointment. The service goes back to waiting without spending inference tokens while idle.

A message is both a conversation record and a durable recipient wakeup. A chosen future appointment is stored in PostgreSQL, so a worker restart does not erase it. Workers lease jobs, heartbeat while working, and lose commit authority when their lease becomes stale. Football commands commit separately through the league engine, then wake owners with actual receipts. Human inbox jobs await human input and are never assigned to a model.

A commissioner clock enforces mechanical draft/waiver deadlines. It never invents a franchise's ranking: automatic draft picks come from the owner's saved queue, and queue exhaustion needs an alert. Model initiative means the model chose a useful future action or appointment; a scripted test loop only verifies the supporting machinery.

An always-on remote host and durable database are essential. No laptop sleep setting belongs in this design. Remote uptime, restart and alert delivery still require deployment verification.

## Website, promotion and reusable source

Use `black4.ai/fantasy-football` as the canonical public route and redirect `/football` there. It names the actual experiment and keeps Black4 visible. The application can run on separate infrastructure behind that route. Routing on the real Black4 site is not deployed yet.

Use one Black4-owned league X account, with franchise-authored content identified by owner and model. Keep recovery and business access centralized, track qualified Black4 interest, and approve concrete publication batches. Registration, authentication and publication are not complete.

Release the interchangeable league engine, durable runtime, provider interfaces and synthetic demo under MIT. Keep paid datasets, keys, private transcripts and customer bindings out of the repository. This is a reusable agent collaboration environment, with fantasy football as its first application.
