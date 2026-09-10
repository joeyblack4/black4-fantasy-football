ALTER TABLE buzz_action_receipts ADD COLUMN cli_diagnostic jsonb;

CREATE TABLE runtime_owner_intro_dispositions (
 league_id text NOT NULL,
 stage_id text NOT NULL,
 agent_id text NOT NULL REFERENCES runtime_agents(id),
 prior_outbox_id uuid NOT NULL UNIQUE REFERENCES runtime_franchise_outbox(id),
 prior_buzz_receipt_id uuid NOT NULL REFERENCES buzz_action_receipts(id),
 replacement_causal_id text NOT NULL,
 receipt_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL,
 evidence jsonb NOT NULL,
 reviewed_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,stage_id,agent_id),
 FOREIGN KEY(league_id,stage_id) REFERENCES runtime_owner_stages(league_id,id),
 UNIQUE(agent_id,replacement_causal_id)
);
