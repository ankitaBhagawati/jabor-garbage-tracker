import { encodeFilter, restJson } from "./supabaseRest.js";
import { uploadImageToCloudinary } from "./cloudinaryService.js";

export async function uploadCleanupProof(reportId, imageFile, cleanedDateEstimate, submittedBy = null) {
  if (!imageFile) throw new Error("Cleanup proof image is required.");
  if (!imageFile.type?.startsWith("image/")) throw new Error("Cleanup proof must be an image.");

  const existingParams = new URLSearchParams();
  existingParams.set("select", "id,status");
  existingParams.set("report_id", `eq.${reportId}`);
  existingParams.set("status", "in.(pending,approved)");
  existingParams.set("limit", "1");
  const existingProofs = await restJson(`/rest/v1/cleanup_proofs?${existingParams.toString()}`);
  if (Array.isArray(existingProofs) && existingProofs.length > 0) {
    throw new Error(existingProofs[0].status === "approved"
      ? "This report already has an approved cleanup proof."
      : "A cleanup proof is already waiting for admin verification.");
  }

  // Supabase stores only this Cloudinary secure URL; no image bytes go to Supabase Storage.
  const imageUrl = await uploadImageToCloudinary(imageFile, "jabor/cleanup-proofs");
  return restJson("/rest/v1/cleanup_proofs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      report_id: reportId,
      image_url: imageUrl,
      cleaned_date_estimate: cleanedDateEstimate,
      submitted_by: submittedBy || null,
      status: "pending",
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
