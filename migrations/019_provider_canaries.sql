ALTER TABLE runtime_jobs ADD COLUMN execution_mode text NOT NULL DEFAULT 'owner' CHECK(execution_mode IN ('owner','provider_canary'));
