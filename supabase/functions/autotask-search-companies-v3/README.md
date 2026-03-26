# Autotask Search Companies Edge Function (v3)

This Edge Function proxies Autotask company search requests for organization autocomplete in the desktop app.

## Deploy

```bash
supabase functions deploy autotask-search-companies-v3
```

## Required secrets

Set these in Supabase Edge Function secrets:

- `AUTOTASK_INTEGRATION_CODE`
- `AUTOTASK_USERNAME`
- `AUTOTASK_SECRET`
- Optional: `AUTOTASK_ZONE_URL`

The function also reads project runtime values:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

`SUPABASE_SERVICE_ROLE_KEY` is required because `v3` upserts organization results into `public.cached_autotask_companies` on each successful search.

## Request

- Method: `GET`
- Route: `/functions/v1/autotask-search-companies-v3`
- Query params:
  - `q` (required, minimum 2 characters)
  - `limit` (optional, default 20, max 50)
- Auth: `Authorization: Bearer <supabase-jwt>`

Example:

`GET /functions/v1/autotask-search-companies-v3?q=acme&limit=20`

## Response

```json
{
  "organizations": [
    { "id": "123", "name": "Acme Corp" }
  ]
}
```

## Cache behavior

- After a successful Autotask query, results are upserted into `public.cached_autotask_companies`
- Upsert key: `autotask_id`
- Updated fields: `company_name`, `cached_at`
- Cache upsert failures are logged server-side and do not block the API response
