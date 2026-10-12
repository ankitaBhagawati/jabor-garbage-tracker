import { HttpError, route, strictRateLimit } from "../../_lib/server.js";
import {
  LIMIT_PER_HOUR, countActiveSuperAdmins, findProfile, requireSuperAdmin, setProfileActive, statusChangeError, validateStatus, writeAudit,
} from "../../_lib/staffAdmin.js";

// POST /api/admin/staff/status  { user_id, is_active }: switch a municipality admin's account on or off.
// Super admin only. Takes effect on the very next request: every admin request reads the caller's own active
// profile (api/_lib/staff.js), nothing is cached. You cannot switch yourself, and only municipality admins can be switched.
export default route("POST", async (req, res) => {
  const actor = await requireSuperAdmin(req, res, "POST /api/admin/staff/status");
  await strictRateLimit(actor.userId, "staff-status", LIMIT_PER_HOUR, 3600);
  const { userId, isActive } = validateStatus(req.body);

  const target = await findProfile(userId);
  const problem = statusChangeError({ actorId: actor.userId, target, isActive, activeSuperAdmins: target?.role === "super_admin" ? await countActiveSuperAdmins() : 0 });
  if (problem) throw problem;
  if (target.is_active === isActive) return res.status(200).json({ user_id: userId, is_active: isActive, changed: false });

  const changed = await setProfileActive(userId, isActive);
  if (!Array.isArray(changed) || changed.length !== 1) throw new HttpError(409, "The account could not be changed.");
  try {
    await writeAudit({
      actor, action: isActive ? "staff_account_activated" : "staff_account_deactivated", municipalityId: target.municipality_id, targetId: userId,
      from: { is_active: target.is_active }, to: { email: target.email, role: target.role, municipality_id: target.municipality_id, is_active: isActive },
    });
  } catch (error) {
    await setProfileActive(userId, target.is_active).catch(() => {}); // no change without its audit row
    throw error;
  }
  return res.status(200).json({ user_id: userId, is_active: isActive, changed: true });
});
