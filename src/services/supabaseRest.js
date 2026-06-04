export const SUPA_URL = import.meta.env.VITE_SUPABASE_URL || "https://uefijiwklnelmwcipwku.supabase.co";
export const SUPA_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlZmlqaXdrbG5lbG13Y2lwd2t1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NjI0MTAsImV4cCI6MjA5NDQzODQxMH0.sI8MQgkyCegNhUrZJT8fvqOWLxi24t8eSPxiJo7t21g";

export const REST_HEADERS = {
  apikey: SUPA_KEY,
  Authorization: `Bearer ${SUPA_KEY}`,
};

export function requestHeaders() {
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
    return res.text().then((body) => {
      throw new Error(`${message}: ${res.status} ${body}`);
    });
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
