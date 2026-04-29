/**
 * Read-only: fetches one Autotask Company by id via Companies/query and returns the UDF
 * "02. Authorised Reps" from userDefinedFields. No create/update/delete.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

type ZoneInfoResponse = {
  url?: string
}

const COMPANIES_QUERY_PATH = "/ATServicesRest/V1.0/Companies/query"
/** Must match the Autotask UDF `name` in the REST API (same as UI label for this field). */
const AUTHORISED_REPS_UDF_NAME = "02. Authorised Reps"

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

function extractAuthorisedRepsFromCompany(company: unknown): string | null {
  if (!company || typeof company !== "object") return null
  const c = company as Record<string, unknown>
  const raw = c.userDefinedFields ?? c.UserDefinedFields
  if (!Array.isArray(raw)) return null
  for (const udf of raw) {
    if (!udf || typeof udf !== "object") continue
    const u = udf as Record<string, unknown>
    const name = String(u.name ?? u.Name ?? "").trim()
    if (name !== AUTHORISED_REPS_UDF_NAME) continue
    const val = u.value ?? u.Value
    if (val == null) return null
    const s = String(val).trim()
    return s.length > 0 ? s : null
  }
  return null
}

async function queryCompanyById(
  zoneUrl: string,
  integrationCode: string,
  userName: string,
  secret: string,
  companyId: number,
): Promise<unknown | null> {
  const endpoint = `${zoneUrl}${COMPANIES_QUERY_PATH}`
  const body = {
    filter: [
      {
        op: "and",
        items: [{ field: "id", op: "eq", value: companyId }],
      },
    ],
    maxRecords: 1,
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
  const items = (data?.items ?? data?.Items ?? []) as unknown[]
  if (!Array.isArray(items) || items.length === 0) return null
  return items[0] ?? null
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "GET") return json(405, { error: "Method not allowed" })

    const authHeader = req.headers.get("Authorization") || ""
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : ""
    if (!token) return json(401, { error: "Unauthorized. Please log in." })

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    if (!supabaseUrl || !anonKey) return json(500, { error: "Server configuration error" })

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
    const companyIdRaw = (url.searchParams.get("companyId") || "").trim()
    const companyId = parseInt(companyIdRaw, 10)
    if (!companyIdRaw || !Number.isFinite(companyId) || companyId <= 0) {
      return json(400, { error: "Invalid or missing companyId" })
    }

    const zoneUrl = atZoneOverride ? atZoneOverride.replace(/\/+$/, "") : await getZoneUrl(atUserName, atIntegrationCode)

    const company = await queryCompanyById(zoneUrl, atIntegrationCode, atUserName, atSecret, companyId)
    const authorisedReps = extractAuthorisedRepsFromCompany(company)

    return json(200, { authorisedReps }, { "Cache-Control": "private, max-age=60" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[autotask-company-key-data] error:", msg)
    const safeDetails =
      msg.startsWith("zone_lookup_failed:") ||
      msg === "zone_lookup_missing_url" ||
      msg.startsWith("companies_query_failed:")
        ? msg
        : "Internal error"
    return json(500, { error: "Failed to load company key data. Please try again.", details: safeDetails })
  }
})
