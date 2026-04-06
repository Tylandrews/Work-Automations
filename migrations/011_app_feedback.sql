-- In-app feature requests and feedback (Call Log).
-- Authenticated users INSERT their own rows; users can read own submissions; admins can read all.
-- Apply via Supabase SQL Editor or your migration pipeline.

CREATE TABLE IF NOT EXISTS public.app_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('feature', 'improvement', 'bug', 'other')),
  message text NOT NULL CHECK (char_length(message) >= 1 AND char_length(message) <= 8000),
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_feedback_user_id_created_at_idx
  ON public.app_feedback (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS app_feedback_created_at_idx
  ON public.app_feedback (created_at DESC);

ALTER TABLE public.app_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_feedback_insert_own
  ON public.app_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY app_feedback_select_own_or_admin
  ON public.app_feedback
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND COALESCE(p.is_admin, false) = true
    )
  );
