import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

type AnalyticsAction = "summary" | "byUser" | "recentCalls" | "liveSeries";

type RequestBody = {
  action?: AnalyticsAction;
  timezoneOffsetMinutes?: number;
  startIso?: string | null;
  endIso?: string | null;
  fromDayKey?: string;
  toDayKey?: string;
  page?: number;
  perPage?: number;
  windowMinutes?: number;
};

function json(status: number, body: unknown, cors = true) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cors) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Headers"] = "authorization, x-client-info, apikey, content-type";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function requireAdmin(
  supabaseAdmin: ReturnType<typeof createClient>,
  req: Request,
): Promise<string> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) throw new Error("missing_auth");

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) throw new Error("invalid_auth");
  const userId = data.user.id;

  const { data: profile, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();

  if (pErr) throw pErr;
  if (!profile?.is_admin) throw new Error("not_admin");
  return userId;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Match browser local calendar day for an instant; `tzOffsetMinutes` = `new Date().getTimezoneOffset()`. */
function localDayKeyFromIso(iso: string, tzOffsetMinutes: number): string {
  const utcMs = new Date(iso).getTime();
  if (Number.isNaN(utcMs)) return "";
  const shifted = utcMs - tzOffsetMinutes * 60 * 1000;
  const d = new Date(shifted);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

function enumerateDayKeys(fromKey: string, toKey: string): string[] {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return [];
  const out: string[] = [];
  const cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  const maxDays = 800;
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < maxDays) {
    const y = cur.getUTCFullYear();
    const m = cur.getUTCMonth() + 1;
    const da = cur.getUTCDate();
    out.push(`${y}-${pad2(m)}-${pad2(da)}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return out;
}

type CallRow = {
  call_time: string;
  user_id: string;
  organization: string | null;
};

async function fetchCallsInRange(
  supabase: ReturnType<typeof createClient>,
  startIso: string | null,
  endIso: string | null,
  columns: string,
): Promise<CallRow[]> {
  const all: CallRow[] = [];
  const pageSize = 1000;
  let from = 0;
  const maxRows = 200_000;
  while (true) {
    let q = supabase.from("calls").select(columns).order("call_time", { ascending: true });
    if (startIso) q = q.gte("call_time", startIso);
    if (endIso) q = q.lte("call_time", endIso);
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as CallRow[];
    all.push(...batch);
    if (all.length > maxRows) {
      throw new Error("range_too_large");
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function loadProfileLabels(
  supabase: ReturnType<typeof createClient>,
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", chunk);
    if (error) throw error;
    for (const r of data ?? []) {
      const id = r.id as string;
      const name = ((r.full_name as string | null) ?? "").trim();
      map.set(id, name || id.slice(0, 8));
    }
  }
  for (const id of userIds) {
    if (!map.has(id)) map.set(id, id.slice(0, 8));
  }
  return map;
}

Deno.serve(async (req: Request) => {
  const cors = true;
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, cors);

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceKey) {
      return json(500, { ok: false, error: "missing_env" }, cors);
    }

    const supabaseAdmin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
      await requireAdmin(supabaseAdmin, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "missing_auth" || msg === "invalid_auth") {
        return json(401, { ok: false, error: "unauthorized" }, cors);
      }
      if (msg === "not_admin") return json(403, { ok: false, error: "forbidden" }, cors);
      throw e;
    }

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json(400, { ok: false, error: "invalid_json" }, cors);
    }

    const action = body.action;
    if (!action) return json(400, { ok: false, error: "missing_action" }, cors);

    const tz = typeof body.timezoneOffsetMinutes === "number" && Number.isFinite(body.timezoneOffsetMinutes)
      ? body.timezoneOffsetMinutes
      : 0;

    const startIso = body.startIso ?? null;
    const endIso = body.endIso ?? null;

    if (action === "liveSeries") {
      const windowMinutes = Math.min(1440, Math.max(5, Math.floor(body.windowMinutes ?? 60)));
      const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
      const { data, error } = await supabaseAdmin
        .from("calls")
        .select("call_time")
        .gte("call_time", since)
        .order("call_time", { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      const bucketMs = 60 * 1000;
      const now = Date.now();
      const n = windowMinutes;
      const startBucket = Math.floor((now - n * bucketMs) / bucketMs) * bucketMs;
      const counts = new Array<number>(n).fill(0);
      for (const r of rows) {
        const t = new Date((r as { call_time: string }).call_time).getTime();
        if (Number.isNaN(t)) continue;
        const idx = Math.floor((t - startBucket) / bucketMs);
        if (idx >= 0 && idx < n) counts[idx] += 1;
      }
      const labels: string[] = [];
      for (let i = 0; i < n; i++) {
        const d = new Date(startBucket + i * bucketMs);
        labels.push(`${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`);
      }
      return json(200, {
        ok: true,
        windowMinutes,
        labelsUtc: labels,
        counts,
        generatedAt: new Date().toISOString(),
      }, cors);
    }

    if (action === "recentCalls") {
      const page = Math.max(1, Math.floor(body.page ?? 1));
      const perPage = Math.min(100, Math.max(1, Math.floor(body.perPage ?? 25)));
      const from = (page - 1) * perPage;
      const to = from + perPage - 1;

      let q = supabaseAdmin
        .from("calls")
        .select("id, call_time, user_id, organization, device_name, support_request", { count: "exact" })
        .order("call_time", { ascending: false });
      if (startIso) q = q.gte("call_time", startIso);
      if (endIso) q = q.lte("call_time", endIso);

      const { data, error, count } = await q.range(from, to);
      if (error) throw error;
      const rows = data ?? [];
      const userIds = [...new Set(rows.map((r) => (r as { user_id: string }).user_id).filter(Boolean))];
      const labels = await loadProfileLabels(supabaseAdmin, userIds);

      const calls = rows.map((r) => {
        const row = r as {
          id: string;
          call_time: string;
          user_id: string;
          organization: string | null;
          device_name: string | null;
          support_request: string | null;
        };
        return {
          id: row.id,
          call_time: row.call_time,
          user_id: row.user_id,
          user_label: labels.get(row.user_id) ?? row.user_id.slice(0, 8),
          organization: row.organization,
          device_name: row.device_name,
          support_request: row.support_request,
        };
      });

      return json(200, {
        ok: true,
        calls,
        page,
        perPage,
        total: count ?? calls.length,
      }, cors);
    }

    // summary + byUser need full scan of range
    const columns = "call_time, user_id, organization";
    const rows = await fetchCallsInRange(supabaseAdmin, startIso, endIso, columns);

    if (action === "byUser") {
      const byUser = new Map<string, { count: number; lastCall: string }>();
      for (const r of rows) {
        const uid = r.user_id;
        if (!uid) continue;
        const prev = byUser.get(uid) || { count: 0, lastCall: "" };
        prev.count += 1;
        if (!prev.lastCall || r.call_time > prev.lastCall) prev.lastCall = r.call_time;
        byUser.set(uid, prev);
      }
      const userIds = [...byUser.keys()];
      const labels = await loadProfileLabels(supabaseAdmin, userIds);
      const list = userIds.map((id) => ({
        user_id: id,
        user_label: labels.get(id) ?? id.slice(0, 8),
        call_count: byUser.get(id)!.count,
        last_call_time: byUser.get(id)!.lastCall,
      })).sort((a, b) => b.call_count - a.call_count);

      return json(200, { ok: true, users: list }, cors);
    }

    if (action === "summary") {
      let fromDayKey = (body.fromDayKey ?? "").trim();
      let toDayKey = (body.toDayKey ?? "").trim();

      const perDay = new Map<string, number>();
      const perUserDay = new Map<string, Map<string, number>>();
      const orgCounts = new Map<string, number>();
      const userSet = new Set<string>();
      let minTs = "";
      let maxTs = "";

      for (const r of rows) {
        const dk = localDayKeyFromIso(r.call_time, tz);
        if (!dk) continue;
        perDay.set(dk, (perDay.get(dk) || 0) + 1);
        const uid = r.user_id;
        if (uid) {
          userSet.add(uid);
          let m = perUserDay.get(uid);
          if (!m) {
            m = new Map();
            perUserDay.set(uid, m);
          }
          m.set(dk, (m.get(dk) || 0) + 1);
        }
        const org = (r.organization || "").trim() || "(Unknown)";
        orgCounts.set(org, (orgCounts.get(org) || 0) + 1);
        if (!minTs || r.call_time < minTs) minTs = r.call_time;
        if (!maxTs || r.call_time > maxTs) maxTs = r.call_time;
      }

      if (!fromDayKey && minTs) fromDayKey = localDayKeyFromIso(minTs, tz);
      if (!toDayKey && maxTs) toDayKey = localDayKeyFromIso(maxTs, tz);
      if (!fromDayKey) fromDayKey = toDayKey || new Date().toISOString().slice(0, 10);
      if (!toDayKey) toDayKey = fromDayKey;

      const dayKeys = enumerateDayKeys(fromDayKey, toDayKey);
      const dailyTimeseries = dayKeys.map((day) => ({ day, calls: perDay.get(day) || 0 }));

      const topUsers = [...perUserDay.entries()]
        .map(([uid, m]) => ({ user_id: uid, total: [...m.values()].reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8)
        .map((x) => x.user_id);

      const userLabels = await loadProfileLabels(supabaseAdmin, topUsers);

      const perUserSeries = topUsers.map((uid) => ({
        user_id: uid,
        title: userLabels.get(uid) ?? uid.slice(0, 8),
        x: dayKeys,
        y: dayKeys.map((d) => perUserDay.get(uid)?.get(d) ?? 0),
      }));

      const total = rows.length;
      const topOrgs = [...orgCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count], i) => ({
          rank: i + 1,
          name,
          count,
          pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        }));

      const rangeDaysInclusive = dayKeys.length || 1;
      const avgPerDay = total > 0 ? Math.round((total / rangeDaysInclusive) * 10) / 10 : 0;

      return json(200, {
        ok: true,
        total,
        unique_users: userSet.size,
        unique_orgs: orgCounts.size,
        first_call: minTs || null,
        last_call: maxTs || null,
        avg_per_day: avgPerDay,
        daily_timeseries: dailyTimeseries,
        per_user_series: perUserSeries,
        top_orgs: topOrgs,
        from_day_key: fromDayKey,
        to_day_key: toDayKey,
      }, cors);
    }

    return json(400, { ok: false, error: "unknown_action" }, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("admin-analytics error:", message);
    if (message === "range_too_large") {
      return json(413, { ok: false, error: "range_too_large", detail: "Too many calls in range" }, true);
    }
    return json(500, { ok: false, error: "server_error", detail: message }, true);
  }
});
