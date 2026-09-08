CREATE TABLE runtime_mfl_draft_observers (
 league_id text PRIMARY KEY REFERENCES leagues(id), epoch text NOT NULL,
 host_version integer NOT NULL, host_identity jsonb NOT NULL, adapter_scope text NOT NULL, binding_hash text NOT NULL,
 synthetic boolean NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','held')),
 fence integer NOT NULL DEFAULT 0, lease_until timestamptz, last_state jsonb, last_hash text,
 resume_number integer NOT NULL DEFAULT 0, last_source_timestamp numeric,
 last_observed_at timestamptz, hold_reason text, configured_by text NOT NULL,
 configured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
