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
