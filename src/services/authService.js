import { apiJson } from "./supabaseRest.js";

// Admin tokens live in HttpOnly cookies set by /api/admin/*; nothing is stored in the page.
// Drop any token left in localStorage by the old client-side login.
try { localStorage.removeItem("jabor_supabase_session"); } catch { /* storage blocked */ }

export async function checkAdminSession() {
  try {
    return await apiJson("/api/admin/session", { method: "GET" });
  } catch {
    return null;
  }
}

export function signInAdmin(email, password) {
  return apiJson("/api/admin/login", { body: { email, password } });
}

export async function signOutAdmin() {
  await apiJson("/api/admin/logout").catch(() => {});
}
