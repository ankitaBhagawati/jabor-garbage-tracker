-- Jabor Version 2 Beta Supabase bootstrap migration
-- Run in the target Supabase project's SQL Editor.
--
-- This migration is designed for a project where the reports table may have
-- been deleted. It creates the app tables, v2 cleanup proof flow, public view,
-- indexes, least-privilege RLS policies, and Data API grants.
-- Admin users must have raw_app_meta_data.role = 'admin'.

create extension if not exists pgcrypto;

-- Representative reference data. The app stores leader names on reports so
-- each report can show the mapped MLA/MP for the selected constituency.
create table if not exists public.mla_list (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  party text,
  constituency text unique,
  district text,
  lok_sabha_seat text,
  phone text,
  email text,
  photo_url text,
  updated_at timestamptz default now()
);

create table if not exists public.mp_list (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  party text,
  lok_sabha_seat text unique,
  phone text,
  email text,
  photo_url text,
  updated_at timestamptz default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  constituency text,
  district text,
  lok_sabha_seat text,
  mla text,
  mla_party text,
  mp text,
  mp_party text,
  area text,
  landmark text,
  waste_type text default 'mixed',
  description text default '',
  photo_url text,
  lat double precision,
  lng double precision,
  status text default 'verified',
  assigned_to text,
  rejected_at timestamptz,
  is_deleted boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint reports_status_check check (status in ('pending', 'verified', 'cleaned', 'rejected'))
);

alter table public.reports add column if not exists constituency text;
alter table public.reports add column if not exists district text;
alter table public.reports add column if not exists lok_sabha_seat text;
alter table public.reports add column if not exists mla text;
alter table public.reports add column if not exists mla_party text;
alter table public.reports add column if not exists mp text;
alter table public.reports add column if not exists mp_party text;
alter table public.reports add column if not exists area text;
alter table public.reports add column if not exists landmark text;
alter table public.reports add column if not exists waste_type text default 'mixed';
alter table public.reports add column if not exists description text default '';
alter table public.reports add column if not exists photo_url text;
alter table public.reports add column if not exists lat double precision;
alter table public.reports add column if not exists lng double precision;
alter table public.reports add column if not exists status text default 'verified';
alter table public.reports alter column status set default 'verified';
alter table public.reports add column if not exists assigned_to text;
alter table public.reports add column if not exists rejected_at timestamptz;
alter table public.reports add column if not exists is_deleted boolean default false;
alter table public.reports add column if not exists created_at timestamptz default now();
alter table public.reports add column if not exists updated_at timestamptz default now();

create table if not exists public.cleanup_proofs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  image_url text not null,
  submitted_by text,
  cleaned_date_estimate text,
  status text default 'pending',
  admin_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint cleanup_proofs_status_check check (status in ('pending', 'approved', 'rejected'))
);

alter table public.cleanup_proofs add column if not exists report_id uuid references public.reports(id) on delete cascade;
alter table public.cleanup_proofs add column if not exists image_url text;
alter table public.cleanup_proofs add column if not exists submitted_by text;
alter table public.cleanup_proofs add column if not exists cleaned_date_estimate text;
alter table public.cleanup_proofs add column if not exists status text default 'pending';
alter table public.cleanup_proofs add column if not exists admin_notes text;
alter table public.cleanup_proofs add column if not exists created_at timestamptz default now();
alter table public.cleanup_proofs add column if not exists updated_at timestamptz default now();

create index if not exists idx_reports_status on public.reports(status);
create index if not exists idx_reports_rejected_at on public.reports(rejected_at);
create index if not exists idx_reports_updated_at on public.reports(updated_at);
create index if not exists idx_reports_created_at on public.reports(created_at);
create index if not exists idx_reports_district on public.reports(district);
create index if not exists idx_reports_constituency on public.reports(constituency);
create index if not exists idx_reports_waste_type on public.reports(waste_type);
create index if not exists idx_cleanup_proofs_report_id on public.cleanup_proofs(report_id);
create index if not exists idx_cleanup_proofs_status on public.cleanup_proofs(status);
create index if not exists idx_cleanup_proofs_created_at on public.cleanup_proofs(created_at);

-- Public read view used by the app.
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
where coalesce(r.is_deleted, false) = false
  and r.status in ('verified', 'cleaned');

-- Explicit Data API grants. New Supabase projects may not expose new tables to
-- the REST API automatically without these grants.
grant usage on schema public to anon, authenticated;
grant select on public.public_reports to anon, authenticated;
grant select on public.mla_list, public.mp_list to anon, authenticated;

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

alter table public.mla_list enable row level security;
alter table public.mp_list enable row level security;
alter table public.reports enable row level security;
alter table public.cleanup_proofs enable row level security;

drop policy if exists "Public read MLA list" on public.mla_list;
create policy "Public read MLA list"
on public.mla_list for select
to anon, authenticated
using (true);

drop policy if exists "Public read MP list" on public.mp_list;
create policy "Public read MP list"
on public.mp_list for select
to anon, authenticated
using (true);

drop policy if exists "Public read reports demo" on public.reports;
drop policy if exists "Public read reports" on public.reports;
create policy "Public read reports"
on public.reports for select
to anon, authenticated
using (
  coalesce(is_deleted, false) = false
  and status in ('verified', 'cleaned')
);

drop policy if exists "Public insert reports" on public.reports;
create policy "Public insert reports"
on public.reports for insert
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

drop policy if exists "Demo admin delete rejected reports" on public.reports;
drop policy if exists "Admin delete rejected reports" on public.reports;
create policy "Admin delete rejected reports"
on public.reports for delete
to authenticated
using (
  (select auth.jwt()->'app_metadata'->>'role') = 'admin'
  and
  status = 'rejected'
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

-- Compatibility: if old rows exist with status=open, make them visible as active.
update public.reports
set status = 'verified'
where status = 'open';

-- Verification checks.
select 'reports columns' as check_name, column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'reports'
order by ordinal_position;

select 'cleanup_proofs exists' as check_name, table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'cleanup_proofs';

-- Ask PostgREST to reload the schema cache so REST endpoints can see newly
-- created tables/views immediately.
notify pgrst, 'reload schema';
