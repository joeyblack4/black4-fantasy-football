ALTER TABLE runtime_mfl_draft_observers ADD COLUMN delivery_mode text NOT NULL DEFAULT 'runtime' CHECK(delivery_mode IN ('runtime','native-buzz'));
ALTER TABLE runtime_mfl_draft_observers ADD COLUMN rehearsal boolean NOT NULL DEFAULT false;
CREATE TABLE runtime_native_draft_notifications (
 id text PRIMARY KEY,
 league_id text NOT NULL REFERENCES leagues(id),
 epoch text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('on-clock','pick-confirmed')),
 payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','uncertain','superseded')),
 event_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempted_at timestamptz,
 delivered_at timestamptz,
 error text
);
CREATE INDEX runtime_native_draft_notifications_pending ON runtime_native_draft_notifications(league_id,created_at) WHERE status='pending';
