# Access matrix

Written for T3 (roles and server-side access control). This section describes what exists **before**
T3. It is checked against the code on `staging` and the staging database on 2026-10-11. The target
matrix is added at the end when it is built.

Keys used in the tables:

- **anon**: the public Supabase key. Subject to RLS as role `anon`.
- **user JWT**: the signed-in admin's token, taken from the HttpOnly cookie. Subject to RLS as `authenticated`.
- **service role**: bypasses RLS. Server code only.

## 1. Endpoints in `api/`

| Route | Method | Tables touched | Key | Who may call it today |
|---|---|---|---|---|
| `/api/reports/submit` | POST | `reports` (insert), `mla_list`, `mp_list` (read); calls edge function `jabor-notify` | service role (falls back to anon if `SUPABASE_SERVICE_ROLE_KEY` is unset); anon for the notify call | Anyone. Upstash limit 3 per 10 min per IP. Turnstile is **skipped when `TURNSTILE_SECRET_KEY` is unset**. |
| `/api/cleanup-proofs` | POST | `reports` (read), `cleanup_proofs` (insert) | service role | Anyone. Limit 5 per 10 min. Turnstile is required, and the route errors if the secret is unset. |
| `/api/cloudinary-signature` | POST | none (signs a Cloudinary upload) | Cloudinary secret | Anyone. Limit 20 per 10 min. No Turnstile. |
| `/api/health` | GET | `mla_list` (read) | anon | Anyone. |
| `/api/admin/login` | POST | Supabase Auth (password grant) | anon | Anyone with credentials. Limit 5 per 15 min. Accepts only `app_metadata.role = 'admin'`. |
| `/api/admin/session` | GET | Supabase Auth (`/user`) | user JWT | Cookie holder with role `admin`. |
| `/api/admin/logout` | POST | Supabase Auth (`/logout`) | user JWT | Anyone. |
| `/api/admin/rest` | POST | **any table** in `rest/v1`, plus three edge functions | user JWT | **Any holder of a valid session cookie.** The role is checked only at login and at token refresh, not per request. |

Cross-site requests are rejected for every POST (Origin must match the host).

## 2. The admin proxy `/api/admin/rest`

Accepts a path, a method, a `Prefer` value and a body from the browser and forwards them to Supabase
with the cookie's token.

- Path: `/rest/v1/<any table name>?<any query>` or `/functions/v1/jabor-(recommendations|execute|embed)`.
  RPC paths do not match the pattern.
- Methods: GET, POST, PATCH. No DELETE (removed in PR #18).
- The query string is not inspected, so embedded tables (`select=*,report_contacts(*)`) and any filter pass.
- `Prefer` is forwarded as sent.
- No role check, no table allowlist, no municipality scoping. Access is decided only by RLS, by table
  privileges, and by `requireAdmin` inside the edge functions.

## 3. Edge functions (`supabase/functions`)

| Function | Auth inside the function | Key it uses | Tables | Real-world effect | Who can invoke it |
|---|---|---|---|---|---|
| `jabor-recommendations` | `requireAdmin`: signed-in user whose `app_metadata.role` is `admin` | service role | reads `reports`, `escalation_guidelines`, `authority_contacts`; writes `recommendations_audit`; calls `match_reports` | Calls the Anthropic API (cost) | The admin proxy, or anyone holding an admin JWT calling Supabase directly |
| `jabor-execute` | `requireAdmin` (same) | service role | reads and updates `reports` (`tweeted_at`, `emailed_at`); writes `recommendations_audit` | **Posts to X and emails real authorities** | Same |
| `jabor-embed` | `requireAdmin` (same) | service role | reads and updates `reports.embedding` | Calls the AI runtime | Same |
| `jabor-notify` | Shared secret in the `x-jabor-notify-secret` header (`NOTIFY_SHARED_SECRET`). No user involved. | service role | reads and writes `report_contacts` | Emails the reporter a confirmation | Only `api/reports/submit`, which holds the secret |

`requireAdmin` does not look at `staff_profiles`, so a deactivated admin still passes it until the auth
user is banned. All four functions answer CORS with `Access-Control-Allow-Origin: *`.

## 4. Tables the admin UI reads or writes

Through the proxy (everything an admin screen does today):

| Table | Reads | Writes | Where |
|---|---|---|---|
| `reports` | list (including hidden and invalid), Hidden tab | PATCH: hide, approve a proof (`cleaned`), restore | `reportService.js`, `cleanupService.js` |
| `cleanup_proofs` | pending proofs (embeds `reports`) | PATCH: approve, reject | `cleanupService.js` |
| `report_contacts` | reporter name and email | none | `reportService.js` |
| `audit_log` | who hid a report, and why | none | `reportService.js` |
| edge functions | n/a | recommendations, execute, embed | `agentService.js` |

The public site reads only `public_reports`, `cleanup_proofs` (five columns) and `mla_list` with the anon key.
No browser code writes to the database directly.

## 5. RLS and privileges on staging (relevant to access)

| Table | `authenticated` privileges | Policies for `authenticated` | Rule type |
|---|---|---|---|
| `reports` | SELECT, UPDATE | Staff read, Staff update | helper functions (active staff, municipality) |
| `cleanup_proofs` | SELECT, UPDATE | Staff read, Staff update | helper functions, through the report |
| `wards`, `ward_localities`, `municipalities`, `audit_log`, `staff_profiles` | SELECT | one SELECT policy each | helper functions |
| `report_contacts` | SELECT | Admin read | **JWT role = `admin`** |
| `authority_contacts`, `escalation_guidelines` | SELECT | Admin read | **JWT role = `admin`** |
| `recommendations_audit` | SELECT, INSERT, UPDATE | Admin read, write, update | **JWT role = `admin`** |

## 6. Findings

**High, once a second role can sign in (it cannot today):**

1. **The proxy has no role check and no allowlist.** It forwards any table name and any query string.
   Today only `admin` users can get a cookie, so RLS is enough. The moment a `municipality_admin` can log
   in, the only things between that user and the contact tables are the RLS policies. They do hold
   (the four agent tables check the JWT role `admin`), but that is one layer, not two.
2. **Embedded tables are not inspected.** A query like `reports?select=*,report_contacts(*)` passes the
   proxy. RLS on `report_contacts` is what stops it for non-admins.

**Medium:**

3. **Deactivation does not reach the four agent tables or the edge functions.** `report_contacts`,
   `authority_contacts`, `escalation_guidelines`, `recommendations_audit` and `requireAdmin` check the
   JWT role only, not `staff_profiles.is_active`. A deactivated admin keeps access to them until their auth
   user is banned and the token expires. The newer tables do check `is_active`.
4. **Login and session ignore `staff_profiles`.** A deactivated staff member can still log in and get a
   session. Only RLS then returns empty results.
5. **`jabor-execute` has real-world side effects** (X posts, emails to authorities). It is correctly limited
   to admins, but it must stay super-admin only and must never be exercised on staging while staging holds
   real authority contacts.
6. **`jabor-notify` cannot take a user role check.** It is called by the server with a shared secret when a
   citizen submits a report. A "super admin only" check would break confirmation emails. It already
   rejects any caller without the secret, including every signed-in user.

**Existing, outside T3:**

7. `api/reports/submit.js` skips Turnstile when `TURNSTILE_SECRET_KEY` is unset (fails open), while
   `api/cleanup-proofs.js` fails closed.
8. `api/cloudinary-signature.js` has a rate limit but no Turnstile.
9. Whether the edge functions are deployed with JWT verification on cannot be seen from the repo.
