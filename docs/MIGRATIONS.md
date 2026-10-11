# Database migrations

Schema changes go only through `supabase/migrations/*.sql`. No SQL editor edits.
The loose `supabase/jabor-*.sql` files are history. Do not run them again; the baseline migration replaces them.

## Projects

| | Staging | Production |
|---|---|---|
| Project ref | `uefijiwklnelmwcipwku` | `wukftoblpeybortcnkuw` |
| Git branch | `staging` | `main` |
| Who applies migrations | Developer or CI | Owner only, after review |

## Link the CLI to staging

The CLI keeps the linked project in `supabase/.temp/` (gitignored). Check it before every CLI command:

```bash
cat supabase/.temp/project-ref
```

It must print the staging ref. To relink:

```bash
supabase link --project-ref uefijiwklnelmwcipwku
```

Never link a developer machine to production. Never run `supabase config push`: `supabase/config.toml` is for the local stack only.

## Create a migration

```bash
supabase migration new short_name
```

This creates `supabase/migrations/<timestamp>_short_name.sql`. Write the matching down script at
`supabase/rollbacks/<timestamp>_short_name.down.sql` (same timestamp). Rules:

- Expand then contract: add nullable columns first; never drop or rename a column in the same release that stops using it.
- One strict RLS policy per table and operation.
- Extensions live in the `extensions` schema (`create extension ... with schema extensions`). Qualify their types and operator classes, for example `extensions.geometry` and `extensions.gin_trgm_ops`.

## Apply to staging

Until the CLI access token with database_write is in place, every DB command passes the
connection string explicitly instead of relying on the linked-project login:

```bash
supabase db push --dry-run --db-url "$STAGING_DB_URL"
supabase db push --db-url "$STAGING_DB_URL"
```

Then run the Supabase security and performance advisors on staging and fix new warnings.

## Roll back on staging

```bash
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollbacks/<timestamp>_short_name.down.sql
supabase migration repair --status reverted <timestamp> --db-url "$STAGING_DB_URL"
```

## Baseline

`supabase/migrations/20261008171232_baseline.sql` is a schema-only dump of the staging `public` schema, plus the extensions and cron job it depends on.
Both databases already have this schema, so the baseline is never executed. It is only marked as applied:

```bash
# staging (done 2026-10-08)
supabase migration repair --status applied 20261008171232 --db-url "$STAGING_DB_URL"
# production (owner only)
supabase migration repair --status applied 20261008171232 --db-url "<production session pooler URL>"
```

Staging's history held four versions from before the baseline (20260626175844, 20260706202437,
20260706224522, 20260711192132) with no local files. Their schema is inside the baseline.
They were marked reverted on staging on 2026-10-08 (history rows only, no SQL run), and
`supabase db push --dry-run` then reported the remote as up to date.

Production has no `supabase_migrations.schema_migrations` table yet. The production
`repair --status applied` command above creates it.

## Before the T3 policy migration (`20261011153608_t3_staff_policies_is_active`)

This migration moves four tables from "the token says admin" to "an active staff profile says super admin".
An admin account without an active profile would lose access to them. Check first, on staging and on production,
in the SQL editor:

```sql
select u.email,
       u.raw_app_meta_data ->> 'role'  as token_role,
       coalesce(sp.role, 'NO PROFILE')  as profile_role,
       coalesce(sp.is_active::text, '-') as active
from auth.users u
left join public.staff_profiles sp on sp.user_id = u.id
where u.raw_app_meta_data ->> 'role' in ('admin', 'super_admin', 'municipality_admin')
order by u.created_at;
```

What to expect:

- The owner's row shows `super_admin` and `active = true`. If it does not, fix that first:
  `update public.staff_profiles set is_active = true where email = '<owner email>';`
- Rows showing `NO PROFILE` are fine: the migration gives each `admin` or `super_admin` account a `super_admin` profile.
  A `municipality_admin` with no profile is not given one and stays locked out until the owner creates it.
- A row with `active = false` stays deactivated, on purpose.

The migration refuses to continue (and changes nothing, because each migration runs in one transaction) if admin
accounts exist but none would have an active `super_admin` profile. The message says what to activate.

