/**
 * Weekly (or forced) full read of active Autotask companies into Supabase.
 *
 * READ-ONLY toward Autotask: only zoneInformation (GET) and Companies/query (POST).
 * All writes are to Supabase (cached_autotask_companies, autotask_org_sync_meta).
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

type AutotaskCompany = {
  id: number
  companyName: string
}

type ZoneInfoResponse = {
  url?: string
}

const FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const SYNC_LOCK_STALE_MS = 45 * 60 * 1000
const AUTOTASK_PAGE_SIZE = 500
const SUPABASE_UPSERT_CHUNK = 500

function json(status: number, body: unknown, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  })
}

let cachedZoneUrl: string | null = null
let cachedZoneUrlFetchedAt = 0
const ZONE_CACHE_TTL_MS = 6 * 60 * 60 * 1000

async function getZoneUrl(userName: string, integrationCode: string): Promise<string> {
  const now = Date.now()
  if (cachedZoneUrl && now - cachedZoneUrlFetchedAt < ZONE_CACHE_TTL_MS) return cachedZoneUrl

  const zoneLookup = `https://webservices.autotask.net/ATServicesRest/V1.0/zoneInformation?user=${encodeURIComponent(userName)}`
  const res = await fetch(zoneLookup, {
    method: "GET",
    headers: {
      ApiIntegrationCode: integrationCode,
      Accept: "application/json",
    },
  })

  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`zone_lookup_failed:${res.status}:${t}`)
  }

  const data = (await res.json()) as ZoneInfoResponse
  const url = String(data?.url || "").trim()
  if (!url) throw new Error("zone_lookup_missing_url")

  cachedZoneUrl = url.replace(/\/+$/, "")
  cachedZoneUrlFetchedAt = now
  return cachedZoneUrl
}

function buildAuthHeaders(integrationCode: string, userName: string, secret: string) {
  return {
    ApiIntegrationCode: integrationCode,
    UserName: userName,
    Secret: secret,
    Accept: "application/json",
    "Content-Type": "application/json",
  }
}

/** Read-only Companies/query. Paginates with id gt lastId (Autotask max ~500 rows per request). */
async function fetchAllActiveCompanies(
  zoneUrl: string,
  integrationCode: string,
  userName: string,
  secret: string,
): Promise<Array<{ id: string; name: string }>> {
  const endpoint = `${zoneUrl}/ATServicesRest/V1.0/Companies/query`
  const headers = buildAuthHeaders(integrationCode, userName, secret)
  const byId = new Map<string, { id: string; name: string }>()
  let lastId = 0

  for (;;) {
    const filter =
      lastId <= 0
        ? [
            {
              op: "and",
              items: [{ field: "isActive", op: "eq", value: true }],
            },
          ]
        : [
            {
              op: "and",
              items: [
                { field: "isActive", op: "eq", value: true },
                { field: "id", op: "gt", value: lastId },
              ],
            },
          ]

    const body = {
      filter,
      maxRecords: AUTOTASK_PAGE_SIZE,
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const t = await res.text().catch(() => "")
      throw new Error(`companies_query_failed:${res.status}:${t}`)
    }

    const data = await res.json()
    const items = (data?.items || data?.Items || []) as AutotaskCompany[]
    if (!Array.isArray(items) || items.length === 0) break

    let maxId = lastId
    for (const c of items) {
      if (!c || typeof c.id !== "number" || typeof c.companyName !== "string") continue
      const id = String(c.id)
      const name = c.companyName.trim()
      if (!name) continue
      byId.set(id, { id, name })
      if (c.id > maxId) maxId = c.id
    }

    if (items.length < AUTOTASK_PAGE_SIZE) break
    if (maxId <= lastId) break
    lastId = maxId
  }

  return Array.from(byId.values())
}

async function upsertCompanyBatches(
  supabaseUrl: string,
  serviceRoleKey: string,
  companies: Array<{ id: string; name: string }>,
) {
  if (!companies.length) return
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const nowIso = new Date().toISOString()

  for (let i = 0; i < companies.length; i += SUPABASE_UPSERT_CHUNK) {
    const slice = companies.slice(i, i + SUPABASE_UPSERT_CHUNK)
    const rows = slice.map((company) => ({
      autotask_id: company.id,
      company_name: company.name,
      cached_at: nowIso,
    }))
    const { error } = await admin.from("cached_autotask_companies").upsert(rows, { onConflict: "autotask_id" })
    if (error) throw error
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Max-Age": "86400",
      },
    })
  }

  try {
    if (req.method !== "GET") return json(405, { error: "Method not allowed" })

    const authHeader = req.headers.get("Authorization") || ""
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : ""
    if (!token) return json(401, { error: "Unauthorized. Please log in." })

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(500, { error: "Server configuration error" })

    const atIntegrationCode = (Deno.env.get("AUTOTASK_INTEGRATION_CODE") ?? "").trim()
    const atUserName = (Deno.env.get("AUTOTASK_USERNAME") ?? "").trim()
    const atSecret = (Deno.env.get("AUTOTASK_SECRET") ?? "").trim()
    const atZoneOverride = (Deno.env.get("AUTOTASK_ZONE_URL") ?? "").trim()

    if (!atIntegrationCode || !atUserName || !atSecret) {
      return json(503, { error: "Autotask API not configured" })
    }

    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json(401, { error: "Invalid or expired session. Please log in again." })
    }

    const url = new URL(req.url)
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true"

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: metaRow, error: metaReadErr } = await admin
      .from("autotask_org_sync_meta")
      .select("last_full_sync_at, full_sync_started_at")
      .eq("id", 1)
      .maybeSingle()

    if (metaReadErr) {
      console.error("[autotask-sync-all] meta read failed:", metaReadErr)
      return json(500, { error: "Failed to read sync metadata. Apply migration 008_autotask_org_sync_meta.sql." })
    }

    const nowMs = Date.now()

    if (!force && metaRow?.last_full_sync_at) {
      const last = new Date(metaRow.last_full_sync_at).getTime()
      if (nowMs - last < FULL_SYNC_INTERVAL_MS) {
        return json(200, {
          skipped: true,
          last_full_sync_at: metaRow.last_full_sync_at,
        })
      }
    }

    if (metaRow?.full_sync_started_at) {
      const started = new Date(metaRow.full_sync_started_at).getTime()
      if (nowMs - started < SYNC_LOCK_STALE_MS) {
        return json(200, {
          skipped: true,
          reason: "sync_in_progress",
          full_sync_started_at: metaRow.full_sync_started_at,
        })
      }
    }

    const lockIso = new Date().toISOString()
    const { error: lockErr } = await admin
      .from("autotask_org_sync_meta")
      .update({ full_sync_started_at: lockIso })
      .eq("id", 1)

    if (lockErr) {
      console.error("[autotask-sync-all] lock failed:", lockErr)
      return json(500, { error: "Failed to claim sync lock" })
    }

    try {
      const zoneUrl = atZoneOverride ? atZoneOverride.replace(/\/+$/, "") : await getZoneUrl(atUserName, atIntegrationCode)
      const companies = await fetchAllActiveCompanies(zoneUrl, atIntegrationCode, atUserName, atSecret)
      await upsertCompanyBatches(supabaseUrl, serviceRoleKey, companies)

      const doneIso = new Date().toISOString()
      const { error: doneErr } = await admin
        .from("autotask_org_sync_meta")
        .update({
          last_full_sync_at: doneIso,
          full_sync_started_at: null,
        })
        .eq("id", 1)

      if (doneErr) throw doneErr

      return json(200, {
        skipped: false,
        synced: true,
        count: companies.length,
        last_full_sync_at: doneIso,
      })
    } catch (syncErr) {
      await admin
        .from("autotask_org_sync_meta")
        .update({ full_sync_started_at: null })
        .eq("id", 1)
        .then(() => {})
        .catch(() => {})

      throw syncErr
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[autotask-sync-all] error:", msg)
    const safeDetails =
      msg.startsWith("zone_lookup_failed:") ||
      msg === "zone_lookup_missing_url" ||
      msg.startsWith("companies_query_failed:")
        ? msg
        : "Internal error"
    return json(500, { error: "Failed to sync organizations.", details: safeDetails })
  }
})
