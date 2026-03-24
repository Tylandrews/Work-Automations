-- Lock down plaintext fields after full cutover and verification.
-- Apply this only after backfill is complete and app reads encrypted fields.

-- Ensure no rows are left without encrypted values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.calls
    WHERE (name IS NOT NULL AND name <> '' AND name_ciphertext IS NULL)
       OR (phone IS NOT NULL AND phone <> '' AND phone_ciphertext IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot lock down plaintext columns until encrypted columns are fully backfilled';
  END IF;
END$$;

-- Prevent future plaintext writes at database level.
ALTER TABLE public.calls
  ADD CONSTRAINT calls_name_plaintext_disallowed CHECK (coalesce(name, '') = ''),
  ADD CONSTRAINT calls_phone_plaintext_disallowed CHECK (coalesce(phone, '') = '');

