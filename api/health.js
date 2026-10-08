import { SUPABASE_ANON_KEY, SUPABASE_URL, route } from "./_lib/server.js";

// Uptime check: one cheap read of public reference data with the anon key.
// Returns 200 when the database answers, 503 otherwise. No error details leave the server.
export default route("GET", async (_req, res) => {
  try {
    const upstream = await fetch(`${SUPABASE_URL}/rest/v1/mla_list?select=id&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) throw new Error(`Supabase answered ${upstream.status}`);
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("[jabor] health check failed:", e?.message || e);
    return res.status(503).json({ status: "unavailable" });
  }
});
