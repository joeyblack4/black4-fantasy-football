CREATE TABLE runtime_owner_stages (
 league_id text NOT NULL REFERENCES leagues(id), id text NOT NULL, stage text NOT NULL CHECK(stage='onboarding'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','reviewed')),
 configuration jsonb NOT NULL, charter text NOT NULL, assignment text NOT NULL, content_hash text NOT NULL,
 configured_by text NOT NULL, receipt_id uuid NOT NULL UNIQUE,
 configured_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(league_id,id)
);
CREATE UNIQUE INDEX runtime_owner_stage_active ON runtime_owner_stages(league_id) WHERE status='active';
CREATE TABLE runtime_owner_stage_turns (
 league_id text NOT NULL, stage_id text NOT NULL, agent_id text NOT NULL REFERENCES runtime_agents(id),
 job_id uuid NOT NULL REFERENCES runtime_jobs(id), fence integer NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,fence), FOREIGN KEY(league_id,stage_id) REFERENCES runtime_owner_stages(league_id,id)
);
CREATE INDEX runtime_owner_stage_agent ON runtime_owner_stage_turns(league_id,stage_id,agent_id);
CREATE TABLE runtime_owner_stage_reviews (
 league_id text NOT NULL, stage_id text NOT NULL, agent_id text NOT NULL REFERENCES runtime_agents(id),
 evidence_hash text NOT NULL, evidence jsonb NOT NULL, note text NOT NULL, reviewed_by text NOT NULL,
 receipt_id uuid NOT NULL UNIQUE, reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,stage_id,agent_id), FOREIGN KEY(league_id,stage_id) REFERENCES runtime_owner_stages(league_id,id)
);
