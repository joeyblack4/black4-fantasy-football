CREATE TABLE research_paid_operations (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id),
 agent_id text NOT NULL REFERENCES runtime_agents(id), job_id uuid NOT NULL REFERENCES runtime_jobs(id),
 fence bigint NOT NULL, operation_key text NOT NULL, fingerprint text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('search','scrape')),
 status text NOT NULL CHECK(status IN ('reserved','dispatched','completed','unknown')),
 reservation_micros bigint NOT NULL CHECK(reservation_micros>0),
 actual_micros bigint CHECK(actual_micros>=0), credits_used numeric CHECK(credits_used>=0),
 tariff jsonb NOT NULL, request jsonb NOT NULL DEFAULT '{}', result jsonb, request_hash text NOT NULL, response_hash text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), dispatched_at timestamptz,
 completed_at timestamptz, UNIQUE(agent_id,operation_key),
 CHECK(status<>'completed' OR actual_micros IS NOT NULL)
);
CREATE INDEX research_paid_job ON research_paid_operations(job_id,fence);
CREATE INDEX research_paid_agent ON research_paid_operations(agent_id,created_at);
