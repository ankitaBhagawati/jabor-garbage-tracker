-- Hotfix: one strict public SELECT policy on reports, mla_list and mp_list.
--
-- reports had three permissive SELECT policies for anon and authenticated. Postgres ORs them, and
-- "Allow public read reports" had no is_deleted check, so a hidden (is_deleted = true) report with
-- status pending or cleaned was readable through the public REST API.
--
-- The replacement keeps exactly what the public UI queries (src/services/reportService.js and
-- cleanupService.js): not hidden, and status in the frontend's public list. Rejected rows stay out.
-- Admins keep reading every row through "Admin read reports" (authenticated, role admin).

drop policy if exists "Allow public read reports" on public.reports;
drop policy if exists "Public can read visible reports" on public.reports;
drop policy if exists "Public read reports" on public.reports;

create policy "Public read reports"
on public.reports
for select
to anon
using (
  coalesce(is_deleted, false) = false
  and status in ('verified', 'pending', 'active', 'reported', 'open', 'cleaned')
);

-- mla_list and mp_list each had two identical USING (true) policies. Keep one each.
-- anon SELECT on mla_list is required by /api/health and the report form.
drop policy if exists "Public read mla_list" on public.mla_list;
drop policy if exists "Public read mp_list" on public.mp_list;
