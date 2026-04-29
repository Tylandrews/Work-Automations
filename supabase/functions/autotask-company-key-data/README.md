# Autotask company key data (read-only)

Edge Function that returns the Company user-defined field **`02. Authorised Reps`** for a given Autotask company id. It calls **`Companies/query`** with `id` equals the requested company. It does not create, update, or delete anything in Autotask.

## Deploy

```bash
npx supabase functions deploy autotask-company-key-data --no-verify-jwt --project-ref <YOUR_PROJECT_REF> --use-api
```

**JWT:** Gateway verification is **off** (`--no-verify-jwt`), matching `autotask-recent-tickets` and other functions in this project. The function still requires a valid user JWT and validates it with `createClient` + `auth.getUser()` before calling Autotask.

## Secrets

Same as other Autotask functions:

- `AUTOTASK_INTEGRATION_CODE`
- `AUTOTASK_USERNAME`
- `AUTOTASK_SECRET`
- Optional: `AUTOTASK_ZONE_URL`

Plus project defaults: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

## Request

- Method: `GET`
- Route: `/functions/v1/autotask-company-key-data`
- Query: `companyId` (required, positive integer Autotask company ID)
- Auth: `Authorization: Bearer <supabase-jwt>`

## Response

```json
{
  "authorisedReps": "Example value or null if unset or company not found"
}
```

The UDF is matched by **`name`** exactly equal to `02. Authorised Reps` in the REST `userDefinedFields` array. If your tenant uses a different API field name, update the constant in `index.ts`.
