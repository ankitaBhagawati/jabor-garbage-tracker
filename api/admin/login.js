import { HttpError, cleanText, rateLimit, route } from "../_lib/server.js";
import { isAdminUser, setSession, supabaseAuth } from "../_lib/admin.js";

export default route("POST", async (req, res) => {
  await rateLimit(req, "admin-login", 5, 15 * 60);
  const email = cleanText(req.body?.email, 254, { required: true, label: "Email" });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) throw new HttpError(400, "Password is required.");

  const { ok, data } = await supabaseAuth("token?grant_type=password", { email, password });
  if (!ok) {
    // Only a real credential mismatch gets the generic message; config problems
    // (e.g. email provider disabled) surface as-is so they aren't mistaken for a bad password.
    if (data?.error_code === "invalid_credentials") throw new HttpError(401, "Invalid email or password.");
    console.error("[jabor] admin login refused by Supabase:", data?.error_code, data?.msg);
    throw new HttpError(401, `Sign-in unavailable: ${data?.msg || "authentication error"}.`);
  }
  if (!isAdminUser(data?.user)) {
    await supabaseAuth("logout", {}, data.access_token);
    throw new HttpError(403, "This account does not have Jabor admin access.");
  }

  setSession(req, res, data);
  return res.status(200).json({ email: data.user.email });
});
