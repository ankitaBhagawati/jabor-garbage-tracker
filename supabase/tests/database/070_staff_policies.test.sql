-- The four agent tables follow the staff helpers: active super admins only, a municipality admin never.
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

select set_config('test.jorhat', (select id::text from public.municipalities where slug = 'jorhat'), true);
insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'legacy@pgtap.test',   '{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000002', 'super@pgtap.test',    '{"role":"super_admin"}'),
  ('20000000-0000-4000-8000-000000000003', 'jmb@pgtap.test',      '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000004', 'inactive@pgtap.test', '{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000005', 'noprofile@pgtap.test','{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000006', 'mismatch@pgtap.test', '{"role":"super_admin"}');
insert into public.staff_profiles (user_id, municipality_id, role, email, is_active) values
  ('20000000-0000-4000-8000-000000000001', null, 'super_admin', 'legacy@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000002', null, 'super_admin', 'super@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000003', current_setting('test.jorhat')::uuid, 'municipality_admin', 'jmb@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000004', null, 'super_admin', 'inactive@pgtap.test', false),
  ('20000000-0000-4000-8000-000000000006', current_setting('test.jorhat')::uuid, 'municipality_admin', 'mismatch@pgtap.test', true);

insert into public.reports (id, district, constituency, area, photo_url) values ('80000000-0000-4000-8000-000000000001', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/p1.webp');
insert into public.report_contacts (report_id, name, email) values ('80000000-0000-4000-8000-000000000001', 'pgtap reporter', 'reporter@example.invalid');
insert into public.authority_contacts (name, authority_type, email) values ('pgtap authority', 'municipal', 'authority@example.invalid');
insert into public.escalation_guidelines (match_type, match_value, severity, authority_type, guidance) values ('waste_type', 'pgtap', 'low', 'municipal', 'pgtap guidance');
insert into public.recommendations_audit (id, report_id, status) values ('90000000-0000-4000-8000-000000000001', null, 'generated');

-- Shape: one select policy per table for authenticated, none of them reading the token's role directly.
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('authority_contacts', 'escalation_guidelines', 'report_contacts', 'recommendations_audit') and cmd = 'SELECT'), 4,
  'one SELECT policy on each of the four tables');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('authority_contacts', 'escalation_guidelines', 'report_contacts', 'recommendations_audit')
  and (coalesce(qual, '') like '%''admin''%' or coalesce(with_check, '') like '%''admin''%')), 0, 'none of them trusts the token role alone');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('authority_contacts', 'escalation_guidelines', 'report_contacts', 'recommendations_audit')
  and coalesce(qual, with_check) like '%is_super_admin%'), 6, 'all six policies use the helper');

-- count of the four tables a caller can read (each fixture row counts once)
create function pg_temp.visible() returns text language sql as $$
  select (select count(*) from public.report_contacts where name = 'pgtap reporter')::text || ','
      || (select count(*) from public.authority_contacts where name = 'pgtap authority')::text || ','
      || (select count(*) from public.escalation_guidelines where match_value = 'pgtap')::text || ','
      || (select count(*) from public.recommendations_audit where id = '90000000-0000-4000-8000-000000000001')::text
$$;
grant execute on function pg_temp.visible() to authenticated, anon;

-- ── A legacy admin token with an active super_admin profile keeps working ─────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"legacy@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '1,1,1,1', 'a legacy admin (role admin + active super_admin profile) reads all four tables');
select lives_ok($$insert into public.recommendations_audit (report_id, status) values (null, 'generated')$$, 'and may write recommendations_audit');
select lives_ok($$update public.recommendations_audit set status = 'approved' where id = '90000000-0000-4000-8000-000000000001'$$, 'and update it');
reset role;

-- ── A super_admin token ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '1,1,1,1', 'a super_admin reads all four tables');
reset role;

-- ── Everyone else reads nothing ──────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000003', 'role', 'authenticated', 'email', 'jmb@pgtap.test',
  'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;
select is(pg_temp.visible(), '0,0,0,0', 'a municipality admin reads none of the four tables');
select throws_ok($$insert into public.recommendations_audit (report_id, status) values (null, 'generated')$$, '42501', null, 'a municipality admin cannot insert into recommendations_audit');
select is_empty($$update public.recommendations_audit set status = 'approved' where id = '90000000-0000-4000-8000-000000000001' returning 1$$, 'nor update it');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000004","role":"authenticated","email":"inactive@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '0,0,0,0', 'a deactivated admin (valid token, inactive profile) reads none of them');
select throws_ok($$insert into public.recommendations_audit (report_id, status) values (null, 'generated')$$, '42501', null, 'and cannot write');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000005","role":"authenticated","email":"noprofile@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '0,0,0,0', 'an admin token with no staff profile reads none of them');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000006","role":"authenticated","email":"mismatch@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '0,0,0,0', 'a super_admin token on a municipality profile reads none of them');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"legacy@pgtap.test","app_metadata":{"role":"authenticated"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '0,0,0,0', 'a profile alone is not enough: the token role must say super admin');
reset role;

-- Deactivation applies within the same session: no caching.
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
update public.staff_profiles set is_active = false where user_id = '20000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(pg_temp.visible(), '0,0,0,0', 'deactivating a super admin ends their access at once, with the same token');
reset role;
update public.staff_profiles set is_active = true where user_id = '20000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(pg_temp.visible(), '1,1,1,1', 'and reactivating restores it');
reset role;

-- Anon never had access.
set local role anon;
select throws_ok($$select 1 from public.report_contacts limit 1$$, '42501', null, 'anon cannot read report_contacts');
select throws_ok($$select 1 from public.authority_contacts limit 1$$, '42501', null, 'anon cannot read authority_contacts');
reset role;

-- The service role (edge functions) is not affected by these policies.
set local role service_role;
select is(pg_temp.visible(), '1,1,1,1', 'the service role still reads all four tables');
reset role;

-- The other helpers behave as before for the same people.
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"legacy@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select ok(private.is_super_admin(), 'private.is_super_admin() is true for the legacy admin');
select is((select count(*)::int from public.reports where area = 'pgtap'), 1, 'a legacy admin still reads reports');
select is((select count(*)::int from public.staff_profiles where email like '%@pgtap.test'), 5, 'a super admin sees every staff profile');
reset role;

select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000003', 'role', 'authenticated', 'email', 'jmb@pgtap.test',
  'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;
select ok(not private.is_super_admin(), 'private.is_super_admin() is false for a municipality admin');
select is((select count(*)::int from public.staff_profiles), 1, 'a municipality admin sees only their own profile');
select is((select count(*)::int from public.municipalities), 1, 'and only their own municipality');
reset role;

select * from finish();
rollback;
