-- Backfill encrypted columns from existing plaintext fields.
-- Run this only after the app can decrypt/encrypt using the configured DEK.
-- This script marks rows for application-side backfill by leaving ciphertext NULL.
-- The app backfill job should process rows where name_ciphertext or phone_ciphertext is NULL.

-- Optional helper index to speed up incremental backfill scans.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'calls_backfill_pending_idx'
  ) THEN
    CREATE INDEX calls_backfill_pending_idx
      ON public.calls (updated_at)
      WHERE name_ciphertext IS NULL OR phone_ciphertext IS NULL;
  END IF;
END$$;

