CREATE TABLE runtime_native_schedule_feeds (
 league_id text NOT NULL REFERENCES leagues(id),
 source text NOT NULL,
 status text NOT NULL CHECK(status IN ('healthy','failed','unknown')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_success_at timestamptz,
 error_code text,
 cursor jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(league_id,source)
);
