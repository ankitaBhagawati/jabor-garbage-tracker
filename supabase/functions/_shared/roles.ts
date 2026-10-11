// Who may call the admin edge functions (jabor-recommendations, jabor-execute, jabor-embed).
// Pure on purpose: no Deno or network imports, so it is tested from node (api/_lib/edge.check.js).

export type StaffProfile = { role?: string | null; is_active?: boolean | null } | null | undefined;

// Only an active super admin. The signed role in the token must say so, and so must the user's
// staff_profiles row. The older role "admin" counts as super admin. A municipality admin, an
// inactive profile, a missing profile and a mismatch between the two are all refused.
export function isActiveSuperAdmin(jwtRole: unknown, profile: StaffProfile): boolean {
  return (jwtRole === "admin" || jwtRole === "super_admin") &&
    profile?.is_active === true && profile?.role === "super_admin";
}
