-- Key management config table for envelope encryption
CREATE TABLE IF NOT EXISTS public.app_keys (
  project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_version smallint NOT NULL,
  dek_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Example: secure PII on contacts table with client-side encryption
-- Adjust table/column names to match your schema if different.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'email_ciphertext'
  ) THEN
    ALTER TABLE public.contacts
      ADD COLUMN email_ciphertext text,
      ADD COLUMN email_blind_index text,
      ADD COLUMN name_ciphertext text,
      ADD COLUMN name_blind_index text,
      ADD COLUMN phone_ciphertext text,
      ADD COLUMN phone_blind_index text,
      ADD COLUMN key_version smallint NOT NULL DEFAULT 1;
  END IF;
END$$;

-- Indexes to support equality lookups via blind indexes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'contacts_email_blind_index_key'
  ) THEN
    CREATE UNIQUE INDEX contacts_email_blind_index_key ON public.contacts (email_blind_index);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'contacts_phone_blind_index_idx'
  ) THEN
    CREATE INDEX contacts_phone_blind_index_idx ON public.contacts (phone_blind_index);
  END IF;
END$$;

-- Enable RLS and add baseline restrictive policies
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='contacts' AND policyname='contacts_service_role_rw'
  ) THEN
    CREATE POLICY contacts_service_role_rw
      ON public.contacts
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

-- Optional: deny by default to public/anon/authenticated unless you add explicit policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='contacts' AND policyname='contacts_read_own'
  ) THEN
    CREATE POLICY contacts_read_own
      ON public.contacts
      FOR SELECT
      TO authenticated
      USING (false);
  END IF;
END$$;

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'app_keys_set_updated_at'
  ) THEN
    CREATE TRIGGER app_keys_set_updated_at
    BEFORE UPDATE ON public.app_keys
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

