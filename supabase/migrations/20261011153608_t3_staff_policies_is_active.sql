-- T3: the four agent tables stop trusting the token's role alone and follow the staff helpers, so a
-- deactivated profile loses access on the next request instead of when its token expires. A municipality
-- admin has no access to them at all. Policies only; no table or column changes.
--
--   authority_contacts, escalation_guidelines, recommendations_audit (select, insert, update), report_contacts (select)
--   now allow a super admin: private.is_super_admin() = active staff_profiles row with role super_admin AND a
--   token role of super_admin or the older "admin".
--
-- LOCKOUT GUARD: those helpers need a staff_profiles row. Every existing admin account gets one first, and
-- the migration stops (changing nothing) if admin accounts exist but none of them would still have access.
-- Check before applying (staging and production): see docs/MIGRATIONS.md, "Before the T3 policy migration".

-- ── 1. Every admin account has a profile ─────────────────────────────────────
-- Existing profiles are left alone, including deactivated ones.
insert into public.staff_profiles (user_id, municipality_id, role, email)
select u.id, null, 'super_admin', coalesce(u.email, '')
from auth.users u
where u.raw_app_meta_data ->> 'role' in ('admin', 'super_admin')
on conflict (user_id) do nothing;

-- ── 2. Refuse to continue if that would lock everyone out ────────────────────
do $$
declare
  admins integer;
  active_supers integer;
begin
  select count(*) into admins from auth.users where raw_app_meta_data ->> 'role' in ('admin', 'super_admin');
  select count(*) into active_supers
  from public.staff_profiles sp join auth.users u on u.id = sp.user_id
  where sp.role = 'super_admin' and sp.is_active and u.raw_app_meta_data ->> 'role' in ('admin', 'super_admin');
  if admins > 0 and active_supers = 0 then
    raise exception 'Stopped: % admin account(s) exist but none has an active super_admin staff profile. Activate the owner''s profile first (update public.staff_profiles set is_active = true where email = ...).', admins;
  end if;
end $$;

-- ── 3. Policies ──────────────────────────────────────────────────────────────
drop policy if exists "Admin read authority contacts" on public.authority_contacts;
drop policy if exists "Super admin read authority contacts" on public.authority_contacts;
create policy "Super admin read authority contacts" on public.authority_contacts for select to authenticated
using ((select private.is_super_admin()));

drop policy if exists "Admin read escalation guidelines" on public.escalation_guidelines;
drop policy if exists "Super admin read escalation guidelines" on public.escalation_guidelines;
create policy "Super admin read escalation guidelines" on public.escalation_guidelines for select to authenticated
using ((select private.is_super_admin()));

drop policy if exists "Admin read report contacts" on public.report_contacts;
drop policy if exists "Super admin read report contacts" on public.report_contacts;
create policy "Super admin read report contacts" on public.report_contacts for select to authenticated
using ((select private.is_super_admin()));

drop policy if exists "Admin read recommendations audit" on public.recommendations_audit;
drop policy if exists "Admin write recommendations audit" on public.recommendations_audit;
drop policy if exists "Admin update recommendations audit" on public.recommendations_audit;
drop policy if exists "Super admin read recommendations audit" on public.recommendations_audit;
drop policy if exists "Super admin write recommendations audit" on public.recommendations_audit;
drop policy if exists "Super admin update recommendations audit" on public.recommendations_audit;
create policy "Super admin read recommendations audit" on public.recommendations_audit for select to authenticated
using ((select private.is_super_admin()));
create policy "Super admin write recommendations audit" on public.recommendations_audit for insert to authenticated
with check ((select private.is_super_admin()));
create policy "Super admin update recommendations audit" on public.recommendations_audit for update to authenticated
using ((select private.is_super_admin()))
with check ((select private.is_super_admin()));
