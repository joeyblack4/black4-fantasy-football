CREATE TABLE runtime_rehearsals (
 league_id text NOT NULL REFERENCES leagues(id), epoch text NOT NULL,
 status text NOT NULL CHECK(status IN ('arming','armed','stopped','restoring','restored')),
 request_hash text NOT NULL, original_host jsonb NOT NULL, trial_host jsonb,
 cap_micros bigint NOT NULL CHECK(cap_micros>0 AND cap_micros<=20000000),
 synthetic boolean NOT NULL, operator_evidence_ref text NOT NULL, reason text NOT NULL,
 configured_by text NOT NULL, configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 start_receipt_seq bigint NOT NULL, PRIMARY KEY(league_id,epoch)
);
CREATE UNIQUE INDEX runtime_one_open_rehearsal ON runtime_rehearsals(league_id) WHERE status<>'restored';
CREATE TABLE runtime_rehearsal_owners (
 league_id text NOT NULL, epoch text NOT NULL, agent_id text NOT NULL REFERENCES runtime_agents(id),
 team_id text NOT NULL, owner_id text NOT NULL, model text NOT NULL, manifest_id uuid REFERENCES provider_manifests(id),
 binding_hash text NOT NULL, PRIMARY KEY(league_id,epoch,agent_id),
 FOREIGN KEY(league_id,epoch) REFERENCES runtime_rehearsals(league_id,epoch),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE runtime_rehearsal_jobs (
 job_id uuid PRIMARY KEY REFERENCES runtime_jobs(id), league_id text NOT NULL, epoch text NOT NULL,
 agent_id text NOT NULL, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(league_id,epoch,agent_id) REFERENCES runtime_rehearsal_owners(league_id,epoch,agent_id)
);
