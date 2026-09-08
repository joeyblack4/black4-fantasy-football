-- A token is never persisted here. One trusted process configuration binds it to one league.
CREATE TABLE x_publication_accounts (
 league_id text PRIMARY KEY REFERENCES leagues(id),
 user_id text NOT NULL,
 username text NOT NULL CHECK (lower(username)='black4fantasy'),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE x_publication_schedules (
 id uuid PRIMARY KEY,
 league_id text NOT NULL REFERENCES leagues(id),
 batch_id uuid NOT NULL UNIQUE REFERENCES franchise_publication_batches(id),
 approval_id uuid NOT NULL REFERENCES franchise_publication_approvals(id),
 content_hash text NOT NULL,
 due_at timestamptz NOT NULL,
 scheduled_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,league_id)
);
CREATE TABLE x_publication_items (
 id uuid PRIMARY KEY,
 schedule_id uuid NOT NULL,
 league_id text NOT NULL,
 item_index integer NOT NULL CHECK(item_index>=0),
 team_id text NOT NULL,
 draft_id text NOT NULL,
 draft_version integer NOT NULL,
 content_hash text NOT NULL,
 text_body text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','checking','sending','published','rejected','cancelled','uncertain')),
 attempt_id uuid,
 claimed_at timestamptz,
 send_started_at timestamptz,
 finished_at timestamptz,
 user_id text,
 tweet_id text,
 error_code text,
 response_status integer,
 billing_status text NOT NULL DEFAULT 'unknown' CHECK(billing_status='unknown'),
 cost_micros bigint CHECK(cost_micros IS NULL),
 receipt jsonb,
 wake_delivered_at timestamptz,
 UNIQUE(schedule_id,item_index),
 FOREIGN KEY(schedule_id,league_id) REFERENCES x_publication_schedules(id,league_id),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE INDEX x_publication_due ON x_publication_schedules(league_id,due_at);
CREATE INDEX x_publication_pending ON x_publication_items(league_id,status);
