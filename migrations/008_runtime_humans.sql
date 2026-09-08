ALTER TABLE runtime_agents ADD COLUMN kind text NOT NULL DEFAULT 'ai' CHECK(kind IN ('ai','human'));
UPDATE runtime_agents a SET kind='human'
 FROM runtime_bindings b JOIN league_teams t ON t.league_id=b.league_id AND t.id=b.team_id
 WHERE a.id=b.agent_id AND t.kind='human';
ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_status_check;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_status_check CHECK(status IN ('pending','running','completed','dead','cancelled','awaiting_human'));
-- A human inbox is not work that a model may claim. Revoke any accidental earlier worker claim.
UPDATE runtime_jobs j SET status='awaiting_human',worker_id=NULL,lease_until=NULL,fence=fence+1
 FROM runtime_agents a WHERE j.agent_id=a.id AND a.kind='human' AND j.kind='message' AND j.status IN ('pending','running');
UPDATE runtime_jobs j SET status='cancelled',error='HUMAN_IDENTITY_NO_MODEL_EXECUTION',worker_id=NULL,lease_until=NULL,fence=fence+1
 FROM runtime_agents a WHERE j.agent_id=a.id AND a.kind='human' AND j.status='running';
UPDATE runtime_reservations r SET status='uncertain'
 FROM runtime_agents a WHERE r.agent_id=a.id AND a.kind='human' AND r.status='reserved';
