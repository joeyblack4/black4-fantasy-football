CREATE TABLE runtime_conventions (
 league_id text NOT NULL REFERENCES leagues(id), meeting_id text NOT NULL,
 host_version integer NOT NULL, host_kind text NOT NULL CHECK(host_kind IN ('custom','mfl')),
 proposal_deadline timestamptz NOT NULL, vote_deadline timestamptz NOT NULL,
 limits jsonb NOT NULL, synthetic boolean NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','stopped')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,meeting_id), CHECK(vote_deadline>proposal_deadline)
);
CREATE UNIQUE INDEX runtime_convention_active ON runtime_conventions(league_id) WHERE status='active';
CREATE TABLE runtime_convention_waves (
 league_id text NOT NULL, meeting_id text NOT NULL, wave text NOT NULL,
 phase text NOT NULL CHECK(phase IN ('proposals','voting','closed')),
 due_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','skipped')),
 completed_at timestamptz,
 PRIMARY KEY(league_id,meeting_id,wave),
 FOREIGN KEY(league_id,meeting_id) REFERENCES runtime_conventions(league_id,meeting_id)
);
CREATE TABLE runtime_convention_turns (
 league_id text NOT NULL, meeting_id text NOT NULL, agent_id text NOT NULL REFERENCES runtime_agents(id),
 job_id uuid NOT NULL REFERENCES runtime_jobs(id), fence integer NOT NULL,
 phase text NOT NULL CHECK(phase IN ('proposals','voting','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,fence),
 FOREIGN KEY(league_id,meeting_id) REFERENCES runtime_conventions(league_id,meeting_id)
);
CREATE INDEX runtime_convention_turn_scope ON runtime_convention_turns(league_id,meeting_id,agent_id,phase);
ALTER TABLE runtime_franchise_outbox DROP CONSTRAINT runtime_franchise_outbox_status_check;
ALTER TABLE runtime_franchise_outbox ADD CONSTRAINT runtime_franchise_outbox_status_check CHECK(status IN ('pending','running','delivered','dead','held'));
