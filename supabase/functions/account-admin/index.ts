import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type User } from "@supabase/supabase-js";

type AdminAction = "list" | "invite" | "setAdmin" | "setBanned" | "deleteUser";

type RequestBody = {
  action?: AdminAction;
  page?: number;
  perPage?: number;
  email?: string;
  redirectTo?: string;
  userId?: string;
  is_admin?: boolean;
  banned?: boolean;
};

type DirectoryUser = {
  id: string;
  email: string | null;
  full_name: string | null;
  is_admin: boolean;
  banned: boolean;
  last_sign_in_at: string | null;
  created_at: string | null;
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

function userBanned(u: User): boolean {
  const until = (u as { banned_until?: string | null }).banned_until;
  if (!until) return false;
  const t = new Date(until).getTime();
  if (Number.isNaN(t)) return false;
  return t > Date.now();
}

async function countAdmins(supabaseAdmin: ReturnType<typeof createClient>): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("is_admin", true);
  if (error) throw error;
  return count ?? 0;
}

async function assertCanDemoteAdmin(
  supabaseAdmin: ReturnType<typeof createClient>,
  targetUserId: string,
  newIsAdmin: boolean,
) {
  if (newIsAdmin !== false) return;
  const { data: target, error: e1 } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", targetUserId)
    .single();
  if (e1) throw e1;
  if (!target?.is_admin) return;
  const n = await countAdmins(supabaseAdmin);
  if (n <= 1) throw new Error("last_admin");
}

async function assertCanDeleteAdminUser(
  supabaseAdmin: ReturnType<typeof createClient>,
  targetUserId: string,
) {
  const { data: target, error: e1 } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", targetUserId)
    .single();
  if (e1 && e1.code !== "PGRST116") throw e1;
  if (!target?.is_admin) return;
  const n = await countAdmins(supabaseAdmin);
  if (n <= 1) throw new Error("last_admin");
}

function mapUserToDirectoryRow(
  u: User,
  profilesById: Map<string, { full_name: string | null; is_admin: boolean }>,
): DirectoryUser {
  const p = profilesById.get(u.id);
  return {
    id: u.id,
    email: u.email ?? null,
    full_name: p?.full_name ?? null,
    is_admin: !!p?.is_admin,
    banned: userBanned(u),
    last_sign_in_at: u.last_sign_in_at ?? null,
    created_at: u.created_at ?? null,
  };
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

    let actorId: string;
    try {
      actorId = await requireAdmin(supabaseAdmin, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "missing_auth" || msg === "invalid_auth") return json(401, { ok: false, error: "unauthorized" }, cors);
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

    if (action === "list") {
      const page = Math.max(1, Math.floor(body.page ?? 1));
      const perPage = Math.min(200, Math.max(1, Math.floor(body.perPage ?? 50)));
      const { data: listData, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });
      if (listErr) throw listErr;
      const users = listData?.users ?? [];
      const ids = users.map((u) => u.id);
      const profilesById = new Map<string, { full_name: string | null; is_admin: boolean }>();
      if (ids.length > 0) {
        const { data: rows, error: pErr } = await supabaseAdmin
          .from("profiles")
          .select("id, full_name, is_admin")
          .in("id", ids);
        if (pErr) throw pErr;
        for (const r of rows ?? []) {
          profilesById.set(r.id as string, {
            full_name: (r.full_name as string | null) ?? null,
            is_admin: !!(r as { is_admin?: boolean }).is_admin,
          });
        }
      }
      const directoryUsers: DirectoryUser[] = users.map((u) => mapUserToDirectoryRow(u, profilesById));
      return json(200, {
        ok: true,
        users: directoryUsers,
        page,
        perPage,
        total: listData?.total ?? directoryUsers.length,
      }, cors);
    }

    if (action === "invite") {
      const email = (body.email ?? "").trim().toLowerCase();
      if (!email) return json(400, { ok: false, error: "missing_email" }, cors);
      const redirectTo = (body.redirectTo ?? "").trim() || undefined;
      const { data: inviteData, error: invErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(
        email,
        redirectTo ? { redirectTo } : {},
      );
      if (invErr) throw invErr;
      const uid = inviteData?.user?.id;
      if (uid) {
        const local = email.split("@")[0] || "User";
        await supabaseAdmin.from("profiles").upsert(
          {
            id: uid,
            full_name: local,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "id" },
        );
      }
      return json(200, { ok: true, userId: uid ?? null }, cors);
    }

    if (action === "setAdmin") {
      const userId = (body.userId ?? "").trim();
      if (!userId) return json(400, { ok: false, error: "missing_user_id" }, cors);
      if (typeof body.is_admin !== "boolean") {
        return json(400, { ok: false, error: "missing_is_admin" }, cors);
      }
      try {
        await assertCanDemoteAdmin(supabaseAdmin, userId, body.is_admin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "last_admin") return json(400, { ok: false, error: "last_admin" }, cors);
        throw e;
      }
      const iso = new Date().toISOString();
      const { data: updatedRows, error: upErr } = await supabaseAdmin
        .from("profiles")
        .update({ is_admin: body.is_admin, updated_at: iso })
        .eq("id", userId)
        .select("id");
      if (upErr) throw upErr;
      if (!updatedRows?.length) {
        const { data: authData, error: getErr } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (getErr) throw getErr;
        const name = authData?.user?.email?.split("@")[0] || "User";
        const { error: insErr } = await supabaseAdmin.from("profiles").insert({
          id: userId,
          full_name: name,
          is_admin: body.is_admin,
          updated_at: iso,
        });
        if (insErr) throw insErr;
      }
      return json(200, { ok: true }, cors);
    }

    if (action === "setBanned") {
      const userId = (body.userId ?? "").trim();
      if (!userId) return json(400, { ok: false, error: "missing_user_id" }, cors);
      if (typeof body.banned !== "boolean") {
        return json(400, { ok: false, error: "missing_banned" }, cors);
      }
      if (userId === actorId) return json(400, { ok: false, error: "cannot_self_ban" }, cors);
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: body.banned ? "876000h" : "none",
      });
      if (banErr) throw banErr;
      return json(200, { ok: true }, cors);
    }

    if (action === "deleteUser") {
      const userId = (body.userId ?? "").trim();
      if (!userId) return json(400, { ok: false, error: "missing_user_id" }, cors);
      if (userId === actorId) return json(400, { ok: false, error: "cannot_self_delete" }, cors);
      try {
        await assertCanDeleteAdminUser(supabaseAdmin, userId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "last_admin") return json(400, { ok: false, error: "last_admin" }, cors);
        throw e;
      }
      await supabaseAdmin.from("profiles").delete().eq("id", userId);
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (delErr) throw delErr;
      return json(200, { ok: true }, cors);
    }

    return json(400, { ok: false, error: "unknown_action" }, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("account-admin error:", message);
    return json(500, { ok: false, error: "server_error", detail: message }, cors);
  }
});
