// Shared helpers for Jabor agent edge functions.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

// Verifies the caller is a signed-in Jabor admin and returns a service-role
// client for privileged DB work. Throws a Response on failure (caller returns it).
export async function requireAdmin(req: Request): Promise<AdminContext> {
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
  if (role !== "admin") {
    throw json({ error: "Admin access required." }, 403);
  }

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

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
