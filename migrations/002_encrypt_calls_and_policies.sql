-- Add encrypted columns and blind indexes to calls
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'calls' AND column_name = 'name_ciphertext'
  ) THEN
    ALTER TABLE public.calls
      ADD COLUMN name_ciphertext text,
      ADD COLUMN name_blind_index text,
      ADD COLUMN phone_ciphertext text,
      ADD COLUMN phone_blind_index text,
      ADD COLUMN key_version smallint NOT NULL DEFAULT 1;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'calls_phone_blind_index_idx'
  ) THEN
    CREATE INDEX calls_phone_blind_index_idx ON public.calls (phone_blind_index);
  END IF;
END$$;

-- Ensure key metadata table exists for wrapped DEKs
CREATE TABLE IF NOT EXISTS public.app_keys (
  key_name text PRIMARY KEY,
  key_version smallint NOT NULL,
  dek_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_keys ENABLE ROW LEVEL SECURITY;

-- Baseline policies. Adjust to your role model if needed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'calls' AND policyname = 'calls_user_rw'
  ) THEN
    CREATE POLICY calls_user_rw
      ON public.calls
      FOR ALL
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_keys' AND policyname = 'app_keys_authenticated_read'
  ) THEN
    CREATE POLICY app_keys_authenticated_read
      ON public.app_keys
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_keys' AND policyname = 'app_keys_authenticated_write'
  ) THEN
    CREATE POLICY app_keys_authenticated_write
      ON public.app_keys
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

