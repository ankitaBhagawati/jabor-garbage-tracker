export const SUPA_URL = import.meta.env.VITE_SUPABASE_URL || "";
export const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

export function assertSupabaseConfig() {
  if (!SUPA_URL || !SUPA_KEY) {
    throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
}

export const REST_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
};

export function requestHeaders() {
  assertSupabaseConfig();
  let accessToken = "";
  try {
    const session = JSON.parse(localStorage.getItem("jabor_supabase_session") || "null");
    accessToken = Number(session?.expires_at || 0) * 1000 > Date.now() ? session?.access_token || "" : "";
    if (!accessToken && session) localStorage.removeItem("jabor_supabase_session");
  } catch {
    accessToken = "";
  }
  return {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${accessToken || SUPA_KEY}`,
  };
}

export function assertOk(res, message) {
  if (!res.ok) {
    throw new Error(`${message}: ${res.status}`);
  }
  return res;
}

export function encodeFilter(value) {
  return encodeURIComponent(value);
}

export async function restJson(path, options = {}) {
  const res = await fetch(`${SUPA_URL}${path}`, {
    ...options,
    headers: {
      ...requestHeaders(),
      ...(options.headers || {}),
    },
  });
  await assertOk(res, `Supabase request failed for ${path}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
