// Admin session kept in HttpOnly cookies so page scripts (and any XSS) can't read the tokens.
import { HttpError, SUPABASE_ANON_KEY, SUPABASE_URL, cookie, readCookies } from "./server.js";

const ACCESS = "jabor_at";
const REFRESH = "jabor_rt";
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;

export async function supabaseAuth(path, body, token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

export const isAdminUser = user => user?.app_metadata?.role === "admin";

export function setSession(req, res, session) {
  // Access cookie expires a minute early so we refresh before Supabase rejects it.
  const accessMaxAge = Math.max(Number(session.expires_in || 3600) - 60, 60);
  res.setHeader("Set-Cookie", [
    cookie(req, ACCESS, session.access_token, accessMaxAge),
    cookie(req, REFRESH, session.refresh_token, REFRESH_MAX_AGE),
  ]);
}

export function clearSession(req, res) {
  res.setHeader("Set-Cookie", [cookie(req, ACCESS, "", 0), cookie(req, REFRESH, "", 0)]);
}

// Returns a live admin access token, refreshing it from the refresh cookie when needed.
export async function getAdminToken(req, res) {
  const cookies = readCookies(req);
  if (cookies[ACCESS]) return cookies[ACCESS];
  if (cookies[REFRESH]) {
    const { ok, data } = await supabaseAuth("token?grant_type=refresh_token", { refresh_token: cookies[REFRESH] });
    if (ok && isAdminUser(data?.user)) {
      setSession(req, res, data);
      return data.access_token;
    }
  }
  clearSession(req, res);
  throw new HttpError(401, "Admin session expired. Please sign in again.");
}
