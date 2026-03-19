import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

// Type definitions for Datto RMM API responses
type DattoOrganization = {
  id: string;
  name: string;
  // Add other fields as needed based on Datto API documentation
  [key: string]: unknown;
};

type DattoApiResponse = {
  data?: DattoOrganization[];
  error?: {
    message: string;
    code?: string;
  };
  // Datto API may have different response structure - adjust based on actual API
  [key: string]: unknown;
};

// Rate limiting: Datto allows 600 requests per 60 seconds
// We'll implement simple in-memory rate limiting per function instance
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 50; // Conservative limit per minute per function instance
const RATE_LIMIT_WINDOW_MS = 60000; // 60 seconds

function checkRateLimit(): boolean {
  const now = Date.now();
  const key = "global";
  const current = rateLimitMap.get(key);

  if (!current || now > current.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (current.count >= RATE_LIMIT_MAX) {
    return false;
  }

  current.count++;
  return true;
}

async function searchDattoOrganizations(
  query: string,
  limit: number,
  apiKey: string,
  baseUrl: string,
  tenantId?: string,
): Promise<DattoOrganization[]> {
  // Construct the Datto API endpoint
  // Note: The exact endpoint needs to be verified from Datto RMM API documentation
  // Common patterns: /api/v2/organizations, /api/v2/companies, /api/v2/sites
  const endpoint = tenantId
    ? `${baseUrl}/api/v2/organizations?tenantId=${tenantId}&name=${encodeURIComponent(query)}&limit=${limit}`
    : `${baseUrl}/api/v2/organizations?name=${encodeURIComponent(query)}&limit=${limit}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Datto RMM may require additional headers - adjust based on API docs
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let errorMessage = `Datto API error: ${response.status} ${response.statusText}`;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.message || errorJson.error || errorMessage;
    } catch {
      // Use default error message
    }
    throw new Error(errorMessage);
  }

  const data: DattoApiResponse = await response.json();

  // Handle different possible response structures
  if (data.error) {
    throw new Error(data.error.message || "Datto API returned an error");
  }

  // Extract organizations from response
  // Adjust based on actual Datto API response structure
  if (Array.isArray(data.data)) {
    return data.data;
  }
  if (Array.isArray(data)) {
    return data;
  }
  if (data.results && Array.isArray(data.results)) {
    return data.results;
  }

  return [];
}

Deno.serve(async (req: Request) => {
  try {
    // Only allow GET requests
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check rate limiting
    if (!checkRateLimit()) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Get Supabase environment variables
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("Missing Supabase environment variables");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Get Datto API credentials from environment secrets
    const dattoApiKey = Deno.env.get("DATTO_API_KEY");
    const dattoBaseUrl = Deno.env.get("DATTO_BASE_URL");
    const dattoTenantId = Deno.env.get("DATTO_TENANT_ID");

    if (!dattoApiKey || !dattoBaseUrl) {
      console.error("Missing Datto API credentials in environment secrets");
      return new Response(
        JSON.stringify({ error: "Datto API not configured" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Authenticate the request using Supabase JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized. Please log in." }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify the JWT token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session. Please log in again." }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Parse query parameters
    const url = new URL(req.url);
    const searchQuery = url.searchParams.get("q") || "";
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20;

    // Validate search query
    if (!searchQuery || searchQuery.trim().length < 2) {
      return new Response(
        JSON.stringify({ error: "Search query must be at least 2 characters" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Search Datto organizations
    const organizations = await searchDattoOrganizations(
      searchQuery.trim(),
      limit,
      dattoApiKey,
      dattoBaseUrl,
      dattoTenantId,
    );

    // Return filtered results (only include safe fields, never expose API key)
    const safeResults = organizations.map((org) => ({
      id: org.id,
      name: org.name,
      // Add other safe fields as needed, but never include sensitive data
    }));

    return new Response(JSON.stringify({ organizations: safeResults }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=300", // Cache for 5 minutes
      },
    });
  } catch (err) {
    // Log error server-side (never expose sensitive details to client)
    const errorMessage = err instanceof Error ? err.message : "Internal server error";
    console.error("Datto search error:", errorMessage);

    // Return generic error to client (don't expose API details)
    return new Response(
      JSON.stringify({
        error: "Failed to search organizations. Please try again.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});
