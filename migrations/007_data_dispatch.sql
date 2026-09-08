-- Forward repair for the local early-build database initialized before the scoring ratification link.
ALTER TABLE scoring_configs ADD COLUMN IF NOT EXISTS constitution_version text;
UPDATE scoring_configs c SET constitution_version=l.constitution_version FROM leagues l WHERE l.id=c.league_id AND c.constitution_version IS NULL;
-- Existing unratified rows, if any, remain visibly unresolved; new service writes require ratification.
ALTER TABLE data_stat_snapshots ALTER COLUMN source_at DROP NOT NULL;
CREATE TABLE data_subscriptions (
 agent_id text NOT NULL REFERENCES runtime_agents(id), league_id text NOT NULL REFERENCES leagues(id),
 feed_id text NOT NULL, player_id text NOT NULL, subscribed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(agent_id,feed_id,player_id),
 FOREIGN KEY(league_id,player_id) REFERENCES league_players(league_id,id)
);
CREATE TABLE data_deliveries (
 event_id uuid NOT NULL REFERENCES data_events(id), agent_id text NOT NULL REFERENCES runtime_agents(id),
 runtime_job_id uuid NOT NULL REFERENCES runtime_jobs(id), delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(event_id,agent_id)
);
