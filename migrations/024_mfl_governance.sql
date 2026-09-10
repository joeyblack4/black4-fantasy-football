-- Owner approval and externally applied MFL settings are distinct records.
CREATE TABLE mfl_governance_menus (
 league_id text NOT NULL REFERENCES leagues(id), id text NOT NULL,
 host_version integer NOT NULL CHECK(host_version>0), content jsonb NOT NULL,
 content_hash text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,id)
);
CREATE TABLE mfl_governance_meetings (
 league_id text NOT NULL REFERENCES leagues(id),id text NOT NULL,menu_id text NOT NULL,
 host_version integer NOT NULL CHECK(host_version>0),proposal_deadline timestamptz NOT NULL,vote_deadline timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(league_id,id),
 FOREIGN KEY(league_id,menu_id) REFERENCES mfl_governance_menus(league_id,id),CHECK(vote_deadline>proposal_deadline)
);
CREATE TABLE mfl_governance_proposals (
 league_id text NOT NULL,id text NOT NULL,meeting_id text NOT NULL,author_team_id text NOT NULL,author_id text NOT NULL,
 version text NOT NULL,title text NOT NULL,content jsonb NOT NULL,content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(league_id,id),
 FOREIGN KEY(league_id,meeting_id) REFERENCES mfl_governance_meetings(league_id,id),
 FOREIGN KEY(league_id,author_team_id) REFERENCES league_teams(league_id,id),UNIQUE(league_id,meeting_id,author_team_id)
);
CREATE TABLE mfl_governance_votes (
 league_id text NOT NULL,proposal_id text NOT NULL,team_id text NOT NULL,owner_id text NOT NULL,choice text NOT NULL CHECK(choice IN ('yes','no')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(league_id,proposal_id,team_id),
 FOREIGN KEY(league_id,proposal_id) REFERENCES mfl_governance_proposals(league_id,id),FOREIGN KEY(league_id,team_id) REFERENCES league_teams(league_id,id)
);
CREATE TABLE mfl_governance_decisions (
 league_id text NOT NULL,id uuid NOT NULL,proposal_id text NOT NULL,proposal_hash text NOT NULL,host_version integer NOT NULL,
 yes_votes integer NOT NULL CHECK(yes_votes>=8 AND yes_votes<=12),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,id),FOREIGN KEY(league_id,proposal_id) REFERENCES mfl_governance_proposals(league_id,id),UNIQUE(league_id,proposal_id)
);
CREATE TABLE mfl_governance_approvals (
 league_id text NOT NULL,id uuid NOT NULL,decision_id uuid NOT NULL,proposal_id text NOT NULL,proposal_hash text NOT NULL,version text NOT NULL,
 host_version integer NOT NULL,approved_by text NOT NULL,approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,id),UNIQUE(league_id,host_version),FOREIGN KEY(league_id,decision_id) REFERENCES mfl_governance_decisions(league_id,id),FOREIGN KEY(league_id,proposal_id) REFERENCES mfl_governance_proposals(league_id,id)
);
CREATE TABLE mfl_governance_applications (
 league_id text NOT NULL,id uuid NOT NULL,approval_id uuid NOT NULL,proposal_hash text NOT NULL,host_version integer NOT NULL,
 evidence jsonb NOT NULL,attested_by text NOT NULL,attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(league_id,id),UNIQUE(league_id,approval_id),FOREIGN KEY(league_id,approval_id) REFERENCES mfl_governance_approvals(league_id,id)
);
