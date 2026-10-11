// Shared helpers for Jabor agent edge functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isActiveSuperAdmin } from "./roles.ts";

import { corsHeaders } from "./cors.ts";

export { corsHeaders };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export interface AdminContext {
  admin: { id: string; email: string | null };
  service: SupabaseClient;
}

// Verifies the caller is an active Jabor super admin and returns a service-role client for
// privileged DB work. Throws a Response on failure (caller returns it). These functions act across
// all municipalities with the service role, so a municipality admin is always refused (403).
// The older JWT role "admin" counts as super admin; either way the user's staff_profiles row must
// say super_admin and be active, so deactivating a profile ends access on the next call.
export async function requireSuperAdmin(req: Request): Promise<AdminContext> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    throw json({ error: "Server is not configured." }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw json({ error: "Missing Authorization token." }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) throw json({ error: "Invalid session." }, 401);

  const role = (data.user.app_metadata as Record<string, unknown> | undefined)
    ?.role;
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: profile } = await service
    .from("staff_profiles")
    .select("role, is_active")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!isActiveSuperAdmin(role, profile)) {
    throw json({ error: "Super admin access required." }, 403);
  }

  return {
    admin: { id: data.user.id, email: data.user.email ?? null },
    service,
  };
}

// gte-small embedding (384 dims) using the Supabase edge AI runtime.
export async function embedText(text: string): Promise<number[]> {
  // deno-lint-ignore no-explicit-any
  const session = new (globalThis as any).Supabase.ai.Session("gte-small");
  const output = await session.run(text, { mean_pool: true, normalize: true });
  return Array.from(output as number[]);
}
