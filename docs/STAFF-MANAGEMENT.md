# Staff management and the audit log export

Backend only. A later change builds the screens. Everything here is for an **active super admin**; nobody else
can call it. No migration is needed (see "Audit log" below).

## Routes

All under `/api/admin/staff`. They are dedicated routes, not part of the generic proxy (`/api/admin/rest`), so the
proxy allowlist is unchanged. They use the same HttpOnly session cookie and the same same-origin check as the other
admin routes. Responses are never cached.

| Route | Does | Body |
|---|---|---|
| `GET /api/admin/staff` | Lists staff: `user_id`, `email`, `role`, `municipality_id`, `municipality_name`, `is_active`, `created_at` | none |
| `POST /api/admin/staff` | Creates a **municipality admin** | `{ "email", "password", "municipality_id" }` and nothing else |
| `POST /api/admin/staff/status` | Switches a municipality admin on or off | `{ "user_id", "is_active": true or false }` and nothing else |

Answers: `201` created, `200` done, `400` bad input (a plain sentence), `401` no session, `403` not allowed, `404` unknown
account, `409` the email already exists, `429` too many requests, `503` the limiter is unavailable, `500` something
failed (nothing is left half done).

## Who may call

Decided on the server for every request, exactly as for the proxy (`docs/ACCESS-MATRIX.md` section 1): the token is
verified by Supabase Auth, then the caller's own `staff_profiles` row is read fresh (nothing cached). Only an
**active `super_admin`** passes. The older token role `admin` counts as `super_admin` when its profile is an active
`super_admin`.

| Caller | Result |
|---|---|
| active super admin (or legacy `admin` with a super_admin profile) | allowed |
| municipality admin | 403 |
| inactive staff, no profile, token and profile disagree, a role such as `authenticated` | 403 |
| no session, bad or expired token | 401 (as everywhere in the admin area) |

Denials are logged with the user id, role and route, never the body.

## Rules

1. **The role is never taken from the request.** The only role these routes create is `municipality_admin`, set in
   the server code (in the login's signed `app_metadata` and in the profile). A body with `role`, `app_metadata`,
   `is_active` or any other extra field is refused with 400. A super admin cannot be created or promoted here.
2. **Validation.** Email: trimmed, lowercased, a plausible address, at most 254 characters. Password: 12 to 72
   characters (72 is the most Supabase Auth reads). `municipality_id`: a UUID of a municipality that exists.
3. **Create** uses the Supabase Auth admin API with the service role key (server only), with the email confirmed.
   Then it inserts the `staff_profiles` row, then the `audit_log` row. If the profile or the audit row fails, the
   new login is deleted again (the profile goes with it), so no login is left without a profile. If the email is
   already used by any account, the answer is `409` and **nothing** is changed: an existing user or profile is never
   overwritten.
4. **Switching an account** (`status`): only municipality admins. You cannot switch yourself. A super admin target is
   refused (and if that is ever allowed, the last active super admin could not be deactivated). The update is limited
   to `role = municipality_admin` in the query itself. If the audit row cannot be written, the change is undone.
   Setting the value it already has changes nothing and writes nothing.
5. **Deactivation is immediate.** Every admin request reads the caller's own *active* profile with the caller's own
   token (row level security hides an inactive one), so the next request with the same valid token gets 403 and the
   session cookies are cleared. Sign-in is refused too. Tested in `api/_lib/staff-mgmt.check.js` and by hand below.
6. **Rate limit.** 10 creates and 10 status changes per hour per actor (the super admin's id, not the address), in
   Upstash. Requests that fail validation count too. If Redis is not configured or does not answer, the request is
   refused with 503 (it never goes through). Only off Vercel (local development, where `VERCEL_ENV` is unset) is an
   in-memory counter used.
7. **No secrets leave the server.** The password only travels from the request to Supabase Auth. It is not stored,
   logged, returned, put in `audit_log` or sent to Sentry (errors name the status and code of the failed call, never
   a body; `sentryScrub` also strips emails, tokens and request data).
8. **Audit.** Every create and every change writes one `audit_log` row with the acting super admin (`actor_id`,
   `actor_email`), the target account (`entity_type = staff_member`, `entity_id` = its user id), the municipality, and
   `to_value` holding the target's email, role, municipality and state. Actions: `staff_account_created`,
   `staff_account_activated`, `staff_account_deactivated`. The database also writes its own `staff_created` /
   `staff_changed` row (actor `system`) for any change to `staff_profiles`; that is expected.

## Audit log findings (checked before building)

- `audit_log` has **no check constraint** on `entity_type` or `action`: only the primary key and the foreign key
  from `municipality_id`. The new values need no migration. (`supabase/tests/database/110_audit_log_staff_actions.test.sql` pins this.)
- It is append-only: triggers block update, delete and truncate, and the service role has no such privileges.
- Row level security: select for `authenticated` only, a super admin reads everything, a municipality admin reads rows
  with their `municipality_id`, nobody else (an inactive admin reads nothing). Only the service role inserts.
- The Audit log tab's list filters today: date range (`created_at` greater or equal and less or equal, sent as one
  `and=(...)`), actor (`actor_email` contains), action (equals). The proxy also allows `entity_type`, `entity_id`, `id`
  and, for a super admin, `municipality_id`.

## Filtered audit log export

`POST /api/admin/export` with `{ "type": "audit_log", "path": "/rest/v1/audit_log?<filters>" }`. Without `type` it is
the reports export, unchanged. The filters are the tab's: `and` (date range), `actor_email`, `action`, plus
`entity_type`, and `municipality_id` for a super admin. Any other key (a column list, paging, ordering, another table) is
refused with 400.

- **Exactly the filters sent.** No filters means every row the caller may see. The rows are read with the caller's own
  token, so row level security applies, and the server adds the municipality scope for a municipality admin (naming a
  municipality as one is a 403). The file never holds more than the filtered list; a test compares the row count with
  the list's count for every filter.
- **Cap: 10,000 rows**, newest first. If more match, the first 10,000 are sent and this is said in the file name
  (`jabor-audit-log-<date>-first-10000.csv`) and in the headers `X-Truncated: true` and `X-Total-Rows: <n>`.
  (The reports export refuses over 10,000 instead.)
- **Columns:** `id, date (India time), actor, action, entity_type, entity_id, details, note`. `details` is the
  from and to values. For report rows, keys that can hold a person's details (`cleaned_by_name`, `name`, `phone`, `email`,
  `lat`, `lng`, `gps*`, `ip*`) are dropped, and text that looks like an email address or a phone number is replaced
  by `[email removed]` or `[phone removed]`. The actor's email is kept (staff, or `public` and `system`), and so are the
  emails inside staff account rows, which are staff emails. There is no actor id column, no coordinates and no IP.
- **Spreadsheet formulas:** a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading quote (the same
  helper as the reports export).
- **The export is logged** (`action = export`, `entity_id = audit_log`) with the filters, the number of rows, the total
  and whether it was cut, and it is written before the file is sent. If that fails, no file is sent.

## Create the first real super admin

Normal creation of super admins is deliberately not an API. The existing owner account already works: a
`staff_profiles` row with `role = super_admin` and the token role `admin` or `super_admin`. For a **new** super admin,
the owner does it once in the Supabase dashboard of the right project (staging first):

1. Authentication, Users, **Add user**: email and a strong password (12 or more characters), tick **Auto confirm**.
2. In the SQL editor, with that email in the two places:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"super_admin"}'::jsonb
where email = 'owner@example.com';

insert into public.staff_profiles (user_id, municipality_id, role, email, is_active)
select id, null, 'super_admin', email, true from auth.users where email = 'owner@example.com'
on conflict (user_id) do nothing;
```

3. Check: `select email, role, is_active from public.staff_profiles where role = 'super_admin';`, then sign in at
   `/admin`. The role in the token is signed by Supabase, so the person signs out and in once after the change.

(`scripts/create-demo-staff.mjs` is for demo accounts on staging and refuses production, so it is not used here.)

## Deactivate and reactivate

Through the API (a screen will call it): `POST /api/admin/staff/status` with the account's `user_id` and `is_active`.
By hand, in an emergency, the same effect in SQL (the API and this are equivalent; the next request is refused):

```sql
update public.staff_profiles set is_active = false where email = 'someone@example.com' and role = 'municipality_admin';
```

To remove a login completely, delete the user in Authentication, Users (the profile goes with it).

## Rollback

Nothing to roll back in the database: there is no migration. To take the feature out, revert the pull request. Accounts
created through it are ordinary municipality admins and keep working; deactivate or delete them as above. An
account that failed halfway never exists: the login is deleted, and if even that deletion fails the server log says
`staff create failed and the new login <id> could not be removed: remove it by hand`: delete that user in
Authentication, Users.

## Tests

- `api/_lib/staff-mgmt.check.js`: validation, who may call, the order of writes, rollback on each failure, duplicate
  email, the rules for switching accounts, immediate deactivation, the limiter (limit, per actor, Redis down, not
  configured), and that no password or key appears in a response, a log or an audit row.
- `api/_lib/export.check.js`: the audit export (filters against the list's count, scope, cap, injection, redaction, logging).
- `supabase/tests/database/110_audit_log_staff_actions.test.sql`: the table takes the new rows, stays append-only, and who reads what.
