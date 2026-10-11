import { HttpError, SUPABASE_ANON_KEY, SUPABASE_URL } from "./server.js";

// Who is calling, decided on the server. The token is verified by Supabase Auth, then the caller's
// own staff_profiles row is read with the caller's own token (RLS lets staff read only their own
// row, and only while it is active). Nothing is cached: deactivating a profile takes effect on the
// very next request. A role or municipality sent by the browser is never read.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// user: Supabase Auth user. profile: that user's staff_profiles row (with its municipality), or null.
// The token's signed role and the profile must agree. The older role "admin" counts as super_admin.
export function deriveStaff(user, profile) {
  if (!user?.id || !profile || profile.user_id !== user.id || profile.is_active !== true) return null;
  const meta = user.app_metadata || {};
  const base = { userId: user.id, email: user.email || "" };
  if ((meta.role === "admin" || meta.role === "super_admin") && profile.role === "super_admin") {
    return { ...base, role: "super_admin", municipalityId: null, municipality: null };
  }
  if (
    meta.role === "municipality_admin" && profile.role === "municipality_admin" &&
    UUID.test(profile.municipality_id || "") && profile.municipality_id === meta.municipality_id
  ) {
    return {
      ...base, role: "municipality_admin", municipalityId: profile.municipality_id,
      municipality: { name: profile.municipalities?.name || "", slug: profile.municipalities?.slug || "" },
    };
  }
  return null;
}

// Verifies the access token and loads the staff member. Throws 401 (not signed in) or 403 (not staff).
export async function resolveStaff(token, { fetchImpl = fetch } = {}) {
  const authRes = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  const user = authRes.ok ? await authRes.json().catch(() => null) : null;
  if (!user?.id || !UUID.test(user.id)) throw new HttpError(401, "Admin session expired. Please sign in again.");

  const profileRes = await fetchImpl(
    `${SUPABASE_URL}/rest/v1/staff_profiles?select=user_id,role,municipality_id,is_active,municipalities(name,slug)&user_id=eq.${user.id}&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  const rows = profileRes.ok ? await profileRes.json().catch(() => null) : null;
  const staff = deriveStaff(user, Array.isArray(rows) ? rows[0] : null);
  if (!staff) throw new HttpError(403, "This account does not have Jabor admin access.");
  return { ...staff, token };
}

// What the browser may know about itself: who, which role, which municipality.
export const sessionBody = staff => ({ email: staff.email, role: staff.role, municipality: staff.municipality });
