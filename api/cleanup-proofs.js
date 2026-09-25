import {
  HttpError,
  assertCloudinaryUrl,
  cleanText,
  rateLimit,
  route,
  serviceRest,
  verifyTurnstile,
} from "./_lib/server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Public cleanup-proof reply. Lands as 'pending' until an admin approves it.
export default route("POST", async (req, res) => {
  await rateLimit(req, "cleanup-proofs", 5, 10 * 60);
  const body = req.body || {};
  await verifyTurnstile(req, body.turnstileToken);

  const reportId = typeof body.report_id === "string" && UUID.test(body.report_id) ? body.report_id : "";
  if (!reportId) throw new HttpError(400, "Invalid report.");
  const imageUrl = assertCloudinaryUrl(body.image_url, "jabor/cleanup-proofs");
  const cleanedDateEstimate = cleanText(body.cleaned_date_estimate, 120, { required: true, label: "Cleaning date" });
  const submittedBy = cleanText(body.submitted_by, 120, { label: "Name" });

  const [report] = await serviceRest(`/rest/v1/reports?id=eq.${reportId}&status=eq.verified&is_deleted=not.is.true&select=id&limit=1`);
  if (!report) throw new HttpError(400, "This report is not available for cleanup proof.");

  await serviceRest("/rest/v1/cleanup_proofs", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      report_id: reportId,
      image_url: imageUrl,
      cleaned_date_estimate: cleanedDateEstimate,
      submitted_by: submittedBy || null,
      status: "pending",
    }),
  });
  return res.status(201).json({ ok: true });
});
