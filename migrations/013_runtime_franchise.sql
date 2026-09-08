ALTER TABLE runtime_jobs ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('urgent','normal','background'));
ALTER TABLE runtime_jobs ADD COLUMN priority_rank integer GENERATED ALWAYS AS (CASE priority WHEN 'urgent' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END) STORED;
ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_kind_check;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_kind_check CHECK(kind IN ('appointment','event','message','staff'));
ALTER TABLE runtime_jobs ADD COLUMN parent_job_id uuid REFERENCES runtime_jobs(id);
ALTER TABLE runtime_jobs ADD COLUMN staff_role text;
ALTER TABLE runtime_jobs ADD COLUMN staff_task text;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_staff_shape CHECK((kind='staff')=(parent_job_id IS NOT NULL AND staff_role IS NOT NULL AND staff_task IS NOT NULL));
CREATE INDEX runtime_jobs_priority_due ON runtime_jobs(priority_rank DESC,due_at) WHERE status IN ('pending','running');
CREATE TABLE franchise_receipts (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id), agent_id text NOT NULL REFERENCES runtime_agents(id), actor_id text NOT NULL,
 idempotency_key text NOT NULL, fingerprint text NOT NULL, type text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(league_id,actor_id,idempotency_key)
);
CREATE TABLE franchise_brand_versions (
 league_id text NOT NULL, team_id text NOT NULL, version integer NOT NULL CHECK(version>0), payload jsonb NOT NULL, content_hash text NOT NULL,
 receipt_id uuid NOT NULL REFERENCES franchise_receipts(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,team_id,version), FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE franchise_service_requests (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id), team_id text NOT NULL, agent_id text NOT NULL REFERENCES runtime_agents(id),
 service text NOT NULL, purpose text NOT NULL, max_cost_micros bigint NOT NULL CHECK(max_cost_micros>=0),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','rejected')),
 review_note text, reviewed_by text, reviewed_at timestamptz, receipt_id uuid NOT NULL REFERENCES franchise_receipts(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE franchise_draft_versions (
 league_id text NOT NULL, team_id text NOT NULL, draft_id text NOT NULL, version integer NOT NULL CHECK(version>0),
 title text NOT NULL, body text NOT NULL, channel text NOT NULL CHECK(channel IN ('x','website','newsletter')), content_hash text NOT NULL,
 receipt_id uuid NOT NULL REFERENCES franchise_receipts(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,team_id,draft_id,version), FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE franchise_publication_batches (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id), content_hash text NOT NULL, items jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','approved','revoked')), created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,content_hash)
);
CREATE TABLE franchise_publication_approvals (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL UNIQUE REFERENCES franchise_publication_batches(id), content_hash text NOT NULL,
 approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE franchise_operator_receipts (
 id uuid PRIMARY KEY, league_id text NOT NULL REFERENCES leagues(id), actor_id text NOT NULL, type text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE runtime_franchise_outbox (
 id uuid PRIMARY KEY, agent_id text NOT NULL REFERENCES runtime_agents(id), job_id uuid NOT NULL REFERENCES runtime_jobs(id),
 causal_id text NOT NULL, fingerprint text NOT NULL, origin_fence integer NOT NULL, league_id text NOT NULL, team_id text NOT NULL, owner_id text NOT NULL, action jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','delivered','dead')), attempts integer NOT NULL DEFAULT 0,
 fence integer NOT NULL DEFAULT 0, worker_id text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz, service_receipt jsonb, error text,
 UNIQUE(agent_id,causal_id), FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE INDEX runtime_franchise_outbox_due ON runtime_franchise_outbox(next_attempt_at) WHERE status IN ('pending','running');
