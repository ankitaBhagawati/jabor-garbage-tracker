-- Reverses 20261011153608: the four agent tables go back to trusting the token's role "admin" alone
-- (no staff_profiles or is_active check). The staff profiles the migration added are kept; they are
-- harmless and the other policies already depend on them.

drop policy if exists "Super admin read authority contacts" on public.authority_contacts;
create policy "Admin read authority contacts" on public.authority_contacts for select to authenticated
using (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));

drop policy if exists "Super admin read escalation guidelines" on public.escalation_guidelines;
create policy "Admin read escalation guidelines" on public.escalation_guidelines for select to authenticated
using (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));

drop policy if exists "Super admin read report contacts" on public.report_contacts;
create policy "Admin read report contacts" on public.report_contacts for select to authenticated
using (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));

drop policy if exists "Super admin read recommendations audit" on public.recommendations_audit;
drop policy if exists "Super admin write recommendations audit" on public.recommendations_audit;
drop policy if exists "Super admin update recommendations audit" on public.recommendations_audit;
create policy "Admin read recommendations audit" on public.recommendations_audit for select to authenticated
using (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));
create policy "Admin write recommendations audit" on public.recommendations_audit for insert to authenticated
with check (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));
create policy "Admin update recommendations audit" on public.recommendations_audit for update to authenticated
using (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text))
with check (((select (auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text));
