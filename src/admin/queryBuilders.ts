// Every request the dashboard sends to the admin proxy is built here, as plain data. Nothing in this file
// touches the network or the browser, so api/_lib/dashboard.check.js can run each one against the proxy's
// allowlist for each role. If a screen needs a query the allowlist does not permit, that test fails.
import { DAY, LEGACY_ACTIVE } from "./format.ts";
import type { Filters, Sort, Status } from "./types.ts";

export const PAGE_SIZE = 25;

export type Envelope = { path: string; method: "GET" | "PATCH" | "POST"; prefer?: string; body?: Record<string, unknown> };
// municipalityId is set for a super admin (the selected municipality). A municipality admin never sends
// it: the proxy adds the scope on the server.
export type Scope = { municipalityId: string | null };

const encode = encodeURIComponent;
const query = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${encode(v)}`).join("&");
const scoped = (scope: Scope, pairs: [string, string][]): [string, string][] =>
  scope.municipalityId ? [...pairs, ["municipality_id", `eq.${scope.municipalityId}`]] : pairs;

export const REPORT_LIST_COLUMNS = "id,area,landmark,district,waste_type,status,is_deleted,ward_id,photo_url,created_at,updated_at,cleaned_by_type,admin_note";
export const REPORT_DETAIL_COLUMNS = `${REPORT_LIST_COLUMNS},description,constituency,claimed_in_municipality,invalid_reason,cleaned_by_name,cleaned_at,cleaned_marked_at,assigned_to_text,due_at,source,municipality_id`;
export const AUDIT_COLUMNS = "id,entity_type,entity_id,actor_email,action,from_value,to_value,note,created_at";

const ACTIVE_LIST = LEGACY_ACTIVE.join(",");
const NOT_HIDDEN = "is_deleted.not.is.true";
const NOT_AUTO = "or(cleaned_by_type.is.null,cleaned_by_type.neq.auto)";

// Conditions for one status, matching private.normalize_status. "Cleaned" leaves out the nightly sweep's
// auto-cleaned reports, which are never counted as cleaned by JMB.
export function statusConditions(status: Status | "auto_cleaned"): string[] {
  switch (status) {
    case "active": return [NOT_HIDDEN, `status.in.(${ACTIVE_LIST})`];
    case "in_progress": return [NOT_HIDDEN, "status.eq.in_progress"];
    case "cleaned": return [NOT_HIDDEN, "status.eq.cleaned", NOT_AUTO];
    case "auto_cleaned": return [NOT_HIDDEN, "status.eq.cleaned", "cleaned_by_type.eq.auto"];
    case "invalid": return ["or(is_deleted.is.true,status.in.(invalid,rejected))"];
  }
}

// What a person typed into the search box, made safe to put inside a quoted filter value: quotes,
// backslashes and control characters are dropped, and it is cut to 80 characters.
export const cleanSearch = (text: string) => text.replace(/["\\]/g, "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);

export const overdueCutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();
const dayStart = (date: string) => new Date(`${date}T00:00:00`).toISOString();
const dayEnd = (date: string) => new Date(`${date}T23:59:59.999`).toISOString();

export function reportConditions(filters: Filters, now: Date, overdueDays: number): string[] {
  const conditions: string[] = [];
  const status: Status | "auto_cleaned" | "" = filters.overdueOnly ? "active" : filters.status;
  if (status) conditions.push(...statusConditions(status));
  if (filters.overdueOnly) conditions.push(`created_at.lt.${overdueCutoff(now, overdueDays)}`);
  if (filters.ward === "unassigned") conditions.push("ward_id.is.null");
  else if (filters.ward) conditions.push(`ward_id.eq.${filters.ward}`);
  if (filters.from) conditions.push(`created_at.gte.${dayStart(filters.from)}`);
  if (filters.to) conditions.push(`created_at.lte.${dayEnd(filters.to)}`);
  const text = cleanSearch(filters.q);
  if (text) {
    const pattern = `"*${text}*"`;
    conditions.push(`or(area.ilike.${pattern},landmark.ilike.${pattern},description.ilike.${pattern})`);
  }
  return conditions;
}

const andParam = (conditions: string[]): [string, string][] => (conditions.length ? [["and", `(${conditions.join(",")})`]] : []);

// ── Summary tiles: one cheap count per tile ──────────────────────────────────
export const TILE_KEYS = ["total", "active", "in_progress", "cleaned", "invalid", "overdue", "auto_cleaned"] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export function tileEnvelope(key: TileKey, scope: Scope, now: Date, overdueDays: number): Envelope {
  const conditions: string[] =
    key === "total" ? [] :
    key === "overdue" ? [...statusConditions("active"), `created_at.lt.${overdueCutoff(now, overdueDays)}`] :
    statusConditions(key);
  return { path: `/rest/v1/reports?${query(scoped(scope, [["select", "id"], ["limit", "1"], ...andParam(conditions)]))}`, method: "GET", prefer: "count=exact" };
}

// ── The reports table ────────────────────────────────────────────────────────
export function reportsPageEnvelope(scope: Scope, filters: Filters, sort: Sort, page: number, now: Date, overdueDays: number): Envelope {
  const order = sort.key === "created_at" || sort.key === "updated_at" ? `${sort.key}.${sort.dir},id.asc` : `${sort.key}.${sort.dir},created_at.desc`;
  return {
    path: `/rest/v1/reports?${query(scoped(scope, [
      ["select", REPORT_LIST_COLUMNS], ...andParam(reportConditions(filters, now, overdueDays)),
      ["order", order], ["limit", String(PAGE_SIZE)], ["offset", String((Math.max(1, page) - 1) * PAGE_SIZE)],
    ]))}`,
    method: "GET",
    prefer: "count=exact",
  };
}

// ── One report ───────────────────────────────────────────────────────────────
export const reportEnvelope = (id: string): Envelope => ({ path: `/rest/v1/reports?${query([["select", REPORT_DETAIL_COLUMNS], ["id", `eq.${id}`], ["limit", "1"]])}`, method: "GET" });

export const historyEnvelope = (id: string): Envelope => ({
  path: `/rest/v1/audit_log?${query([["select", AUDIT_COLUMNS], ["entity_type", "eq.report"], ["entity_id", `eq.${id}`], ["order", "created_at.asc,id.asc"], ["limit", "200"]])}`,
  method: "GET",
});

export const patchReportEnvelope = (id: string, body: Record<string, unknown>): Envelope => ({
  path: `/rest/v1/reports?${query([["id", `eq.${id}`]])}`, method: "PATCH", prefer: "return=representation", body,
});

// ── Reference data ───────────────────────────────────────────────────────────
export const wardsEnvelope = (scope: Scope): Envelope => ({ path: `/rest/v1/wards?${query(scoped(scope, [["select", "id,number,name"], ["order", "number"], ["limit", "100"]]))}`, method: "GET" });
export const municipalitiesEnvelope = (): Envelope => ({ path: `/rest/v1/municipalities?${query([["select", "id,slug,name,settings"], ["order", "name"], ["limit", "100"]])}`, method: "GET" });

// ── The audit log ────────────────────────────────────────────────────────────
export type AuditFilters = { from: string; to: string; actor: string; action: string };
export const EMPTY_AUDIT_FILTERS: AuditFilters = { from: "", to: "", actor: "", action: "" };

export function auditPageEnvelope(scope: Scope, filters: AuditFilters, page: number): Envelope {
  const pairs: [string, string][] = [["select", AUDIT_COLUMNS]];
  const dates: string[] = [];
  if (filters.from) dates.push(`created_at.gte.${dayStart(filters.from)}`);
  if (filters.to) dates.push(`created_at.lte.${dayEnd(filters.to)}`);
  pairs.push(...andParam(dates));
  const actor = filters.actor.replace(/[*%\u0000-\u001f]/g, "").trim().slice(0, 80);
  if (actor) pairs.push(["actor_email", `ilike.*${actor}*`]);
  if (filters.action) pairs.push(["action", `eq.${filters.action}`]);
  pairs.push(["order", "created_at.desc,id.desc"], ["limit", String(PAGE_SIZE)], ["offset", String((Math.max(1, page) - 1) * PAGE_SIZE)]);
  return { path: `/rest/v1/audit_log?${query(scoped(scope, pairs))}`, method: "GET", prefer: "count=exact" };
}

// ── Hidden reports (the Hidden tab) ──────────────────────────────────────────
export const hiddenEnvelope = (scope: Scope): Envelope => ({
  path: `/rest/v1/reports?${query(scoped(scope, [
    ["select", "id,photo_url,area,landmark,district,status,is_deleted,invalid_reason,admin_note,created_at,updated_at"],
    ["or", "(is_deleted.eq.true,status.in.(invalid,rejected))"], ["order", "updated_at.desc"], ["limit", "200"],
  ]))}`,
  method: "GET",
});
export const hiddenHistoryEnvelope = (ids: string[]): Envelope => ({
  path: `/rest/v1/audit_log?${query([["select", "entity_id,action,actor_email,to_value,note,created_at"], ["entity_type", "eq.report"], ["entity_id", `in.(${ids.join(",")})`], ["action", "in.(hidden,status_change)"], ["order", "created_at.desc"], ["limit", "1000"]])}`,
  method: "GET",
});

// ── Exports and reports (T6/T7) ──────────────────────────────────────────────
// The CSV export sends only the filters. The server picks the columns, the order and the paging.
export const exportEnvelope = (scope: Scope, filters: Filters, now: Date, overdueDays: number): { path: string } => ({
  path: `/rest/v1/reports?${query(scoped(scope, andParam(reportConditions(filters, now, overdueDays))))}`,
});

// month is "yyyy-mm". A municipality admin never sends a municipality: the proxy adds their own.
export const monthlyEnvelope = (scope: Scope, month: string): Envelope => ({
  path: "/rest/v1/rpc/monthly_ward_report", method: "POST",
  body: { p_month: `${month}-01`, ...(scope.municipalityId ? { p_municipality: scope.municipalityId } : {}) },
});

export const hotspotsEnvelope = (scope: Scope, days: 30 | 60 | 90): Envelope => ({
  path: "/rest/v1/rpc/ward_hotspots", method: "POST",
  body: { p_days: days, ...(scope.municipalityId ? { p_municipality: scope.municipalityId } : {}) },
});
