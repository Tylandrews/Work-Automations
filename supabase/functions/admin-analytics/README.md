# admin-analytics

Edge function for **administrators only**: aggregate and list call metadata across all users (no name/phone/ciphertext fields).

## Deploy

Deploy with **gateway JWT verification disabled** so the Edge runtime receives the request and this function can validate the bearer token with `auth.getUser` and `profiles.is_admin`. (If the gateway verifies JWT, some clients hit **Invalid JWT** before this code runs.)

```bash
supabase functions deploy admin-analytics --no-verify-jwt
```

Same approach as `account-admin` when documented with `--no-verify-jwt`.

## Actions (POST JSON)

| `action` | Body fields | Returns |
|----------|-------------|---------|
| `summary` | `startIso`, `endIso` (optional), `timezoneOffsetMinutes` (optional, default 0 — use `new Date().getTimezoneOffset()` from the app) | Totals, daily series, per-user daily series, top organizations |
| `byUser` | Same date fields as summary | Rows: user id, label, call count, last call time |
| `recentCalls` | `page`, `perPage` (max 100) | Paginated recent calls + user label |
| `liveSeries` | `windowMinutes` (optional, default 60, max 1440) | Per-minute call counts for the blessed-contrib CLI |

## Environment

Uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (injected by Supabase when deployed).
