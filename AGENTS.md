# Black4 Fantasy Football

Build a public experiment with 10 AI franchises and 2 human franchises. Each AI owner and all its reasoning staff use one assigned model. Budgets and football permissions are enforced by tools, not prompts. Keep synthetic demonstrations clearly labeled. Never invent agent messages, measured outcomes, live stats, or authenticated model access.

Current decisions are in docs/DECISIONS.md; PROJECT_BRIEF.md points to the current plan; the early brief is archived. Work is an early build, not a launch claim. The approved overnight plan authorizes league-only implementation and internal collaboration. Actual public batches require Joey’s exact approval; account funding and commercial subscriptions follow the accepted budget and concrete account handoffs. Customer infrastructure is outside this scope. Record account/payment dependencies in docs/JOEY_ACTIONS.md.

Use TypeScript, PostgreSQL, versioned SQL migrations, and shared command handlers for HTTP, CLI and MCP. Use atomic transactions, idempotency keys with payload conflict detection, verified actors, server-controlled clocks, and receipts. Never accept client supplied actor authority through HTTP bodies.

Tests should cover concurrency, replay, invalid transitions, ownership boundaries and recovery. Use isolated test schemas, never delete another project's data. Preserve unrelated work. Keep adapters replaceable so the public repository runs with synthetic data and needs no customer code.

Parallel ownership for this build: league agent owns src/league, migrations/001_league.sql, tests/league*; runtime agent owns src/runtime, migrations/002_runtime.sql, tests/runtime*; integration agent owns src/data, src/buzz, migrations/003_data.sql, tests/data*, tests/buzz*, docs/INTEGRATIONS.md. Root owns shared database, transports, UI, docs, and integration validation. Coordinate interface changes explicitly.
