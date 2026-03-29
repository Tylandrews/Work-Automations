-- Harden profiles.is_admin: block authenticated/anon JWT holders from setting or changing it.
-- Service role (Edge Functions) and database triggers without a JWT (e.g. new-user handler) are allowed.
-- Apply in Supabase SQL Editor or via migration pipeline.

CREATE OR REPLACE FUNCTION public.profiles_prevent_is_admin_client_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  role_name text;
BEGIN
  role_name := auth.role();

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_admin, false) = true THEN
      IF role_name IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'is_admin cannot be set by client roles'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
      IF role_name IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'is_admin can only be changed by a privileged service'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_is_admin_client_change ON public.profiles;
CREATE TRIGGER profiles_prevent_is_admin_client_change
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.profiles_prevent_is_admin_client_change();

-- Recommended RLS (adjust names if you already have policies on profiles):
-- - SELECT: auth.uid() = id  (and optional team read policies)
-- - INSERT: auth.uid() = id  (signup) or service role
-- - UPDATE: auth.uid() = id  for full_name / updated_at; never expose is_admin to client updates
-- The trigger above is a safety net if UPDATE policies are too broad.
