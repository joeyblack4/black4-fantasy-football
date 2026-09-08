CREATE TABLE leagues (
  id text PRIMARY KEY,
  name text NOT NULL,
  rules jsonb NOT NULL,
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup','drafting','active')),
  constitution_version text,
  constitution_receipt text,
  constitution_rules_hash text,
  constitution_ratified_at timestamptz,
  current_week integer NOT NULL DEFAULT 1 CHECK (current_week BETWEEN 1 AND 18),
  next_pick integer NOT NULL DEFAULT 0 CHECK (next_pick >= 0),
  pick_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE league_teams (
  league_id text NOT NULL REFERENCES leagues(id),
  id text NOT NULL,
  name text NOT NULL,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human','ai')),
  draft_position integer NOT NULL CHECK (draft_position BETWEEN 0 AND 11),
  waiver_priority integer NOT NULL,
  faab integer NOT NULL CHECK (faab >= 0),
  PRIMARY KEY (league_id,id),
  UNIQUE (league_id,owner_id),
  UNIQUE (league_id,draft_position)
);
CREATE TABLE league_players (
  league_id text NOT NULL REFERENCES leagues(id),
  id text NOT NULL,
  name text NOT NULL,
  positions text[] NOT NULL,
  PRIMARY KEY (league_id,id)
);
CREATE TABLE league_player_games (
  league_id text NOT NULL,
  player_id text NOT NULL,
  week integer NOT NULL CHECK (week BETWEEN 1 AND 18),
  kickoff_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','postponed','cancelled','final','bye')),
  PRIMARY KEY (league_id,player_id,week),
  FOREIGN KEY (league_id,player_id) REFERENCES league_players(league_id,id)
);
CREATE TABLE league_rosters (
  league_id text NOT NULL,
  player_id text NOT NULL,
  team_id text NOT NULL,
  PRIMARY KEY (league_id,player_id),
  FOREIGN KEY (league_id,player_id) REFERENCES league_players(league_id,id),
  FOREIGN KEY (league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE league_draft_picks (
  league_id text NOT NULL REFERENCES leagues(id),
  pick_index integer NOT NULL,
  team_id text NOT NULL,
  player_id text NOT NULL,
  automatic boolean NOT NULL,
  picked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (league_id,pick_index),
  UNIQUE (league_id,player_id),
  FOREIGN KEY (league_id,team_id) REFERENCES league_teams(league_id,id),
  FOREIGN KEY (league_id,player_id) REFERENCES league_players(league_id,id)
);
CREATE TABLE league_draft_queues (
  league_id text NOT NULL,
  team_id text NOT NULL,
  player_ids text[] NOT NULL,
  PRIMARY KEY (league_id,team_id),
  FOREIGN KEY (league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE league_lineups (
  league_id text NOT NULL,
  team_id text NOT NULL,
  week integer NOT NULL CHECK (week BETWEEN 1 AND 18),
  slot_id text NOT NULL,
  player_id text NOT NULL,
  PRIMARY KEY (league_id,team_id,week,slot_id),
  UNIQUE (league_id,team_id,week,player_id),
  FOREIGN KEY (league_id,team_id) REFERENCES league_teams(league_id,id),
  FOREIGN KEY (league_id,player_id) REFERENCES league_players(league_id,id)
);
CREATE TABLE league_trades (
  league_id text NOT NULL REFERENCES leagues(id),
  id text NOT NULL,
  from_team text NOT NULL,
  to_team text NOT NULL,
  give_players text[] NOT NULL,
  receive_players text[] NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','cancelled','rejected')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (league_id,id),
  CHECK (from_team <> to_team),
  FOREIGN KEY (league_id,from_team) REFERENCES league_teams(league_id,id),
  FOREIGN KEY (league_id,to_team) REFERENCES league_teams(league_id,id)
);
CREATE TABLE league_waiver_periods (
  league_id text NOT NULL REFERENCES leagues(id),
  id text NOT NULL,
  closes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  PRIMARY KEY (league_id,id)
);
CREATE TABLE league_waiver_claims (
  league_id text NOT NULL,
  id text NOT NULL,
  period_id text NOT NULL,
  team_id text NOT NULL,
  add_player text NOT NULL,
  drop_player text,
  bid integer NOT NULL CHECK (bid >= 0),
  priority integer NOT NULL CHECK (priority >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','cancelled')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (league_id,id),
  FOREIGN KEY (league_id,period_id) REFERENCES league_waiver_periods(league_id,id),
  FOREIGN KEY (league_id,team_id) REFERENCES league_teams(league_id,id),
  FOREIGN KEY (league_id,add_player) REFERENCES league_players(league_id,id),
  FOREIGN KEY (league_id,drop_player) REFERENCES league_players(league_id,id)
);
CREATE TABLE league_command_receipts (
  league_id text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  id text NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (league_id,actor_id,idempotency_key)
);
CREATE TABLE league_events (
  id bigserial PRIMARY KEY,
  league_id text NOT NULL REFERENCES leagues(id),
  receipt_id text NOT NULL UNIQUE REFERENCES league_command_receipts(id),
  actor_id text NOT NULL,
  type text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public','private')),
  participant_team_ids text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz
);
CREATE INDEX league_events_pending ON league_events(id) WHERE delivered_at IS NULL;
CREATE INDEX league_rosters_team ON league_rosters(league_id,team_id);

CREATE TABLE league_free_agent_windows (
  league_id text NOT NULL REFERENCES leagues(id),
  id text NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  PRIMARY KEY (league_id,id),
  CHECK (closes_at > opens_at)
);
