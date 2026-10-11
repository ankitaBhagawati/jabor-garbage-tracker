export type Role = "super_admin" | "municipality_admin";
export type Session = { email: string; role: Role; municipality: { name: string; slug: string } | null };

// The four statuses of the JMB workflow. auto_cleaned is only a filter: cleaned by the nightly sweep.
export type Status = "active" | "in_progress" | "cleaned" | "invalid";
export type StatusFilter = "" | Status | "auto_cleaned";

export type Ward = { id: string; number: number; name: string | null };
export type MunicipalityInfo = { id: string; slug: string; name: string; settings: { overdue_after_days?: number } | null };

export type ReportRow = {
  id: string;
  area: string | null;
  landmark: string | null;
  district: string | null;
  waste_type: string | null;
  status: string | null;
  is_deleted: boolean | null;
  ward_id: string | null;
  photo_url: string | null;
  created_at: string;
  updated_at: string | null;
  cleaned_by_type: string | null;
  admin_note: string | null;
};

export type ReportDetail = ReportRow & {
  description: string | null;
  constituency: string | null;
  claimed_in_municipality: string | null;
  invalid_reason: string | null;
  cleaned_by_name: string | null;
  cleaned_at: string | null;
  cleaned_marked_at: string | null;
  assigned_to_text: string | null;
  due_at: string | null;
  source: string | null;
  municipality_id: string | null;
};

export type AuditRow = {
  id: number;
  entity_type: string;
  entity_id: string;
  actor_email: string;
  action: string;
  from_value: Record<string, unknown> | null;
  to_value: Record<string, unknown> | null;
  note: string | null;
  created_at: string;
};

export type Filters = {
  status: StatusFilter;
  ward: string; // "" for all, "unassigned", or a ward id
  from: string; // yyyy-mm-dd, local
  to: string;
  overdueOnly: boolean;
  q: string;
};
export const EMPTY_FILTERS: Filters = { status: "", ward: "", from: "", to: "", overdueOnly: false, q: "" };

export type SortKey = "created_at" | "updated_at" | "status" | "area";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

// One row of the monthly ward report (public.monthly_ward_report). kind is "ward", "unassigned" or "total".
export type MonthlyRow = {
  kind: "ward" | "unassigned" | "total";
  ward_id: string | null;
  ward_number: number | null;
  ward_name: string | null;
  received: number;
  cleaned: number;
  auto_cleaned: number;
  active: number;
  in_progress: number;
  invalid: number;
  overdue: number;
  median_days: number | null;
  avg_days: number | null;
};

// One row of the hotspot ranking (public.ward_hotspots).
export type HotspotRow = {
  ward_id: string;
  ward_number: number;
  ward_name: string | null;
  reports: number;
  active: number;
  overdue: number;
  repeat_locations: number;
  avg_days_to_clean: number | null;
  score: number;
  rank: number;
};
export type HotspotWindow = 30 | 60 | 90;
