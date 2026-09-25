import { HttpError, cleanText, rateLimit, route } from "../_lib/server.js";
import { isAdminUser, setSession, supabaseAuth } from "../_lib/admin.js";

export default route("POST", async (req, res) => {
  await rateLimit(req, "admin-login", 5, 15 * 60);
  const email = cleanText(req.body?.email, 254, { required: true, label: "Email" });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) throw new HttpError(400, "Password is required.");

  const { ok, data } = await supabaseAuth("token?grant_type=password", { email, password });
  if (!ok) throw new HttpError(401, "Invalid email or password.");
  if (!isAdminUser(data?.user)) {
    await supabaseAuth("logout", {}, data.access_token);
    throw new HttpError(403, "This account does not have Jabor admin access.");
  }

  setSession(req, res, data);
  return res.status(200).json({ email: data.user.email });
});
