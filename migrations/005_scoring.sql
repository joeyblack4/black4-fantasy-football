CREATE TABLE scoring_configs (
 league_id text NOT NULL REFERENCES leagues(id), week integer NOT NULL CHECK(week BETWEEN 1 AND 18),
 feed_id text NOT NULL, rules jsonb NOT NULL, config_hash text NOT NULL, rules_hash text NOT NULL,
 constitution_version text NOT NULL, configured_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,week)
);
CREATE TABLE scoring_matchups (
 league_id text NOT NULL, week integer NOT NULL, home_team_id text NOT NULL, away_team_id text NOT NULL,
 PRIMARY KEY(league_id,week,home_team_id), UNIQUE(league_id,week,away_team_id), CHECK(home_team_id<>away_team_id),
 FOREIGN KEY(league_id,week) REFERENCES scoring_configs(league_id,week),
 FOREIGN KEY(league_id,home_team_id) REFERENCES league_teams(league_id,id),
 FOREIGN KEY(league_id,away_team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE scoring_player_games (
 league_id text NOT NULL, week integer NOT NULL, player_id text NOT NULL, game_id text NOT NULL,
 PRIMARY KEY(league_id,week,player_id),
 FOREIGN KEY(league_id,week) REFERENCES scoring_configs(league_id,week),
 FOREIGN KEY(league_id,player_id) REFERENCES league_players(league_id,id)
);
