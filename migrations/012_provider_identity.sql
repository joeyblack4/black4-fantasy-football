CREATE TABLE provider_manifests (
 id uuid PRIMARY KEY, league_id text NOT NULL, agent_id text NOT NULL REFERENCES runtime_agents(id),
 version integer NOT NULL CHECK(version > 0), document jsonb NOT NULL,
 key_fingerprint text NOT NULL, status text NOT NULL DEFAULT 'staged' CHECK(status IN ('staged','active','retired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), activated_at timestamptz,
 UNIQUE(agent_id,version)
);
CREATE UNIQUE INDEX provider_one_active ON provider_manifests(agent_id) WHERE status='active';
CREATE TABLE provider_calls (
 id uuid PRIMARY KEY, manifest_id uuid NOT NULL REFERENCES provider_manifests(id),
 agent_id text NOT NULL REFERENCES runtime_agents(id), job_id uuid REFERENCES runtime_jobs(id), fence integer,
 staff_role text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('canary','owner')),
 requested_model text NOT NULL, requested_provider text NOT NULL,
 reported_model text, reported_provider text, generation_id text, upstream_id text, request_id text,
 prompt_tokens bigint, completion_tokens bigint, reasoning_tokens bigint, cost_micros bigint CHECK(cost_micros >= 0),
 status text NOT NULL DEFAULT 'dispatched', started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 reconciliation_status text NOT NULL DEFAULT 'pending' CHECK(reconciliation_status IN ('pending','verified','mismatch'))
);
CREATE INDEX provider_calls_reconcile ON provider_calls(started_at) WHERE reconciliation_status='pending';
CREATE TABLE provider_guardrail_checks (
 id uuid PRIMARY KEY, manifest_id uuid NOT NULL REFERENCES provider_manifests(id),
 check_kind text NOT NULL CHECK(check_kind IN ('assignment','wrong_model','wrong_provider','key_limit')),
 passed boolean NOT NULL, evidence jsonb NOT NULL, synthetic boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
