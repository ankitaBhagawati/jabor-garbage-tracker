# Access matrix

Who can do what, and where it is enforced. Written for T3 (roles and server-side access control) and
kept up to date with the code. Checked against `staging` and the staging database.

Keys: **anon** is the public Supabase key (RLS as `anon`). **user JWT** is the signed-in admin's token from the
HttpOnly cookie (RLS as `authenticated`). **service role** bypasses RLS and is only used on the server.

## 1. Roles and how they are decided

| Role | Who | Sees |
|---|---|---|
| `super_admin` | The owner. The older JWT role `admin` counts as `super_admin`. | Every municipality, the contact tables, the edge functions. |
| `municipality_admin` | JMB staff. One municipality. | Their own municipality's reports, wards, audit log, and their own profile. Nothing else. |

The role is decided on the server for every request, never from anything the browser sends:

1. Supabase Auth verifies the access token (`/auth/v1/user`).
2. The caller's own `staff_profiles` row is read with the caller's own token. RLS lets staff read only their own row,
   and only while it is active.
3. The signed role in the token (`app_metadata`, set only with the service role) and the profile must agree.
   For a municipality admin the token's `municipality_id` must equal the profile's. The municipality used for
   scoping comes from the profile.
4. Nothing is cached. Setting `is_active = false` takes effect on the very next request, even with a valid token.

Anything else (no profile, inactive, mismatched, an unknown role such as `authenticated`) is refused with 403 and the
session cookies are cleared.

## 2. The admin proxy `POST /api/admin/rest`

Default is deny. Allowed requests are rebuilt from validated parts, so Supabase receives exactly what was checked.
Code: `api/_lib/access.js`. Tests: `api/_lib/access.check.js`.

### Role x table x operation

`S` select, `U` update by id. No role may insert or delete through the proxy. `-` means denied (403).

| Table | super_admin | municipality_admin | Municipality scope added by the server |
|---|---|---|---|
| `reports` | S, U | S, U | `municipality_id = own` |
| `cleanup_proofs` | S, U | - | (not available to municipality admins yet) |
| `report_contacts` | S | - | |
| `audit_log` | S | S | `municipality_id = own` |
| `wards` | S | S | `municipality_id = own` |
| `ward_localities` | S | - | (not available to municipality admins yet) |
| `municipalities` | S | S | `id = own` |
| `staff_profiles` | S | S | `user_id = self` |
| `authority_contacts`, `escalation_guidelines`, `recommendations_audit` | - | - | Edge functions read these with the service role |
| anything else (`mla_list`, `mp_list`, `constituencies`, `report_activity`, RPCs, other schemas) | - | - | |

### Edge functions through the proxy

| Function | super_admin | municipality_admin |
|---|---|---|
| `jabor-recommendations`, `jabor-execute`, `jabor-embed` | POST | - |
| `jabor-notify` | - (not reachable through the proxy) | - |

### What a request may contain

- **Path:** exactly `/rest/v1/<table>` or `/functions/v1/<function>`. No sub-paths, no `rpc`, no encoded tricks, no query on functions.
- **Query keys:** only `select`, `order`, `limit`, `offset`, `or`, `and`, and the filter columns listed for that role and table. Anything else is refused.
  A key may appear once. A municipality admin may never send the scope key (`municipality_id`, `id` on municipalities, `user_id` on staff profiles); the server adds it.
- **`or=` and `and=`:** every column used anywhere inside, however nested, must be one the role may filter by. So `or=(municipality_id.eq.x,...)` is refused for a municipality admin.
- **Filters:** `col=op.value` with operators `eq neq gt gte lt lte in is like ilike`, optionally `not.`, on allowed columns only.
- **`select`:** explicit columns the role may read. `*` only on `cleanup_proofs`. No `embedding`. Embedded tables only where listed (`cleanup_proofs` embeds `reports` for a super admin); `reports?select=*,report_contacts(*)` is refused for everyone.
- **`order`:** up to 3 allowed columns. **`limit`:** 1 to 1000 (1000 is added when absent). **`offset`:** a number.
- **`Prefer`:** one of `return=minimal`, `return=representation`, `count=exact`. Nothing else (no upsert, rollback or missing=default). `Range` and every other client header are never forwarded.
- **Body envelope:** only `path`, `method`, `prefer`, `body`. A `role` or `municipality_id` key is refused.
- **Updates (PATCH):** one row, with `id=eq.<uuid>` as the only filter. Allowed body keys:
  - super_admin on `reports`: `status`, `is_deleted`, `ward_id`, `assigned_to_text`, `due_at`, `cleaned_by_name`, `cleaned_by_type`, `cleaned_at`, `invalid_reason`, `admin_note`, `updated_at`
  - municipality_admin on `reports`: `status`, `ward_id`, `admin_note`, plus `invalid_reason`, `cleaned_by_name`, `cleaned_by_type`, `cleaned_at`, which the status trigger requires with Invalid and Cleaned
  - super_admin on `cleanup_proofs`: `status` (approved or rejected), `admin_notes`, `updated_at`
  - Statuses are `active`, `in_progress`, `cleaned`, `invalid`; `cleaned_by_type` is `jmb`, `citizen` or `other` (never `auto`). The database trigger still enforces the transition rules and writes `audit_log`.
- **Errors:** denials return `403 {"error":"Not allowed."}` and are logged with user id, role, route and a reason code, never the query or body. Database errors keep `code` and `message` only.

## 3. Edge functions

| Function | Credential checked inside | Notes |
|---|---|---|
| `jabor-recommendations`, `jabor-execute`, `jabor-embed` | `requireSuperAdmin`: a valid user token whose role is `admin` or `super_admin` **and** an active `staff_profiles` row with role `super_admin`, read with the service role on every call. A municipality admin gets 403. | They run with the service role across all municipalities. `jabor-execute` posts to X and emails real authorities: never run it on staging while staging holds real contacts. |
| `jabor-notify` | The shared secret in `x-jabor-notify-secret`, compared in constant time, failing closed when the secret is not set. A user JWT of any role is not a credential. | Called only by `api/reports/submit.js`. |

## 4. Endpoints in `api/`

| Route | Method | Tables touched | Key | Who may call it |
|---|---|---|---|---|
| `/api/reports/submit` | POST | `reports` (insert), `municipalities`, `wards`, `mla_list`, `mp_list`; calls `jabor-notify` | service role; anon for the notify call | Anyone. Upstash limit, Turnstile, validation. |
| `/api/cleanup-proofs` | POST | `reports` (read), `cleanup_proofs` (insert) | service role | Anyone. Limit, Turnstile (required). |
| `/api/municipalities` | GET | `municipalities`, `wards`, `ward_localities` (read) | service role | Anyone. Reference data for the report form only. |
| `/api/cloudinary-signature` | POST | none | Cloudinary secret | Anyone. Rate limited. |
| `/api/health` | GET | `mla_list` (read) | anon | Anyone. |
| `/api/admin/login` | POST | Supabase Auth, `staff_profiles` (own row) | anon, then the user's token | Anyone with credentials, rate limited. Accepts only active staff. |
| `/api/admin/session` | GET | Supabase Auth, `staff_profiles` (own row) | user JWT | Active staff. Returns email, role, municipality. |
| `/api/admin/logout` | POST | Supabase Auth | user JWT | Anyone. |
| `/api/admin/rest` | POST | per section 2 | user JWT | Active staff, per role. |

## 5. Database (RLS), the second layer

| Table | Who can read | Who can write |
|---|---|---|
| `reports` | staff of the municipality (super admin: all); anon only the public columns and public rows | staff update only (trigger limits columns and transitions); no client insert or delete |
| `cleanup_proofs` | staff through their report; anon the approved ones, five columns | staff update |
| `wards`, `ward_localities`, `municipalities`, `audit_log`, `staff_profiles` | staff of the municipality; super admin all; `staff_profiles` own row only | nobody from the client |
| `report_contacts`, `authority_contacts`, `escalation_guidelines`, `recommendations_audit` | active super admin only (`private.is_super_admin()`) | `recommendations_audit`: active super admin; others none |

`private.is_super_admin()` needs an active `staff_profiles` row, so deactivation also ends access here.

## 6. Findings from the T3 inventory

| # | Finding | Status |
|---|---|---|
| 1 | The proxy had no role check and no allowlist | Fixed: per-role allowlist, section 2 |
| 2 | Embedded tables were not inspected | Fixed: `select` is parsed; embeds only where listed |
| 3 | Deactivation did not reach the four agent tables or the edge functions | Fixed: policies use the helpers (migration `t3_staff_policies_is_active`); `requireSuperAdmin` reads the profile |
| 4 | Login and session ignored `staff_profiles` | Fixed: both resolve the staff member per request |
| 5 | `jabor-execute` has real-world side effects | Unchanged by design: super admin only; do not run on staging until contacts are replaced |
| 6 | `jabor-notify` cannot take a user role check | Kept on the shared secret, now constant time, with tests for user JWTs |
| 7 | `api/reports/submit.js` skips Turnstile when the secret is unset (fails open) | Fixed: refused with 503 in production (`VERCEL_ENV`); still skipped in Preview and local |
| 8 | `/api/cloudinary-signature` has no Turnstile | Open |
| 9 | Whether the edge functions are deployed with JWT verification on | Cannot be seen from the repo; check the Supabase dashboard |

## 7. T5: the admin dashboard needed no allowlist additions

Every request the dashboard sends (tiles, reports page, report drawer, wards, municipalities, audit log, hidden tab, status, ward and note updates) is already allowed by sections 2 to 4. `api/_lib/dashboard.check.js` builds each request shape for both roles and checks it against `authorize()`, so a change to the query builders that needs a wider allowlist fails `npm test`.

- A municipality admin's update body is limited to status, ward, note and the fields the status rules add (cleaned by, invalid reason). The status trigger and `audit_log` still apply.
- The audit log gained one action, `note_change`, written when only `admin_note` changes (migration `t5_audit_note_changes`; apply it before deploying the code).
- The drawer shows the after photo from the public view, not from `cleanup_proofs`, which stays denied to municipality admins.
- Nothing in the dashboard sends DELETE, and no map, GPS or contact details are requested for a municipality admin.

## 8. T6/T7: exports, monthly report, hotspots

Three tabs for both staff roles (Monthly report, Hotspots, and the Export button on the Dashboard). Nothing
public. Detail: `docs/REPORTS.md`, `docs/HOTSPOTS.md`.

**Allowlist additions** (`api/_lib/access.js`, `RPCS`): the only change to the proxy.

| Route | Method | Who | Body the proxy accepts |
|---|---|---|---|
| `/rest/v1/rpc/monthly_ward_report` | POST | super_admin, municipality_admin | `p_month` (the 1st of a month, 2020 or later); a super admin also `p_municipality` (uuid) |
| `/rest/v1/rpc/ward_hotspots` | POST | super_admin, municipality_admin | `p_days` (30, 60 or 90); a super admin also `p_municipality` (uuid) |

Everything else about an RPC call is refused: other functions, other methods, any query string, any `Prefer`,
extra or missing keys, arrays, wrong types. A municipality admin that sends `p_municipality` is refused
(`scope-key`); for them the proxy adds their own. Other database functions (including `private.*` helpers and
`auto_clean_old_reports`) are not routes.

**New route** `POST /api/admin/export` (not through the table proxy): same session and role lookup as the proxy.
The body holds one key, `path`, and it must be `/rest/v1/reports` with only an `and` filter (and, for a super
admin, `municipality_id`). Any other key, column, order or paging is refused with 400. The server then reads
with `authorize()` (so the municipality scope is added for a municipality admin and a municipality admin naming
one is refused with 403), writes the audit row with the service role, and only then sends the file.

**Database:** both functions are `SECURITY INVOKER`: row level security on `reports`, `wards` and `audit_log`
applies, and the functions check the caller again (a municipality admin gets their own municipality whatever
is passed; a super admin names one; deactivated and non-staff users get no rows). `EXECUTE` is granted to
`authenticated` only; `anon` and `PUBLIC` cannot run them. No coordinates, contact details or free text are in
either result.

| | super_admin | municipality_admin | anon |
|---|---|---|---|
| `monthly_ward_report`, `ward_hotspots` through the proxy | yes, names the municipality | yes, own municipality only | no (no session) |
| The same functions called directly in Supabase | yes | own municipality only | permission denied |
| `POST /api/admin/export` | yes | own municipality only | 401 |

## 9. Staff management and the audit log export

Dedicated routes outside the proxy, super admin only (details: `docs/STAFF-MANAGEMENT.md`). The proxy allowlist is unchanged.

| Route | super_admin | municipality_admin | anon |
|---|---|---|---|
| `GET /api/admin/staff` (list) | yes | 403 | 401 |
| `POST /api/admin/staff` (create a municipality admin; role fixed by the server) | yes | 403 | 401 |
| `POST /api/admin/staff/status` (switch a municipality admin on or off) | yes (not yourself) | 403 | 401 |
| `POST /api/admin/export` with `type: "audit_log"` | all rows, or one municipality by filter | own municipality only (naming one is 403) | 401 |

Inactive staff, a missing profile, a token and profile that disagree, and a role such as `authenticated` get 403, as
for the proxy. Creating accounts uses the Auth admin API with the service role key, on the server only. Create and
status changes are limited to 10 per hour per actor and fail closed if Redis is unreachable.

## 10. Hide and restore for municipality admins

Changed in migration `20261012160000_t13_municipality_admin_hide`. A municipality admin may hide and unhide reports of
their own municipality; before, only a super admin could.

- **Database:** the update trigger on `reports` allows a change to `is_deleted` for any active staff member. Row level
  security still limits a municipality admin to reports of their municipality, the column whitelist and the status rules
  are unchanged, and nothing can be deleted (no role has DELETE). Every hide and unhide writes an audit row with the actor.
- **Proxy:** `is_deleted` is added to a municipality admin's allowed update keys on `reports`, and it must be `true` or
  `false` (for every role). Sent together with a key outside the allowed list, the request is still refused.
- **Screens:** the report drawer has "Hide from public site" (reason required, note optional) and, for a hidden report,
  "Restore to public site". The Hidden tab lets both roles restore.
- **Not given to municipality admins:** the older owner screen **Moderation** (AI recommendations, which can email
  authorities and post to X, and reporter contacts) and **Cleanup Verification** (cleanup proofs). Both stay super admin only.
