-- Persist the private inbox before network I/O. Reconciliation must use that same inbox.
ALTER TABLE runtime_native_schedule_occurrences ADD COLUMN delivery_lane integer CHECK(delivery_lane IN (0,1));
