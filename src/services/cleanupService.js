import { encodeFilter, restJson } from "./supabaseRest.js";
import { uploadImageToCloudinary } from "./cloudinaryService.js";

export async function uploadCleanupProof(reportId, imageFile, cleanedDateEstimate, submittedBy = null) {
  if (!imageFile) throw new Error("Cleanup proof image is required.");
  if (!imageFile.type?.startsWith("image/")) throw new Error("Cleanup proof must be an image.");

  const reportParams = new URLSearchParams();
  reportParams.set("select", "id,status,cleanup_proof_status");
  reportParams.set("id", `eq.${reportId}`);
  reportParams.set("limit", "1");
  const reports = await restJson(`/rest/v1/public_reports?${reportParams.toString()}`);
  const report = Array.isArray(reports) ? reports[0] : null;
  if (!report || report.status !== "verified") {
    throw new Error("This report is not available for cleanup proof.");
  }
  if (report.cleanup_proof_status === "pending" || report.cleanup_proof_status === "approved") {
    throw new Error(report.cleanup_proof_status === "approved"
      ? "This report already has an approved cleanup proof."
      : "A cleanup proof is already waiting for admin verification.");
  }

  // Supabase stores only this Cloudinary secure URL; no image bytes go to Supabase Storage.
  const imageUrl = await uploadImageToCloudinary(imageFile, "jabor/cleanup-proofs");
  return restJson("/rest/v1/cleanup_proofs", {
    method: "POST",
    // Pending proofs are not publicly readable, so avoid requiring SELECT RLS
    // permission just to complete a valid public insert.
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      report_id: reportId,
      image_url: imageUrl,
      cleaned_date_estimate: cleanedDateEstimate,
      submitted_by: submittedBy || null,
    }),
  });
}

export function fetchPendingCleanupProofs() {
  const params = new URLSearchParams();
  params.set("select", "*,reports(id,photo_url,area,landmark,district,constituency,description,waste_type,mla,mp,created_at,status)");
  params.set("status", "eq.pending");
  params.set("order", "created_at.desc");
  return restJson(`/rest/v1/cleanup_proofs?${params.toString()}`);
}

export async function approveCleanupProof(cleanupProofId, reportId) {
  await restJson(`/rest/v1/cleanup_proofs?id=eq.${encodeFilter(cleanupProofId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      status: "approved",
      updated_at: new Date().toISOString(),
    }),
  });

  return restJson(`/rest/v1/reports?id=eq.${encodeFilter(reportId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      status: "cleaned",
      updated_at: new Date().toISOString(),
    }),
  });
}

export function rejectCleanupProof(cleanupProofId, adminNotes = "") {
  return restJson(`/rest/v1/cleanup_proofs?id=eq.${encodeFilter(cleanupProofId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      status: "rejected",
      admin_notes: adminNotes,
      updated_at: new Date().toISOString(),
    }),
  });
}
