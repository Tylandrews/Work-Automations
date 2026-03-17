import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

type PeriodType = "weekly" | "monthly";
type Scope = "team" | "user";

type ReportRow = {
  period_type: PeriodType;
  period_start: string; // YYYY-MM-DD
  period_end: string; // YYYY-MM-DD
  scope: Scope;
  user_id: string | null;
  metrics: Record<string, unknown>;
  generated_at: string;
};

function toIsoDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

function isLastDayOfMonthUTC(d: Date): boolean {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return next.getUTCMonth() !== d.getUTCMonth();
}

function lastFridayOnOrBeforeUTC(day: Date): Date {
  const d = startOfUtcDay(day);
  const dow = d.getUTCDay(); // 0=Sun..5=Fri
  const delta = (dow - 5 + 7) % 7;
  return addUtcDays(d, -delta);
}

function monthPeriodForUTC(day: Date): { start: Date; end: Date } {
  const d = startOfUtcDay(day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  // end = last day of this month
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start, end: startOfUtcDay(end) };
}

function previousMonthPeriodForUTC(day: Date): { start: Date; end: Date } {
  const d = startOfUtcDay(day);
  const prevMonthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  const prevMonthStart = new Date(Date.UTC(prevMonthEnd.getUTCFullYear(), prevMonthEnd.getUTCMonth(), 1));
  return { start: prevMonthStart, end: startOfUtcDay(prevMonthEnd) };
}

function weeklyPeriodEndingFridayUTC(friday: Date): { start: Date; end: Date } {
  const end = startOfUtcDay(friday);
  const start = addUtcDays(end, -6);
  return { start, end };
}

function buildTimeseries(start: Date, end: Date, countsByDay: Map<string, number>) {
  const out: Array<{ day: string; calls: number }> = [];
  let d = startOfUtcDay(start);
  const last = startOfUtcDay(end);
  while (d.getTime() <= last.getTime()) {
    const key = toIsoDateUTC(d);
    out.push({ day: key, calls: countsByDay.get(key) ?? 0 });
    d = addUtcDays(d, 1);
  }
  return out;
}

function normalizeOrgKey(org: unknown): string {
  const s = String(org ?? "").trim();
  return s.length ? s : "Unknown";
}

function computeMetricsForCalls(
  calls: Array<{ user_id: string; organization: string; call_time: string }>,
  periodStart: Date,
  periodEnd: Date,
  includePerUserCounts: boolean,
) {
  const perOrg = new Map<string, number>();
  const perUser = new Map<string, number>();
  const orgSet = new Set<string>();
  const countsByDay = new Map<string, number>();

  for (const c of calls) {
    const org = normalizeOrgKey(c.organization);
    perOrg.set(org, (perOrg.get(org) ?? 0) + 1);
    orgSet.add(org);
    if (includePerUserCounts) {
      perUser.set(c.user_id, (perUser.get(c.user_id) ?? 0) + 1);
    }

    const dt = new Date(c.call_time);
    if (!Number.isNaN(dt.getTime())) {
      const dayKey = toIsoDateUTC(startOfUtcDay(dt));
      countsByDay.set(dayKey, (countsByDay.get(dayKey) ?? 0) + 1);
    }
  }

  const per_org_counts: Record<string, number> = {};
  for (const [k, v] of perOrg.entries()) per_org_counts[k] = v;

  const metrics: Record<string, unknown> = {
    calls_total: calls.length,
    orgs_unique: orgSet.size,
    per_org_counts,
    daily_timeseries: buildTimeseries(periodStart, periodEnd, countsByDay),
  };

  if (includePerUserCounts) {
    const per_user_counts: Record<string, number> = {};
    for (const [k, v] of perUser.entries()) per_user_counts[k] = v;
    metrics.per_user_counts = per_user_counts;
  }

  return metrics;
}

async function reportExists(
  supabaseAdmin: ReturnType<typeof createClient>,
  periodType: PeriodType,
  periodStart: string,
  scope: Scope,
  userId: string | null,
): Promise<boolean> {
  let q = supabaseAdmin
    .from("call_reports")
    .select("id", { count: "exact", head: true })
    .eq("period_type", periodType)
    .eq("period_start", periodStart)
    .eq("scope", scope);

  q = userId ? q.eq("user_id", userId) : q.is("user_id", null);
  const { count, error } = await q;
  if (error) throw error;
  return (count ?? 0) > 0;
}

async function upsertReport(
  supabaseAdmin: ReturnType<typeof createClient>,
  row: ReportRow,
) {
  const { error } = await supabaseAdmin.from("call_reports").upsert(row, {
    onConflict: "period_type,period_start,scope,user_id",
  });
  if (error) throw error;
}

async function fetchCallsInRange(
  supabaseAdmin: ReturnType<typeof createClient>,
  startInclusive: Date,
  endInclusive: Date,
) {
  const startIso = startOfUtcDay(startInclusive).toISOString();
  const endExclusiveIso = addUtcDays(startOfUtcDay(endInclusive), 1).toISOString();

  const { data, error } = await supabaseAdmin
    .from("calls")
    .select("user_id, organization, call_time")
    .gte("call_time", startIso)
    .lt("call_time", endExclusiveIso);

  if (error) throw error;
  const rows = (data ?? []) as Array<{ user_id: string; organization: string; call_time: string }>;
  return rows.filter((r) => !!r.user_id && !!r.call_time);
}

async function generateForPeriod(
  supabaseAdmin: ReturnType<typeof createClient>,
  periodType: PeriodType,
  start: Date,
  end: Date,
) {
  const period_start = toIsoDateUTC(start);
  const period_end = toIsoDateUTC(end);

  // If the team report exists we assume the period was already processed.
  const already = await reportExists(supabaseAdmin, periodType, period_start, "team", null);
  if (already) return { period_start, period_end, skipped: true };

  const calls = await fetchCallsInRange(supabaseAdmin, start, end);
  const now = new Date().toISOString();

  // Team report
  const teamMetrics = computeMetricsForCalls(calls, start, end, true);
  await upsertReport(supabaseAdmin, {
    period_type: periodType,
    period_start,
    period_end,
    scope: "team",
    user_id: null,
    metrics: teamMetrics,
    generated_at: now,
  });

  // Per-user reports
  const callsByUser = new Map<string, Array<{ user_id: string; organization: string; call_time: string }>>();
  for (const c of calls) {
    const arr = callsByUser.get(c.user_id) ?? [];
    arr.push(c);
    callsByUser.set(c.user_id, arr);
  }

  for (const [userId, userCalls] of callsByUser.entries()) {
    const userMetrics = computeMetricsForCalls(userCalls, start, end, false);
    await upsertReport(supabaseAdmin, {
      period_type: periodType,
      period_start,
      period_end,
      scope: "user",
      user_id: userId,
      metrics: userMetrics,
      generated_at: now,
    });
  }

  return { period_start, period_end, skipped: false, users: callsByUser.size };
}

function candidateMonthlyPeriodUTC(today: Date) {
  return isLastDayOfMonthUTC(today) ? monthPeriodForUTC(today) : previousMonthPeriodForUTC(today);
}

function candidateWeeklyPeriodUTC(today: Date) {
  const friday = lastFridayOnOrBeforeUTC(today);
  return weeklyPeriodEndingFridayUTC(friday);
}

async function generateBackfill(
  supabaseAdmin: ReturnType<typeof createClient>,
  today: Date,
) {
  const results: Record<string, unknown> = { weekly: [], monthly: [] };

  // Weekly: try up to 8 Fridays back until we hit an existing team report.
  let wEnd = candidateWeeklyPeriodUTC(today).end;
  for (let i = 0; i < 8; i++) {
    const { start, end } = weeklyPeriodEndingFridayUTC(wEnd);
    const periodStart = toIsoDateUTC(start);
    const exists = await reportExists(supabaseAdmin, "weekly", periodStart, "team", null);
    if (exists) break;
    const r = await generateForPeriod(supabaseAdmin, "weekly", start, end);
    (results.weekly as Array<unknown>).push(r);
    wEnd = addUtcDays(wEnd, -7);
  }

  // Monthly: try up to 3 months back until we hit an existing team report.
  let { start: mStart, end: mEnd } = candidateMonthlyPeriodUTC(today);
  for (let i = 0; i < 3; i++) {
    const periodStart = toIsoDateUTC(mStart);
    const exists = await reportExists(supabaseAdmin, "monthly", periodStart, "team", null);
    if (exists) break;
    const r = await generateForPeriod(supabaseAdmin, "monthly", mStart, mEnd);
    (results.monthly as Array<unknown>).push(r);
    ({ start: mStart, end: mEnd } = previousMonthPeriodForUTC(mStart));
  }

  return results;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceKey) {
      return new Response(
        JSON.stringify({
          error: "Missing env",
          detail: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const supabaseAdmin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const today = new Date();
    const results = await generateBackfill(supabaseAdmin, today);

    return new Response(JSON.stringify({ ok: true, generated: results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

