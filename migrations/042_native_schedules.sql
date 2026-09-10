-- Owner-created appointments are independent of native model process lifetimes.
CREATE TABLE runtime_native_schedules (
 id text PRIMARY KEY,
 league_id text NOT NULL REFERENCES leagues(id),
 team_id text NOT NULL,
 label text NOT NULL,
 prompt text NOT NULL,
 timing jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','completed')),
 next_due_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE INDEX runtime_native_schedules_due ON runtime_native_schedules(league_id,next_due_at) WHERE status='active';
CREATE TABLE runtime_native_schedule_commands (
 league_id text NOT NULL,
 team_id text NOT NULL,
 idempotency_key text NOT NULL,
 payload_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,team_id,idempotency_key)
);
CREATE TABLE runtime_native_schedule_occurrences (
 id text PRIMARY KEY,
 schedule_id text NOT NULL REFERENCES runtime_native_schedules(id),
 league_id text NOT NULL,
 team_id text NOT NULL,
 schedule_version integer NOT NULL,
 prompt text NOT NULL,
 scheduled_for timestamptz NOT NULL,
 missed_through timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','blocked','sending','delivered','started','completed','failed','uncertain','cancelled')),
 event_id text,
 attempt_at timestamptz,
 delivered_at timestamptz,
 started_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason text,
 execution_evidence jsonb
);
CREATE INDEX runtime_native_schedule_dispatch ON runtime_native_schedule_occurrences(league_id,status,scheduled_for);
CREATE TABLE runtime_native_schedule_events (
 league_id text NOT NULL REFERENCES leagues(id),
 id text NOT NULL,
 kind text NOT NULL,
 audience_team_id text,
 occurs_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(league_id,id)
);
