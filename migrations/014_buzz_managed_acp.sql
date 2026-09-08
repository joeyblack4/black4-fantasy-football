CREATE TABLE buzz_managed_identities (
 league_id text NOT NULL REFERENCES leagues(id), agent_id text NOT NULL REFERENCES runtime_agents(id),
 team_id text NOT NULL, owner_id text NOT NULL, pubkey text NOT NULL, community_url text NOT NULL,
 credential_path text NOT NULL, credential_fingerprint text NOT NULL,
 owner_pubkey_hint text, provenance text NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,agent_id), UNIQUE(league_id,pubkey),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE buzz_acp_deliveries (
 id uuid PRIMARY KEY, league_id text NOT NULL, agent_id text NOT NULL,
 session_id text NOT NULL, prompt_hash text NOT NULL, prompt jsonb NOT NULL,
 inbox_id uuid NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 provenance text NOT NULL, synthetic boolean NOT NULL,
 UNIQUE(league_id,agent_id,prompt_hash),
 FOREIGN KEY(league_id,agent_id) REFERENCES buzz_managed_identities(league_id,agent_id)
);
