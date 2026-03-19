import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

type AutotaskCompany = {
  id: number;
  companyName: string;
  isActive?: boolean;
};

type ZoneInfoResponse = {
  url?: string;
};

const CACHE_TTL_HOURS = 24 * 30; // Cache companies for 1 month (30 days)

function json(status: number, body: unknown, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}

// In-memory cache per function instance (best-effort)
let cachedZoneUrl: string | null = null;
let cachedZoneUrlFetchedAt = 0;
const ZONE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getZoneUrl(userName: string, integrationCode: string): Promise<string> {
  const now = Date.now();
  if (cachedZoneUrl && now - cachedZoneUrlFetchedAt < ZONE_CACHE_TTL_MS) return cachedZoneUrl;

  // Autotask zone lookup endpoint (public)
  // Returns the correct webservicesXX.autotask.net base URL for the tenant.
  const zoneLookup = `https://webservices.autotask.net/ATServicesRest/V1.0/zoneInformation?user=${encodeURIComponent(userName)}`;
  const res = await fetch(zoneLookup, {
    method: "GET",
    headers: {
      ApiIntegrationCode: integrationCode,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`zone_lookup_failed:${res.status}:${t}`);
  }

  const data = (await res.json()) as ZoneInfoResponse;
  let url = String(data?.url || "").trim();
  if (!url) throw new Error("zone_lookup_missing_url");

  // Ensure URL has protocol and no trailing slash
  url = url.replace(/\/+$/, "");
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  cachedZoneUrl = url;
  cachedZoneUrlFetchedAt = now;
  return cachedZoneUrl;
}

function buildAuthHeaders(integrationCode: string, userName: string, secret: string) {
  // Autotask REST uses these headers for auth
  return {
    ApiIntegrationCode: integrationCode,
    UserName: userName,
    Secret: secret,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function queryCompaniesFromCache(
  supabaseAdmin: ReturnType<typeof createClient>,
  query: string,
  limit: number,
): Promise<Array<{ id: string; name: string }> | null> {
  // Check cache for companies matching the query (case-insensitive, contains)
  const { data, error } = await supabaseAdmin
    .from("cached_autotask_companies")
    .select("autotask_id, company_name, cached_at")
    .ilike("company_name", `%${query}%`)
    .gte("cached_at", new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString())
    .order("company_name", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[autotask] Cache read error:", error.message);
    return null; // Fall back to API
  }

  if (!data || data.length === 0) return null; // Cache miss

  // Return cached results
  return data.map((c) => ({
    id: c.autotask_id,
    name: c.company_name,
  }));
}

async function updateCache(
  supabaseAdmin: ReturnType<typeof createClient>,
  companies: Array<{ id: string; name: string }>,
): Promise<void> {
  if (companies.length === 0) return;

  // Upsert companies into cache (update if exists, insert if new)
  const cacheEntries = companies.map((c) => ({
    autotask_id: c.id,
    company_name: c.name,
    cached_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin
    .from("cached_autotask_companies")
    .upsert(cacheEntries, {
      onConflict: "autotask_id",
      ignoreDuplicates: false,
    });

  if (error) {
    console.error("[autotask] Cache write error:", error.message);
    // Don't throw - cache write failure shouldn't break the API response
  }
}

async function queryCompaniesFromAPI(
  zoneUrl: string,
  integrationCode: string,
  userName: string,
  secret: string,
  query: string,
  limit: number,
): Promise<Array<{ id: string; name: string }>> {
  // Use the query endpoint for partial name matches. Autotask query language supports beginsWith/contains.
  // We'll do "contains" so the UX feels like search-as-you-type.
  const endpoint = `${zoneUrl}/ATServicesRest/V1.0/Companies/query`;

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
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: buildAuthHeaders(integrationCode, userName, secret),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // Log endpoint for debugging (safe - no secrets)
    console.error(`[autotask] Query failed at: ${endpoint.substring(0, 60)}...`);
    throw new Error(`companies_query_failed:${res.status}:${t.substring(0, 300)}`);
  }

  const data = await res.json();
  const items = (data?.items || data?.Items || []) as AutotaskCompany[];
  if (!Array.isArray(items)) return [];

  return items
    .filter((c) => c && typeof c.id === "number" && typeof c.companyName === "string")
    .slice(0, limit)
    .map((c) => ({ id: String(c.id), name: c.companyName }));
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "GET") return json(405, { error: "Method not allowed" });

    // Require Supabase auth (JWT) from the Electron client.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) return json(401, { error: "Unauthorized. Please log in." });

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(500, { error: "Server configuration error" });

    // Autotask secrets (server-side only)
    const atIntegrationCode = (Deno.env.get("AUTOTASK_INTEGRATION_CODE") ?? "").trim();
    const atUserName = (Deno.env.get("AUTOTASK_USERNAME") ?? "").trim();
    const atSecret = (Deno.env.get("AUTOTASK_SECRET") ?? "").trim();
    const atZoneOverride = (Deno.env.get("AUTOTASK_ZONE_URL") ?? "").trim(); // optional

    if (!atIntegrationCode || !atUserName || !atSecret) {
      return json(503, { error: "Autotask API not configured" });
    }

    // Validate the JWT against Supabase Auth using the project's anon key.
    // This avoids relying on service role secrets and matches how the client is authenticated.
    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await supabaseAuth.auth.getUser();
    if (error || !data?.user?.id) return json(401, { error: "Invalid or expired session. Please log in again." });

    // Create admin client for cache operations (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20;
    if (q.length < 2) return json(400, { error: "Search query must be at least 2 characters" });

    // Try cache first (fast path)
    let companies = await queryCompaniesFromCache(supabaseAdmin, q, limit);

    // If cache miss or stale, fetch from Autotask API
    if (!companies || companies.length === 0) {
      let zoneUrl = atZoneOverride ? atZoneOverride.replace(/\/+$/, "") : await getZoneUrl(atUserName, atIntegrationCode);
      
      // Convert web interface URL (ww6.autotask.net) to webservices URL (webservices6.autotask.net)
      if (zoneUrl.includes("ww6.autotask.net")) {
        zoneUrl = zoneUrl.replace("ww6.autotask.net", "webservices6.autotask.net");
      }
      
      // Ensure URL has protocol and no trailing slash
      if (!zoneUrl.startsWith("http://") && !zoneUrl.startsWith("https://")) {
        zoneUrl = `https://${zoneUrl}`;
      }
      zoneUrl = zoneUrl.replace(/\/+$/, "");
      
      companies = await queryCompaniesFromAPI(zoneUrl, atIntegrationCode, atUserName, atSecret, q, limit);
      
      // Update cache asynchronously (don't wait for it)
      updateCache(supabaseAdmin, companies).catch((err) => {
        console.error("[autotask] Cache update failed:", err.message);
      });
    }

    // Cache client-side allowed; key never included
    return json(200, { organizations: companies }, { "Cache-Control": "private, max-age=300" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log server-side only; never include secrets
    console.error("Autotask search error:", msg);
    // Return error details (safe - no secrets) for debugging
    const safeError = msg.includes("zone_lookup") || msg.includes("companies_query") 
      ? msg 
      : "Internal error";
    return json(500, { error: "Failed to search organizations. Please try again.", details: safeError });
  }
});

