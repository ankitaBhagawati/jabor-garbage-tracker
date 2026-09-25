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

export function assertOk(res, message) {
  if (!res.ok) {
    throw new Error(`${message}: ${res.status}`);
  }
  return res;
}

export function encodeFilter(value) {
  return encodeURIComponent(value);
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Public, read-only Supabase calls with the anon key.
export async function restJson(path, options = {}) {
  assertSupabaseConfig();
  const res = await fetch(`${SUPA_URL}${path}`, {
    ...options,
    headers: {
      ...REST_HEADERS,
      ...(options.headers || {}),
    },
  });
  await assertOk(res, `Supabase request failed for ${path}`);
  if (res.status === 204) return null;
  return parseJson(res);
}

// Our own /api endpoints (public writes + admin session).
export async function apiJson(path, { method = "POST", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await parseJson(res);
  if (!res.ok) {
    const error = new Error(data?.error || data?.message || `Request failed (${res.status}).`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// Admin Supabase calls go through /api/admin/rest, which attaches the HttpOnly session cookie.
export function adminRestJson(path, { method = "GET", prefer, body } = {}) {
  return apiJson("/api/admin/rest", { body: { path, method, prefer, body } });
}
