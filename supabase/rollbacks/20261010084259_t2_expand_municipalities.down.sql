-- Reverses 20261010084259_t2_expand_municipalities.sql and returns the public schema to its state
-- after 20261010082228 (verified by a dump diff on a local database).
--
-- Data loss: drops the new report columns (ward, cleaned-by details, notes, GPS fields), the
-- audit log, staff profiles, wards and localities. Roll the frontend back first: the frontend from
-- this release reads the new public_reports view (it also works with the old one restored here).
-- The postgis and pg_trgm extensions are left installed; production had postgis before this.

begin;

-- Triggers and their functions.
drop trigger if exists reports_before_update on public.reports;
drop trigger if exists reports_audit on public.reports;
drop trigger if exists staff_profiles_audit on public.staff_profiles;
drop trigger if exists audit_log_no_update_delete on public.audit_log;
drop trigger if exists audit_log_no_truncate on public.audit_log;

-- Auto-clean sweep as it was.
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

-- Public view as it was.
drop view if exists public.public_reports;
create view public.public_reports
with (security_invoker = true)
as
select
  r.id,
  r.constituency,
  r.district,
  r.lok_sabha_seat,
  coalesce(m.name, r.mla) as mla,
  coalesce(m.party, r.mla_party) as mla_party,
  coalesce(p.name, r.mp) as mp,
  coalesce(p.party, r.mp_party) as mp_party,
  r.area,
  r.landmark,
  r.waste_type,
  r.description,
  r.photo_url,
  approved_proof.image_url as cleanup_photo_url,
  r.lat,
  r.lng,
  r.status,
  r.assigned_to,
  r.rejected_at,
  r.is_deleted,
  r.created_at,
  r.updated_at
from public.reports r
left join public.mla_list m on m.constituency = r.constituency
left join public.mp_list p on p.lok_sabha_seat = r.lok_sabha_seat
left join lateral (
  select proof.image_url
  from public.cleanup_proofs proof
  where proof.report_id = r.id
    and proof.status = 'approved'
  order by proof.updated_at desc, proof.created_at desc
  limit 1
) approved_proof on true
where coalesce(r.is_deleted, false) = false
  and r.status in ('verified', 'cleaned');
revoke all on table public.public_reports from anon, authenticated;
grant all on table public.public_reports to anon, authenticated, service_role;

-- Policies on reports as they were.
drop policy if exists "Staff read reports" on public.reports;
drop policy if exists "Staff update reports" on public.reports;
drop policy if exists "Public read reports" on public.reports;
create policy "Public read reports" on public.reports for select to anon
using (coalesce(is_deleted, false) = false and status in ('verified', 'pending', 'active', 'reported', 'open', 'cleaned'));
create policy "Admin read reports" on public.reports for select to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "Admin update reports" on public.reports for update to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "Admin delete rejected reports" on public.reports for delete to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  and status = 'rejected' and rejected_at is not null and rejected_at < now() - interval '7 days');
grant delete on table public.reports to authenticated;

-- Policies on cleanup_proofs as they were.
drop policy if exists "Staff read cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Staff update cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Public read approved cleanup proofs" on public.cleanup_proofs;
create policy "Public read approved cleanup proofs" on public.cleanup_proofs for select to authenticated, anon
using (status = 'approved');
create policy "Admin read cleanup proofs" on public.cleanup_proofs for select to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "Admin update cleanup proofs" on public.cleanup_proofs for update to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Status values: map the new ones back before narrowing the check.
update public.reports set status = 'verified' where status in ('active', 'in_progress');
update public.reports set status = 'rejected' where status = 'invalid';
alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports add constraint reports_status_check
  check (status in ('pending', 'verified', 'cleaned', 'rejected'));

-- New report columns (their checks, foreign keys and single-column indexes go with them).
drop index if exists public.idx_reports_municipality_status_created;
drop index if exists public.idx_reports_ward;
drop index if exists public.idx_reports_lat_lng;
alter table public.reports
  drop column if exists municipality_id,
  drop column if exists ward_id,
  drop column if exists gps_accuracy,
  drop column if exists gps_source,
  drop column if exists claimed_in_municipality,
  drop column if exists in_municipality,
  drop column if exists invalid_reason,
  drop column if exists cleaned_by_name,
  drop column if exists cleaned_by_type,
  drop column if exists cleaned_at,
  drop column if exists cleaned_marked_at,
  drop column if exists cleaned_marked_by,
  drop column if exists assigned_to_text,
  drop column if exists due_at,
  drop column if exists admin_note;

-- New tables, then the private schema with every function in it.
drop table if exists public.audit_log;
drop table if exists public.staff_profiles;
drop table if exists public.ward_localities;
drop table if exists public.wards;
drop table if exists public.municipalities;
drop schema if exists private cascade;

-- Grants on the older tables as they were.
grant all on table public.report_activity to anon, authenticated;
grant all on table public.constituencies, public.mla_list, public.mp_list to anon, authenticated;
grant all on sequence public.constituencies_id_seq to anon, authenticated;
revoke all on table public.report_contacts from anon, authenticated;
grant select, references, trigger, truncate, maintain on table public.report_contacts to anon, authenticated;

commit;

notify pgrst, 'reload schema';
