CREATE TABLE runtime_convention_pauses (
 id uuid PRIMARY KEY, league_id text NOT NULL, meeting_id text NOT NULL,
 host_version integer NOT NULL, paused_at timestamptz NOT NULL,
 resumed_at timestamptz, duration_ms bigint,
 status text NOT NULL CHECK(status IN ('paused','resumed')),
 before_snapshot jsonb NOT NULL, after_snapshot jsonb,
 frozen_content_hash text NOT NULL, paused_by text NOT NULL, resumed_by text,
 reason text NOT NULL, resume_reason text,
 FOREIGN KEY(league_id,meeting_id) REFERENCES runtime_conventions(league_id,meeting_id),
 CHECK((status='paused' AND resumed_at IS NULL AND duration_ms IS NULL) OR (status='resumed' AND resumed_at>=paused_at AND duration_ms>=0))
);
CREATE UNIQUE INDEX runtime_one_convention_pause ON runtime_convention_pauses(league_id) WHERE status='paused';
CREATE TABLE runtime_convention_control_receipts (
 league_id text NOT NULL, actor_id text NOT NULL, idempotency_key text NOT NULL,
 request_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,actor_id,idempotency_key)
);
