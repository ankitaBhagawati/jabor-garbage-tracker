# Demo data on staging

Two scripts turn staging into a safe demo environment: one empties it of real report data, the other fills
it with synthetic Jorhat reports. Both run only against the staging database (or, with `--local`, the
local Supabase stack). They refuse production and any other project, and print no secrets or row values.

| Script | What it does |
|---|---|
| `scripts/wipe-staging-data.mjs` | Deletes reports and everything derived from them. Replaces real authority contacts with fakes. |
| `scripts/seed-demo-data.mjs` | Creates about 150 synthetic Jorhat reports with their history. |

Both are a dry run unless you pass `--execute`, and `--execute` asks you to type the staging project
ref (`uefijiwklnelmwcipwku`) first.

## What the wipe deletes, replaces and keeps

- **Deletes:** `reports` (and through foreign keys `cleanup_proofs` and `report_contacts`),
  `recommendations_audit`, `report_activity`, and the `audit_log` rows with `entity_type = 'report'`.
  The audit log is append-only, so the script switches its no-delete trigger off inside the one
  transaction and back on before it commits.
- **Replaces:** every row of `authority_contacts` gets `Demo Authority NNN`, `authority-NNN@example.invalid`
  and phone `0000000000`. Authority type, district and constituency stay.
- **Keeps:** `staff_profiles`, `municipalities`, `wards`, `ward_localities`, `mla_list`, `mp_list`,
  `constituencies`, `escalation_guidelines`, the audit rows about staff, and every auth user.
- **Cloudinary:** never called. Photos stay where they are; only the database rows pointing at them go.
- If a table exists that the script does not know, it stops and says so, so nothing keeps report data by accident.

`escalation_guidelines` is kept, but its guidance text may name real people. Read it once yourself.

## What the seed creates

All rows are marked `reports.source = 'demo'` and belong to the Jorhat municipality.

- 150 reports: 83 active, 22 in progress, 38 cleaned, 7 invalid (55%, 15%, 25%, 5%).
- Spread over the 19 wards with some heavy and some light; 15 reports have no ward.
- Dates over the last 60 days, more in recent weeks. Active reports older than the overdue threshold
  (`municipalities.settings.overdue_after_days`, 7) show as overdue.
- Cleaned reports are cleaned by `jmb` or `citizen`, never `auto`. About 26 have an approved proof photo.
- Repeat locations: about 14 places have two or more reports, and several have a cleaned report and a newer open one.
- About 38 reports have a fake reporter contact (`demo-citizen-NNN@example.invalid`).
- Each report has a believable history in `audit_log`: created, ward assigned, in progress, cleaned or invalid.
- Descriptions start with `[Demo]`. Places are `Demo Area NN` and `Demo Landmark NN`. If JMB's own
  locality names have been loaded into `ward_localities`, those are used instead. Ward names are never invented.
- Photos are `/demo/placeholder-*.svg`, served by the site itself. Nothing is uploaded.

Running the seed again does nothing while demo rows exist. `--replace` clears them and seeds again.

## Run order on staging

Run from the repository root, on a machine with `psql` installed and `.env.local` holding the staging
settings (`STAGING_DB_URL` is the session pooler connection string).

1. **Make sure the code is deployed and Cloudinary is isolated.**
   - This PR and the T4-lite PR are merged to `staging`, the migrations are applied, and Vercel has deployed
     staging (the demo images live in `public/demo`).
   - Vercel, Preview scope: `CLOUDINARY_FOLDER_PREFIX=jabor-staging`.
   - Staging and production still share one Cloudinary account and API key. The scripts never call
     Cloudinary, but until staging has its own account or a restricted key, anything with staging's key
     can reach production's photos.
   - `psql --version` works.
2. **Wipe, dry run.** Read the counts and the keep list.
   ```bash
   node --env-file=.env.local scripts/wipe-staging-data.mjs
   ```
3. **Wipe, for real.** Type `uefijiwklnelmwcipwku` when asked.
   ```bash
   node --env-file=.env.local scripts/wipe-staging-data.mjs --execute
   ```
4. **Create the demo staff** (optional). `scripts/create-demo-staff.mjs` belongs to T3 and is not written yet.
   Without staff accounts the demo history is attributed to a fake `jmb-demo-staff@example.invalid`.
   Once real demo accounts exist, run the seed with `--replace` to attribute the history to them.
5. **Seed, dry run.**
   ```bash
   node --env-file=.env.local scripts/seed-demo-data.mjs
   ```
6. **Seed, for real.** Type `uefijiwklnelmwcipwku` when asked. It prints its own checks afterwards.
   ```bash
   node --env-file=.env.local scripts/seed-demo-data.mjs --execute
   ```
7. **Verify** with the queries below, then look at `https://staging.jabor.in`.

## Verification queries (staging SQL editor)

```sql
-- 150 demo reports, 83 / 22 / 38 / 7
select status, count(*) from public.reports where source = 'demo' group by status order by status;
-- reports per ward, and the 15 with none
select coalesce(w.number::text, 'none') as ward, count(*) from public.reports r left join public.wards w on w.id = r.ward_id group by 1 order by 2 desc;
-- who cleaned: jmb and citizen only; auto must be 0
select cleaned_by_type, count(*) from public.reports where status = 'cleaned' group by 1;
-- history ends in each report's status: must be 0
select count(*) from public.reports r where r.source = 'demo' and coalesce((select a.to_value ->> 'status' from public.audit_log a
  where a.entity_type = 'report' and a.entity_id = r.id::text and a.action = 'status_change' order by a.created_at desc, a.id desc limit 1), 'active') <> r.status;
-- nothing real is left: all three must be 0
select count(*) from public.authority_contacts where email not like '%@example.invalid' or phone <> '0000000000';
select count(*) from public.report_contacts where email not like '%@example.invalid';
select count(*) from public.reports where source = 'demo' and photo_url not like '/demo/%';
-- the audit triggers are on: must be 0
select count(*) from pg_trigger where tgrelid in ('public.reports'::regclass, 'public.audit_log'::regclass) and not tgisinternal and tgenabled <> 'O';
```

On the site: the feed shows Active (105) and Cleaned (38). Active counts in-progress reports, because the
public site shows them as Active.

## Trying the scripts without staging

```bash
supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,realtime,storage-api,supavisor,postgres-meta
supabase db reset --local
node --env-file=.local/local-app.env scripts/seed-demo-data.mjs --local
```
`--local` only accepts a database on this machine, and asks you to type `local` instead of the project ref.
