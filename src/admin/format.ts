import type { AuditRow, Status, Ward } from "./types.ts";

export { DAY, LEGACY_ACTIVE, statusOf, ageDays, isOverdue, wardLabel, overdueDaysFrom } from "./rules.js";
import { statusOf, wardLabel } from "./rules.js";

export const STATUS_LABEL: Record<Status, string> = { active: "Active", in_progress: "In progress", cleaned: "Cleaned", invalid: "Invalid" };
export const INVALID_REASONS: { value: string; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "duplicate", label: "Duplicate" },
  { value: "outside_jurisdiction", label: "Outside jurisdiction" },
  { value: "other", label: "Other" },
];
export const WASTE_LABEL: Record<string, string> = {
  mixed: "Mixed", plastic: "Plastic", construction: "Construction", organic: "Organic", water: "Water body", medical: "Medical",
};

export const ageLabel = (days: number) => (days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`);

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const formatDate = (iso: string | null | undefined) => (iso ? DATE.format(new Date(iso)) : "");
export const formatDateTime = (iso: string | null | undefined) => (iso ? DATE_TIME.format(new Date(iso)) : "");

export const ACTION_LABEL: Record<string, string> = {
  report_created: "Report received", status_change: "Status changed", ward_change: "Ward changed", assignment_change: "Assignment changed",
  cleaned_details_change: "Cleaned details changed", note_change: "Note changed", hidden: "Hidden", unhidden: "Restored",
  export: "Export downloaded", staff_account_created: "Municipal admin added", staff_account_activated: "Municipal admin reactivated", staff_account_deactivated: "Municipal admin deactivated", staff_created: "Staff account created", staff_changed: "Staff account changed", staff_deleted: "Staff account removed",
};

export const actorLabel = (email: string) => (email === "public" ? "Public (citizen)" : email === "system" ? "System" : email);

// One line saying what an audit row did, from its from and to values.
export function describeAudit(row: Pick<AuditRow, "action" | "from_value" | "to_value" | "note">, wards: Map<string, Ward>): string {
  const from = row.from_value ?? {};
  const to = row.to_value ?? {};
  const wardName = (id: unknown) => (typeof id === "string" && wards.get(id) ? wardLabel(wards.get(id) as Ward) : id ? "a ward" : "Unassigned");
  const status = (value: unknown) => STATUS_LABEL[statusOf({ status: typeof value === "string" ? value : null, is_deleted: false })];
  switch (row.action) {
    case "report_created": {
      const answer = to.claimed_in_municipality;
      const where = answer === "yes" ? "inside the municipal area" : answer === "not_sure" ? "not sure if inside the municipal area" : answer === "no" ? "outside the municipal area" : "";
      return `Report received${where ? `, reporter says ${where}` : ""}.`;
    }
    case "status_change": {
      const parts = [`Status: ${status(from.status)} to ${status(to.status)}`];
      if (to.cleaned_by_name) parts.push(`cleaned by ${String(to.cleaned_by_name)}${to.cleaned_by_type ? ` (${String(to.cleaned_by_type).toUpperCase()})` : ""}`);
      if (to.invalid_reason) parts.push(`reason: ${INVALID_REASONS.find(r => r.value === to.invalid_reason)?.label ?? String(to.invalid_reason)}`);
      return `${parts.join(", ")}.`;
    }
    case "ward_change": return `Ward: ${wardName(from.ward_id)} to ${wardName(to.ward_id)}.`;
    case "assignment_change": return to.assigned_to_text ? `Assigned to ${String(to.assigned_to_text)}.` : "Assignment cleared.";
    case "cleaned_details_change": return `Cleaned details changed${to.cleaned_by_name ? ` (${String(to.cleaned_by_name)})` : ""}.`;
    case "note_change": return to.admin_note ? "Internal note updated." : "Internal note cleared.";
    case "staff_account_created": return `${to.email ? String(to.email) : "A municipal admin"} was added as a municipal admin.`;
    case "staff_account_activated": return `${to.email ? String(to.email) : "A municipal admin"} was reactivated.`;
    case "staff_account_deactivated": return `${to.email ? String(to.email) : "A municipal admin"} was deactivated and lost access at once.`;
    case "export": return `Downloaded a CSV of ${Number(to.rows ?? 0).toLocaleString("en-IN")} reports${to.filters ? " with filters" : ", no filters"}.`;
    case "hidden": return "Hidden from the public site.";
    case "unhidden": return "Restored to the public site.";
    case "staff_created": return `Staff account created${to.role ? ` (${String(to.role).replace("_", " ")})` : ""}.`;
    case "staff_changed": return to.is_active === false ? "Staff account deactivated." : "Staff account changed.";
    default: return ACTION_LABEL[row.action] ?? row.action;
  }
}

// ── Actions on one report ────────────────────────────────────────────────────
export type ActionId = "start" | "back_to_active" | "clean" | "invalid" | "reopen";
export const ACTION_LABEL_TEXT: Record<ActionId, string> = {
  start: "Start work", back_to_active: "Back to Active", clean: "Mark cleaned", invalid: "Mark invalid", reopen: "Reopen as Active",
};

// Only the moves docs/STATUS-MODEL.md allows. The database enforces them again.
export function actionsFor(status: Status): ActionId[] {
  switch (status) {
    case "active": return ["start", "clean", "invalid"];
    case "in_progress": return ["back_to_active", "clean", "invalid"];
    case "cleaned": return ["reopen"];
    case "invalid": return ["reopen"];
  }
}

export type ActionInput = { name: string; date: string; reason: string; note: string; currentNote: string | null };
const NOTE_MAX = 1000;
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayISO = (now = new Date()) => isoDate(now);

// The update to send for an action, or an error message to show before sending anything.
export function buildStatusPatch(action: ActionId, input: ActionInput, now = new Date()): { body: Record<string, unknown> } | { error: string } {
  const note = input.note.trim();
  if (note.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters.` };
  const withNote = (body: Record<string, unknown>) => ({ body: note ? { ...body, admin_note: note } : body });
  switch (action) {
    case "start": return withNote({ status: "in_progress" });
    case "back_to_active": return withNote({ status: "active" });
    case "clean": {
      const name = input.name.trim();
      if (!name) return { error: "Say who cleaned it." };
      if (name.length > 120) return { error: "Keep the name under 120 characters." };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { error: "Choose the date it was cleaned." };
      if (input.date > isoDate(now)) return { error: "The cleaned date cannot be in the future." };
      return withNote({ status: "cleaned", cleaned_by_name: name, cleaned_by_type: "jmb", cleaned_at: new Date(`${input.date}T12:00:00`).toISOString() });
    }
    case "invalid":
      if (!INVALID_REASONS.some(r => r.value === input.reason)) return { error: "Choose a reason." };
      if (!note) return { error: "Write a note saying why it is invalid." };
      return { body: { status: "invalid", invalid_reason: input.reason, admin_note: note } };
    case "reopen":
      if (!note) return { error: "Write a note saying why it is being reopened." };
      if (note === (input.currentNote ?? "").trim()) return { error: "Write a new note: it must differ from the current one." };
      return { body: { status: "active", admin_note: note } };
  }
}

// Saving the internal note on its own.
export function buildNotePatch(note: string, currentNote: string | null): { body: Record<string, unknown> } | { error: string } {
  const text = note.trim();
  if (text.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters.` };
  if (text === (currentNote ?? "").trim()) return { error: "The note has not changed." };
  return { body: { admin_note: text || null } };
}

// ── Hide and restore (soft: the report stays in the database, only the public site stops showing it) ──
export function buildHidePatch(reason: string, note: string): { body: Record<string, unknown> } | { error: string } {
  if (!INVALID_REASONS.some(r => r.value === reason)) return { error: "Choose a reason." };
  const text = note.trim();
  if (text.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters.` };
  return { body: { is_deleted: true, invalid_reason: reason, ...(text ? { admin_note: text } : {}) } };
}

// Restoring puts it back on the public site. A report that is still marked Invalid keeps its reason; any other
// report loses the reason the hide gave it.
export function buildUnhidePatch(report: { status: string | null }, note: string): { body: Record<string, unknown> } | { error: string } {
  const text = note.trim();
  if (text.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters.` };
  const stillInvalid = statusOf({ status: report.status, is_deleted: false }) === "invalid";
  return { body: { is_deleted: false, ...(stillInvalid ? {} : { invalid_reason: null }), ...(text ? { admin_note: text } : {}) } };
}
