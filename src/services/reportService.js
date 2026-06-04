import { encodeFilter, restJson } from "./supabaseRest.js";

const REPORT_SELECT = "*";

async function addCleanupProofData(reports) {
  if (!Array.isArray(reports) || reports.length === 0) return [];
  const reportIds = reports.map(report => report.id).filter(Boolean);
  if (reportIds.length === 0) return reports;

  const params = new URLSearchParams();
  params.set("select", "report_id,image_url,status,created_at,updated_at");
  params.set("report_id", `in.(${reportIds.join(",")})`);
  params.set("status", "in.(pending,approved)");
  params.set("order", "updated_at.desc");

  try {
    const proofs = await restJson(`/rest/v1/cleanup_proofs?${params.toString()}`);
    const proofByReport = new Map();
    for (const proof of Array.isArray(proofs) ? proofs : []) {
      if (!proofByReport.has(proof.report_id)) proofByReport.set(proof.report_id, proof);
    }
    return reports.map(report => {
      const proof = proofByReport.get(report.id);
      return {
        ...report,
        cleanup_proof_status: report.cleanup_proof_status || proof?.status || null,
        cleanup_photo_url: report.cleanup_photo_url || (proof?.status === "approved" ? proof.image_url : null),
      };
    });
  } catch {
    return reports;
  }
}

function applyReportFilters(params, filters = {}) {
  if (filters.place?.trim()) {
    const term = `*${filters.place.trim()}*`;
    params.set("or", `(area.ilike.${term},landmark.ilike.${term},district.ilike.${term},constituency.ilike.${term})`);
  }
  if (filters.wasteType) params.set("waste_type", `eq.${filters.wasteType}`);
  if (filters.startDate) params.set("created_at", `gte.${filters.startDate}`);
  if (filters.endDate) params.append("created_at", `lte.${filters.endDate}`);
}

async function fetchReportsByStatus(status, filters = {}) {
  const params = new URLSearchParams();
  params.set("select", REPORT_SELECT);
  params.set("status", `eq.${status}`);
  params.set("is_deleted", "eq.false");
  params.set("order", status === "cleaned" ? "updated_at.desc" : "created_at.desc");
  applyReportFilters(params, filters);
  return addCleanupProofData(await restJson(`/rest/v1/public_reports?${params.toString()}`));
}

export async function fetchPublicReports(filters = {}) {
  const params = new URLSearchParams();
  params.set("select", REPORT_SELECT);
  params.set("status", "in.(verified,cleaned)");
  params.set("is_deleted", "eq.false");
  params.set("order", "created_at.desc");
  applyReportFilters(params, filters);
  return addCleanupProofData(await restJson(`/rest/v1/public_reports?${params.toString()}`));
}

export function fetchActiveReports(filters = {}) {
  return fetchReportsByStatus("verified", filters);
}

export function fetchCleanedReports(filters = {}) {
  return fetchReportsByStatus("cleaned", filters);
}

export async function fetchAdminReports(status = "") {
  const params = new URLSearchParams();
  params.set("select", REPORT_SELECT);
  params.set("is_deleted", "eq.false");
  if (status) params.set("status", `eq.${status}`);
  params.set("order", status === "cleaned" ? "updated_at.desc" : "created_at.desc");
  return addCleanupProofData(await restJson(`/rest/v1/public_reports?${params.toString()}`));
}

export function hideReport(reportId) {
  return restJson(`/rest/v1/reports?id=eq.${encodeFilter(reportId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      is_deleted: true,
      updated_at: new Date().toISOString(),
    }),
  });
}
