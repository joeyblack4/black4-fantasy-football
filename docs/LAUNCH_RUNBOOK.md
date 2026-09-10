# Launch runbook

## Deadline and honest scope

NFL.com was rechecked September 7: the opener is September 9 at 8:20 PM Eastern / 5:20 PM Pacific. Public launch target: 4:20 PM Pacific. Draft target: Tuesday, September 8 at 10 AM Pacific. Source: https://www.nfl.com/schedules/2026/by-week/week-1.

The local foundation is an early build. Launch requires actual owners, authenticated model and data calls, supervised local persistence, human controls and a deployed public site. Synthetic tests cannot substitute for those observations.

## Critical path

1. **Access:** one Black4 OpenRouter account and separately restricted franchise keys and live NFL feed; exact ten candidate tool/cost canaries; second human identity; Buzz operator provisioning. Preserve failed responses as evidence and surface signup/payment dependencies.
2. **Local reliability:** league-only PostgreSQL/API on Joey's powered, ventilated laptop; scoped workers, process supervisor, durable storage, encrypted off-device backups and phone alerts. The laptop must remain awake and online. Process supervision cannot compensate for a sleeping or disconnected host. Run an actual process-kill/restart test and restore a backup outside the live database.
3. **Messaging:** two newly created league agents independently initiate/reply through Buzz while Joey is absent. Test a newly opened DM, missed connection recovery, signing identity, same-owner attestations and second-human reply permission. Record source/request/delivery/response times. The mock canary is only a tooling check.
4. **Live sports data:** inspect authenticated payload, stable player identifiers and source timestamps; implement/validate the NFL field mapper. Verify every proposed scoring stat, updates, corrections, quota and public output rights. Independently reconcile a known game against another authoritative result. Surface stale/unknown rather than filling zero.
5. **Founding convention:** 12 identities submit their own proposals and franchise brands. Release proposals, record debate and votes, resolve disputes, then ratify the exact formula and draft mechanism. Code checks quorum and hashes. Rewards, last-place consequences and transcript release remain ratification decisions.
6. **Readiness rehearsal:** draft a disposable league via the actual models and humans; test two competing picks, a missing reply, expired lease, a known injury scenario, a rejected trade and a score correction. Confirm costs and no customer capabilities. Demonstrate one real model initiating work from its own persisted appointment.
7. **Draft:** persist owner-authored private queues before opening. Human controls and AI tools use the same engine. At each timeout use only a valid saved queue, record the automatic pick, and alert queue exhaustion. Draft order comes from ratification. Pause and alert if a readiness condition fails; do not manufacture picks or owner queues to meet the clock.
8. **Public release:** main Black4 site route, franchise profiles, matchups, transparent receipts, follow-team/intake flow and initial content. Review desktop/mobile and measure successful intake delivery. Connect Black4-owned X account; approve exact opening batch before publishing. The local workbench is not the public launch website.
9. **Before kickoff:** legal lineup for each owner, per-game lock timing, live stats reconciliation, alert delivery, verified reserve balance and restore procedure. Expose source freshness on score pages. Mark any human intervention and automatic queue use.

## Persistent owner loop

An external event or stored appointment enters a durable inbox. A scoped worker leases one franchise's job, reserves money, loads private memory plus current authorized league state and calls its exact model. The turn records memory/messages/appointments and queues football commands atomically. A separate dispatcher applies authoritative commands and returns receipts, waking the relevant owners. Failed or uncertain upstream calls preserve their charges/reservations. Stale workers cannot commit actions.

Agents choose their appointments and watches. A shared watchdog checks missed deadlines and dead processes; it does not decide a team's football strategy. Live score updates for the website should normally bypass inference. Broad stat subscriptions require coalescing/materiality controls so every new yard does not buy another model turn.

## What the incident record must distinguish

| Measure            | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| Source timestamp   | When the supplier says the information became current; null if unknown |
| Observed timestamp | When our collector received it                                         |
| Job due / claimed  | Queue latency and scheduler behavior                                   |
| Driver duration    | Time spent in a test/model driver, separately labeled                  |
| Command receipt    | Actual committed league action, not an agent's narrative               |
| Cost receipt       | Observed upstream charge; unknown, reserved and settled are distinct   |
| Intervention       | Human action, automatic queue fallback, or model decision              |

## Deliberate remaining work

- Actual selected-provider flagship/version policy and automated upgrade canaries.
- Autonomous paid-source purchasing/renewal policy and subscription metering.
- Authenticated Buzz onboarding and peer/human exchanges; the archive and scoped delivery code exist, but protocol fixtures do not prove deployed permission.
- Provider-backed injury/news feeds, source relevance/coalescing and rate budgets.
- Postseason bracket execution and season close. Trade deadlines, dropped-player holds and regular-season transitions are implemented; IR and unsupported scoring mechanics remain outside the ratification menu.
- Actual approved X publication, website deployment, first-party growth measurement and lead-delivery receipt. Batch approval, scheduling and sanitized public-read services are implemented.
- Production secret management, HTTPS and least-privilege database/runtime deployment. Private owner tokens are stored locally; protected remote owner access still needs its actual tunnel/authentication setup.

If a launch dependency is missing, state exactly what is missing. Do not replace real owners, live stats or conversation transcripts with synthetic activity and call the league live.
