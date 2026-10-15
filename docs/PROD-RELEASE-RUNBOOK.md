# Production release runbook: staging to jabor.in

Written 2026-10-13 from the repository only. **Nothing here was run against production, and no production
credential was used.** Every step is the owner's (see `docs/RELEASE.md`, "Who does what"). Every command uses a
variable, never a literal secret:

| Variable | What it is |
|---|---|
| `PROD_DB_URL` | Production Postgres connection string, session pooler (port 5432). Owner's shell only. |
| `PROD_REF` | `wukftoblpeybortcnkuw` |
| `STAGING_DB_URL` | Staging connection string |
| `REHEARSAL_DB_URL`, `REHEARSAL_REF` | The temporary rehearsal project (section 2). Never the production ref. |

Do not run `supabase link` to production. Every CLI command below passes `--db-url` or `--project-ref` instead.

## 0. What is being released, and what "old code" means

- **OLD code** = `origin/main` at `fe14c5d` (merge of PR #20, 2026-10-11). **NEW code** = `staging`.
- Production's database is the pre-T2 schema: no `municipalities`, `wards`, `staff_profiles`, `audit_log`, no `private`
  schema, no `supabase_migrations` table. Staging has all twelve files in `supabase/migrations/` (the twelfth, `20261015090000_municipality_admin_proof_review`, once it is applied there).
- Deployment order (differs from `docs/RELEASE.md` in one place, see 3.6): Vercel env vars, then migrations, then edge
  function secrets and deploys, then the merge to `main`.

**Not knowable from the repository** (check each before the rehearsal, section 9 lists them again):
1. Which commit `jabor.in` runs today. `main` at `fe14c5d` already contains the admin Hidden tab, which reads
   `audit_log`, `invalid_reason` and `admin_note`. If that commit is live, that tab already fails on production.
2. Whether the two production-side fixes (`rls_hotfix_public_reads`, `align_public_grants`) were already applied by hand.
   Both are written to be re-runnable, so applying them again is harmless.
3. Which version of each edge function is deployed, and whether Verify JWT is on (`docs/ACCESS-MATRIX.md` finding 9).
4. The Vercel Production environment (section 4) and the Supabase Auth settings (`docs/SUPABASE-AUTH-SETTINGS.md`).

---

## 1. Migrations on staging and not on production

Eleven files, in this order. The baseline (`20261008171232_baseline.sql`) is never executed; it is only marked applied
(3.2). `supabase db push` runs each file in its own transaction and stops at the first failure; files before it stay
applied. Regenerate this list with `ls supabase/migrations` on the day: any file added after 2026-10-13 belongs in it.

"Old code" below means `origin/main` at `fe14c5d`. Its database reads were listed from its source:
anon reads `public_reports` (17 columns), `cleanup_proofs` (5 columns), `mla_list`, `mp_list`, and, in one fallback
(`db.getReports` in `Jabor.jsx`), `reports` with 23 named columns. `api/reports/submit.js` and `api/cleanup-proofs.js`
write with the service role key. The admin reads and writes `reports`, `cleanup_proofs`, `report_contacts`, `audit_log`
and the four agent tables with the staff member's own token, through `/api/admin/rest`.

| # | File | What it changes | Old code keeps working? | Down script |
|---|---|---|---|---|
| 1 | `20261010074755_rls_hotfix_public_reads` | Replaces three permissive `reports` SELECT policies with one strict `anon` policy (not hidden, status in the public list). Drops the duplicate `Public read mla_list` and `Public read mp_list` policies. | **Yes**, with one check. The old frontend reads exactly the rows the strict policy allows. The check: the duplicate policies it keeps must exist on production (`Public read MLA list`, `Public read MP list`, `public read constituencies`). If production lacks them, the report form cannot load constituencies. Query in 5.5. | `20261010074755_rls_hotfix_public_reads.down.sql`. Restores the leak of hidden pending or cleaned reports. |
| 2 | `20261010082228_align_public_grants` | Resets and re-grants anon and authenticated privileges on every public table, view, sequence and function to staging's. Anon loses the ability to call `auto_clean_old_reports()`, to read non-approved or private `cleanup_proofs` columns, and to write `reports`. | **Yes only if the Production Vercel env has `SUPABASE_SERVICE_ROLE_KEY`.** Old `submit.js` falls back to the anon key when it is missing, and this migration removes anon INSERT on `reports`: every submission would then fail with a 502. `cleanup-proofs.js` has no fallback and already needs the key. Everything else the old code reads is still granted (verified column by column: `cleanup_proofs` select is exactly `report_id,image_url,status,created_at,updated_at`; `reports` stays readable by anon). | `20261010082228_align_public_grants.down.sql`. **Production only.** Reopens both gaps. |
| 3 | `20261010084259_t2_expand_municipalities` | PostGIS and pg_trgm (in `extensions`), schema `private`, `normalize_status`. New tables `municipalities`, `wards`, `ward_localities`, `staff_profiles`, `audit_log` (RLS on, SELECT for `authenticated` only). Seeds **Jorhat Municipal Board** and **wards 1 to 19 (names null)**. 15 new nullable columns on `reports`, a wider status check, three indexes. Backfills `municipality_id` for `district = 'Jorhat'` and `cleaned_by_type`. Creates a `super_admin` profile for every existing `auth.users` row whose app role is `admin` or `super_admin`. New staff policies on `reports` and `cleanup_proofs` (replace the `role = 'admin'` ones), `Public read reports` rewritten on `normalize_status`, **`DELETE` revoked from `authenticated` on `reports`**. **Replaces the `public_reports` view** (drops `assigned_to`, `rejected_at`, `is_deleted`, `lat`, `lng`; status becomes `active` or `cleaned`). Append-only audit triggers, `reports_before_update` (staff column whitelist and status moves) and `reports_audit`. Replaces `auto_clean_old_reports()`. Revokes `report_activity`; narrows grants on `constituencies`, `mla_list`, `mp_list`, `report_contacts`. | **Yes, with five behaviour changes the owner must accept** (below the table). Verified: all 17 view columns old code selects still exist; old status filters (`verified, pending, active, reported, open`, `cleaned`) match the view's `active` and `cleaned`; the old admin's approve, reject, hide and restore calls are the shapes the triggers were written for (the approve call sends only `status`, and the trigger fills "cleaned by" from the approved proof). | `20261010084259_t2_expand_municipalities.down.sql`. **Destroys data**: the new report columns, `audit_log`, `staff_profiles`, wards, localities, the `private` schema. Run last, after every later down script. |
| 4 | `20261010162253_t2_in_progress_to_active_and_auto_clean_setting` | Allows `in_progress` back to `active`. Adds `settings.auto_clean_enabled` (false) to every municipality. Rewrites `auto_clean_old_reports()` so a municipality's reports are swept only when that setting is true. | **Yes.** Same sweep behaviour as row 3 for Jorhat (off). | `20261010162253_..._setting.down.sql` |
| 5 | `20261011144926_t4_lite_public_ward` | `reports.source` (`public` or `demo`), a `before insert` trigger (ward must belong to the municipality) and an `after insert` trigger (writes a `report_created` row to `audit_log`). Adds `settings.public_form` to Jorhat. | **Yes.** Old `submit.js` sends no ward, so the insert trigger passes; the audit trigger runs as definer and writes `public` or `system`. Side effect: one `audit_log` row per submitted report. | `20261011144926_t4_lite_public_ward.down.sql`. Drops `reports.source`. Roll the code back first. |
| 6 | `20261011145402_anon_reports_column_grants` | Anon loses table-wide SELECT on `reports` and gets SELECT on 23 named columns. | **Yes for `main` at `fe14c5d`**: the list equals `REPORT_SELECT` in its `reportService.js` and the select in `Jabor.jsx` `getReports`. **No for anything else that reads `reports` as anon with `select=*` or with a filter on another column**: PostgREST answers "permission denied". Old deployments, bookmarks, scripts, or an older cached bundle are the only way to hit it. | `20261011145402_anon_reports_column_grants.down.sql` |
| 7 | `20261011153608_t3_staff_policies_is_active` | The four agent tables (`authority_contacts`, `escalation_guidelines`, `recommendations_audit`, `report_contacts`) follow `private.is_super_admin()`. Creates a profile for every admin account first, and **aborts, changing nothing, if no active super admin profile would exist**. | **Yes if the owner's account passes the guard.** The token role must be `admin` or `super_admin` and the profile active. Run the query in `docs/MIGRATIONS.md` ("Before the T3 policy migration") first (5.1). An admin whose token role is something else loses access to the agent tables and to reports. | `20261011153608_..._is_active.down.sql`. Keeps the profiles it created. |
| 8 | `20261011154754_t5_audit_note_changes` | `reports_audit()` also writes a `note_change` row. | **Yes.** Function only. | `20261011154754_t5_audit_note_changes.down.sql` |
| 9 | `20261011170000_t6_t7_report_functions` | Two staff-only functions, `monthly_ward_report` and `ward_hotspots` (security invoker, not executable by anon). | **Yes.** New objects, nothing reads them. | `20261011170000_t6_t7_report_functions.down.sql` |
| 10 | `20261012160000_t13_municipality_admin_hide` | `reports_before_update()` lets a municipality admin hide and restore. | **Yes.** Function only. | `20261012160000_t13_municipality_admin_hide.down.sql` |
| 11 | `20261015090000_municipality_admin_proof_review` | New `review_cleanup_proof()` (security invoker, approve or reject a pending proof and close the report in one transaction; `authenticated` only). New `cleanup_proofs_audit` trigger (`proof_approved` / `proof_rejected` rows). `authenticated` UPDATE on `cleanup_proofs` narrowed to `status`, `admin_notes`, `updated_at`. | **Yes.** Old code PATCHes a proof with `status`, `admin_notes`, `updated_at` only, all still granted, and its approval now also writes a `proof_approved` audit row. New code needs this file applied first (it calls the function). | `20261015090000_municipality_admin_proof_review.down.sql`. Roll the code back first. |

### Behaviour changes old code will show after row 3 (none is an error; all need the owner's yes)

1. **Pending reports become public.** The old view showed only `verified` and `cleaned`. The new view shows
   `pending`, `active`, `reported` and `open` as "active". `submit.js` inserts with the column default (`verified`), so
   this matters only if production holds `pending` rows (an old moderation queue). Count them first (5.1).
2. **Jorhat reports stop being auto-cleaned.** Every report with `district = 'Jorhat'` gets a municipality in the
   backfill; the sweep skips municipalities whose `auto_clean_enabled` is false (it is). Active Jorhat reports older
   than 15 days stay Active until JMB closes them. Reports from other districts are still swept.
3. **New reports submitted by old code have no municipality** (old `submit.js` never sets one). They are visible to the
   super admin, invisible to a municipality admin, and still swept after 15 days. The window closes when the new code is
   deployed. Re-run the backfill statement from migration 3 (idempotent) afterwards (section 7, option A).
4. **A signed-in admin without a `staff_profiles` row sees no reports.** Existing `admin` and `super_admin` accounts get
   one from migrations 3 and 7.
5. **No client can delete a report** (the old policy allowed deleting rejected ones; nothing used it).

---

## 2. Rehearsal on a temporary Supabase project

Purpose: run the real migrations on a copy of production's data and privileges, then run both versions of the code.
The copy holds real reporter contacts. Treat the rehearsal project as production data: no edge functions, no Resend,
no Turnstile or Cloudinary production keys, and delete it when done (2.7).

### 2.1 Create the target

Create a new Supabase project in the same region and with the same Postgres major version as production. Record its ref
as `REHEARSAL_REF` and its session pooler URL as `REHEARSAL_DB_URL`. In its dashboard, enable the same extensions
production has. The baseline needs `pgcrypto`, `vector` and `pg_cron`; migration 3 creates `postgis` and `pg_trgm` itself (production already had postgis).
Check the exact list and versions on production first:

```bash
psql "$PROD_DB_URL" -X -At -c "select extname, extversion from pg_extension order by 1"
```

Supabase also offers "restore a backup to a new project" for paid plans. If it is available, use it and skip 2.2 and
2.3; carry on from 2.4. The commands below work on any plan.

### 2.2 Dump production (read-only)

```bash
mkdir -p .local/rehearsal
pg_dump "$PROD_DB_URL" --schema=public --no-owner -Fc -f .local/rehearsal/prod-public.dump
pg_dump "$PROD_DB_URL" --data-only --no-owner -Fc \
  --table=auth.users --table=auth.identities -f .local/rehearsal/prod-auth.dump
```

`.local/` is gitignored. Keep the grants: do **not** pass `--no-privileges`. The rehearsal is only useful if it has
production's privileges (`docs/RELEASE.md` explains why).

### 2.3 Restore

```bash
pg_restore --no-owner --exit-on-error -d "$REHEARSAL_DB_URL" .local/rehearsal/prod-auth.dump
pg_restore --no-owner --clean --if-exists -d "$REHEARSAL_DB_URL" .local/rehearsal/prod-public.dump
```

Expect warnings about objects owned by Supabase extensions; any error that mentions a `public` table, policy, grant or
function is a finding, not noise. If `pg_restore` of `auth` fails on a missing `auth` column or default, restore it
with `--disable-triggers` and note the project's Auth version. Then compare:

```bash
psql "$PROD_DB_URL"      -X -At -c "select count(*) from public.reports"
psql "$REHEARSAL_DB_URL" -X -At -c "select count(*) from public.reports"
```

Both counts must match.

### 2.4 Prove the rehearsal looks like production

```bash
pg_dump "$REHEARSAL_DB_URL" --schema-only --schema=public --no-owner -f .local/rehearsal-public-before.sql
pg_dump "$PROD_DB_URL"      --schema-only --schema=public --no-owner -f .local/prod-public-before.sql
diff <(grep -E '^(GRANT|REVOKE|ALTER DEFAULT|CREATE POLICY|ALTER TABLE .* ROW LEVEL)' .local/prod-public-before.sql | sort) \
     <(grep -E '^(GRANT|REVOKE|ALTER DEFAULT|CREATE POLICY|ALTER TABLE .* ROW LEVEL)' .local/rehearsal-public-before.sql | sort)
```

The diff must be empty. If not, fix the restore first; a rehearsal on different privileges proves nothing.

### 2.5 Apply the migrations on the rehearsal

```bash
supabase migration repair --status applied 20261008171232 --db-url "$REHEARSAL_DB_URL"
supabase migration list --db-url "$REHEARSAL_DB_URL"
supabase db push --dry-run --db-url "$REHEARSAL_DB_URL"     # must list exactly the eleven files of section 1
supabase db push --db-url "$REHEARSAL_DB_URL"
```

Run the read-only checks in 5.1 first (they decide whether migration 7 will pass), and the verification SQL in 3.7
afterwards.

### 2.6 Database tests

```bash
scripts/pgtap-remote.sh "$REHEARSAL_DB_URL"
```

The script refuses only the production ref. Each file runs in a rolled-back transaction, so no rows remain and no
email is sent. Run it once on staging as a control (`scripts/pgtap-remote.sh "$STAGING_DB_URL"`); a test that fails
on both is a test bug, and one that fails only on the rehearsal is a data difference to understand.

### 2.7 Old and new code against the migrated rehearsal

Use a throwaway `.env.rehearsal` (gitignored; values from the rehearsal project only; Turnstile test keys
`1x00000000000000000000AA` and `1x0000000000000000000000000000000AA`; `CLOUDINARY_FOLDER_PREFIX=jabor-staging`;
no `RESEND_API_KEY`, no `NOTIFY_SHARED_SECRET`, no X keys). Never put a real Resend, X or Anthropic key in it.

**Old code** (the point of the rehearsal):

```bash
git worktree add ../jabor-main-rehearsal origin/main
cd ../jabor-main-rehearsal && npm ci
node --env-file=../jabor-garbage-tracker/.env.rehearsal node_modules/vite/bin/vite.js --port 5176 --strictPort
```

Then check by hand, on `http://localhost:5176`: the feed (Active and Cleaned tabs), a report with before and after
photos, the report form's district and constituency lists, a submitted report (it lands with no municipality), and, as
the owner's account copied from production, the admin: reports list, Hidden tab, approve and reject a cleanup proof,
hide and restore. Compare the feed count with production's.

**New code**: from the main checkout, the same with `staging` and
`PLAYWRIGHT_BASE_URL=http://localhost:5176 npx playwright test`. Remove the worktree and the project when finished:
`git worktree remove ../jabor-main-rehearsal`, then delete the project in the Supabase dashboard.

Record: every diff line in 2.4, every pgTAP failure, every manual check, and the elapsed time of `db push` (the longest
step is the `reports` backfill and the view replacement; on production's volume it should be seconds).

---

## 3. Production apply procedure (owner)

Prerequisites, all true before step 3.1: rehearsal done and written up; section 4 variables set in Vercel (3.5);
the owner has read 5.1 results; a maintenance slot chosen with no one editing reports in the admin.

### 3.1 Privilege dump and diff

```bash
mkdir -p .local
pg_dump "$PROD_DB_URL"    --schema-only --schema=public --no-owner -f .local/prod-public-with-privileges.sql
pg_dump "$STAGING_DB_URL" --schema-only --schema=public --no-owner -f .local/staging-public-with-privileges.sql
diff <(grep -E '^(GRANT|REVOKE|ALTER DEFAULT|CREATE POLICY|ALTER TABLE .* ROW LEVEL)' .local/prod-public-with-privileges.sql | sort) \
     <(grep -E '^(GRANT|REVOKE|ALTER DEFAULT|CREATE POLICY|ALTER TABLE .* ROW LEVEL)' .local/staging-public-with-privileges.sql | sort)
```

Staging is already migrated, so this diff is large. Read it as a checklist: **every** line must be explained by a
file in section 1 (new tables, new policies, the grants of migrations 2 and 6). A grant or policy difference that no
migration explains is a stop. Production was rebuilt from a dump once and has wider grants. Keep both files: after the
apply, the same command, run again, must show only the policy and grant lines of tables that exist on both.

Also take a data backup now (dashboard backup, or PITR if on): `pg_dump "$PROD_DB_URL" --schema=public --data-only -Fc -f .local/prod-public-data-before.dump`.

### 3.2 Baseline repair

Production has no migration history table; this creates it and marks the baseline applied without running it.

```bash
supabase migration repair --status applied 20261008171232 --db-url "$PROD_DB_URL"
supabase migration list --db-url "$PROD_DB_URL"
```

Expected `migration list`: twelve local versions, remote shows only `20261008171232`.

### 3.3 Dry run: the exact expectation

```bash
supabase db push --dry-run --db-url "$PROD_DB_URL"
```

It must print, in this order, and nothing else:

```
20261010074755_rls_hotfix_public_reads.sql
20261010082228_align_public_grants.sql
20261010084259_t2_expand_municipalities.sql
20261010162253_t2_in_progress_to_active_and_auto_clean_setting.sql
20261011144926_t4_lite_public_ward.sql
20261011145402_anon_reports_column_grants.sql
20261011153608_t3_staff_policies_is_active.sql
20261011154754_t5_audit_note_changes.sql
20261011170000_t6_t7_report_functions.sql
20261012160000_t13_municipality_admin_hide.sql
20261015090000_municipality_admin_proof_review.sql
```

Stop if the baseline is listed (the repair did not take), if a file is missing, or if any other file appears.

### 3.4 Apply

```bash
supabase db push --db-url "$PROD_DB_URL"
supabase migration list --db-url "$PROD_DB_URL"      # local and remote columns now match for all twelve
```

If a file fails, nothing from that file is applied. Do not edit it. Read the error, then decide with section 8.

### 3.5 Vercel Production variables (before the migrations, set in section 4)

At minimum, before step 3.4: `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`NOTIFY_SHARED_SECRET`, `TURNSTILE_SECRET_KEY`. No redeploy is needed for the old code to read `SUPABASE_SERVICE_ROLE_KEY`
on its next cold start, but trigger one redeploy of the current production deployment so it is certain.

### 3.6 Edge functions (after the migrations)

`docs/RELEASE.md` lists edge deploys before migrations. For this release, do them **after**: the new
`requireSuperAdmin` reads `staff_profiles`, which exists only after migration 3. Old functions keep working on the
migrated schema (they check the token role only). Section 5 lists the secrets. Then:

```bash
supabase functions deploy jabor-recommendations --project-ref "$PROD_REF"
supabase functions deploy jabor-execute         --project-ref "$PROD_REF"
supabase functions deploy jabor-embed           --project-ref "$PROD_REF"
supabase functions deploy jabor-notify          --project-ref "$PROD_REF"
```

Do not invoke `jabor-execute` or `jabor-notify` as a test (they send email and post to X). Check Verify JWT per function
in the dashboard (`docs/SUPABASE-AUTH-SETTINGS.md` item 18).

### 3.7 Post-apply verification SQL (read-only)

Run each with `psql "$PROD_DB_URL" -X -f <file>` or paste it. None of these writes.

```sql
-- 1. history
select version, name from supabase_migrations.schema_migrations order by version;   -- 11 rows

-- 2. new tables exist with RLS on
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('municipalities','wards','ward_localities','staff_profiles','audit_log')
order by 1;                                                                          -- 5 rows, all true

-- 3. Jorhat and its 19 wards
select m.slug, m.name, m.is_active, m.settings,
       (select count(*) from public.wards w where w.municipality_id = m.id) as wards,
       (select count(*) from public.wards w where w.municipality_id = m.id and w.name is not null) as wards_with_name
from public.municipalities m;                       -- jorhat, wards = 19, wards_with_name = 0 until JMB supplies names

-- 4. what anon can and cannot do
select has_table_privilege('anon','public.reports','insert')                       as anon_insert_reports,       -- false
       has_table_privilege('anon','public.audit_log','select')                      as anon_audit_log,            -- false
       has_table_privilege('anon','public.staff_profiles','select')                 as anon_staff,                -- false
       has_column_privilege('anon','public.reports','photo_url','select')           as anon_photo_url,            -- true
       has_column_privilege('anon','public.reports','admin_note','select')          as anon_admin_note,           -- false
       has_column_privilege('anon','public.reports','embedding','select')           as anon_embedding,            -- false
       has_function_privilege('anon','public.auto_clean_old_reports()','execute')   as anon_sweep,                -- false
       has_function_privilege('anon','public.monthly_ward_report(uuid,date)','execute') as anon_report_fn;        -- false

-- 5. every public column the old frontend reads is still granted to anon
select col, has_column_privilege('anon','public.reports',col,'select') as ok
from unnest(array['id','constituency','district','lok_sabha_seat','mla','mla_party','mp','mp_party','area','landmark',
  'waste_type','description','photo_url','lat','lng','status','assigned_to','rejected_at','is_deleted','created_at',
  'updated_at','tweeted_at','emailed_at']) as col order by col;                       -- all true

-- 6. policies on reports and cleanup_proofs (compare with the same query on staging: output must match;
--    the local stack shows 7 rows, including an anon INSERT policy named temporarily_blocked on reports)
select tablename, policyname, cmd, roles from pg_policies
where schemaname = 'public' and tablename in ('reports','cleanup_proofs') order by 1, 2;

-- 7. triggers on reports (expected: reports_before_insert, reports_before_update, reports_audit, reports_audit_insert)
select tgname from pg_trigger where tgrelid = 'public.reports'::regclass and not tgisinternal order by 1;

-- 8. the nightly sweep is still scheduled
select jobname, schedule, active from cron.job where jobname = 'jabor-auto-clean-old-reports';   -- 1 row

-- 9. the public view returns the same rows as before, plus any pending
select status, count(*) from public.public_reports group by 1 order by 1;
select status, is_deleted, count(*) from public.reports group by 1, 2 order by 1, 2;

-- 10. staff: the owner is an active super admin, every admin has a profile
select u.email, u.raw_app_meta_data ->> 'role' as token_role,
       coalesce(sp.role, 'NO PROFILE') as profile_role, coalesce(sp.is_active::text, '-') as active
from auth.users u left join public.staff_profiles sp on sp.user_id = u.id
where u.raw_app_meta_data ->> 'role' in ('admin','super_admin','municipality_admin')
order by u.created_at;

-- 11. backfill result (section 7 plans what to do with the rest)
select count(*) filter (where municipality_id is not null) as with_municipality,
       count(*) filter (where municipality_id is null)     as without_municipality,
       count(*) filter (where ward_id is not null)         as with_ward
from public.reports;
```

Then run the Supabase security and performance advisors on production and compare with staging's open warnings.
A deviation in 4, 5, 6 or 7 is a stop: do not merge to `main` until it is explained.

### 3.8 Merge and deploy

Open the `staging` to `main` PR, collect the "Production release steps" of every PR in it, merge **(owner)**. Vercel
deploys `jabor.in`. Build-time variables (section 4) must already be set, or the build bakes in the wrong values.
Then run section 8.

### 3.9 After the deploy

Re-run the idempotent municipality backfill (7, option A) to catch reports that old code inserted between 3.4 and 3.8.
Create the first real super admin (section 6) before anyone needs the admin.

---

## 4. Environment variable matrix

Every name read by `api/`, `src/`, `Jabor.jsx`, `SupportJaborSection.jsx`, `vite.config.js`, `supabase/functions` and the
build. "Build-time" means the value is baked into the browser bundle or the build, so changing it needs a redeploy.
Vercel scopes: **Production** (branch `main`) and **Preview** (branch `staging`, with `staging.jabor.in`).

| Variable | Read by | Production | Preview | Must differ prod vs staging | Build-time |
|---|---|---|---|---|---|
| `VITE_SUPABASE_URL` | browser, `api/` fallback | yes (prod project URL) | yes (staging) | **yes** | **yes** |
| `VITE_SUPABASE_ANON_KEY` | browser, `api/` fallback | yes | yes | **yes** | **yes** |
| `SUPABASE_URL` | `api/` (optional override) | optional, same as above | optional | **yes** if set | no |
| `SUPABASE_ANON_KEY` | `api/` (optional override) | optional | optional | **yes** if set | no |
| `SUPABASE_SERVICE_ROLE_KEY` | `api/` (submit, cleanup proofs, staff, export, municipalities) | **required before migration 2** | yes | **yes. Never copy staging's.** Server only, never `VITE_`. | no |
| `VITE_CLOUDINARY_CLOUD_NAME` | browser, `api/` | yes | yes | no (same account allowed) | **yes** |
| `CLOUDINARY_CLOUD_NAME` | `api/` fallback | optional | optional | no | no |
| `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | `api/cloudinary-signature.js` | yes | yes | recommended separate keys; same account is allowed | no |
| `CLOUDINARY_FOLDER_PREFIX` | `api/_lib/server.js` | **unset** (defaults to `jabor`) | `jabor-staging` | **yes** | no |
| `VITE_TURNSTILE_SITE_KEY` | browser, `vite.config.js` | yes (production widget) | yes (staging widget) | **yes** (widget hostname lists differ) | **yes** |
| `TURNSTILE_SECRET_KEY` | `api/_lib/server.js` | **required** (unset means the check is skipped: ACCESS-MATRIX finding 7) | yes | **yes**, and must belong to the same widget as the site key | no |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (`KV_REST_API_URL`, `KV_REST_API_TOKEN` accepted) | `api/` rate limits, staff routes | **required** (staff creation answers 503 without it) | yes | recommended separate database so staging traffic cannot spend production's limits | no |
| `NOTIFY_SHARED_SECRET` | `api/reports/submit.js`, edge `jabor-notify` | yes, **equal to the edge secret** | yes | **yes** | no |
| `APP_ENV` | `api/_lib/sentry.js`, browser (`vite.config.js` envPrefix) | `production` | `staging` | **yes** (staging turns GA4 off) | **yes** |
| `VITE_SENTRY_DSN`, `SENTRY_DSN` | browser, `api/` | yes | yes | may share one Sentry project; events are tagged by `APP_ENV` | `VITE_SENTRY_DSN`: **yes** |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | build (source maps) | yes | yes | no | **yes** (build only) |
| `VITE_RAZORPAY_PAYMENT_BUTTON_ID` | `SupportJaborSection.jsx` | the live button id | a test button id or unset | **yes** | **yes** |
| `VERCEL_ENV` | `api/_lib/server.js` (disables the in-memory rate limit fallback) | set by Vercel, do not set | set by Vercel | n/a | no |

Not in Vercel (local tooling only; never set them there): `SUPABASE_ACCESS_TOKEN`, `STAGING_DB_URL`,
`STAGING_PROJECT_REF`, `LOCAL_DB_URL`, `DEMO_*`, `E2E_*`, `PLAYWRIGHT_BASE_URL`, `VERCEL_AUTOMATION_BYPASS_SECRET`.
`vite.config.js` refuses to build if a `VITE_` name contains SECRET, SERVICE_ROLE, PRIVATE, PASSWORD or TOKEN, and
`npm run check:bundle` greps the built bundle for keys.

Checks after setting them (without printing values): `vercel env ls production` shows every Production name above;
for each build-time name, confirm the deployment that follows the change is newer than the change.

---

## 5. Edge functions: deploy and secrets

### 5.1 Read-only questions to answer on production before 3.4

`staff_profiles` does not exist yet, so the first query reads `auth.users` only.

```sql
-- who can sign in as staff, and with which token role (decides whether migrations 3 and 7 can lock anyone out)
select email, raw_app_meta_data ->> 'role' as token_role, created_at
from auth.users where raw_app_meta_data ->> 'role' is not null order by created_at;
-- status mix (decides behaviour change 1: pending reports become public)
select status, is_deleted, count(*) from public.reports group by 1, 2 order by 1, 2;
-- how reports can be written and read today
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'reports' order by 1;
select tablename, policyname from pg_policies
where schemaname = 'public' and tablename in ('mla_list','mp_list','constituencies') order by 1, 2;
```

Expect the owner's row with token role `admin` or `super_admin`. Any other role on the owner's row is a **stop** for
migration 7. Expect `Public read MLA list`, `Public read MP list` and `public read constituencies` in the last query.

### 5.2 Secrets per function

| Function | Secrets it reads | Notes |
|---|---|---|
| `jabor-recommendations` | `ANTHROPIC_API_KEY` | Super admin only. Production key, own budget limit. |
| `jabor-execute` | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | **Emails real authorities and posts to X.** |
| `jabor-notify` | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `NOTIFY_SHARED_SECRET` | Confirmation email to the reporter. |
| `jabor-embed` | none of its own | Super admin only. |
| all | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Injected by Supabase for each project. Do not set them by hand. |

Set with the CLI (values come from the owner's password manager, not from a file in the repo):

```bash
supabase secrets set --project-ref "$PROD_REF" NOTIFY_SHARED_SECRET="$PROD_NOTIFY_SHARED_SECRET"
supabase secrets set --project-ref "$PROD_REF" RESEND_API_KEY="$PROD_RESEND_API_KEY" EMAIL_FROM="Jabor <alerts@jabor.in>" EMAIL_REPLY_TO="$PROD_REPLY_TO"
supabase secrets set --project-ref "$PROD_REF" ANTHROPIC_API_KEY="$PROD_ANTHROPIC_API_KEY"
supabase secrets set --project-ref "$PROD_REF" X_API_KEY="$PROD_X_API_KEY" X_API_SECRET="$PROD_X_API_SECRET" X_ACCESS_TOKEN="$PROD_X_ACCESS_TOKEN" X_ACCESS_SECRET="$PROD_X_ACCESS_SECRET"
supabase secrets list --project-ref "$PROD_REF"     # names and digests only
```

### 5.3 Must not be copied from staging

- **`X_*` four keys**: staging's belong to whichever account was used for tests. Copying them posts production content
  as the wrong account, or posts test content to the real one.
- **`NOTIFY_SHARED_SECRET`**: generate a new value (`openssl rand -hex 32`) and set it identically in Vercel Production.
- **`RESEND_API_KEY`**: use a key for the verified production sender domain (SPF, DKIM, DMARC), not staging's. The
  fallback `EMAIL_REPLY_TO` in the code is a personal Gmail address; set it explicitly.
- **`SUPABASE_SERVICE_ROLE_KEY`** in Vercel, **`TURNSTILE_SECRET_KEY`**, **`UPSTASH_*`** (see section 4).
- `ANTHROPIC_API_KEY`: a separate key lets the owner cap and revoke production use independently.

Staging's contacts in `authority_contacts` and `report_contacts` are not replaced yet (standing rule): never run
send, escalate or notify flows on staging. On production, check `authority_contacts` holds real addresses before the
first escalation, and make the first use of `jabor-execute` a deliberate, single, supervised one.

---

## 6. The first real super admin on production

`scripts/create-demo-staff.mjs` and `scripts/lib/target.mjs` refuse the production project by design. Do this by hand,
once, in the production dashboard. It is the procedure already described in `docs/STAFF-MANAGEMENT.md`, with the checks
this release needs.

**Existing owner account.** If the owner already signs in as an `admin` today, migrations 3 and 7 give that account an
active `super_admin` profile. Check with 3.7 query 10, and sign out and in once so the session reflects it. Nothing
else is needed. Create a new account only for a new person.

**A new super admin** (replace the email in both places; use a real address you control):

1. Check `docs/SUPABASE-AUTH-SETTINGS.md` items 1 to 5 on production first: sign-ups off, anonymous sign-ins off. Open
   sign-up with an unknown role would let anyone create an account (the role is in `app_metadata`, which users cannot
   write, so the risk is nuisance accounts, not privilege).
2. Dashboard, Authentication, Users, **Add user**: the email, a strong password of 12 or more characters, **Auto confirm
   user** ticked.
3. SQL editor (run as the project owner):

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"super_admin"}'::jsonb
where email = 'owner@example.com';

insert into public.staff_profiles (user_id, municipality_id, role, email, is_active)
select id, null, 'super_admin', email, true from auth.users where email = 'owner@example.com'
on conflict (user_id) do nothing;
```

4. Verify (read-only):

```sql
select u.email, u.raw_app_meta_data ->> 'role' as token_role, sp.role, sp.is_active, sp.municipality_id
from auth.users u join public.staff_profiles sp on sp.user_id = u.id
where u.email = 'owner@example.com';          -- super_admin, super_admin, true, null
select action, actor_email, created_at from public.audit_log
where entity_type = 'staff_profile' order by id desc limit 3;      -- a staff_created row, actor 'system'
```

5. Sign in at `https://jabor.in/admin` (a fresh sign-in, so the token carries the new role). The header shows
   Super Admin, the municipality chooser starts on View all, and Add admins is in the menu.
6. Create the Jorhat municipality admin from **Add admins** (it uses the Auth admin API with the service role and
   Upstash, so both must be set in Production). Do not create municipality admins by hand in SQL.

Do not create a super admin through the app: no route does, deliberately.

### 6.1 Are the municipality and the 19 wards on production?

They are created by migration 3 (3.7 query 3). Expected: one row `jorhat`, 19 wards numbered 1 to 19, **names null**.
If query 3 shows anything else, a migration did not run: stop and use section 8.

The names of the wards and the localities in each ward are **not in the repository and must not be invented**. JMB has
to supply them. Proposal for loading them once they do (not written, not run):

- `data/jorhat/wards.csv` with columns `number,name` (19 rows) and `data/jorhat/ward_localities.csv` with
  `ward_number,name,aliases` (aliases separated by `|`), supplied and signed off by JMB, never typed by us.
- `scripts/load-jorhat-wards.mjs`, modelled on `scripts/create-demo-staff.mjs`: refuses any target but the one named
  by `--target`; dry run by default; `--execute` to write; reads the CSV; checks that every ward number is 1 to 19;
  `update public.wards set name = ...`; inserts localities with `on conflict` skipped; prints counts, never data
  other than ward numbers. Uses the service role from the environment.
- Ward polygons (`wards.geom`, MultiPolygon, SRID 4326) only from JMB's official boundary file, loaded with
  `ogr2ogr` or `shp2pgsql` into a staging table, validated with `ST_IsValid` and `ST_MakeValid`, then copied over.
  Until then, wards have no geometry and the geometry backfill (7, option C) cannot run.

---

## 7. Backfill proposal for existing production reports (no execution)

State after migration 3: every `district = 'Jorhat'` report has `municipality_id`; every report has `ward_id = null`
and `in_municipality = null`; `cleaned_by_type` is set on cleaned reports (`citizen` if an approved proof exists,
otherwise `auto`). Nothing else is guessed.

**Count first** (read-only):

```sql
select count(*) filter (where municipality_id is null)                          as no_municipality,
       count(*) filter (where municipality_id is not null and ward_id is null)  as jorhat_no_ward,
       count(*) filter (where lat is null or lng is null)                       as no_coordinates
from public.reports where coalesce(is_deleted,false) = false;
```

| Option | What it does | Risk |
|---|---|---|
| **A. Municipality by district** (already in migration 3) | `district = 'Jorhat'` sets the municipality. Re-run the same statement after the deploy to catch reports inserted by old code: `update public.reports r set municipality_id = m.id from public.municipalities m where m.slug = 'jorhat' and r.district = 'Jorhat' and r.municipality_id is null;` | A reporter who picked district Jorhat for a place outside the Jorhat Municipal Board still gets the municipality, because the district is wider than the board. The "inside the municipal area" answer exists only on new reports. Mitigation: JMB marks such reports Invalid (outside jurisdiction). |
| **B1. Leave wards empty** (recommended start) | JMB assigns each report from the Unassigned wards tab. No data risk. | Workload equals `jorhat_no_ward`. The monthly report and hotspots show them as Unassigned until done. |
| **B2. Match by locality text** | Needs `ward_localities` loaded. Propose in a temporary table first: `area` or `landmark` matched to a locality name or alias (exact, then trigram above a high threshold), only when exactly one ward matches. Review a sample with JMB, then apply. | Wrong ward on fuzzy matches, shared place names across wards, free-text typos. Only unique exact matches should be applied automatically. |
| **C. Match by coordinates** | After `wards.geom` is loaded: `ST_Covers(w.geom, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326))`, longitude first. | Depends entirely on boundary quality. Legacy reports have no recorded GPS accuracy or source, and `lat`/`lng` may be a pin or a device fix. A point on a ward border or a bad boundary assigns the wrong ward. Points inside no ward stay null (correct). |

Rules for any ward backfill:

1. Write to a temporary table first, review counts and a random sample with JMB, then apply in batches inside one
   transaction each.
2. Run it as `postgres` (not through the admin). The update trigger then skips the staff rules and **does not touch
   `updated_at`**. Do not set `updated_at`: the Cleaned feed orders by it.
3. Each assignment writes one `ward_change` row to `audit_log` with actor `system`. That is wanted, and it grows the log.
4. The ward must belong to the report's municipality (trigger-enforced), so set `municipality_id` first.
5. Do not touch `in_municipality`, `gps_*`, `cleaned_*` or status. Never backfill status.

---

## 8. Post-release smoke tests and the rollback decision tree

### 8.1 Smoke tests

The Playwright smoke suite refuses `jabor.in` on purpose (`playwright.config.js`), so these are manual and `curl`:

```bash
curl -s https://www.jabor.in/api/health                       # {"status":"ok"}
curl -sI https://www.jabor.in/ | grep -i x-robots-tag         # prints nothing
curl -sI https://www.jabor.in/privacy | head -1               # 200
curl -sI https://www.jabor.in/terms | head -1                 # 200
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://$PROD_REF.supabase.co/rest/v1/reports?select=admin_note&limit=1" -H "apikey: $PROD_ANON_KEY"   # 401 or 403 (column not granted)
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://$PROD_REF.supabase.co/rest/v1/audit_log?select=id&limit=1" -H "apikey: $PROD_ANON_KEY"        # 401 or 403
```

By hand: the feed (Active and Cleaned tabs, counts match 3.7 query 9), a report with before and after photos, the
photo viewer, the report form lists districts and constituencies and shows the municipal-area question for Jorhat,
`/admin` sign-in as the owner (Super Admin badge, View all, Add admins, Cleanup Verification, Moderation, Hotspots,
Monthly report), and a Jorhat municipality admin (own municipality only, no Add admins, no Moderation). Open one report
and change its internal note, then check `audit_log` shows the `note_change` row (this is a real write: pick one, or skip
and rely on staging). Submitting a real test report writes production data and sends the reporter email if an address
is given: only with the owner's explicit yes, with no email address, and hide it afterwards from the admin. Sentry shows
no new `production` errors for 30 minutes. Supabase logs show no 42501 (permission denied) from the anon role.

### 8.2 Decision tree

```
Something is wrong after the release
|
+-- Public feed or form broken?
|   +-- Submissions fail (502 "Could not save the report")
|   |     Cause is almost always SUPABASE_SERVICE_ROLE_KEY missing in Production (migration 2 removed anon insert).
|   |     FIX FORWARD: set the variable, redeploy. Do not run a down script.
|   +-- Feed empty or the form lists are empty
|         Check 3.7 queries 4, 5, 6. A missing mla_list, mp_list policy or a missing column grant.
|         FIX FORWARD with a one-line corrective grant or policy in a NEW migration file, applied by the owner.
|
+-- New code broken, database fine (UI bug, wrong env value, admin proxy refusing a valid request)
|     VERCEL INSTANT ROLLBACK to the previous production deployment, then revert the merge on main.
|     The schema is expand-only, so old code works on it (section 1). No down script.
|
+-- Admin cannot see reports / "Super admin access required" / locked out
|     Check 3.7 query 10 (profile missing, inactive, or token role not admin/super_admin), then sign out and in.
|     FIX FORWARD with the update/insert in section 6 (a data fix). If migration 7 aborted during apply, nothing
|     changed: fix the profile first, then re-run db push.
|
+-- A migration failed during db push
|     The failing file changed nothing (one transaction). Earlier files stay applied. Read the error, fix the
|     cause in the data or environment, re-run db push. Never edit an applied file.
|
+-- Data is being damaged by a migration (wrong rows hidden, auto-clean sweeping reports it should not, audit rows
|   wrong), and a forward fix is not obvious
      RUN DOWN SCRIPTS, NEWEST FIRST, ONE AT A TIME, checking after each:
        proof_review, t13, t6/t7, t5, t3, anon_reports_column_grants, t4, t2 in_progress, t2, align_public_grants, rls_hotfix
        psql "$PROD_DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollbacks/<version>_<name>.down.sql
        supabase migration repair --status reverted <version> --db-url "$PROD_DB_URL"
      Roll the Vercel code back FIRST for t4 and t2 (the new code sends the new fields).
      t2's down script DESTROYS audit_log, staff_profiles, wards, ward_localities and the new report columns.
      Dump them before running it: pg_dump "$PROD_DB_URL" -Fc --table=public.audit_log --table=public.staff_profiles
      --table=public.wards --table=public.ward_localities --table=public.municipalities -f .local/pre-rollback.dump
      Prefer stopping at the smallest script that removes the problem (e.g. only t13, only anon_reports_column_grants).
```

Rule of thumb: **code problem, roll back Vercel. Configuration problem, fix the variable. Permission problem, fix
forward with a new migration. Data-damaging migration, roll back that migration and those after it.**

---

## 9. Open risks

1. **What production runs today is unknown.** If `main` at `fe14c5d` is live, its admin Hidden tab and restore already
   fail against the pre-T2 schema. Read the current production deployment's commit in Vercel before the rehearsal.
2. **`SUPABASE_SERVICE_ROLE_KEY` may be missing in Production.** Then migration 2 breaks report submission. Checked in 3.5.
3. **Production grants may differ from staging in ways not covered by the two grant migrations.** The privilege diff
   (3.1) is the control; it is only as good as the person reading it.
4. **Lockout risk in migrations 3 and 7** if the owner's token role is not `admin` or `super_admin`. The guard protects
   against zero active super admins, not against the wrong person having one.
5. **Pending reports becoming public** (behaviour change 1) if production holds `pending` rows.
6. **Jorhat reports no longer auto-clean**, and Jorhat's whole district is treated as the board's area until JMB
   triages. JMB must agree to this before launch.
7. **Reports submitted between migrations and the deploy have no municipality** until the re-run backfill.
8. **Ward names, localities and boundaries do not exist.** Ward-level reports, hotspots and the monthly report are
   mostly "Unassigned" until JMB supplies data (section 6.1).
9. **Edge function Verify JWT state is unknown** (`docs/ACCESS-MATRIX.md` finding 9), and which function versions are
   deployed is unknown. Redeploy all four after the migrations.
10. **Open security findings in the access matrix**: `submit.js` skips Turnstile when the secret is unset (finding 7);
    `/api/cloudinary-signature` has no Turnstile (finding 8). Confirm the production secret is set; the second is not fixed.
11. **Leaked-password protection** is a Pro-plan setting and is the one open advisor warning on staging
    (`docs/SUPABASE-AUTH-SETTINGS.md` item 8). Decide before launch.
12. **Custom SMTP (Resend) for Supabase Auth** is required for staff invites and resets on production; the built-in mailer
    is rate limited.
13. **Staging's agent contacts are placeholders.** Production's `authority_contacts` must be checked before any
    escalation. `jabor-execute` really emails and posts to X.
14. **Rehearsal data is real personal data.** Keep it short-lived, access-limited, and delete it.
15. **`docs/RELEASE.md` order differs** from section 3.6 for this release. Update it in a separate change.
16. **Upstash**: sharing one database between staging and production lets staging traffic consume production's rate
    limits. Use a separate one.
17. **`pg_restore` into a new project may not reproduce everything** (extension versions, Auth schema version). The
    empty diff in 2.4 is the check; if it cannot be made empty, the rehearsal proves less than this runbook assumes.
18. **No automated production smoke tests exist** and the Playwright config refuses production. Section 8.1 is manual.
