-- Allow citizens using the public frontend to submit new verified reports.
-- This grants INSERT only. Anonymous users still cannot update or delete rows.

grant insert on public.reports to anon, authenticated;

drop policy if exists "Public insert reports" on public.reports;
create policy "Public insert reports"
on public.reports
for insert
to anon, authenticated
with check (
  status = 'verified'
  and coalesce(is_deleted, false) = false
);

select policyname, roles, cmd, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'reports'
order by policyname;
