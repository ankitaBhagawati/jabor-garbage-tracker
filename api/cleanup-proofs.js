import {
  HttpError,
  assertCloudinaryUrl,
  assertProofTicket,
  cloudinaryFolder,
  cleanText,
  rateLimit,
  route,
  serviceRest,
  stepTimer,
} from "./_lib/server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public cleanup-proof reply. Lands as 'pending' until an admin approves it. Turnstile was checked when the
// upload was signed; the ticket from that step stands in for it here (tokens are single-use).
export default route("POST", async (req, res) => {
  const step = stepTimer(res);
  await step("ratelimit", () => rateLimit(req, "cleanup-proofs", 5, 10 * 60));
  const body = req.body && typeof req.body === "object" ? req.body : {};
  assertProofTicket(req, body.proofTicket);

  const reportId = typeof body.report_id === "string" && UUID.test(body.report_id) ? body.report_id : "";
  if (!reportId) throw new HttpError(400, "Invalid report.");
  const imageUrl = assertCloudinaryUrl(body.image_url, cloudinaryFolder("cleanup-proofs"));
  const cleanedDateEstimate = cleanText(body.cleaned_date_estimate, 120, { required: true, label: "Cleaning date" });
  const submittedBy = cleanText(body.submitted_by, 120, { label: "Name" });

  const [report] = await step("report", () => serviceRest(`/rest/v1/reports?id=eq.${reportId}&status=in.(verified,active,in_progress)&is_deleted=not.is.true&select=id&limit=1`));
  if (!report) throw new HttpError(400, "This report is not available for cleanup proof.");

  await step("insert", () => serviceRest("/rest/v1/cleanup_proofs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      report_id: reportId,
      image_url: imageUrl,
      cleaned_date_estimate: cleanedDateEstimate,
      submitted_by: submittedBy || null,
      status: "pending",
    }),
  }));
  return res.status(201).json({ ok: true });
});
