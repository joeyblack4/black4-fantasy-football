-- Preserve submitted text; revisions append with an explicit owner-only predecessor.
ALTER TABLE mfl_governance_meetings ADD COLUMN discussion_opens_at timestamptz;
UPDATE mfl_governance_meetings SET discussion_opens_at=proposal_deadline;
ALTER TABLE mfl_governance_meetings ALTER COLUMN discussion_opens_at SET NOT NULL;
DO $$ DECLARE old_constraint text; BEGIN
 SELECT conname INTO STRICT old_constraint FROM pg_constraint
 WHERE conrelid='mfl_governance_proposals'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (league_id, meeting_id, author_team_id)';
 EXECUTE format('ALTER TABLE mfl_governance_proposals DROP CONSTRAINT %I',old_constraint);
END $$;
ALTER TABLE mfl_governance_proposals ADD COLUMN revision_no integer NOT NULL DEFAULT 1 CHECK(revision_no BETWEEN 1 AND 3),
 ADD COLUMN replaces_proposal_id text,
 ADD CONSTRAINT mfl_revision_predecessor_fk FOREIGN KEY(league_id,replaces_proposal_id) REFERENCES mfl_governance_proposals(league_id,id),
 ADD CONSTRAINT mfl_owner_revision_unique UNIQUE(league_id,meeting_id,author_team_id,revision_no),
 ADD CONSTRAINT mfl_revision_predecessor_unique UNIQUE(league_id,replaces_proposal_id),
 ADD CONSTRAINT mfl_revision_chain_check CHECK((revision_no=1 AND replaces_proposal_id IS NULL) OR (revision_no>1 AND replaces_proposal_id IS NOT NULL));
