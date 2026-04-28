/**
 * Read-only: fetches Autotask tickets for a company with lastActivityDate in the last 14 days (UTC).
 * Calls Tickets/query plus batched Resources/query, Roles/query, and GET Tickets/entityInformation/fields
 * (for status picklist labels). No ticket create/update/delete.
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
  source?: number
  assignedResourceID?: number
  assignedResourceroleID?: number
  lastActivityDate?: string
}

type FieldRow = {
  name?: string
  picklistValues?: Array<{ value?: string; label?: string }>
}

const TICKETS_QUERY_PATH = "/ATServicesRest/V1.0/Tickets/query"
const TICKETS_FIELDS_PATH = "/ATServicesRest/V1.0/Tickets/entityInformation/fields"
const RESOURCES_QUERY_PATH = "/ATServicesRest/V1.0/Resources/query"
const ROLES_QUERY_PATH = "/ATServicesRest/V1.0/Roles/query"
const AUTOTASK_PAGE_SIZE = 500
const ID_CHUNK_SIZE = 250
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

function extractFieldsPayload(data: unknown): FieldRow[] {
  if (!data || typeof data !== "object") return []
  const o = data as Record<string, unknown>
  const raw = o.fields ?? o.Fields
  return Array.isArray(raw) ? (raw as FieldRow[]) : []
}

async function fetchTicketStatusLabelMap(
  zoneUrl: string,
  headers: Record<string, string>,
): Promise<Map<number, string>> {
  const m = new Map<number, string>()
  const res = await fetch(`${zoneUrl}${TICKETS_FIELDS_PATH}`, { method: "GET", headers })
  if (!res.ok) {
    const t = await res.text().catch(() => "")
    throw new Error(`ticket_fields_failed:${res.status}:${t}`)
  }
  const payload = await res.json().catch(() => ({}))
  const fields = extractFieldsPayload(payload)
  const statusField = fields.find((f) => String(f?.name || "").toLowerCase() === "status")
  const rawList = Array.isArray(statusField?.picklistValues) ? statusField.picklistValues : []
  for (const pv of rawList) {
    const n = Number(pv?.value)
    const lab = String(pv?.label ?? "").trim()
    if (Number.isFinite(n) && lab) m.set(n, lab)
  }
  return m
}

async function queryByIdIn(
  zoneUrl: string,
  queryPath: string,
  headers: Record<string, string>,
  ids: number[],
  includeFields: string[],
): Promise<unknown[]> {
  const unique = [...new Set(ids.filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0))]
  if (unique.length === 0) return []

  const out: unknown[] = []
  for (let i = 0; i < unique.length; i += ID_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + ID_CHUNK_SIZE)
    const body = {
      MaxRecords: AUTOTASK_PAGE_SIZE,
      IncludeFields: includeFields,
      filter: [{ op: "in", field: "id", value: chunk }],
    }
    const res = await fetch(`${zoneUrl}${queryPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => "")
      throw new Error(`${queryPath}_failed:${res.status}:${t}`)
    }
    const data = await res.json().catch(() => ({}))
    const items = (data?.items || data?.Items || []) as unknown[]
    if (Array.isArray(items)) out.push(...items)
  }
  return out
}

function buildResourceNameMap(rows: unknown[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const r of rows) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const id = typeof o.id === "number" ? o.id : Number(o.id)
    if (!Number.isFinite(id)) continue
    const first = String(o.firstName ?? "").trim()
    const last = String(o.lastName ?? "").trim()
    const name = [first, last].filter(Boolean).join(" ").trim() || String(o.userName ?? "").trim() || ""
    if (name) m.set(id, name)
  }
  return m
}

function buildRoleNameMap(rows: unknown[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const r of rows) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const id = typeof o.id === "number" ? o.id : Number(o.id)
    if (!Number.isFinite(id)) continue
    const name = String(o.name ?? "").trim()
    if (name) m.set(id, name)
  }
  return m
}

function formatPrimaryResourceRole(
  resourceId: number | null,
  roleId: number | null,
  resourceNames: Map<number, string>,
  roleNames: Map<number, string>,
): string | null {
  const resName = resourceId != null && Number.isFinite(resourceId) ? resourceNames.get(resourceId) : undefined
  const roleName = roleId != null && Number.isFinite(roleId) ? roleNames.get(roleId) : undefined
  if (resName && roleName) return `${resName} (${roleName})`
  if (resName) return resName
  if (roleName) return roleName
  return null
}

function buildAutotaskTicketUrl(zoneUrl: string, ticketId: number): string | null {
  const safeTicketId = Number(ticketId)
  if (!Number.isFinite(safeTicketId) || safeTicketId <= 0) return null
  const base = normalizeAutotaskPortalBaseUrl(zoneUrl)
  if (!base) return null
  return `${base}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=${encodeURIComponent(String(Math.trunc(safeTicketId)))}`
}

function normalizeAutotaskPortalBaseUrl(zoneUrl: string): string | null {
  const raw = String(zoneUrl || "").trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname
    const protocol = parsed.protocol || "https:"
    const candidates = buildAutotaskPortalHostCandidates(host)
    for (const h of candidates) {
      const base = `${protocol}//${h}`.replace(/\/+$/, "")
      if (base) return base
    }
    return null
  } catch (_e) {
    return null
  }
}

function buildAutotaskPortalHostCandidates(host: string): string[] {
  const out: string[] = []
  const h = String(host || "").trim().toLowerCase()
  if (!h) return out

  // Preferred: canonical portal host.
  if (/^ww\d*\.autotask\.net$/i.test(h)) out.push(h)

  // Common API host -> portal host mapping (webservicesX -> wwX).
  const ws = h.match(/^webservices(\d*)\.autotask\.net$/i)
  if (ws) out.push(`ww${ws[1] || ""}.autotask.net`)

  // Generic fallback for custom subdomains on autotask.net.
  if (h.endsWith(".autotask.net") && !out.includes(h)) out.push(h)

  // Last resort: explicit primary portal host.
  if (!out.includes("ww.autotask.net")) out.push("ww.autotask.net")

  return [...new Set(out)]
}

function buildAutotaskTicketUrlByNumber(zoneUrl: string, ticketNumber: string): string | null {
  const safeTicketNumber = String(ticketNumber || "").trim()
  if (!safeTicketNumber) return null
  const base = normalizeAutotaskPortalBaseUrl(zoneUrl)
  if (!base) return null
  return `${base}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketNumber=${encodeURIComponent(safeTicketNumber)}`
}

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
    IncludeFields: [
      "id",
      "ticketNumber",
      "title",
      "status",
      "source",
      "assignedResourceID",
      "assignedResourceroleID",
      "lastActivityDate",
    ],
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

async function enrichAndNormalizeTickets(
  rows: AutotaskTicketRow[],
  zoneUrl: string,
  authHeaders: Record<string, string>,
): Promise<
  Array<{
    id: number
    ticketNumber: string
    title: string
    status: number | null
    statusName: string | null
    source: number | null
    primaryResourceRole: string | null
    lastActivityDate: string | null
    ticketUrl: string | null
    ticketUrlByNumber: string | null
  }>
> {
  let statusLabels = new Map<number, string>()
  try {
    statusLabels = await fetchTicketStatusLabelMap(zoneUrl, {
      ApiIntegrationCode: authHeaders.ApiIntegrationCode,
      UserName: authHeaders.UserName,
      Secret: authHeaders.Secret,
      Accept: "application/json",
    })
  } catch (e) {
    console.warn("[autotask-recent-tickets] status picklist fetch failed:", e)
  }

  const resourceIds: number[] = []
  const roleIds: number[] = []
  for (const t of rows) {
    if (typeof t.assignedResourceID === "number" && Number.isFinite(t.assignedResourceID)) {
      resourceIds.push(t.assignedResourceID)
    }
    if (typeof t.assignedResourceroleID === "number" && Number.isFinite(t.assignedResourceroleID)) {
      roleIds.push(t.assignedResourceroleID)
    }
  }

  let resourceNames = new Map<number, string>()
  let roleNames = new Map<number, string>()
  try {
    const getHeaders = buildAuthHeaders(
      authHeaders.ApiIntegrationCode,
      authHeaders.UserName,
      authHeaders.Secret,
    )
    const [rRows, roRows] = await Promise.all([
      queryByIdIn(zoneUrl, RESOURCES_QUERY_PATH, getHeaders, resourceIds, ["id", "firstName", "lastName", "userName"]),
      queryByIdIn(zoneUrl, ROLES_QUERY_PATH, getHeaders, roleIds, ["id", "name"]),
    ])
    resourceNames = buildResourceNameMap(rRows)
    roleNames = buildRoleNameMap(roRows)
  } catch (e) {
    console.warn("[autotask-recent-tickets] resource/role lookup failed:", e)
  }

  return [...rows]
    .filter((t) => t && typeof t.id === "number")
    .sort((a, b) => parseActivityMs(b) - parseActivityMs(a))
    .map((t) => {
      const statusNum = typeof t.status === "number" ? t.status : null
      const resId = typeof t.assignedResourceID === "number" ? t.assignedResourceID : null
      const roleId = typeof t.assignedResourceroleID === "number" ? t.assignedResourceroleID : null
      const statusName =
        statusNum != null && Number.isFinite(statusNum) ? statusLabels.get(statusNum) ?? null : null
      return {
        id: t.id as number,
        ticketNumber: typeof t.ticketNumber === "string" ? t.ticketNumber : String(t.ticketNumber ?? ""),
        title: typeof t.title === "string" ? t.title : "",
        status: statusNum,
        statusName,
        source: typeof t.source === "number" ? t.source : null,
        primaryResourceRole: formatPrimaryResourceRole(resId, roleId, resourceNames, roleNames),
        lastActivityDate: typeof t.lastActivityDate === "string" ? t.lastActivityDate : null,
        ticketUrl: buildAutotaskTicketUrl(zoneUrl, t.id as number),
        ticketUrlByNumber: buildAutotaskTicketUrlByNumber(
          zoneUrl,
          typeof t.ticketNumber === "string" ? t.ticketNumber : String(t.ticketNumber ?? ""),
        ),
      }
    })
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
    const authHeaders = {
      ApiIntegrationCode: atIntegrationCode,
      UserName: atUserName,
      Secret: atSecret,
    }

    const rows = await queryTicketsForCompany(
      zoneUrl,
      atIntegrationCode,
      atUserName,
      atSecret,
      companyId,
      isoDaysAgoUtc(LAST_ACTIVITY_WINDOW_DAYS),
    )

    const tickets = await enrichAndNormalizeTickets(rows, zoneUrl, authHeaders)
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
