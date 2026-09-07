CREATE TABLE api_credentials (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  actor_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','commissioner','system')),
  league_id text NOT NULL,
  team_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (role <> 'owner' OR team_id IS NOT NULL)
);
CREATE TABLE runtime_bindings (
  agent_id text PRIMARY KEY REFERENCES runtime_agents(id),
  league_id text NOT NULL,
  team_id text NOT NULL,
  UNIQUE(league_id,team_id),
  FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
