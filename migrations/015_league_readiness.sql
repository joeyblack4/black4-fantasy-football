ALTER TABLE leagues ADD COLUMN draft_paused_at timestamptz;
ALTER TABLE leagues ADD COLUMN draft_pause_reason text;
ALTER TABLE leagues ADD COLUMN draft_pause_remaining_ms integer CHECK(draft_pause_remaining_ms>=0);
ALTER TABLE leagues ADD COLUMN draft_epoch integer NOT NULL DEFAULT 0 CHECK(draft_epoch>=0);
ALTER TABLE leagues ADD COLUMN ratified_capability_version text;
ALTER TABLE governance_proposals ADD COLUMN capability_version text;
CREATE TABLE league_player_holds (
 league_id text NOT NULL,player_id text NOT NULL,dropping_team_id text NOT NULL,
 expires_at timestamptz NOT NULL,reason text NOT NULL CHECK(reason IN ('waiver_drop','free_agent_drop')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,player_id),
 FOREIGN KEY(league_id,player_id) REFERENCES league_players(league_id,id),
 FOREIGN KEY(league_id,dropping_team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE league_event_deliveries (
 event_id bigint NOT NULL REFERENCES league_events(id),agent_id text NOT NULL REFERENCES runtime_agents(id),
 runtime_job_id uuid NOT NULL REFERENCES runtime_jobs(id),delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(event_id,agent_id)
);
