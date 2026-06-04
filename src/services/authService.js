import { SUPA_KEY, SUPA_URL } from "./supabaseRest.js";

const SESSION_KEY = "jabor_supabase_session";

function saveSession(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export function getStoredSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    saveSession(null);
    return null;
  }
}

export function getAccessToken() {
  return getStoredSession()?.access_token || "";
}

export function isAdminSession(session = getStoredSession()) {
  const expiresAt = Number(session?.expires_at || 0);
  return session?.user?.app_metadata?.role === "admin" && expiresAt * 1000 > Date.now();
}

export async function signInAdmin(email, password) {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.msg || data?.error_description || "Could not sign in.");
  if (!isAdminSession(data)) {
    saveSession(null);
    throw new Error("This account does not have Jabor admin access.");
  }
  saveSession(data);
  return data;
}

export async function signOutAdmin() {
  const token = getAccessToken();
  saveSession(null);
  if (!token) return;
  await fetch(`${SUPA_URL}/auth/v1/logout`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${token}` },
  });
}
