# Report status model

## Stored values and what they mean

`reports.status` holds legacy and new values side by side. `private.normalize_status(status, is_deleted)`
maps them to the four workflow statuses. The public policy, the `public_reports` view and the update
trigger all use this one function.

| Stored | Normalised |
|---|---|
| `verified`, `pending`, `active`, `reported`, `open` | active |
| `in_progress` | in_progress |
| `cleaned` | cleaned |
| `rejected`, `invalid`, null, anything else | invalid |
| any status with `is_deleted = true` | invalid |

New reports are still stored as `verified` (the column default). Existing values are not rewritten.

## Who sees what

- **Public** (`public_reports` view, anon): active, in_progress and cleaned reports. `in_progress` is shown
  as `active`. Only public columns are exposed.
- **Staff** (`reports` table, authenticated): a municipality admin sees reports whose `municipality_id` is
  theirs. A super admin sees everything. Both need an active `staff_profiles` row; the JWT alone is not enough.
  Role `admin` is treated as super admin until every account is migrated.
- `cleanup_proofs` follow their report: staff see and update a proof when they may see its report.

## Transitions (enforced for staff by a trigger)

| From | To | Required |
|---|---|---|
| active | in_progress | nothing (assigned to and due date are optional) |
| in_progress | active | nothing (a note is optional) |
| active, in_progress | cleaned | cleaned by name, type and date |
| active, in_progress | invalid | reason: `spam`, `duplicate`, `outside_jurisdiction` or `other` |
| cleaned, invalid | active | a new note |

Anything else is rejected. Staff may change only: status, ward,
assigned to, due date, cleaned details, invalid reason and note. `cleaned_marked_at` and `cleaned_marked_by`
are always set by the server.

Two legacy paths from the current admin screen keep working:

- **Approve a citizen proof.** The screen sets the report to `cleaned` without details. The trigger fills
  them from the approved proof (`cleaned_by_type = 'citizen'`, name from the proof).
- **Hide** (`is_deleted = true`). Super admins only. Recorded as invalid with reason `other`.

The rules apply to the `authenticated` role only. Server code (service role), the database owner and the
nightly sweep are not restricted, but everything they change is still audited.

## Auto-cleaned reports

The nightly job `jabor-auto-clean-old-reports` marks reports older than 15 days as cleaned, with
`cleaned_by_type = 'auto'`. It never touches reports in progress.

Reports with no municipality are always swept. For a municipality's reports the sweep is a setting,
`municipalities.settings.auto_clean_enabled`, off by default and off for Jorhat. Changing it is a data
change, run by the owner, not a migration:

```sql
update public.municipalities
set settings = jsonb_set(settings, '{auto_clean_enabled}', 'true')
where slug = 'jorhat';
```

**Dashboards and exports must report `auto` separately from `jmb` and `citizen`.** Auto-cleaned reports
are left out of days-to-clean and out of the cleaned-without-proof count: nobody confirmed they were cleaned.

## Audit log

`audit_log` gets one row per status change, ward change, assignment change, cleaned-detail change, hide or
unhide, and staff profile change. Rows without a signed-in user are recorded with actor `system`. The table is
append-only: no role, including the owner, can update, delete or truncate it.
