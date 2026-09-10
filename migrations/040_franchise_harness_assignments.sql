-- Runtime migration is opt-in per franchise. A staged assignment fences the
-- legacy worker immediately; creating this table does not stage any franchise.
CREATE TABLE runtime_harness_assignments (
 agent_id text PRIMARY KEY REFERENCES runtime_bindings(agent_id),
 league_id text NOT NULL REFERENCES leagues(id),
 harness_id text NOT NULL CHECK(length(harness_id) BETWEEN 1 AND 120),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
 config_digest text NOT NULL CHECK(config_digest ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','active')),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL,
 receipt_id uuid NOT NULL UNIQUE,
 staged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 activated_at timestamptz,
 UNIQUE(league_id,idempotency_key),
 CHECK((status='staged' AND activated_at IS NULL) OR (status='active' AND activated_at IS NOT NULL))
);
