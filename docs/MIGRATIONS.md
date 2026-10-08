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

```bash
supabase db push --dry-run
supabase db push
```

Then run the Supabase security and performance advisors on staging and fix new warnings.

## Roll back on staging

```bash
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollbacks/<timestamp>_short_name.down.sql
supabase migration repair --status reverted <timestamp>
```

## Baseline

`supabase/migrations/<timestamp>_baseline.sql` is a schema-only dump of staging (schemas `public` and `private`, plus extensions and cron jobs).
Both databases already have this schema, so the baseline is never executed. It is marked as applied:

```bash
# staging (developer)
supabase migration repair --status applied <timestamp>
# production (owner, from a machine linked to production, only after the staging/production schema diff is reviewed)
supabase migration repair --status applied <timestamp>
```
