# Public report form: municipal area question

When a reporter picks a district and constituency that a municipality has switched on, the form asks
"Is this location within <municipality name> area?" with Yes, No and Not sure. Yes also asks for a
ward. There is no map, no GPS and no location permission.

## Switching a municipality on (a data change, not a migration)

The question is driven by `municipalities.settings.public_form`:

```sql
update public.municipalities
set settings = settings || '{"public_form": {"district": "Jorhat", "constituencies": ["Jorhat"]}}'::jsonb
where slug = 'jorhat';
```

- `district` and `constituencies` are the values of the form's District and Constituency lists. The
  question appears when the reporter picks one of those constituencies in that district. Other
  constituencies in the same district (for example Mariani) are not asked.
- The municipality must have `is_active = true`.
- To switch it off, remove the key: `settings = settings - 'public_form'`.
- Ward names in the dropdown come from `wards.name`. A ward with no name shows its first three
  `ward_localities` names, and otherwise just its number.
- Changes show up on the form within about five minutes (the config is cached by the CDN).

## What the server decides

`POST /api/reports/submit` never reads a `municipality_id` from the browser. From the district,
constituency, `municipality_answer` and `ward_id` it sets:

| Answer | Municipality | Ward | Notes |
|---|---|---|---|
| Yes | the municipality | the chosen ward, or none for "Not sure, JMB will assign" | The ward must belong to that municipality, else 400 |
| Not sure | the municipality | none | A ward is rejected (400) |
| No | none | none | A ward is rejected (400) |
| missing or invalid | | | 400, when the location is one the question applies to |
| anywhere else | none | none | Stored as before. A ward is rejected (400). An answer is ignored. |

The raw answer is stored in `reports.claimed_in_municipality` and is admin-only. `reports.source` is
set to `public`, and the creation is written to `audit_log` (`report_created`, actor `public`).
Status, ward changes and everything else a client might send are ignored.

## What the public can read

- `public_reports` has no ward, municipality, answer, source or note columns.
- Anon can read only the `reports` columns that the live frontend selects (migration
  `anon_reports_column_grants`). Before it, anon could read `ward_id`, `claimed_in_municipality`,
  `admin_note` and the embedding straight from the base table.
- `GET /api/municipalities` returns ward numbers, names and up to three locality names, and the
  settings needed to show the question. It does not return municipality ids or other settings.
