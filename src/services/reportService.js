import { encodeFilter, restJson } from "./supabaseRest.js";

const REPORT_SELECT = [
  "id",
  "constituency",
  "district",
  "lok_sabha_seat",
  "mla",
  "mla_party",
  "mp",
  "mp_party",
  "area",
  "landmark",
  "waste_type",
  "description",
  "photo_url",
  "lat",
  "lng",
  "status",
  "assigned_to",
  "rejected_at",
  "is_deleted",
  "created_at",
  "updated_at",
  "tweeted_at",
  "emailed_at",
].join(",");

const ACTIVE_REPORT_STATUSES = ["verified", "pending", "active", "reported", "open"];
const PUBLIC_REPORT_STATUSES = [...ACTIVE_REPORT_STATUSES, "cleaned"];

function statusFilter(statuses) {
  return `in.(${statuses.join(",")})`;
}

function normalizeReports(reports) {
  const normalized = (Array.isArray(reports) ? reports : []).map(report => ({
    ...report,
    // Report images have one canonical field throughout the app.
    photo_url: report.photo_url || null,
    status: ACTIVE_REPORT_STATUSES.includes(report.status) ? "verified" : report.status,
  }));

  if (import.meta.env.DEV) {
    console.debug("[Jabor] fetched reports", normalized);
    normalized.forEach(report => {
      console.debug(`[Jabor] report ${report.id || "unknown"} photo_url`, report.photo_url);
    });
  }

  return normalized;
}

async function addCleanupProofData(reports) {
  const normalizedReports = normalizeReports(reports);
  if (normalizedReports.length === 0) return [];
  const reportIds = normalizedReports.map(report => report.id).filter(Boolean);
  if (reportIds.length === 0) return normalizedReports;

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
    return normalizedReports.map(report => {
      const proof = proofByReport.get(report.id);
      return {
        ...report,
        cleanup_proof_status: report.cleanup_proof_status || proof?.status || null,
        cleanup_photo_url: report.cleanup_photo_url || (proof?.status === "approved" ? proof.image_url : null),
      };
    });
  } catch {
    return normalizedReports;
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

async function fetchReportsByStatus(statuses, filters = {}) {
  const params = new URLSearchParams();
  params.set("select", REPORT_SELECT);
  params.set("status", statusFilter(statuses));
  params.set("is_deleted", "eq.false");
  params.set("order", statuses.includes("cleaned") ? "updated_at.desc" : "created_at.desc");
  applyReportFilters(params, filters);
  return addCleanupProofData(await restJson(`/rest/v1/reports?${params.toString()}`));
}

export async function fetchPublicReports(filters = {}) {
  const params = new URLSearchParams();
  params.set("select", REPORT_SELECT);
  params.set("status", statusFilter(PUBLIC_REPORT_STATUSES));
  params.set("is_deleted", "eq.false");
  params.set("order", "created_at.desc");
  applyReportFilters(params, filters);
  return addCleanupProofData(await restJson(`/rest/v1/reports?${params.toString()}`));
}

export function fetchActiveReports(filters = {}) {
  return fetchReportsByStatus(ACTIVE_REPORT_STATUSES, filters);
}

export function fetchCleanedReports(filters = {}) {
  return fetchReportsByStatus(["cleaned"], filters);
}

export async function fetchAdminReports(status = "") {
  const params = new URLSearchParams();
  params.set("select", REPORT_SELECT);
  params.set("is_deleted", "eq.false");
  if (status) {
    params.set("status", status === "verified"
      ? statusFilter(ACTIVE_REPORT_STATUSES)
      : `eq.${status}`);
  }
  params.set("order", status === "cleaned" ? "updated_at.desc" : "created_at.desc");
  return addCleanupProofData(await restJson(`/rest/v1/reports?${params.toString()}`));
}

export function hideReport(reportId) {
  return restJson(`/rest/v1/reports?id=eq.${encodeFilter(reportId)}`, {
    method: "PATCH",
    // Once is_deleted becomes true, public report SELECT policies intentionally
    // hide the row. Do not ask PostgREST to return a row that is no longer readable.
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      is_deleted: true,
      updated_at: new Date().toISOString(),
    }),
  });
}
