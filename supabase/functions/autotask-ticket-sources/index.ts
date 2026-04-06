/**
 * Read-only: returns Autotask Ticket `source` picklist (value id + UI label) from
 * GET .../Tickets/entityInformation/fields. Admin-only; uses the same Autotask API user as other functions.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

type ZoneInfoResponse = {
  url?: string
}

type FieldRow = {
  name?: string
  isPickList?: boolean
  picklistValues?: Array<{
    value?: string
    label?: string
    isActive?: boolean
    sortOrder?: number
  }>
}

const TICKETS_FIELDS_PATH = "/ATServicesRest/V1.0/Tickets/entityInformation/fields"

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
  }
}

function extractFieldsPayload(data: unknown): FieldRow[] {
  if (!data || typeof data !== "object") return []
  const o = data as Record<string, unknown>
  const raw = o.fields ?? o.Fields
  return Array.isArray(raw) ? (raw as FieldRow[]) : []
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
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json(401, { error: "Invalid or expired session. Please log in again." })
    }

    const { data: profile, error: profErr } = await supabaseAuth
      .from("profiles")
      .select("is_admin")
      .eq("id", userData.user.id)
      .maybeSingle()

    if (profErr || !profile?.is_admin) {
      return json(403, { error: "Admin access required." })
    }

    const zoneUrl = atZoneOverride ? atZoneOverride.replace(/\/+$/, "") : await getZoneUrl(atUserName, atIntegrationCode)
    const endpoint = `${zoneUrl}${TICKETS_FIELDS_PATH}`

    const res = await fetch(endpoint, {
      method: "GET",
      headers: buildAuthHeaders(atIntegrationCode, atUserName, atSecret),
    })

    if (!res.ok) {
      const t = await res.text().catch(() => "")
      throw new Error(`ticket_fields_failed:${res.status}:${t}`)
    }

    const payload = await res.json().catch(() => ({}))
    const fields = extractFieldsPayload(payload)
    const sourceField = fields.find((f) => String(f?.name || "").toLowerCase() === "source")

    if (!sourceField) {
      return json(502, { error: "Could not find Tickets source field in Autotask metadata." })
    }

    const rawList = Array.isArray(sourceField.picklistValues) ? sourceField.picklistValues : []
    const sources = rawList
      .map((pv) => {
        const n = Number(pv?.value)
        return {
          value: Number.isFinite(n) ? n : null,
          label: String(pv?.label ?? "").trim(),
          isActive: pv?.isActive !== false,
          sortOrder: typeof pv?.sortOrder === "number" ? pv.sortOrder : 0,
        }
      })
      .filter((s) => s.value !== null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))

    return json(200, { sources }, { "Cache-Control": "private, max-age=300" })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[autotask-ticket-sources] error:", msg)
    const safeDetails =
      msg.startsWith("zone_lookup_failed:") ||
      msg === "zone_lookup_missing_url" ||
      msg.startsWith("ticket_fields_failed:")
        ? msg
        : "Internal error"
    return json(500, { error: "Failed to load ticket sources. Please try again.", details: safeDetails })
  }
})
