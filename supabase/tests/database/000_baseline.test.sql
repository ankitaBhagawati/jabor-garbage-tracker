-- Sanity checks that the baseline built. Every test file runs in a transaction that is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);
select has_table('public', 'reports', 'reports exists');
select has_view('public', 'public_reports', 'public_reports exists');
select ok((select relrowsecurity from pg_class where oid = 'public.reports'::regclass), 'RLS is on for reports');
select is((select count(*)::int from cron.job where jobname = 'jabor-auto-clean-old-reports'), 1, 'auto-clean job exists');

select * from finish();
rollback;
