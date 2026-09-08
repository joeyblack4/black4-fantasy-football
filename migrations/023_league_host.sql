CREATE TABLE league_host_bindings (
 league_id text PRIMARY KEY REFERENCES leagues(id),
 host text NOT NULL CHECK(host IN ('custom','mfl')),
 version integer NOT NULL CHECK(version>0),
 config jsonb NOT NULL,
 changed_by text NOT NULL,
 reason text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(config)='object'),
 CHECK((host='custom' AND config='{}'::jsonb) OR
  (host='mfl' AND config ?& ARRAY['season','leagueId','configRef'] AND
   config-ARRAY['season','leagueId','configRef']='{}'::jsonb AND
   jsonb_typeof(config->'season')='number' AND (config->>'season')~'^[0-9]{4}$' AND
   jsonb_typeof(config->'leagueId')='string' AND (config->>'leagueId')~'^[0-9]{1,8}$' AND
   jsonb_typeof(config->'configRef')='string' AND (config->>'configRef')~'^[A-Za-z0-9_.:-]{1,160}$'))
);
CREATE TABLE league_host_receipts (
 id uuid PRIMARY KEY,
 league_id text NOT NULL REFERENCES leagues(id),
 actor_id text NOT NULL,
 idempotency_key text NOT NULL,
 payload_hash text NOT NULL,
 previous_binding jsonb NOT NULL,
 binding jsonb NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,actor_id,idempotency_key)
);
CREATE UNIQUE INDEX league_host_revision_once ON league_host_receipts(league_id,(binding->>'version'));
ALTER TABLE runtime_football_outbox ADD COLUMN host_kind text NOT NULL DEFAULT 'custom' CHECK(host_kind IN ('custom','mfl'));
ALTER TABLE runtime_football_outbox ADD COLUMN host_version integer NOT NULL DEFAULT 0 CHECK(host_version>=0);
ALTER TABLE runtime_football_outbox ADD COLUMN host_identity jsonb;
ALTER TABLE runtime_football_outbox DROP CONSTRAINT runtime_football_outbox_status_check;
ALTER TABLE runtime_football_outbox ADD CONSTRAINT runtime_football_outbox_status_check CHECK(status IN ('pending','running','delivered','dead','held'));
