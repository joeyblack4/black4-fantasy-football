ALTER TABLE league_teams DROP CONSTRAINT league_teams_league_id_draft_position_key;
ALTER TABLE league_teams ADD CONSTRAINT league_teams_league_id_draft_position_key UNIQUE(league_id,draft_position) DEFERRABLE INITIALLY IMMEDIATE;
CREATE TABLE governance_meetings (
 league_id text NOT NULL REFERENCES leagues(id), id text NOT NULL,
 proposal_deadline timestamptz NOT NULL, vote_deadline timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,id), CHECK(vote_deadline>proposal_deadline)
);
CREATE TABLE governance_proposals (
 league_id text NOT NULL, id text NOT NULL, meeting_id text NOT NULL,
 author_team_id text NOT NULL, author_id text NOT NULL, version text NOT NULL,
 title text NOT NULL, rationale text NOT NULL, rules jsonb NOT NULL, team_order text[] NOT NULL,
 content_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,id), UNIQUE(league_id,meeting_id,author_team_id),
 FOREIGN KEY(league_id,meeting_id) REFERENCES governance_meetings(league_id,id),
 FOREIGN KEY(league_id,author_team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE governance_votes (
 league_id text NOT NULL, proposal_id text NOT NULL, team_id text NOT NULL, owner_id text NOT NULL,
 choice text NOT NULL CHECK(choice IN ('yes','no')), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,proposal_id,team_id),
 FOREIGN KEY(league_id,proposal_id) REFERENCES governance_proposals(league_id,id),
 FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE governance_decisions (
 league_id text NOT NULL, id text NOT NULL, proposal_id text NOT NULL,
 created_by text NOT NULL, yes_votes integer NOT NULL CHECK(yes_votes>=8 AND yes_votes<=12),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), consumed_at timestamptz,
 ratification_receipt_id text REFERENCES league_command_receipts(id),
 PRIMARY KEY(league_id,id), UNIQUE(league_id,proposal_id),
 FOREIGN KEY(league_id,proposal_id) REFERENCES governance_proposals(league_id,id)
);
CREATE TABLE governance_receipts (
 league_id text NOT NULL, actor_id text NOT NULL, idempotency_key text NOT NULL,
 id text NOT NULL UNIQUE, payload_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,actor_id,idempotency_key)
);
