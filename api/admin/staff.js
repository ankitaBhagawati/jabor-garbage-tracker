import { HttpError, SUPABASE_ANON_KEY, SUPABASE_URL, route, strictRateLimit } from "../_lib/server.js";
import {
  EmailTaken, LIMIT_PER_HOUR, createAuthUser, deleteAuthUser, findMunicipality, insertProfile, requireSuperAdmin, validateCreate, writeAudit,
} from "../_lib/staffAdmin.js";

// GET  /api/admin/staff   the staff list.
// POST /api/admin/staff   create a municipality admin: { email, password, municipality_id }.
// Super admin only. The role of the new account is always municipality_admin; the request cannot say otherwise.

const list = route("GET", async (req, res) => {
  const staff = await requireSuperAdmin(req, res, "GET /api/admin/staff");
  // Read with the caller's own token: row level security shows a super admin every row.
  const upstream = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_profiles?select=user_id,email,role,municipality_id,is_active,created_at,municipalities(name)&order=created_at.desc&limit=500`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${staff.token}` } },
  );
  if (!upstream.ok) throw new Error(`staff list read failed (status ${upstream.status})`);
  const rows = await upstream.json();
  return res.status(200).json(rows.map(r => ({
    user_id: r.user_id, email: r.email, role: r.role, municipality_id: r.municipality_id,
    municipality_name: r.municipalities?.name ?? null, is_active: r.is_active, created_at: r.created_at,
  })));
});

const create = route("POST", async (req, res) => {
  const actor = await requireSuperAdmin(req, res, "POST /api/admin/staff");
  await strictRateLimit(actor.userId, "staff-create", LIMIT_PER_HOUR, 3600);
  const { email, password, municipalityId } = validateCreate(req.body);
  const municipality = await findMunicipality(municipalityId);
  if (!municipality) throw new HttpError(400, "That municipality does not exist.");

  // 1. the login. If the email is taken, nothing is changed.
  let userId;
  try {
    userId = await createAuthUser({ email, password, municipalityId });
  } catch (error) {
    if (error instanceof EmailTaken) throw new HttpError(409, "An account with this email already exists. Nothing was changed.");
    throw error;
  }

  // 2. the profile and the audit row. If either fails, the login is removed again, so no orphan login remains.
  try {
    await insertProfile({ userId, email, municipalityId });
    await writeAudit({
      actor, action: "staff_account_created", municipalityId, targetId: userId,
      to: { email, role: "municipality_admin", municipality_id: municipalityId, municipality_name: municipality.name, is_active: true },
    });
  } catch (error) {
    const removed = await deleteAuthUser(userId).catch(() => false); // the profile goes with it (on delete cascade)
    if (!removed) console.error(`[jabor] staff create failed and the new login ${userId} could not be removed: remove it by hand`);
    throw error;
  }

  return res.status(201).json({ user_id: userId, email, role: "municipality_admin", municipality_id: municipalityId, municipality_name: municipality.name, is_active: true });
});

export default function handler(req, res) {
  if (req.method === "GET") return list(req, res);
  return create(req, res); // route() answers 405 for any other method
}
