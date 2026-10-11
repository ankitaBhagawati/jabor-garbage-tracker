# Ward hotspot ranking

A staff-only view that ranks the wards of one municipality by how much attention they need. It is the
**Hotspots** tab of the admin dashboard, for `municipality_admin` and `super_admin`. It is never public:
there is no public route, the data comes from a function only signed-in staff can run, and the proxy and the
database each check the role and the municipality again.

Ward level only. There is no map, and no coordinates are read, returned or shown anywhere.

## Window

Reports received in the last **30, 60 or 90 days** (the person chooses). Reports that are invalid or hidden
are left out of every number, so spam does not make a ward look bad.

## Numbers per ward

| Column | Meaning |
|---|---|
| Reports | Reports received in the window, not counting invalid or hidden ones |
| Active | Of those, reports that are Active today (see `docs/STATUS-MODEL.md`) |
| Overdue | Of those, Active for longer than the municipality's overdue limit (`municipalities.settings.overdue_after_days`, 7 if unset) |
| Repeat places | Number of places named by **two or more** of those reports. A place is the landmark text, or the locality when there is no landmark, ignoring case and spaces |
| Avg days to clean | Average days from received to cleaned, for the reports cleaned by JMB or a citizen. **Auto-cleaned reports are left out** (nobody confirmed them) |

Reports with no ward are not ranked (a ward is needed to rank). Wards with no reports are listed with a score of 0.

## Score

```
score = overdue x 3 + active x 1 + repeat places x 2
```

An overdue report is also active, so each one adds 3 + 1. Reports in progress and cleaned reports add nothing:
the score measures work still waiting. It is a plain sum so anyone can check it by hand, and the UI shows the
formula next to the table and as a tooltip on the Score column.

Example: a ward with 3 active reports, 2 of them overdue, and one place reported twice scores
`2 x 3 + 3 + 1 x 2 = 11`.

## Rank

Rank 1 is the highest score. Wards with the same score share a rank (1, 2, 2, 4). The table lists higher score
first, then more reports, then the lower ward number.

## Small samples

A ward with **fewer than 3 reports** in the window is marked *Small sample*. Its place in the ranking says
little, so it is flagged rather than hidden. The bar chart shows it in a lighter colour.

## Where it lives

- Database: `public.ward_hotspots(p_municipality uuid, p_days integer)`, `SECURITY INVOKER`
  (migration `20261011170000_t6_t7_report_functions`). A municipality admin always gets their own
  municipality, whatever is passed. A super admin names one. `anon` cannot run it; a deactivated or non-staff
  user gets no rows.
- Proxy: `POST /rest/v1/rpc/ward_hotspots` with `p_days` 30, 60 or 90 (see `docs/ACCESS-MATRIX.md`).
- Tests: `supabase/tests/database/100_report_functions.test.sql`, `api/_lib/reports.check.js`, `tests/admin.spec.js`.

## Changing the formula

Change the weights in the function (a new migration) and in `HOTSPOT_FORMULA` / `hotspotScore` in
`src/admin/reportTables.ts`. `api/_lib/reports.check.js` and the pgTAP file both pin the numbers, so a mismatch
between the two fails `npm test` or `supabase test db`.
