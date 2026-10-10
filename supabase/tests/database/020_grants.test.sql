-- Privileges of anon and authenticated after the grants alignment.
-- Runs inside a transaction that is rolled back, including the auto-clean sweep at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

-- auto_clean_old_reports(): only the cron job (postgres) and service_role may run it.
select ok(not has_function_privilege('anon', 'public.auto_clean_old_reports()', 'execute'), 'anon cannot execute auto_clean_old_reports()');
select ok(not has_function_privilege('authenticated', 'public.auto_clean_old_reports()', 'execute'), 'authenticated cannot execute auto_clean_old_reports()');
select ok(has_function_privilege('service_role', 'public.auto_clean_old_reports()', 'execute'), 'service_role can execute auto_clean_old_reports()');
select ok(has_function_privilege('postgres', 'public.auto_clean_old_reports()', 'execute'), 'postgres can execute auto_clean_old_reports()');
select results_eq(
  $$select username::text, command, active from cron.job where jobname = 'jabor-auto-clean-old-reports'$$,
  $$values ('postgres', 'select public.auto_clean_old_reports()', true)$$,
  'the cron job is active, runs as postgres and calls the sweep');

-- Tables anon must not write to or read whole.
select ok(not has_table_privilege('anon', 'public.reports', 'insert, update, delete, truncate'), 'anon has no write privilege on reports');
select ok(not has_table_privilege('anon', 'public.cleanup_proofs', 'insert, update, delete, truncate'), 'anon has no write privilege on cleanup_proofs');
select ok(not has_table_privilege('anon', 'public.authority_contacts', 'select'), 'anon cannot select authority_contacts');
select ok(not has_table_privilege('anon', 'public.escalation_guidelines', 'select'), 'anon cannot select escalation_guidelines');
select ok(not has_table_privilege('anon', 'public.recommendations_audit', 'select'), 'anon cannot select recommendations_audit');
select ok(not has_table_privilege('anon', 'public.report_contacts', 'insert, update, delete'), 'anon cannot write report_contacts');

set local role anon;

select throws_ok($$select public.auto_clean_old_reports()$$, '42501', null, 'calling the sweep as anon is a permission error');
select throws_ok($$select submitted_by from public.cleanup_proofs limit 1$$, '42501', null, 'anon cannot select submitted_by from cleanup_proofs');
select throws_ok($$select admin_notes from public.cleanup_proofs limit 1$$, '42501', null, 'anon cannot select admin_notes from cleanup_proofs');
select lives_ok($$select report_id, image_url, status, created_at, updated_at from public.cleanup_proofs limit 1$$,
  'anon can still select the five public cleanup_proofs columns');

reset role;

-- The sweep itself still works for its owner (what pg_cron does every night). Rolled back below.
select lives_ok($$select public.auto_clean_old_reports()$$, 'the sweep runs as postgres');

select * from finish();
rollback;
