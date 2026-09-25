import { readCookies, route } from "../_lib/server.js";
import { clearSession, supabaseAuth } from "../_lib/admin.js";

export default route("POST", async (req, res) => {
  const token = readCookies(req).jabor_at;
  // Revokes the refresh token server-side too, not just the cookies.
  if (token) await supabaseAuth("logout", {}, token).catch(() => {});
  clearSession(req, res);
  return res.status(200).json({ ok: true });
});
