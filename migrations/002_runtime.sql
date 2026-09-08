CREATE TABLE runtime_agents (
 id text PRIMARY KEY, model text NOT NULL, budget_micros bigint NOT NULL CHECK(budget_micros >= 0 AND budget_micros <= 9007199254740991),
 spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros >= 0), reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros >= 0),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE runtime_jobs (
 id uuid PRIMARY KEY, agent_id text NOT NULL REFERENCES runtime_agents(id), causal_id text NOT NULL, fingerprint text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('appointment','event','message')), payload jsonb NOT NULL,
 due_at timestamptz NOT NULL, source_occurred_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','dead','cancelled')),
 attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
 worker_id text, fence integer NOT NULL DEFAULT 0, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), claimed_at timestamptz, completed_at timestamptz, error text,
 UNIQUE(agent_id,causal_id)
);
CREATE INDEX runtime_jobs_due ON runtime_jobs(due_at) WHERE status IN ('pending','running');
CREATE TABLE runtime_conversations (
 id uuid PRIMARY KEY, first_agent text NOT NULL REFERENCES runtime_agents(id), second_agent text NOT NULL REFERENCES runtime_agents(id),
 message_count integer NOT NULL DEFAULT 0 CHECK(message_count BETWEEN 0 AND 24), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(first_agent <> second_agent)
);
CREATE TABLE runtime_messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES runtime_conversations(id), sender_id text NOT NULL REFERENCES runtime_agents(id),
 recipient_id text NOT NULL REFERENCES runtime_agents(id), causal_id text NOT NULL, body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
 reply_to uuid REFERENCES runtime_messages(id), recipient_job_id uuid NOT NULL REFERENCES runtime_jobs(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz, responded_at timestamptz,
 UNIQUE(sender_id,causal_id)
);
CREATE TABLE runtime_reservations (
 id uuid PRIMARY KEY, agent_id text NOT NULL REFERENCES runtime_agents(id), job_id uuid NOT NULL REFERENCES runtime_jobs(id), fence integer NOT NULL,
 amount_micros bigint NOT NULL CHECK(amount_micros >= 0), actual_micros bigint, observed_micros bigint,
 status text NOT NULL CHECK(status IN ('reserved','settled','released','uncertain')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(job_id,fence)
);
CREATE TABLE runtime_receipts (
 seq bigserial PRIMARY KEY, type text NOT NULL, agent_id text REFERENCES runtime_agents(id), job_id uuid REFERENCES runtime_jobs(id),
 details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE runtime_memory (
 agent_id text NOT NULL REFERENCES runtime_agents(id), key text NOT NULL CHECK(length(key) BETWEEN 1 AND 100),
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 8000), version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(agent_id,key)
);
