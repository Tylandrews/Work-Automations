# Autotask Search Companies Edge Function

This Edge Function securely proxies requests to the **Autotask PSA REST API** to search companies (used as “organizations” in the app). **Autotask credentials are stored server-side only** in Supabase secrets and are never exposed to the Electron app.

## Secrets (server-side only)

Set these in Supabase (Dashboard → Settings → Edge Functions → Secrets) or via CLI:

```bash
supabase secrets set AUTOTASK_INTEGRATION_CODE=your-integration-code
supabase secrets set AUTOTASK_USERNAME=api-user@example.com
supabase secrets set AUTOTASK_SECRET=your-secret

# Optional: if you already know your tenant zone URL, you can skip zone lookup
supabase secrets set AUTOTASK_ZONE_URL=https://webservicesXX.autotask.net
```

## Deploy

```bash
supabase functions deploy autotask-search-companies
```

## Request

- Method: `GET`
- Query params:
  - `q` (required, min 2 chars)
  - `limit` (optional, default 20, max 50)
- Auth: Supabase JWT in `Authorization: Bearer <token>`

Example:

`GET /functions/v1/autotask-search-companies?q=acme&limit=20`

## Response

```json
{
  "organizations": [
    { "id": "123", "name": "Acme Corp" }
  ]
}
```

## Security notes

- The Electron app never sees Autotask credentials.
- All requests require a valid Supabase session token.
- Errors returned to the client are generic (no secrets, no raw upstream payload).

