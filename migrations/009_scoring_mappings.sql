ALTER TABLE scoring_player_games ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE TABLE scoring_mapping_events (
 id uuid PRIMARY KEY, league_id text NOT NULL, week integer NOT NULL, player_id text NOT NULL,
 actor_id text NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL,
 previous_game_id text, game_id text NOT NULL, version integer NOT NULL CHECK(version>0), reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,actor_id,idempotency_key),
 FOREIGN KEY(league_id,week) REFERENCES scoring_configs(league_id,week),
 FOREIGN KEY(league_id,player_id) REFERENCES league_players(league_id,id)
);
