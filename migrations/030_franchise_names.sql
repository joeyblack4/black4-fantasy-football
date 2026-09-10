CREATE TABLE franchise_name_receipts (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id), team_id text NOT NULL,
 agent_id text NOT NULL REFERENCES runtime_agents(id), brand_receipt_id uuid NOT NULL REFERENCES franchise_receipts(id),
 brand_version integer NOT NULL, manifest_id uuid NOT NULL REFERENCES provider_manifests(id), manifest_version integer NOT NULL,
 pubkey text NOT NULL, channel_id uuid NOT NULL, desired_name text NOT NULL CHECK(length(desired_name) BETWEEN 1 AND 200),
 previous_local_name text NOT NULL, actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,team_id,brand_receipt_id,manifest_id),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE franchise_name_observations (
 id uuid PRIMARY KEY, name_receipt_id uuid NOT NULL REFERENCES franchise_name_receipts(id),
 actor_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('operator-handoff','operator-attested-buzz-readback')),
 evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
