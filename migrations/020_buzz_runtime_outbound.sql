CREATE TABLE buzz_runtime_outbound (
 runtime_message_id uuid PRIMARY KEY REFERENCES runtime_messages(id), league_id text NOT NULL REFERENCES leagues(id),
 sender_agent_id text NOT NULL REFERENCES runtime_agents(id), recipient_agent_id text NOT NULL REFERENCES runtime_agents(id),
 channel_id uuid, sender_pubkey text, recipient_pubkey text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked','prepared','accepted','unknown','rejected')),
 open_receipt_id uuid REFERENCES buzz_action_receipts(id), send_receipt_id uuid REFERENCES buzz_action_receipts(id),
 event_id text, content_hash text NOT NULL, last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,event_id)
);
CREATE INDEX buzz_runtime_pending ON buzz_runtime_outbound(league_id,created_at) WHERE status IN ('pending','blocked','prepared','unknown');
CREATE TABLE buzz_archive_held_events (
 league_id text NOT NULL, event_id text NOT NULL, reason text NOT NULL,
 held_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(league_id,event_id),
 FOREIGN KEY(league_id,event_id) REFERENCES buzz_archive_events(league_id,event_id)
);
CREATE TABLE buzz_ingress_cutovers (
 id uuid PRIMARY KEY, league_id text NOT NULL, agent_id text NOT NULL, actor_id text NOT NULL,
 receipt_id text NOT NULL, previous_mode text, selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(league_id,agent_id) REFERENCES buzz_ingress_modes(league_id,agent_id)
);
