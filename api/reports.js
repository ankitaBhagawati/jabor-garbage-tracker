import crypto from "node:crypto";
import {
  HttpError,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  assertCloudinaryUrl,
  cleanText,
  rateLimit,
  route,
  serviceRest,
  verifyTurnstile,
} from "./_lib/server.js";

const WASTE_TYPES = new Set(["mixed", "plastic", "construction", "organic", "water", "medical"]);
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 254;

// Public report submission. The anon role no longer has INSERT on reports,
// so this is the only way in: rate limit → human check → validate → service insert.
export default route("POST", async (req, res) => {
  await rateLimit(req, "reports", 5, 10 * 60);
  const body = req.body || {};
  await verifyTurnstile(req, body.turnstileToken);

  const constituency = cleanText(body.constituency, 120, { required: true, label: "Constituency" });
  const area = cleanText(body.area, 200, { required: true, label: "Area" });
  const landmark = cleanText(body.landmark, 200, { label: "Landmark" });
  const description = cleanText(body.description, 1000, { label: "Description" });
  const wasteType = WASTE_TYPES.has(body.waste_type) ? body.waste_type : "mixed";
  const photoUrl = assertCloudinaryUrl(body.photo_url, "jabor/reports");
  const email = cleanText(body.email, 254, { label: "Email" });
  const name = cleanText(body.name, 120, { label: "Name" });
  if (email && !isEmail(email)) throw new HttpError(400, "Please enter a valid email.");

  // Representatives come from our own tables, never from the client.
  const [mla] = await serviceRest(`/rest/v1/mla_list?constituency=eq.${encodeURIComponent(constituency)}&select=name,party,district,lok_sabha_seat&limit=1`);
  if (!mla) throw new HttpError(400, "Unknown constituency.");
  const [mp] = mla.lok_sabha_seat
    ? await serviceRest(`/rest/v1/mp_list?lok_sabha_seat=eq.${encodeURIComponent(mla.lok_sabha_seat)}&select=name,party&limit=1`)
    : [];

  const report = {
    id: crypto.randomUUID(),
    status: "verified",
    district: mla.district || cleanText(body.district, 120, { required: true, label: "District" }),
    constituency,
    lok_sabha_seat: mla.lok_sabha_seat || "",
    mla: mla.name || "Unknown",
    mla_party: mla.party || "Unknown",
    mp: mp?.name || "Unknown",
    mp_party: mp?.party || "Unknown",
    area,
    landmark,
    waste_type: wasteType,
    description,
    photo_url: photoUrl,
    lat: null,
    lng: null,
  };
  await serviceRest("/rest/v1/reports", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(report) });

  if (email) await notifyReporter({ report_id: report.id, name, email, area, waste_type: wasteType, district: report.district, constituency });

  return res.status(201).json({ report });
});

// Best-effort: stores the contact and sends the confirmation email. Never fails the submission.
async function notifyReporter(payload) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/jabor-notify`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        "x-jabor-notify-secret": process.env.NOTIFY_SHARED_SECRET || "",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("jabor-notify failed", e);
  }
}
