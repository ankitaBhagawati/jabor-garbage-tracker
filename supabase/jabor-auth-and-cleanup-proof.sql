-- Jabor admin auth, protected mutations, and single cleanup proof workflow.
-- Admin users must have app_metadata.role = 'admin'.

alter table public.reports
add column if not exists cleanup_proof_status text
check (cleanup_proof_status in ('pending', 'approved', 'rejected'));

create schema if not exists private;

create or replace function private.sync_report_cleanup_proof_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reports
  set cleanup_proof_status = new.status,
      updated_at = now()
  where id = new.report_id;
  return new;
end;
$$;

drop trigger if exists sync_report_cleanup_proof_status on public.cleanup_proofs;
create trigger sync_report_cleanup_proof_status
after insert or update of status on public.cleanup_proofs
for each row execute function private.sync_report_cleanup_proof_status();

update public.reports report
set cleanup_proof_status = proof.status
from (
  select distinct on (report_id) report_id, status
  from public.cleanup_proofs
  order by report_id, created_at desc, id desc
) proof
where report.id = proof.report_id;

-- Keep only the newest active proof if older data contains duplicates.
with ranked as (
  select id,
         row_number() over (partition by report_id order by created_at desc, id desc) as row_number
  from public.cleanup_proofs
  where status in ('pending', 'approved')
)
update public.cleanup_proofs proof
set status = 'rejected',
    admin_notes = coalesce(proof.admin_notes, 'Superseded during single-proof migration.'),
    updated_at = now()
from ranked
where proof.id = ranked.id
  and ranked.row_number > 1;

create unique index if not exists idx_cleanup_proofs_one_active_per_report
on public.cleanup_proofs(report_id)
where status in ('pending', 'approved');

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

drop policy if exists "Demo admin update reports" on public.reports;
drop policy if exists "Demo admin delete rejected reports" on public.reports;
drop policy if exists "Admin read reports" on public.reports;
create policy "Admin read reports"
on public.reports for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admin update reports" on public.reports;
create policy "Admin update reports"
on public.reports for update
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin')
with check ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Admin delete rejected reports" on public.reports;
create policy "Admin delete rejected reports"
on public.reports for delete
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
on public.cleanup_proofs for select
to anon, authenticated
using (status = 'approved');

drop policy if exists "Public insert cleanup proofs" on public.cleanup_proofs;
create policy "Public insert cleanup proofs"
on public.cleanup_proofs for insert
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
on public.cleanup_proofs for select
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

drop policy if exists "Demo admin update cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Admin update cleanup proofs" on public.cleanup_proofs;
create policy "Admin update cleanup proofs"
on public.cleanup_proofs for update
to authenticated
using ((select auth.jwt()->'app_metadata'->>'role') = 'admin')
with check ((select auth.jwt()->'app_metadata'->>'role') = 'admin');

notify pgrst, 'reload schema';
