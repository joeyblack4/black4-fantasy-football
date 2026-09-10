ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_execution_mode_check;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_execution_mode_check CHECK(execution_mode IN('owner','provider_canary','conversation'));
CREATE TABLE runtime_conversation_sessions (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id), epoch text NOT NULL,
 host_snapshot jsonb NOT NULL, status text NOT NULL CHECK(status IN('active','closed')),
 configuration jsonb NOT NULL, request_hash text NOT NULL, idempotency_key text NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 closed_at timestamptz, actor_id text NOT NULL, receipt_id uuid NOT NULL,
 UNIQUE(league_id,idempotency_key), FOREIGN KEY(league_id,epoch) REFERENCES runtime_rehearsals(league_id,epoch)
);
CREATE UNIQUE INDEX runtime_conversation_one_active ON runtime_conversation_sessions(league_id) WHERE status='active';
CREATE TABLE runtime_conversation_owners (
 session_id uuid NOT NULL REFERENCES runtime_conversation_sessions(id), agent_id text NOT NULL REFERENCES runtime_agents(id),
 binding_hash text NOT NULL, PRIMARY KEY(session_id,agent_id)
);
CREATE TABLE runtime_conversation_jobs (
 job_id uuid PRIMARY KEY REFERENCES runtime_jobs(id), session_id uuid NOT NULL, agent_id text NOT NULL,
 event_id text NOT NULL, event_hash text NOT NULL, channel_id uuid NOT NULL,
 FOREIGN KEY(session_id,agent_id) REFERENCES runtime_conversation_owners(session_id,agent_id)
);
