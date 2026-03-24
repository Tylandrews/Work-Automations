-- Rotation template:
-- 1) Store new wrapped DEK in app_keys with incremented key_version
-- 2) App writes new/updated rows using new key_version
-- 3) Background re-encrypt old rows
-- 4) Retire previous version after completion

-- Example upsert for new wrapped DEK value:
-- INSERT INTO public.app_keys (key_name, key_version, dek_encrypted)
-- VALUES ('calls_pii', 2, '<wrapped_dek_v2>')
-- ON CONFLICT (key_name)
-- DO UPDATE SET key_version = EXCLUDED.key_version, dek_encrypted = EXCLUDED.dek_encrypted, updated_at = now();

