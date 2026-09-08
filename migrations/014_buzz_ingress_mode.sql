CREATE TABLE buzz_ingress_modes (
 league_id text NOT NULL REFERENCES leagues(id), agent_id text NOT NULL REFERENCES runtime_agents(id),
 mode text NOT NULL CHECK(mode IN ('poll','managed_acp')),
 selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,agent_id)
);
