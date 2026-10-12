// Staff management: validation, the rules for switching an account on or off, and the calls to the Supabase
// Auth admin API. The routes are api/admin/staff.js and api/admin/staff/status.js. Only an active super
// admin gets this far (see requireSuperAdmin). The role of a new account is fixed here, never read from a request.
import { HttpError, SUPABASE_URL, serviceRest } from "./server.js";
import { requireStaff } from "./admin.js";

const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>()[\],;:\\"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export const CREATE_FIELDS = ["email", "municipality_id", "password"];
export const STATUS_FIELDS = ["is_active", "user_id"];
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 72; // Supabase Auth hashes with bcrypt, which reads at most 72 bytes
export const LIMIT_PER_HOUR = 10;

// Only an active super admin, decided from the verified token and a fresh staff_profiles row (requireStaff).
// Anyone else who has a session gets 403; no session is 401, as everywhere in the admin area.
export async function requireSuperAdmin(req, res, routeName) {
  const staff = await requireStaff(req, res);
  if (staff.role !== "super_admin") {
    console.warn(`[jabor] staff route denied: user=${staff.userId} role=${staff.role} route="${routeName}"`);
    throw new HttpError(403, "Not allowed.");
  }
  return staff;
}

// The body must be an object with exactly the allowed keys: anything else (a role, a municipality name, an id) is refused.
function checkKeys(body, allowed) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Bad request.");
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new HttpError(400, `Unknown field: ${key.slice(0, 40)}.`);
  for (const key of allowed) if (!(key in body)) throw new HttpError(400, `${key} is required.`);
}

export function validateCreate(body) {
  checkKeys(body, CREATE_FIELDS);
  if (typeof body.email !== "string") throw new HttpError(400, "Enter a valid email address.");
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (typeof body.password !== "string" || body.password.length < PASSWORD_MIN) throw new HttpError(400, `The password must be at least ${PASSWORD_MIN} characters.`);
  if (new TextEncoder().encode(body.password).length > PASSWORD_MAX) throw new HttpError(400, `The password must be at most ${PASSWORD_MAX} characters.`);
  if (typeof body.municipality_id !== "string" || !UUID.test(body.municipality_id)) throw new HttpError(400, "Choose a municipality.");
  return { email, password: body.password, municipalityId: body.municipality_id.toLowerCase() };
}

export function validateStatus(body) {
  checkKeys(body, STATUS_FIELDS);
  if (typeof body.user_id !== "string" || !UUID.test(body.user_id)) throw new HttpError(400, "Choose an account.");
  if (typeof body.is_active !== "boolean") throw new HttpError(400, "is_active must be true or false.");
  return { userId: body.user_id.toLowerCase(), isActive: body.is_active };
}

// The rules for switching an account. target: its staff_profiles row. activeSuperAdmins: how many active super
// admins there are now. Returns null when the change is allowed, else the error to send.
export function statusChangeError({ actorId, target, isActive, activeSuperAdmins }) {
  if (!target) return new HttpError(404, "That account was not found.");
  if (target.user_id === actorId) return new HttpError(403, "You cannot change your own account.");
  if (target.role !== "municipality_admin") {
    // Super admins are never switched here. If that is ever allowed, the last active one must stay.
    return new HttpError(403, "Only municipality admin accounts can be switched on or off here.");
  }
  if (target.role === "super_admin" && !isActive && target.is_active && activeSuperAdmins <= 1) {
    return new HttpError(409, "The last active super admin cannot be deactivated.");
  }
  return null;
}

// ── Supabase Auth admin API (service role, server only) ─────────────────────
// Errors from these calls carry the status and the Auth error code, never the request body (which holds a password).
async function authAdmin(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, code: body?.error_code || body?.code || "", body };
}

export class EmailTaken extends Error {}

// Creates a confirmed login whose signed role is municipality_admin. Returns the new user's id.
export async function createAuthUser({ email, password, municipalityId }) {
  const result = await authAdmin("/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { role: "municipality_admin", municipality_id: municipalityId } }),
  });
  if (result.ok && typeof result.body?.id === "string" && UUID.test(result.body.id)) return result.body.id;
  if (result.status === 422 && /exists|registered/.test(`${result.code} ${result.body?.msg || ""}`)) throw new EmailTaken();
  throw new Error(`Auth admin could not create the user (status ${result.status}, code ${result.code || "none"}).`);
}

export async function deleteAuthUser(userId) {
  const result = await authAdmin(`/users/${userId}`, { method: "DELETE" });
  return result.ok;
}

// ── Database (service role) ──────────────────────────────────────────────────
export const findMunicipality = async id => (await serviceRest(`/rest/v1/municipalities?id=eq.${id}&select=id,name&limit=1`))?.[0] ?? null;
export const findProfile = async userId => (await serviceRest(`/rest/v1/staff_profiles?user_id=eq.${userId}&select=user_id,email,role,municipality_id,is_active&limit=1`))?.[0] ?? null;
export const countActiveSuperAdmins = async () => (await serviceRest("/rest/v1/staff_profiles?role=eq.super_admin&is_active=eq.true&select=user_id&limit=1000"))?.length ?? 0;

export const insertProfile = ({ userId, email, municipalityId }) => serviceRest("/rest/v1/staff_profiles", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({ user_id: userId, municipality_id: municipalityId, role: "municipality_admin", email, is_active: true }),
});

// Only a municipality admin's row can change here, whatever the id is: the filter says so.
export const setProfileActive = (userId, isActive) => serviceRest(`/rest/v1/staff_profiles?user_id=eq.${userId}&role=eq.municipality_admin`, {
  method: "PATCH",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({ is_active: isActive }),
});

// One audit_log row for a staff action: who did it, to which account, in which municipality. Never a password.
export const writeAudit = ({ actor, action, municipalityId, targetId, from, to }) => serviceRest("/rest/v1/audit_log", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({
    municipality_id: municipalityId, entity_type: "staff_member", entity_id: targetId, actor_id: actor.userId, actor_email: actor.email,
    action, from_value: from ?? null, to_value: to ?? null, note: null,
  }),
});
