# autotask-sync-all-companies

Read-only full sync of **active** Autotask companies into `public.cached_autotask_companies`, at most once per **7 days** unless `?force=1`.

## Autotask (read-only)

This function only calls:

- `GET .../zoneInformation` (zone discovery)
- `POST .../Companies/query` (query body; no create/update/delete)

All writes are to **Supabase** only.

## Deploy

```bash
supabase functions deploy autotask-sync-all-companies
```

Use the same Autotask secrets as `autotask-search-companies-v3` (`AUTOTASK_INTEGRATION_CODE`, `AUTOTASK_USERNAME`, `AUTOTASK_SECRET`, optional `AUTOTASK_ZONE_URL`) plus `SUPABASE_SERVICE_ROLE_KEY`.

Apply migration `008_autotask_org_sync_meta.sql` before first use.

## Route

`GET /functions/v1/autotask-sync-all-companies`  
`GET /functions/v1/autotask-sync-all-companies?force=1`

Headers: `Authorization: Bearer <user JWT>`, `apikey: <anon key>`.

## Responses

- `200` `{ skipped: true, last_full_sync_at }` — sync not needed (within 7 days)
- `200` `{ skipped: true, reason: "sync_in_progress" }` — another invocation holds the lock
- `200` `{ synced: true, count, last_full_sync_at }` — completed
- `503` — Autotask env not configured
