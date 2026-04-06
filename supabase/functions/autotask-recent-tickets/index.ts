/**
 * Read-only: fetches Autotask tickets for a company with lastActivityDate in the last 14 days (UTC).
 * Calls ONLY .../Tickets/query (POST with JSON search body). No ticket create/update/delete.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

type ZoneInfoResponse = {
  url?: string
}

type AutotaskTicketRow = {
  id?: number
  ticketNumber?: string
  title?: string
  status?: number
  lastActivityDate?: string
}

const TICKETS_QUERY_PATH = "/ATServicesRest/V1.0/Tickets/query"
const AUTOTASK_PAGE_SIZE = 500
/** Rolling window for lastActivityDate (UTC). */
const LAST_ACTIVITY_WINDOW_DAYS = 14

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

function isoDaysAgoUtc(days: number): string {
  const ms = days * 24 * 60 * 60 * 1000
  return new Date(Date.now() - ms).toISOString()
}

/**
 * Single Autotask read: POST Tickets/query. No other Autotask URLs.
 */
async function queryTicketsForCompany(
  zoneUrl: string,
  integrationCode: string,
  userName: string,
  secret: string,
  companyId: number,
  lastActivitySinceIso: string,
): Promise<AutotaskTicketRow[]> {
  const endpoint = `${zoneUrl}${TICKETS_QUERY_PATH}`
  const body = {
    MaxRecords: AUTOTASK_PAGE_SIZE,
    IncludeFields: ["id", "ticketNumber", "title", "status", "lastActivityDate"],
    filter: [
      {
        op: "and",
        items: [
          { field: "companyID", op: "eq", value: companyId },
          { field: "lastActivityDate", op: "gte", value: lastActivitySinceIso },
        ],
      },
    ],
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildAuthHeaders(integrationCode, userName, secret),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`tickets_query_failed:${res.status}:${t}`)
  }

  const data = await res.json()
  const items = (data?.items || data?.Items || []) as AutotaskTicketRow[]
  if (!Array.isArray(items)) return []
  return items
}

function parseActivityMs(t: AutotaskTicketRow): number {
  const raw = t?.lastActivityDate
  if (!raw || typeof raw !== "string") return 0
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : 0
}

function normalizeTickets(rows: AutotaskTicketRow[]) {
  return [...rows]
    .filter((t) => t && typeof t.id === "number")
    .sort((a, b) => parseActivityMs(b) - parseActivityMs(a))
    .map((t) => ({
      id: t.id as number,
      ticketNumber: typeof t.ticketNumber === "string" ? t.ticketNumber : String(t.ticketNumber ?? ""),
      title: typeof t.title === "string" ? t.title : "",
      status: typeof t.status === "number" ? t.status : null,
      lastActivityDate: typeof t.lastActivityDate === "string" ? t.lastActivityDate : null,
    }))
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

    const rows = await queryTicketsForCompany(
      zoneUrl,
      atIntegrationCode,
      atUserName,
      atSecret,
      companyId,
      isoDaysAgoUtc(LAST_ACTIVITY_WINDOW_DAYS),
    )

    const tickets = normalizeTickets(rows)
    return json(200, { tickets }, { "Cache-Control": "private, max-age=60" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[autotask-recent-tickets] error:", msg)
    const safeDetails =
      msg.startsWith("zone_lookup_failed:") ||
      msg === "zone_lookup_missing_url" ||
      msg.startsWith("tickets_query_failed:")
        ? msg
        : "Internal error"
    return json(500, { error: "Failed to load recent tickets. Please try again.", details: safeDetails })
  }
})
