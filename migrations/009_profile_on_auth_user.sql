-- Auto-create a public.profiles row when a new auth.users row is inserted.
-- Display name comes from raw_user_meta_data.full_name (set on sign-up) or email local-part.
-- Apply via Supabase SQL Editor or your migration pipeline.
-- Also add redirect URL calllog://auth/callback (or your PASSWORD_RESET_REDIRECT_URL) under
-- Authentication → URL Configuration → Redirect URLs for password recovery emails.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, updated_at)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(BTRIM(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
      NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''),
      'User'
    ),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profiles ON auth.users;
CREATE TRIGGER on_auth_user_created_profiles
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();
