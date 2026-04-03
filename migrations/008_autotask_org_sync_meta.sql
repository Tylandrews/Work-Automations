-- Single-row metadata for full Autotask company cache sync (weekly cadence).
-- Authenticated users may read; only service role (edge functions) writes.

CREATE TABLE IF NOT EXISTS public.autotask_org_sync_meta (
  id smallint PRIMARY KEY CHECK (id = 1),
  last_full_sync_at timestamptz,
  full_sync_started_at timestamptz
);

ALTER TABLE public.autotask_org_sync_meta ENABLE ROW LEVEL SECURITY;

INSERT INTO public.autotask_org_sync_meta (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'autotask_org_sync_meta'
      AND policyname = 'autotask_org_sync_meta_authenticated_select'
  ) THEN
    CREATE POLICY autotask_org_sync_meta_authenticated_select
      ON public.autotask_org_sync_meta
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END$$;
