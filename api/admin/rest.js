import { HttpError, SUPABASE_ANON_KEY, SUPABASE_URL, route } from "../_lib/server.js";
import { requireStaff } from "../_lib/admin.js";
import { Denied, authorize } from "../_lib/access.js";

// Forwards admin calls to Supabase with the token from the HttpOnly cookie, but only what the caller's
// role may do (api/_lib/access.js). The role comes from the verified token and the caller's own
// staff_profiles row, looked up on every request. RLS and the edge functions still decide again.
const BODY_KEYS = new Set(["path", "method", "prefer", "body"]);

export default route("POST", async (req, res) => {
  const staff = await requireStaff(req, res);

  // The request body is the proxy's own envelope; any other key (a role, a municipality) is refused.
  const envelope = req.body;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) || Object.keys(envelope).some(k => !BODY_KEYS.has(k))) {
    throw new HttpError(400, "Bad request.");
  }
  const { path, method = "GET", prefer, body } = envelope;
  if (typeof method !== "string" || (prefer != null && typeof prefer !== "string")) throw new HttpError(400, "Bad request.");

  let plan;
  try {
    plan = authorize(staff, { path, method, prefer, body });
  } catch (error) {
    if (!(error instanceof Denied)) throw error;
    // Who, which role, which route and why: never the query or the body.
    const where = typeof path === "string" ? `${method} ${path.split("?")[0].slice(0, 60)}` : "unknown";
    console.warn(`[jabor] admin proxy denied: user=${staff.userId} role=${staff.role} route="${where}" reason=${error.reason}`);
    throw new HttpError(403, "Not allowed.");
  }

  const upstream = await fetch(`${SUPABASE_URL}${plan.path}`, {
    method: plan.method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${staff.token}`,
      "Content-Type": "application/json",
      ...(plan.prefer ? { Prefer: plan.prefer } : {}),
    },
    body: plan.body,
  });

  let text = await upstream.text();
  if (!upstream.ok && plan.path.startsWith("/rest/")) {
    // Database errors keep their code and message (the status rules write friendly ones) but not the details or hints.
    try {
      const { code, message } = JSON.parse(text);
      text = JSON.stringify({ code, message });
    } catch {
      text = JSON.stringify({ message: "Request failed." });
    }
  }
  res.status(upstream.status);
  res.setHeader("Content-Type", "application/json");
  const range = upstream.headers.get("content-range");
  if (range) res.setHeader("Content-Range", range);
  return res.end(text);
});
