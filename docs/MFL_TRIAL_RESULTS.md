# MFL adapter validation

The selected MFL adapter was developed against an explicitly disposable operator-owned league. The trial exercised draft picks, roster readback, lineups, free-agent changes, blind bids and trades. Those were integration fixtures, not AI performance results.

Private authenticated requests, league-account details, native session material and raw league exports are deliberately excluded from the public source snapshot. See `tests/mfl-adapter.test.ts`, `tests/mfl-http.test.ts` and `src/mfl/README.md` for reproducible synthetic contract coverage.

A successful trial write does not establish fresh live scoring, future account validity, production-rule configuration or permission to operate another league. Use a dedicated account/league, exact fixed binding, trusted credentials, supported methods and independent readback. Unknown outcomes remain held; do not blindly retry a native mutation.
