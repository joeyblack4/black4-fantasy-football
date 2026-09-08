CREATE TABLE buzz_league_bindings (
 league_id text PRIMARY KEY REFERENCES leagues(id), community_url text NOT NULL UNIQUE,
 mode text NOT NULL CHECK(mode IN ('mock','real')), binding_receipt_id text NOT NULL,
 archive_consent_receipt_id text NOT NULL, configuration_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE buzz_participants (
 league_id text NOT NULL REFERENCES buzz_league_bindings(league_id), pubkey text NOT NULL,
 owner_id text NOT NULL, team_id text NOT NULL, agent_id text,
 kind text NOT NULL CHECK(kind IN ('human','agent')), owner_pubkey text,
 PRIMARY KEY(league_id,pubkey), UNIQUE(league_id,team_id), UNIQUE(agent_id)
);
CREATE TABLE buzz_conversations (
 league_id text NOT NULL REFERENCES buzz_league_bindings(league_id), channel_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('dm','private-channel')), member_pubkeys jsonb NOT NULL,
 discovery_receipt_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,channel_id)
);
CREATE TABLE buzz_archive_events (
 sequence bigserial PRIMARY KEY, league_id text NOT NULL, channel_id uuid NOT NULL,
 event_id text NOT NULL, author_pubkey text NOT NULL, kind integer NOT NULL,
 content text NOT NULL, tags jsonb NOT NULL, source_created_at bigint NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), payload_hash text NOT NULL,
 target_event_id text, relation_status text NOT NULL CHECK(relation_status IN ('none','pending','valid','invalid')),
 mode text NOT NULL CHECK(mode IN ('mock','real')), provenance text NOT NULL,
 FOREIGN KEY(league_id,channel_id) REFERENCES buzz_conversations(league_id,channel_id),
 UNIQUE(league_id,event_id)
);
CREATE INDEX buzz_archive_channel_sequence ON buzz_archive_events(league_id,channel_id,sequence);
CREATE TABLE buzz_inbound_cursors (
 league_id text NOT NULL, listener_pubkey text NOT NULL, channel_id uuid NOT NULL,
 since_seconds bigint NOT NULL DEFAULT 0, last_poll_at timestamptz, last_complete_at timestamptz,
 state text NOT NULL DEFAULT 'new' CHECK(state IN ('new','healthy','gap','error')),
 PRIMARY KEY(league_id,listener_pubkey,channel_id),
 FOREIGN KEY(league_id,channel_id) REFERENCES buzz_conversations(league_id,channel_id)
);
CREATE TABLE buzz_inbound_deliveries (
 league_id text NOT NULL, event_id text NOT NULL, agent_id text NOT NULL,
 inbox_id uuid NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,event_id,agent_id),
 FOREIGN KEY(league_id,event_id) REFERENCES buzz_archive_events(league_id,event_id)
);
ALTER TABLE buzz_action_receipts ADD COLUMN expected_content_hash text;
ALTER TABLE buzz_action_receipts ADD COLUMN expected_reply_to text;
ALTER TABLE buzz_action_receipts ADD COLUMN reconciliation jsonb;
