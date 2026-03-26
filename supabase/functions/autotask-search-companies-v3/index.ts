import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

type AutotaskCompany = {
  id: number
  companyName: string
}

type ZoneInfoResponse = {
  url?: string
}

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

async function queryCompanies(
  zoneUrl: string,
  integrationCode: string,
  userName: string,
  secret: string,
  query: string,
  limit: number,
): Promise<Array<{ id: string; name: string }>> {
  const endpoint = `${zoneUrl}/ATServicesRest/V1.0/Companies/query`
  const body = {
    filter: [
      {
        op: "and",
        items: [
          { field: "companyName", op: "contains", value: query },
          { field: "isActive", op: "eq", value: true },
        ],
      },
    ],
    maxRecords: Math.min(Math.max(limit, 1), 50),
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildAuthHeaders(integrationCode, userName, secret),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`companies_query_failed:${res.status}:${t}`)
  }

  const data = await res.json()
  const items = (data?.items || data?.Items || []) as AutotaskCompany[]
  if (!Array.isArray(items)) return []

  return items
    .filter((c) => c && typeof c.id === "number" && typeof c.companyName === "string")
    .slice(0, limit)
    .map((c) => ({ id: String(c.id), name: c.companyName }))
}

async function upsertCompanyCache(
  supabaseUrl: string,
  serviceRoleKey: string,
  companies: Array<{ id: string; name: string }>,
) {
  if (!companies.length) return
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const nowIso = new Date().toISOString()
  const rows = companies.map((company) => ({
    autotask_id: company.id,
    company_name: company.name,
    cached_at: nowIso,
  }))
  const { error } = await admin
    .from("cached_autotask_companies")
    .upsert(rows, { onConflict: "autotask_id" })
  if (error) throw error
}

Deno.serve(async (req: Request) => {
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
    const { data, error } = await supabaseAuth.auth.getUser()
    if (error || !data?.user?.id) return json(401, { error: "Invalid or expired session. Please log in again." })

    const url = new URL(req.url)
    const q = (url.searchParams.get("q") || "").trim()
    const limitParam = url.searchParams.get("limit")
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20
    if (q.length < 2) return json(400, { error: "Search query must be at least 2 characters" })

    const zoneUrl = atZoneOverride ? atZoneOverride.replace(/\/+$/, "") : await getZoneUrl(atUserName, atIntegrationCode)
    const companies = await queryCompanies(zoneUrl, atIntegrationCode, atUserName, atSecret, q, limit)
    try {
      await upsertCompanyCache(supabaseUrl, serviceRoleKey, companies)
    } catch (cacheError) {
      console.error("[autotask-v3] cache upsert failed:", cacheError)
    }

    return json(200, { organizations: companies }, { "Cache-Control": "private, max-age=300" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[autotask-v3] error:", msg)
    const safeDetails =
      msg.startsWith("zone_lookup_failed:") ||
      msg === "zone_lookup_missing_url" ||
      msg.startsWith("companies_query_failed:")
        ? msg
        : "Internal error"
    return json(500, { error: "Failed to search organizations. Please try again.", details: safeDetails })
  }
})
