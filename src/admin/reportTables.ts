// What the monthly report and the hotspot ranking show and export. Pure functions, tested by api/_lib/reports.check.js.
import { toCsv } from "./csv.js";
import { wardLabel } from "./format.ts";
import type { HotspotRow, MonthlyRow } from "./types.ts";

export const SMALL_SAMPLE = 3;

// The hotspot score. The database computes it (public.ward_hotspots); this is the same sum, shown in the
// tooltip and used by the tests to check the database's numbers.
export const HOTSPOT_FORMULA = "overdue × 3 + active × 1 + repeat locations × 2";
export const hotspotScore = (row: Pick<HotspotRow, "overdue" | "active" | "repeat_locations">) => row.overdue * 3 + row.active + row.repeat_locations * 2;
export const isSmallSample = (row: Pick<HotspotRow, "reports">) => row.reports < SMALL_SAMPLE;

export const monthValue = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
export const monthLabel = (month: string) => new Date(`${month}-01T12:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
export const isMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export const days = (value: number | null) => (value === null || value === undefined ? "–" : Number(value).toFixed(1));

export const monthlyName = (row: MonthlyRow) =>
  row.kind === "total" ? "Total" : row.kind === "unassigned" ? "Unassigned" : wardLabel({ number: row.ward_number ?? 0, name: row.ward_name });

export const MONTHLY_HEADER = ["ward", "received", "cleaned", "auto_cleaned", "active_at_month_end", "in_progress_at_month_end", "invalid_at_month_end", "overdue_at_month_end", "median_days_to_clean", "average_days_to_clean"];
export const monthlyCsv = (rows: MonthlyRow[]) =>
  toCsv(MONTHLY_HEADER, rows.map(r => [monthlyName(r), r.received, r.cleaned, r.auto_cleaned, r.active, r.in_progress, r.invalid, r.overdue, r.median_days, r.avg_days]));

export const HOTSPOT_HEADER = ["rank", "ward", "reports_in_window", "active", "overdue", "repeat_locations", "average_days_to_clean", "score", "small_sample"];
export const hotspotCsv = (rows: HotspotRow[]) =>
  toCsv(HOTSPOT_HEADER, rows.map(r => [r.rank, wardLabel({ number: r.ward_number, name: r.ward_name }), r.reports, r.active, r.overdue, r.repeat_locations, r.avg_days_to_clean, r.score, isSmallSample(r) ? "yes" : "no"]));
