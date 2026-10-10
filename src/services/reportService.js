import { adminRestJson, encodeFilter, restJson } from "./supabaseRest.js";

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

// Columns of the public_reports view, the only thing the public pages read. The view already
// leaves out hidden and invalid reports and every admin-only column.
const PUBLIC_REPORT_SELECT = [
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
  "cleanup_photo_url",
  "status",
  "created_at",
  "updated_at",
].join(",");

// The view reports 'active' or 'cleaned'. The older names are kept so the same query also works
// against the previous view and the admin's base-table reads.
export const ACTIVE_REPORT_STATUSES = ["verified", "pending", "active", "reported", "open"];
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

// Admin-only: attach reporter contact (name/email) from report_contacts.
// RLS returns rows only for the admin token; anonymous reports have none.
async function addContactData(reports) {
  const reportIds = reports.map(report => report.id).filter(Boolean);
  if (reportIds.length === 0) return reports;
  const params = new URLSearchParams();
  params.set("select", "report_id,name,email");
  params.set("report_id", `in.(${reportIds.join(",")})`);
  try {
    const contacts = await adminRestJson(`/rest/v1/report_contacts?${params.toString()}`);
    const byReport = new Map();
    for (const c of Array.isArray(contacts) ? contacts : []) byReport.set(c.report_id, c);
    return reports.map(report => {
      const c = byReport.get(report.id);
      return { ...report, reporter_name: c?.name || null, reporter_email: c?.email || null };
    });
  } catch {
    return reports;
  }
}

async function addCleanupProofData(reports, request = restJson) {
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
    const proofs = await request(`/rest/v1/cleanup_proofs?${params.toString()}`);
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
  params.set("select", PUBLIC_REPORT_SELECT);
  params.set("status", statusFilter(statuses));
  params.set("order", statuses.includes("cleaned") ? "updated_at.desc" : "created_at.desc");
  applyReportFilters(params, filters);
  return addCleanupProofData(await restJson(`/rest/v1/public_reports?${params.toString()}`));
}

export async function fetchPublicReports(filters = {}) {
  const params = new URLSearchParams();
  params.set("select", PUBLIC_REPORT_SELECT);
  params.set("status", statusFilter(PUBLIC_REPORT_STATUSES));
  params.set("order", "created_at.desc");
  applyReportFilters(params, filters);
  return addCleanupProofData(await restJson(`/rest/v1/public_reports?${params.toString()}`));
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
  const reports = await addCleanupProofData(await adminRestJson(`/rest/v1/reports?${params.toString()}`), adminRestJson);
  return addContactData(reports);
}

export function hideReport(reportId) {
  return adminRestJson(`/rest/v1/reports?id=eq.${encodeFilter(reportId)}`, {
    method: "PATCH",
    // Once is_deleted becomes true, public report SELECT policies intentionally
    // hide the row. Do not ask PostgREST to return a row that is no longer readable.
    prefer: "return=minimal",
    body: {
      is_deleted: true,
      updated_at: new Date().toISOString(),
    },
  });
}

const HIDDEN_STATUSES = ["invalid", "rejected"];

// Admin-only: reports that are off the public site, either marked invalid or hidden with the
// older is_deleted flag. Who hid each one, when and why comes from the audit log; reports hidden
// before the audit log existed have no entry.
export async function fetchHiddenReports() {
  const params = new URLSearchParams();
  params.set("select", "id,photo_url,area,landmark,district,status,is_deleted,invalid_reason,admin_note,created_at,updated_at");
  params.set("or", `(is_deleted.eq.true,status.in.(${HIDDEN_STATUSES.join(",")}))`);
  params.set("order", "updated_at.desc");
  const reports = await adminRestJson(`/rest/v1/reports?${params.toString()}`);
  if (!Array.isArray(reports) || reports.length === 0) return [];

  const auditParams = new URLSearchParams();
  auditParams.set("select", "entity_id,action,actor_email,to_value,note,created_at");
  auditParams.set("entity_type", "eq.report");
  auditParams.set("entity_id", `in.(${reports.map(report => report.id).join(",")})`);
  auditParams.set("action", "in.(hidden,status_change)");
  auditParams.set("order", "created_at.desc");
  let audit = [];
  try {
    audit = (await adminRestJson(`/rest/v1/audit_log?${auditParams.toString()}`)) || [];
  } catch {
    // The list is still useful without the history.
  }

  return reports.map(report => {
    // Newest entry that took this report off the public site.
    const entry = audit.find(row => row.entity_id === report.id
      && (row.action === "hidden" || HIDDEN_STATUSES.includes(row.to_value?.status)));
    return {
      ...report,
      hidden_at: entry?.created_at || null,
      hidden_by: entry?.actor_email || null,
      hidden_reason: entry?.to_value?.invalid_reason || report.invalid_reason || null,
      hidden_note: entry?.note || null,
    };
  });
}

// Puts a hidden report back. A report hidden with is_deleted keeps its status (a hidden cleaned
// report comes back as cleaned). A report marked invalid goes back to active, which the database
// only allows with a note, so one is written when the admin leaves the field empty.
export async function restoreReport(report, note = "") {
  const text = note.trim();
  const body = report.is_deleted
    ? { is_deleted: false, ...(HIDDEN_STATUSES.includes(report.status) ? {} : { invalid_reason: null }), ...(text ? { admin_note: text } : {}) }
    : { status: "active", admin_note: text || `Restored from the Hidden tab on ${new Date().toISOString()}` };
  const rows = await adminRestJson(`/rest/v1/reports?id=eq.${encodeFilter(report.id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body,
  });
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("This report could not be restored.");
  return rows[0];
}
