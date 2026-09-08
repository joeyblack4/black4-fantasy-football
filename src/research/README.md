# Bounded franchise research tools

`createOwnerResearchTools(db, options?)` returns the `OwnerReadTool[]` interface used by `OpenRouterDriver`:

- `research_sources`: list trusted public sources and availability.
- `research_retrieve`: retrieve one permitted URL, return a bounded untrusted excerpt, source links, provenance and receipt.
- `research_search`: explicitly returns `SEARCH_NOT_CONFIGURED`. It makes no external search request and does not spend money.

Initial sources are NFL's [news](https://www.nfl.com/news), [injury reports](https://www.nfl.com/injuries/) and [schedule](https://www.nfl.com/schedules). Public pages and the actual pinned-IP reader were checked on September 7, 2026. All three returned HTTP 200. This establishes public reading capability, not a licensed live statistics feed, search account, or paid subscription entitlement.

The trusted application supplies the source allowlist. Models cannot add hosts, change allowed paths, supply headers or credentials, select ports, or follow redirects. HTTPS requests resolve DNS, reject nonpublic addresses, pin the validated address to the TLS socket, and preserve the original hostname for certificate validation. The reader sends no provider/account headers, ignores proxies, rejects compressed responses, and bounds DNS/request time and the body to four megabytes. NFL news/schedule HTML exceeded the original one-megabyte bound; the tested four-megabyte ceiling accommodates their current approximately 1.6–1.8 MB pages without removing bounds.

Only a current, enabled, league-bound, fenced runtime job can use these tools. There are at most eight retrieval/search receipts per job and sixty per owner per hour. Public reads have no API purchase path. Optional paid research still requires the separate franchise account/spending workflow; it cannot be introduced through these tools.

Cache entries retain a bounded plain-text excerpt, at most five short allowed links, title, content hash and source-time metadata. Raw HTML is discarded. Excerpts are capped at 120 words; script/style/navigation content is removed, and no HTML is executed. All returned source content is explicitly untrusted and cannot authorize instructions or spending.

A declared article timestamp is separate from retrieval time. Missing source time stays unknown; an old article fetched moments ago is not described as fresh news. Future/invalid source timestamps are rejected as unknown. Shared short-lived cache leases prevent duplicate concurrent page fetches. Completed retrievals and failures have durable league/owner/job receipts; failures never substitute invented football information.

`npx vitest run tests/research.test.ts` verifies URL and address boundaries, redirects, body limits, error redaction, source-time uncertainty, bounded extraction, cache reuse, concurrent fetch leases, fenced job authority, request limits, and explicit unavailable search. Unit/integration fixtures are synthetic; separate read-only public network checks established that the initial official pages are reachable.
