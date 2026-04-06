-- Shared regex + color rules for Recent tickets panel (Call Log).
-- SELECT: all authenticated users. INSERT/UPDATE/DELETE: admins only (profiles.is_admin).

CREATE TABLE IF NOT EXISTS public.recent_ticket_style_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sort_order integer NOT NULL,
  label text NOT NULL DEFAULT '',
  pattern text NOT NULL,
  color text NOT NULL DEFAULT '#6b7280',
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recent_ticket_style_rules_sort_order_idx
  ON public.recent_ticket_style_rules (sort_order);

ALTER TABLE public.recent_ticket_style_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY recent_ticket_style_rules_select_authenticated
  ON public.recent_ticket_style_rules
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY recent_ticket_style_rules_insert_admin
  ON public.recent_ticket_style_rules
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND COALESCE(p.is_admin, false) = true
    )
  );

CREATE POLICY recent_ticket_style_rules_update_admin
  ON public.recent_ticket_style_rules
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND COALESCE(p.is_admin, false) = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND COALESCE(p.is_admin, false) = true
    )
  );

CREATE POLICY recent_ticket_style_rules_delete_admin
  ON public.recent_ticket_style_rules
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND COALESCE(p.is_admin, false) = true
    )
  );
