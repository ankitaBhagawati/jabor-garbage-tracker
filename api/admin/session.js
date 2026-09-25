import { HttpError, route } from "../_lib/server.js";
import { clearSession, getAdminToken, isAdminUser, supabaseAuth } from "../_lib/admin.js";

export default route("GET", async (req, res) => {
  const token = await getAdminToken(req, res);
  const { ok, data } = await supabaseAuth("user", null, token);
  if (!ok || !isAdminUser(data)) {
    clearSession(req, res);
    throw new HttpError(401, "Admin session expired. Please sign in again.");
  }
  return res.status(200).json({ email: data.email });
});
