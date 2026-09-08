-- Local owner-authored preferences, not native MFL WorkList/MyDraftList uploads.
CREATE TABLE mfl_draft_queue_revisions (
 league_id text NOT NULL REFERENCES leagues(id),team_id text NOT NULL,host_version integer NOT NULL CHECK(host_version>0),
 version integer NOT NULL CHECK(version>0),player_ids text[] NOT NULL CHECK(cardinality(player_ids)<=200),
 owner_id text NOT NULL,receipt_id uuid NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,team_id,host_version,version),FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE mfl_draft_queue_receipts (
 id uuid PRIMARY KEY,league_id text NOT NULL REFERENCES leagues(id),team_id text NOT NULL,owner_id text NOT NULL,
 host_version integer NOT NULL CHECK(host_version>0),idempotency_key text NOT NULL,payload_hash text NOT NULL,response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(league_id,owner_id,idempotency_key),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
ALTER TABLE mfl_draft_queue_revisions ADD CONSTRAINT mfl_draft_queue_receipt_fk FOREIGN KEY(receipt_id) REFERENCES mfl_draft_queue_receipts(id);
