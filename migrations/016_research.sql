CREATE TABLE research_cache (
 url text PRIMARY KEY,source_id text NOT NULL,document jsonb,cached_at timestamptz,
 fetch_token uuid,fetch_lease_until timestamptz,
 CHECK((document IS NULL)=(cached_at IS NULL))
);
CREATE TABLE research_receipts (
 id uuid PRIMARY KEY,league_id text NOT NULL REFERENCES leagues(id),agent_id text NOT NULL REFERENCES runtime_agents(id),job_id uuid NOT NULL REFERENCES runtime_jobs(id),
 tool text NOT NULL,url text,source_id text,status text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz
);
CREATE INDEX research_receipts_job ON research_receipts(job_id,created_at);
CREATE INDEX research_receipts_agent ON research_receipts(agent_id,created_at);
