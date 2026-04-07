# Autotask recent tickets (read-only)

Edge Function that returns tickets for an Autotask **company** whose **`lastActivityDate` is in the last 14 days (UTC)**, newest first (up to **500** per Autotask query page). It calls `Tickets/query`, then enriches rows with **`GET Tickets/entityInformation/fields`** (status labels) and batched **`Resources/query`** / **`Roles/query`** for primary assignee names. It does not create, update, or delete anything in Autotask.

## Deploy

```bash
npx supabase functions deploy autotask-recent-tickets --no-verify-jwt --project-ref <YOUR_PROJECT_REF> --use-api
```

**JWT:** Gateway verification is **off** (`--no-verify-jwt`), matching `autotask-search-companies-v3` and other functions in this project. The function still requires a valid user JWT and validates it with `createClient` + `auth.getUser()` before calling Autotask.

## Secrets

Same as other Autotask functions:

- `AUTOTASK_INTEGRATION_CODE`
- `AUTOTASK_USERNAME`
- `AUTOTASK_SECRET`
- Optional: `AUTOTASK_ZONE_URL`

Plus project defaults: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

## Request

- Method: `GET`
- Route: `/functions/v1/autotask-recent-tickets`
- Query: `companyId` (required, positive integer Autotask company ID)
- Auth: `Authorization: Bearer <supabase-jwt>`

## Response

```json
{
  "tickets": [
    {
      "id": 123,
      "ticketNumber": "T20260101.0001",
      "title": "Example",
      "status": 1,
      "statusName": "In Progress",
      "source": 12,
      "primaryResourceRole": "Jane Smith (Service Desk)",
      "lastActivityDate": "2026-04-01T12:00:00Z"
    }
  ]
}
```

## Behavior notes

- **`statusName`** is resolved from the Ticket **status** picklist (or `null` if unknown). Numeric **`status`** is still included.
- **`primaryResourceRole`** combines **assignedResourceID** and **assignedResourceroleID** into `"First Last (Role name)"` when both exist, or a single name if only one side is set. If Autotask denies **Resources** or **Roles** query access for the API user, this field may be `null` even when a resource or role is assigned.
- Each ticket includes **`source`** (Ticket Source picklist **ID**, integer, or `null`).
- Queries tickets with `lastActivityDate` **greater than or equal to** now minus **14** days (UTC). No wider fallback window.
- Autotask returns up to **500** rows per query (sorted by internal ID); this function re-sorts by `lastActivityDate` descending. If a company has more than **500** tickets with activity in that window, the list is incomplete (Autotask API limit).
