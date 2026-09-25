import { adminRestJson, apiJson, encodeFilter, restJson } from "./supabaseRest.js";
import { uploadImageToCloudinary, validateUploadImage } from "./cloudinaryService.js";

export async function uploadCleanupProof(reportId, imageFile, cleanedDateEstimate, submittedBy = null, turnstileToken = "") {
  validateUploadImage(imageFile, "Cleanup proof");
  if (!turnstileToken) throw new Error("Please complete the human check.");

  // Cheap check before spending an image upload; /api/cleanup-proofs re-checks server-side.
  const reportParams = new URLSearchParams();
  reportParams.set("select", "id,status");
  reportParams.set("id", `eq.${reportId}`);
  reportParams.set("limit", "1");
  const reports = await restJson(`/rest/v1/reports?${reportParams.toString()}`);
  const report = Array.isArray(reports) ? reports[0] : null;
  if (!report || report.status !== "verified") {
    throw new Error("This report is not available for cleanup proof.");
  }

  // Supabase stores only this Cloudinary secure URL; no image bytes go to Supabase Storage.
  const imageUrl = await uploadImageToCloudinary(imageFile, "jabor/cleanup-proofs");
  return apiJson("/api/cleanup-proofs", {
    body: {
      report_id: reportId,
      image_url: imageUrl,
      cleaned_date_estimate: cleanedDateEstimate,
      submitted_by: submittedBy || null,
      turnstileToken,
    },
  });
}

export function fetchPendingCleanupProofs() {
  const params = new URLSearchParams();
  params.set("select", "*,reports(id,photo_url,area,landmark,district,constituency,description,waste_type,mla,mp,created_at,status)");
  params.set("status", "eq.pending");
  params.set("order", "created_at.desc");
  return adminRestJson(`/rest/v1/cleanup_proofs?${params.toString()}`);
}

export async function approveCleanupProof(cleanupProofId, reportId) {
  await adminRestJson(`/rest/v1/cleanup_proofs?id=eq.${encodeFilter(cleanupProofId)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "approved",
      updated_at: new Date().toISOString(),
    },
  });

  return adminRestJson(`/rest/v1/reports?id=eq.${encodeFilter(reportId)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "cleaned",
      updated_at: new Date().toISOString(),
    },
  });
}

export function rejectCleanupProof(cleanupProofId, adminNotes = "") {
  return adminRestJson(`/rest/v1/cleanup_proofs?id=eq.${encodeFilter(cleanupProofId)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      status: "rejected",
      admin_notes: adminNotes,
      updated_at: new Date().toISOString(),
    },
  });
}
