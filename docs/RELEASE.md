# Release process

Steps marked **(owner)** are done only by the project owner. Nothing in CI can touch production.

## 1. Feature branch to staging

1. Cut a branch from the latest `staging` (`feat/<task>`). Commit in small steps.
2. Open a PR into `staging`. The PR description must include a **Production release steps** section
   (migrations and their order relative to the code deploy, Vercel env vars, edge function deploys, rollback).
3. CI runs on the PR: lint, unit self-checks, build, a grep of the client bundle for secrets, and a
   gitleaks scan of the PR's commits. CI uses no secrets and no database.
4. Review and merge into `staging` **(owner)**.

## 2. On staging

After the merge, without anyone running anything:

- Vercel deploys `staging.jabor.in` with Preview-scoped env vars.
- If the merge changed `supabase/migrations/`, the "Staging migrations" workflow runs
  `supabase db push --db-url` against the staging project only. It refuses any other project ref.
- When the Vercel deployment of the staging head succeeds, the "Staging smoke tests" workflow runs
  read-only Playwright tests against `staging.jabor.in` (home, report form, admin gate, `/api/health`,
  noindex). It can also be started by hand from the Actions tab.

Then test the change by hand on `staging.jabor.in` using the steps in its PR.

## 3. Staging to production **(owner)**

1. Open a PR from `staging` into `main`. Collect the "Production release steps" of every PR it contains.
2. Before any production migration, dump production's privileges and diff them against staging.
   Production was rebuilt from a dump once and ended up with wider grants than staging; a migration
   rehearsed on staging can behave differently on a database with different privileges.
   ```bash
   pg_dump "<production session pooler URL>" --schema-only --schema=public --no-owner -f .local/prod-public-with-privileges.sql
   pg_dump "$STAGING_DB_URL" --schema-only --schema=public --no-owner -f .local/staging-public-with-privileges.sql
   diff <(grep -E '^(GRANT|REVOKE|ALTER DEFAULT|CREATE POLICY|ALTER TABLE .* ROW LEVEL)' .local/prod-public-with-privileges.sql | sort) \
        <(grep -E '^(GRANT|REVOKE|ALTER DEFAULT|CREATE POLICY|ALTER TABLE .* ROW LEVEL)' .local/staging-public-with-privileges.sql | sort)
   ```
   The only differences should be the ones the pending migrations create. Anything else is resolved
   first. `.local/` is gitignored; the dumps hold structure only.
3. Do the steps that must come **before** the code deploy:
   - Vercel Production env vars.
   - Edge function deploys and secrets.
   - Migrations marked "before code". Apply from your own machine, never from CI:
     ```bash
     supabase migration list --db-url "<production session pooler URL>"
     supabase db push --dry-run --db-url "<production session pooler URL>"
     supabase db push --db-url "<production session pooler URL>"
     ```
     Then run the Supabase security and performance advisors on production.
4. Merge into `main`. Vercel deploys `jabor.in`.
5. Do the steps marked "after code" (for example, contract migrations).
6. Check production:
   - `https://www.jabor.in/api/health` returns `{"status":"ok"}`.
   - Feed, Active and Cleaned tabs, a report detail with before and after photos, admin login.
   - No `X-Robots-Tag` header: `curl -sI https://www.jabor.in/ | grep -i x-robots-tag` prints nothing.
   - Sentry shows no new errors tagged `production`.

## Rollback **(owner)**

- **Code:** in Vercel, open the previous production deployment and use Instant Rollback. Then revert the
  merge on `main` so the next deploy does not bring the change back.
- **Migration:** run its down script, then mark it reverted:
  ```bash
  psql "<production session pooler URL>" -v ON_ERROR_STOP=1 -f supabase/rollbacks/<version>_<name>.down.sql
  supabase migration repair --status reverted <version> --db-url "<production session pooler URL>"
  ```
  Expand-then-contract means the previous code keeps working on the expanded schema, so a code rollback
  usually needs no migration rollback.
- **Env vars:** restore the previous value in Vercel and redeploy.

## Who does what

| Step | Who |
|---|---|
| Feature branches, PRs into staging, staging migrations | Developer or CI |
| Merging into `staging` | Owner |
| Merging into `main` | Owner |
| Production migrations, `migration repair` on production | Owner |
| Vercel env vars (any scope), edge function deploys and secrets | Owner |
| Vercel Instant Rollback | Owner |
