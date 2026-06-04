-- Allow citizens using the public frontend to submit new verified reports.
-- This grants INSERT only. Anonymous users still cannot update or delete rows.
-- The frontend uses Prefer: return=minimal so this policy does not require a
-- public SELECT policy on the underlying reports table.

alter table public.reports enable row level security;
alter table public.reports alter column status set default 'verified';
grant usage on schema public to anon, authenticated;

revoke insert on public.reports from anon, authenticated;
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
  status,
  lat,
  lng
) on public.reports to anon, authenticated;

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

select policyname, roles, cmd, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'reports'
order by policyname;
