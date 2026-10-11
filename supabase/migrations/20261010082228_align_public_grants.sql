-- Aligns the public-schema privileges of anon, authenticated and PUBLIC with staging's state on
-- 2026-10-10, for every table, view, sequence and function.
--
-- Why: production was rebuilt from a dump, so every object picked up Supabase's default
-- privileges (ALL to anon and authenticated). Staging has the narrower grants applied by hand
-- earlier. Two gaps were exploitable on production with the public anon key:
--   - anon could call public.auto_clean_old_reports() (security definer) through /rest/v1/rpc
--   - anon could read every column of approved cleanup_proofs, including submitted_by and admin_notes
--
-- Each object is reset (REVOKE ALL) and then granted exactly what staging has, so the migration is
-- idempotent and changes nothing on staging. service_role and postgres are not touched.
-- A table-level REVOKE also removes column-level grants, so those are granted again below.
-- Grants that are still wider than needed (constituencies, mla_list, mp_list, report_activity,
-- report_contacts, public_reports) are kept as staging has them; a later migration narrows them.

-- ── Functions ────────────────────────────────────────────────────────────────
-- Only the pg_cron job (runs as postgres, the owner) and service_role may run the sweep.
revoke all on function public.auto_clean_old_reports() from public, anon, authenticated;
grant execute on function public.auto_clean_old_reports() to service_role;

revoke all on function public.match_reports(extensions.vector, integer, uuid, text, timestamptz) from anon, authenticated;
grant all on function public.match_reports(extensions.vector, integer, uuid, text, timestamptz) to anon, authenticated;

-- ── Tables that anon must not touch ──────────────────────────────────────────
revoke all on table public.authority_contacts from anon, authenticated;
grant select on table public.authority_contacts to authenticated;

revoke all on table public.escalation_guidelines from anon, authenticated;
grant select on table public.escalation_guidelines to authenticated;

revoke all on table public.recommendations_audit from anon, authenticated;
grant select, insert, update on table public.recommendations_audit to authenticated;

-- ── cleanup_proofs: anon reads five columns only ─────────────────────────────
revoke all on table public.cleanup_proofs from anon, authenticated;
grant select (report_id, image_url, status, created_at, updated_at) on table public.cleanup_proofs to anon;
grant select, update on table public.cleanup_proofs to authenticated;

-- ── reports ──────────────────────────────────────────────────────────────────
revoke all on table public.reports from anon, authenticated;
grant select on table public.reports to anon;
grant select, update, delete on table public.reports to authenticated;

-- ── report_contacts: no client writes (rows are written by service_role only) ─
revoke all on table public.report_contacts from anon, authenticated;
grant select, references, trigger, truncate, maintain on table public.report_contacts to anon, authenticated;

-- ── Same on both databases today; stated so the file covers every object ─────
revoke all on table public.constituencies from anon, authenticated;
grant all on table public.constituencies to anon, authenticated;

revoke all on sequence public.constituencies_id_seq from anon, authenticated;
grant all on sequence public.constituencies_id_seq to anon, authenticated;

revoke all on table public.mla_list from anon, authenticated;
grant all on table public.mla_list to anon, authenticated;

revoke all on table public.mp_list from anon, authenticated;
grant all on table public.mp_list to anon, authenticated;

revoke all on table public.report_activity from anon, authenticated;
grant all on table public.report_activity to anon, authenticated;

revoke all on table public.public_reports from anon, authenticated;
grant all on table public.public_reports to anon, authenticated;
