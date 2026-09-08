-- Forward repair for deployed databases whose earlier outbox constraints predate
-- durable holds. Preserve all existing terminal states and validate existing rows.
ALTER TABLE runtime_franchise_outbox
  DROP CONSTRAINT IF EXISTS runtime_franchise_outbox_status_check;
ALTER TABLE runtime_franchise_outbox
  ADD CONSTRAINT runtime_franchise_outbox_status_check
  CHECK (status IN ('pending','running','delivered','dead','held'));

ALTER TABLE runtime_football_outbox
  DROP CONSTRAINT IF EXISTS runtime_football_outbox_status_check;
ALTER TABLE runtime_football_outbox
  ADD CONSTRAINT runtime_football_outbox_status_check
  CHECK (status IN ('pending','running','delivered','dead','held'));
