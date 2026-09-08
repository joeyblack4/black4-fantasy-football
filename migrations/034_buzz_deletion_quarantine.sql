CREATE TABLE buzz_deletion_quarantine (
 sequence bigserial PRIMARY KEY,
 league_id text NOT NULL,
 observed_channel_id uuid NOT NULL,
 event_id text NOT NULL,
 listener_pubkey text NOT NULL,
 raw_event jsonb NOT NULL,
 payload_hash text NOT NULL,
 reason text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('mock','real')),
 provenance text NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(league_id,observed_channel_id) REFERENCES buzz_conversations(league_id,channel_id),
 UNIQUE(league_id,observed_channel_id,event_id)
);
