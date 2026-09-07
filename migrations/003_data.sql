CREATE TABLE data_stat_snapshots (
 id uuid PRIMARY KEY, feed_id text NOT NULL, game_id text NOT NULL, player_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision>=0), source_at timestamptz,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 game_status text NOT NULL CHECK(game_status IN ('scheduled','live','final','postponed','cancelled')),
 synthetic boolean NOT NULL, stats jsonb NOT NULL, payload_hash text NOT NULL,
 UNIQUE(feed_id,game_id,player_id,revision)
);
CREATE TABLE data_latest_stats (
 feed_id text NOT NULL, game_id text NOT NULL, player_id text NOT NULL,
 snapshot_id uuid NOT NULL REFERENCES data_stat_snapshots(id), PRIMARY KEY(feed_id,game_id,player_id)
);
CREATE TABLE data_events (
 id uuid PRIMARY KEY, snapshot_id uuid NOT NULL UNIQUE REFERENCES data_stat_snapshots(id), kind text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE buzz_action_receipts (
 id uuid PRIMARY KEY, operation_key text NOT NULL UNIQUE, plan_hash text NOT NULL,
 actor_pubkey text NOT NULL, community_url text NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','accepted','rejected','unknown')),
 event_id text, channel_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
