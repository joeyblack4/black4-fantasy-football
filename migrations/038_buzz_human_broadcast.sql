-- Explicit private-channel opt-in. No existing channel or historical event is enabled.
CREATE TABLE buzz_human_broadcast_policies (
 league_id text NOT NULL, channel_id uuid NOT NULL,
 enabled boolean NOT NULL, version integer NOT NULL CHECK(version>0),
 effective_after_seconds bigint NOT NULL CHECK(effective_after_seconds>=0),
 changed_by text NOT NULL, changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,channel_id),
 FOREIGN KEY(league_id,channel_id) REFERENCES buzz_conversations(league_id,channel_id)
);
CREATE TABLE buzz_human_broadcast_receipts (
 id uuid PRIMARY KEY, league_id text NOT NULL, channel_id uuid NOT NULL,
 actor_id text NOT NULL, idempotency_key text NOT NULL, payload_hash text NOT NULL,
 before_policy jsonb, after_policy jsonb NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,actor_id,idempotency_key),
 FOREIGN KEY(league_id,channel_id) REFERENCES buzz_conversations(league_id,channel_id)
);
