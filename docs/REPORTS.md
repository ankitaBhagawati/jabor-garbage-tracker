# Exports and the monthly ward report

Both are in the admin dashboard for `municipality_admin` and `super_admin`. A municipality admin sees only
their own municipality; a super admin chooses one.

## CSV export of the reports table

The **Export CSV** button on the Dashboard tab downloads the reports the table is showing, with the current
filters (status, ward, dates, overdue only, search). The file is built **on the server**
(`api/admin/export.js`). The browser sends only the filters; the server chooses the columns, the order and the
paging, and reads through the same allowlist and row level security as the dashboard.

Columns: `id, date, ward, status, age_days, overdue, cleaned_date, cleaned_by_type, description`.

- No contact details, no GPS and no embeddings are ever requested. The description is free text typed by the
  public, so anything that looks like an email address or a phone number is replaced by `[email removed]` or
  `[phone removed]`, and line breaks become spaces.
- Dates are in India time. `age_days` and `overdue` use the dashboard's rules. `status` is one of `active`,
  `in_progress`, `cleaned`, `invalid`. `cleaned_by_type` is `jmb`, `citizen`, `other` or `auto` and is only filled
  for cleaned reports.
- **Spreadsheet formulas:** a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a single
  quote in front, so it opens as text.
- **Limit:** at most **10,000 reports** per export. With more, nothing is exported and the message says to narrow
  the filters (a date range or a ward). A partial file is never sent.
- **Audit:** each export writes one `audit_log` row (action `export`) with the person, the filters as the server
  read them and the number of rows. If that row cannot be written, no file is sent. Municipality admins see
  their own exports in the Audit log tab.

The monthly report and hotspot CSVs are built in the browser from the numbers already on screen (ward totals, no
report-level data) and are not logged.

## Monthly ward report

Pick a month; one row per ward, an **Unassigned** row and a **Total** row. It shows on screen, exports to CSV,
and prints cleanly (**Print or save as PDF** uses the browser's print dialog; there is no PDF library).

| Column | Meaning |
|---|---|
| Received | Reports created in the month, whatever their status now |
| Cleaned | Reports cleaned in the month (by their cleaned date) that are cleaned now, by JMB, a citizen or other. **Never auto** |
| Auto-cleaned | Reports the nightly sweep closed in the month. Shown separately, never counted as cleaned |
| Active, In progress, Invalid | Where every report received **up to the end of the month** stood on the last day of the month |
| Overdue | Of the Active ones, those older than the overdue limit on the last day of the month |
| Median / average days to clean | Days from received to cleaned, for the reports counted in Cleaned |

The state at the end of a past month is **rebuilt from `audit_log`**: the last status change up to that moment,
or, if the first change came later, the status it changed from. A report with no history is taken as it is today,
except that one cleaned after the month's end counts as Active at that month's end. Hidden and restored reports
are handled the same way. For the **current month** the end is "now", so Active, In progress, Invalid and
Overdue equal the dashboard tiles exactly.

A report is shown under the ward it has now (ward changes are not replayed). Month boundaries are India time.

Database: `public.monthly_ward_report(p_municipality uuid, p_month date)`, `SECURITY INVOKER`, same access
rules as the hotspot function (see `docs/HOTSPOTS.md`). `p_month` must be the first day of a month.
