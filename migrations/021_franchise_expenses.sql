CREATE TABLE franchise_expenses (
 id uuid PRIMARY KEY,
 league_id text NOT NULL REFERENCES leagues(id),
 request_id uuid NOT NULL UNIQUE REFERENCES franchise_service_requests(id),
 agent_id text NOT NULL REFERENCES runtime_agents(id),
 team_id text NOT NULL,
 reserved_micros bigint NOT NULL CHECK(reserved_micros>0 AND reserved_micros<=9007199254740991),
 actual_micros bigint CHECK(actual_micros>=0 AND actual_micros<=9007199254740991),
 status text NOT NULL CHECK(status IN ('reserved','uncertain','settled','cancelled')),
 invoice_reference text,
 evidence text,
 begun_by text NOT NULL,
 begun_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id),
 CHECK((status='settled')=(invoice_reference IS NOT NULL)),
 CHECK((status IN ('settled','cancelled'))=(actual_micros IS NOT NULL)),
 CHECK(status<>'cancelled' OR actual_micros=0)
);
CREATE UNIQUE INDEX franchise_expense_invoice_once ON franchise_expenses(league_id,invoice_reference) WHERE invoice_reference IS NOT NULL;
CREATE TABLE franchise_expense_receipts (
 id uuid PRIMARY KEY,
 league_id text NOT NULL REFERENCES leagues(id),
 expense_id uuid NOT NULL REFERENCES franchise_expenses(id),
 actor_id text NOT NULL,
 idempotency_key text NOT NULL,
 fingerprint text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('begin','settle','uncertain','cancel')),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(league_id,actor_id,idempotency_key)
);
