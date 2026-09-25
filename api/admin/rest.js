import { HttpError, SUPABASE_ANON_KEY, SUPABASE_URL, route } from "../_lib/server.js";
import { getAdminToken } from "../_lib/admin.js";

// Forwards admin calls to Supabase with the token from the HttpOnly cookie.
// Grants nothing extra: RLS and the edge functions' requireAdmin still decide access.
const ALLOWED_PATH = /^\/(rest\/v1\/[a-z_]+(\?[^#]*)?|functions\/v1\/jabor-(recommendations|execute|embed))$/;
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

export default route("POST", async (req, res) => {
  const { path, method = "GET", prefer, body } = req.body || {};
  if (typeof path !== "string" || !ALLOWED_PATH.test(path)) throw new HttpError(400, "Path not allowed.");
  if (!ALLOWED_METHODS.has(method)) throw new HttpError(400, "Method not allowed.");

  const token = await getAdminToken(req, res);
  const upstream = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(typeof prefer === "string" ? { Prefer: prefer } : {}),
    },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("Content-Type", "application/json");
  return res.end(text);
});
