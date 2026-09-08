-- Existing rehearsals deliberately remain UNKNOWN: no invented retroactive scoring votes.
ALTER TABLE governance_proposals ADD COLUMN scoring_rules jsonb;
ALTER TABLE leagues ADD COLUMN ratified_scoring_rules jsonb;
