CREATE TABLE runtime_football_outbox (
 id uuid PRIMARY KEY, agent_id text NOT NULL REFERENCES runtime_agents(id), job_id uuid NOT NULL REFERENCES runtime_jobs(id),
 causal_id text NOT NULL, fingerprint text NOT NULL, origin_fence integer NOT NULL,
 league_id text NOT NULL, team_id text NOT NULL, owner_id text NOT NULL, command jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','delivered','dead')),
 attempts integer NOT NULL DEFAULT 0, fence integer NOT NULL DEFAULT 0, worker_id text, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz,
 engine_receipt jsonb, error text, UNIQUE(agent_id,causal_id),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE INDEX runtime_football_outbox_due ON runtime_football_outbox(next_attempt_at) WHERE status IN ('pending','running');
