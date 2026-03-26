-- Cache table used by the Autotask company search edge function.
-- This is safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.cached_autotask_companies (
  autotask_id text PRIMARY KEY,
  company_name text NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'cached_autotask_companies_company_name_idx'
  ) THEN
    CREATE INDEX cached_autotask_companies_company_name_idx
      ON public.cached_autotask_companies (company_name);
  END IF;
END$$;

ALTER TABLE public.cached_autotask_companies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'cached_autotask_companies'
      AND policyname = 'cached_autotask_companies_authenticated_read'
  ) THEN
    CREATE POLICY cached_autotask_companies_authenticated_read
      ON public.cached_autotask_companies
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'cached_autotask_companies'
      AND policyname = 'cached_autotask_companies_authenticated_write'
  ) THEN
    CREATE POLICY cached_autotask_companies_authenticated_write
      ON public.cached_autotask_companies
      FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'cached_autotask_companies'
      AND policyname = 'cached_autotask_companies_authenticated_update'
  ) THEN
    CREATE POLICY cached_autotask_companies_authenticated_update
      ON public.cached_autotask_companies
      FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;
