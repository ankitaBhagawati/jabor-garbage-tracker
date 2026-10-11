// Rules shared by the dashboard (TypeScript) and the export route (api/admin/export.js). Plain JavaScript on
// purpose, so the server can import it without a build step. format.ts re-exports these.

export const DAY = 24 * 60 * 60 * 1000;

// Stored values older than the workflow: these all mean Active. See docs/STATUS-MODEL.md.
export const LEGACY_ACTIVE = ["verified", "pending", "active", "reported", "open"];

/**
 * The same rule as private.normalize_status in the database. A hidden report counts as invalid.
 * @param {{ status: string | null, is_deleted: boolean | null }} report
 * @returns {"active" | "in_progress" | "cleaned" | "invalid"}
 */
export function statusOf(report) {
  if (report.is_deleted) return "invalid";
  if (report.status && LEGACY_ACTIVE.includes(report.status)) return "active";
  if (report.status === "in_progress") return "in_progress";
  if (report.status === "cleaned") return "cleaned";
  return "invalid";
}

/** @param {string} createdAt @param {Date} now */
export const ageDays = (createdAt, now) => Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / DAY));

/**
 * Overdue means Active for longer than the municipality's threshold. Reports in progress are being worked on.
 * @param {{ status: string | null, is_deleted: boolean | null, created_at: string }} report
 * @param {number} thresholdDays @param {Date} now
 */
export const isOverdue = (report, thresholdDays, now) =>
  statusOf(report) === "active" && now.getTime() - Date.parse(report.created_at) > thresholdDays * DAY;

/** @param {{ number: number, name: string | null }} ward */
export const wardLabel = ward => (ward.name?.trim() ? `Ward ${ward.number} · ${ward.name.trim()}` : `Ward ${ward.number}`);

// The municipality's overdue threshold: the setting when it is a positive number, otherwise seven days.
/** @param {{ overdue_after_days?: number } | null | undefined} settings */
export const overdueDaysFrom = settings => (settings?.overdue_after_days && settings.overdue_after_days > 0 ? settings.overdue_after_days : 7);
