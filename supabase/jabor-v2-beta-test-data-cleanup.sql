-- Jabor Version 2 Beta test-data cleanup.
-- This intentionally deletes all report activity while preserving:
--   - Supabase Auth users, including admin users
--   - mla_list and mp_list lookup/master data
--   - database schema, policies, and configuration
--
-- Review the preview counts first. Run the DELETE transaction only when all
-- existing report activity is confirmed to be test data.

select 'reports' as table_name, count(*) as row_count from public.reports
union all
select 'cleanup_proofs', count(*) from public.cleanup_proofs;

begin;

-- Optional activity tables are deleted first when they exist.
do $$
begin
  if to_regclass('public.notifications') is not null then
    execute 'delete from public.notifications';
  end if;

  if to_regclass('public.comments') is not null then
    execute 'delete from public.comments';
  end if;
end
$$;

-- cleanup_proofs references reports, so proofs must be deleted first.
delete from public.cleanup_proofs;
delete from public.reports;

commit;

select 'reports' as table_name, count(*) as row_count from public.reports
union all
select 'cleanup_proofs', count(*) from public.cleanup_proofs;
