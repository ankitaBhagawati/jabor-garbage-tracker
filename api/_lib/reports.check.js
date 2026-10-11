// Tests for what the monthly report and the hotspot ranking show and export: `node api/_lib/reports.check.js`
import assert from "node:assert/strict";

const BOM = String.fromCharCode(0xfeff);

const T = await import("../../src/admin/reportTables.ts");

// The score formula: the same numbers as supabase/tests/database/100_report_functions.test.sql
assert.equal(T.HOTSPOT_FORMULA, "overdue × 3 + active × 1 + repeat locations × 2");
assert.equal(T.hotspotScore({ overdue: 2, active: 3, repeat_locations: 1 }), 11);
assert.equal(T.hotspotScore({ overdue: 1, active: 2, repeat_locations: 0 }), 5);
assert.equal(T.hotspotScore({ overdue: 0, active: 0, repeat_locations: 0 }), 0);
assert.equal(T.hotspotScore({ overdue: 0, active: 1, repeat_locations: 0 }), 1);
// a small sample is fewer than three reports
assert.deepEqual([0, 1, 2, 3, 4].map(reports => T.isSmallSample({ reports })), [true, true, true, false, false]);

// months
assert.equal(T.monthValue(new Date(2026, 9, 11)), "2026-10");
assert.equal(T.monthValue(new Date(2026, 0, 1)), "2026-01");
assert.equal(T.monthLabel("2026-08"), "August 2026");
for (const ok of ["2026-08", "2024-12", "2026-01"]) assert.equal(T.isMonth(ok), true, ok);
for (const bad of ["2026-13", "2026-00", "2026-8", "26-08", "2026-08-01", "", "august", "2026-08 "]) assert.equal(T.isMonth(bad), false, bad);
assert.equal(T.days(null), "–");
assert.equal(T.days(6), "6.0");
assert.equal(T.days(4.25), "4.3");

// the monthly CSV: names, order, numbers, and no formulas from ward names
const row = (extra = {}) => ({ kind: "ward", ward_id: "w", ward_number: 1, ward_name: null, received: 5, cleaned: 2, auto_cleaned: 1, active: 2, in_progress: 0, invalid: 0, overdue: 2, median_days: 6, avg_days: 6, ...extra });
const csv = T.monthlyCsv([row(), row({ ward_number: 2, ward_name: "=Main Road", received: 2, median_days: null, avg_days: null }), row({ kind: "unassigned", ward_id: null, ward_number: null }), row({ kind: "total", ward_id: null, ward_number: null, received: 8 })]);
const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
assert.equal(lines[0], "ward,received,cleaned,auto_cleaned,active_at_month_end,in_progress_at_month_end,invalid_at_month_end,overdue_at_month_end,median_days_to_clean,average_days_to_clean");
assert.equal(lines[1], "Ward 1,5,2,1,2,0,0,2,6,6");
assert.equal(lines[2], "Ward 2 · =Main Road,2,2,1,2,0,0,2,,", "the ward name is not at the start of the cell, so it is safe");
assert.equal(lines[3].split(",")[0], "Unassigned");
assert.equal(lines[4].split(",")[0], "Total");
assert.ok(csv.startsWith(BOM));
assert.equal(T.monthlyName(row({ kind: "total" })), "Total");

// the hotspot CSV
const hot = (extra = {}) => ({ ward_id: "w", ward_number: 1, ward_name: null, reports: 5, active: 3, overdue: 2, repeat_locations: 1, avg_days_to_clean: 4, score: 11, rank: 1, ...extra });
const hcsv = T.hotspotCsv([hot(), hot({ ward_number: 2, reports: 1, score: 1, rank: 2, avg_days_to_clean: null })]).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
assert.equal(hcsv[0], "rank,ward,reports_in_window,active,overdue,repeat_locations,average_days_to_clean,score,small_sample");
assert.equal(hcsv[1], "1,Ward 1,5,3,2,1,4,11,no");
assert.equal(hcsv[2], "2,Ward 2,1,3,2,1,,1,yes");
// nothing that locates a report is ever in an export
for (const text of [csv, T.hotspotCsv([hot()])]) assert.doesNotMatch(text, /lat|lng|gps|coordinate|email|phone|contact/i);

console.log("report tables ok");
