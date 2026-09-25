-- Reports 15+ days old are auto-marked cleaned, so they move to the Cleaned tab.
-- Run once in the Supabase SQL editor. Requires the pg_cron extension (Database > Extensions).

create extension if not exists pg_cron;

create or replace function public.auto_clean_old_reports()
returns void
language sql
security definer
set search_path = public
as $$
  update public.reports
  set status = 'cleaned',
      updated_at = now()
  -- 'pending' left out: unmoderated reports shouldn't surface publicly as Cleaned.
  where status in ('verified', 'active', 'reported', 'open')
    and is_deleted = false
    and created_at <= now() - interval '15 days';
$$;

-- Public functions are callable via /rest/v1/rpc by default; only cron should run this.
revoke execute on function public.auto_clean_old_reports() from public, anon, authenticated;

-- Backfill existing reports now.
select public.auto_clean_old_reports();

-- ponytail: daily sweep, so a report can sit up to ~24h past day 15 before moving.
select cron.unschedule('jabor-auto-clean-old-reports')
where exists (select 1 from cron.job where jobname = 'jabor-auto-clean-old-reports');

select cron.schedule('jabor-auto-clean-old-reports', '0 0 * * *', 'select public.auto_clean_old_reports()');
