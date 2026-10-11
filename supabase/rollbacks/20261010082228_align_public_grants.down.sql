-- PRODUCTION ROLLBACK ONLY. Do not run on staging: staging never had these grants.
--
-- Restores the anon and authenticated privileges production had before 20261010082228, taken
-- from the production dump of 2026-10-10 (.local/prod-public-with-privileges.sql).
-- Warning: this reopens both gaps the migration closed (anon can call auto_clean_old_reports()
-- and read every column of approved cleanup_proofs).

grant all on function public.auto_clean_old_reports() to anon, authenticated;

grant all on table public.authority_contacts to anon, authenticated;
grant all on table public.cleanup_proofs to anon, authenticated;
grant all on table public.escalation_guidelines to anon, authenticated;
grant all on table public.recommendations_audit to anon, authenticated;
grant all on table public.report_contacts to anon, authenticated;
grant all on table public.reports to anon, authenticated;
