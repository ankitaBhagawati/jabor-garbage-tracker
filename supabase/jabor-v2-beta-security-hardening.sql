-- Jabor Version 2 Beta security hardening.
-- Run after the existing schema/auth migrations on the live Supabase project.
-- Admin users must have raw_app_meta_data.role = 'admin'.

alter table public.mla_list enable row level security;
alter table public.mp_list enable row level security;
alter table public.reports enable row level security;
alter table public.cleanup_proofs enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.mla_list, public.mp_list to anon, authenticated;

-- Remove broad table-level write grants before adding least-privilege grants.
revoke all on public.reports from anon, authenticated;
revoke all on public.cleanup_proofs from anon, authenticated;

grant select on public.reports to anon, authenticated;
grant select (
  report_id,
  image_url,
  status,
  created_at,
  updated_at
) on public.cleanup_proofs to anon;
grant select on public.cleanup_proofs to authenticated;

grant insert (
  constituency,
  district,
  lok_sabha_seat,
  mla,
  mla_party,
  mp,
  mp_party,
  area,
  landmark,
  waste_type,
  description,
  photo_url,
  lat,
  lng
) on public.reports to anon, authenticated;

grant insert (
  report_id,
  image_url,
  submitted_by,
  cleaned_date_estimate
) on public.cleanup_proofs to anon, authenticated;

grant update, delete on public.reports to authenticated;
grant update on public.cleanup_proofs to authenticated;

drop policy if exists "Public read reports demo" on public.reports;
drop policy if exists "Public read reports" on public.reports;
create policy "Public read reports"
on public.reports
for select
to anon, authenticated
using (
  coalesce(is_deleted, false) = false
  and status in ('verified', 'cleaned')
);

drop policy if exists "Public insert reports" on public.reports;
create policy "Public insert reports"
on public.reports
for insert
to anon, authenticated
with check (
  status = 'verified'
  and coalesce(is_deleted, false) = false
  and assigned_to is null
  and rejected_at is null
  and nullif(btrim(district), '') is not null
  and nullif(btrim(constituency), '') is not null
  and nullif(btrim(area), '') is not null
  and photo_url like 'https://res.cloudinary.com/%'
);

drop policy if exists "Demo admin update reports" on public.reports;
drop policy if exists "Admin read reports" on public.reports;
drop policy if exists "Admin update reports" on public.reports;
create policy "Admin read reports"
on public.reports
for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

create policy "Admin update reports"
on public.reports
for update
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin')
with check ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Demo admin delete rejected reports" on public.reports;
drop policy if exists "Admin delete rejected reports" on public.reports;
create policy "Admin delete rejected reports"
on public.reports
for delete
to authenticated
using (
  (select auth.jwt()->'app_metadata'->>'role') = 'admin'
  and status = 'rejected'
  and rejected_at is not null
  and rejected_at < now() - interval '7 days'
);

drop policy if exists "Public read cleanup proofs demo" on public.cleanup_proofs;
drop policy if exists "Public read approved cleanup proofs" on public.cleanup_proofs;
create policy "Public read approved cleanup proofs"
on public.cleanup_proofs
for select
to anon, authenticated
using (status = 'approved');

drop policy if exists "Public insert cleanup proofs" on public.cleanup_proofs;
create policy "Public insert cleanup proofs"
on public.cleanup_proofs
for insert
to anon, authenticated
with check (
  status = 'pending'
  and nullif(btrim(cleaned_date_estimate), '') is not null
  and image_url like 'https://res.cloudinary.com/%'
  and exists (
    select 1
    from public.reports report
    where report.id = report_id
      and report.status = 'verified'
      and coalesce(report.is_deleted, false) = false
  )
);

drop policy if exists "Admin read cleanup proofs" on public.cleanup_proofs;
create policy "Admin read cleanup proofs"
on public.cleanup_proofs
for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Demo admin update cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Admin update cleanup proofs" on public.cleanup_proofs;
create policy "Admin update cleanup proofs"
on public.cleanup_proofs
for update
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin')
with check ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

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
  r.cleanup_proof_status,
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

grant select on public.public_reports to anon, authenticated;

notify pgrst, 'reload schema';

-- Verification output.
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('reports', 'cleanup_proofs')
order by tablename, policyname;
