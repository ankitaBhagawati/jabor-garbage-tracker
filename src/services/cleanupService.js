import { adminRestJson, apiJson, restJson } from "./supabaseRest.js";
import { uploadImageToCloudinary, validateUploadImage } from "./cloudinaryService.js";
import { ACTIVE_REPORT_STATUSES } from "./reportService.js";

export async function uploadCleanupProof(reportId, imageFile, cleanedDateEstimate, submittedBy = null, turnstileToken = "") {
  validateUploadImage(imageFile, "Cleanup proof");
  if (!turnstileToken) throw new Error("Please complete the human check.");

  // Cheap check before spending an image upload; /api/cleanup-proofs re-checks server-side.
  const reportParams = new URLSearchParams();
  reportParams.set("select", "id,status");
  reportParams.set("id", `eq.${reportId}`);
  reportParams.set("limit", "1");
  const reports = await restJson(`/rest/v1/public_reports?${reportParams.toString()}`);
  const report = Array.isArray(reports) ? reports[0] : null;
  if (!report || !ACTIVE_REPORT_STATUSES.includes(report.status)) {
    throw new Error("This report is not available for cleanup proof.");
  }

  // Supabase stores only this Cloudinary secure URL; no image bytes go to Supabase Storage.
  const { url: imageUrl, proofTicket } = await uploadImageToCloudinary(imageFile, "cleanup-proofs", turnstileToken);
  return apiJson("/api/cleanup-proofs", {
    body: {
      report_id: reportId,
      image_url: imageUrl,
      cleaned_date_estimate: cleanedDateEstimate,
      submitted_by: submittedBy || null,
      proofTicket,
    },
  });
}

export function fetchPendingCleanupProofs() {
  const params = new URLSearchParams();
  // !inner: for a municipality admin the admin proxy filters on the report's municipality.
  params.set("select", "*,reports!inner(id,photo_url,area,landmark,district,constituency,description,waste_type,mla,mp,created_at,status,municipality_id)");
  params.set("status", "eq.pending");
  params.set("order", "created_at.desc");
  return adminRestJson(`/rest/v1/cleanup_proofs?${params.toString()}`);
}

// Approve (closes the report) or reject, in one database transaction. The proxy replaces p_municipality with a
// municipality admin's own (who must not send it); a super admin sends the report's (null outside every municipality).
export function reviewCleanupProof(proof, decision, note, role) {
  const body = { p_proof: proof.id, p_decision: decision, p_note: note || null };
  if (role === "super_admin") body.p_municipality = proof.reports?.municipality_id ?? null;
  return adminRestJson("/rest/v1/rpc/review_cleanup_proof", { method: "POST", body });
}
