CREATE TABLE public_league_releases (
 league_id text PRIMARY KEY REFERENCES leagues(id), mode text NOT NULL CHECK(mode IN ('live','rehearsal')),
 approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 scope_hash text NOT NULL, enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE public_league_snapshots (
 league_id text PRIMARY KEY REFERENCES leagues(id), document jsonb NOT NULL,
 generated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
