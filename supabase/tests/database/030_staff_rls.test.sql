-- Municipality isolation, inactive staff, the public view and the audit log's privileges.
-- All rows (including the auth.users rows) are created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(37);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.municipalities (id, slug, name) values ('10000000-0000-4000-8000-000000000001', 'pgtap-town', 'pgTAP Town');
insert into public.wards (id, municipality_id, number) values ('10000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 1);
select set_config('test.jorhat', (select id::text from public.municipalities where slug = 'jorhat'), true);
select set_config('test.other', '10000000-0000-4000-8000-000000000001', true);

insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'super@pgtap.test',    '{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000002', 'jmb@pgtap.test',      '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000003', 'other@pgtap.test',    '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000004', 'inactive@pgtap.test', '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000005', 'noprofile@pgtap.test','{"role":"admin"}');
-- The migration's backfill ran before these users existed, so their profiles are added here.
insert into public.staff_profiles (user_id, municipality_id, role, email, is_active) values
  ('20000000-0000-4000-8000-000000000001', null, 'super_admin', 'super@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000002', current_setting('test.jorhat')::uuid, 'municipality_admin', 'jmb@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'municipality_admin', 'other@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000004', current_setting('test.jorhat')::uuid, 'municipality_admin', 'inactive@pgtap.test', false);

insert into public.reports (id, district, constituency, area, photo_url, status, is_deleted, municipality_id, admin_note) values
  ('30000000-0000-4000-8000-000000000001', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/s1.webp', 'verified',    false, current_setting('test.jorhat')::uuid, 'internal note'),
  ('30000000-0000-4000-8000-000000000002', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/s2.webp', 'verified',    false, '10000000-0000-4000-8000-000000000001', null),
  ('30000000-0000-4000-8000-000000000003', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/s3.webp', 'verified',    false, null, null),
  ('30000000-0000-4000-8000-000000000004', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/s4.webp', 'in_progress', false, current_setting('test.jorhat')::uuid, null),
  ('30000000-0000-4000-8000-000000000005', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/s5.webp', 'invalid',     false, current_setting('test.jorhat')::uuid, null),
  ('30000000-0000-4000-8000-000000000006', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/s6.webp', 'cleaned',     true,  current_setting('test.jorhat')::uuid, null);
insert into public.cleanup_proofs (report_id, image_url, status) values
  ('30000000-0000-4000-8000-000000000001', 'https://res.cloudinary.com/pgtap/p1.webp', 'pending'),
  ('30000000-0000-4000-8000-000000000002', 'https://res.cloudinary.com/pgtap/p2.webp', 'pending');
insert into public.audit_log (municipality_id, entity_type, entity_id, actor_email, action) values
  (current_setting('test.jorhat')::uuid, 'report', 'pgtap-jorhat', 'system', 'pgtap'),
  ('10000000-0000-4000-8000-000000000001', 'report', 'pgtap-other', 'system', 'pgtap');

-- ── Seed and table privileges ────────────────────────────────────────────────
select is((select count(*)::int from public.wards w join public.municipalities m on m.id = w.municipality_id
           where m.slug = 'jorhat' and w.name is null and w.number between 1 and 19), 19, 'Jorhat has wards 1 to 19 with null names');
select ok(not has_table_privilege('anon', 'public.municipalities', 'select')
      and not has_table_privilege('anon', 'public.wards', 'select')
      and not has_table_privilege('anon', 'public.ward_localities', 'select')
      and not has_table_privilege('anon', 'public.staff_profiles', 'select')
      and not has_table_privilege('anon', 'public.audit_log', 'select'), 'anon has no SELECT on any new table');
select ok(not has_table_privilege('authenticated', 'public.audit_log', 'insert, update, delete, truncate')
      and not has_table_privilege('authenticated', 'public.staff_profiles', 'insert, update, delete, truncate')
      and not has_table_privilege('authenticated', 'public.municipalities', 'insert, update, delete, truncate')
      and not has_table_privilege('authenticated', 'public.wards', 'insert, update, delete, truncate'), 'authenticated has no write privilege on the new tables');
select ok(not has_table_privilege('authenticated', 'public.reports', 'insert, delete, truncate'), 'authenticated cannot insert or delete reports');
select ok(not has_table_privilege('anon', 'public.report_activity', 'select, insert, update, delete, truncate')
      and not has_table_privilege('anon', 'public.mla_list', 'insert, update, delete, truncate')
      and not has_table_privilege('anon', 'public.mp_list', 'insert, update, delete, truncate')
      and not has_table_privilege('anon', 'public.constituencies', 'insert, update, delete, truncate')
      and has_table_privilege('anon', 'public.mla_list', 'select'), 'reference tables are read-only for anon; report_activity is closed');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in
           ('reports','cleanup_proofs','municipalities','wards','ward_localities','staff_profiles','audit_log')
           and cmd in ('INSERT', 'DELETE') and permissive = 'PERMISSIVE' and qual is distinct from 'false' and with_check is distinct from 'false'), 0,
          'no policy lets a client role insert or delete on these tables');
select is((select max(n)::int from (select count(*) n from pg_policies p, unnest(p.roles) r where p.schemaname = 'public'
           and p.tablename in ('reports','cleanup_proofs','municipalities','wards','ward_localities','staff_profiles','audit_log')
           group by p.tablename, p.cmd, r) x), 1, 'one policy per table, operation and role');

-- ── Public view ──────────────────────────────────────────────────────────────
select is(
  (select string_agg(attname::text, ',' order by attname) from pg_attribute
   where attrelid = 'public.public_reports'::regclass and attnum > 0 and not attisdropped),
  'area,cleanup_photo_url,constituency,created_at,description,district,id,landmark,lok_sabha_seat,mla,mla_party,mp,mp_party,photo_url,status,updated_at,waste_type',
  'public_reports exposes only the public columns (no admin or sensitive ones)');
select is((select count(*)::int from pg_class where relname = 'public_reports' and relnamespace = 'public'::regnamespace), 1, 'there is one public_reports view');
select ok((select reloptions::text like '%security_invoker=on%' from pg_class where oid = 'public.public_reports'::regclass), 'public_reports is a security invoker view');

set local role anon;
select results_eq(
  $$select id::text, status from public.public_reports where area = 'pgtap' order by 1$$,
  $$values ('30000000-0000-4000-8000-000000000001', 'active'), ('30000000-0000-4000-8000-000000000002', 'active'),
           ('30000000-0000-4000-8000-000000000003', 'active'), ('30000000-0000-4000-8000-000000000004', 'active')$$,
  'anon sees active and in-progress reports as active; invalid and hidden ones are absent');
select throws_ok($$select admin_note from public.public_reports limit 1$$, '42703', null, 'anon cannot read admin_note through the view');
select throws_ok($$select 1 from public.audit_log limit 1$$, '42501', null, 'anon cannot read audit_log');
select throws_ok($$select 1 from public.staff_profiles limit 1$$, '42501', null, 'anon cannot read staff_profiles');
reset role;

-- ── Municipality admin (Jorhat) ──────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000002', 'role', 'authenticated',
  'email', 'jmb@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;

select results_eq($$select id::text from public.reports where area = 'pgtap' order by 1$$,
  $$values ('30000000-0000-4000-8000-000000000001'), ('30000000-0000-4000-8000-000000000004'),
           ('30000000-0000-4000-8000-000000000005'), ('30000000-0000-4000-8000-000000000006')$$,
  'a Jorhat admin reads only Jorhat reports, including invalid and hidden ones');
select is_empty($$update public.reports set admin_note = 'x' where id = '30000000-0000-4000-8000-000000000002' returning 1$$,
  'a Jorhat admin cannot update another municipality''s report');
select is_empty($$update public.reports set admin_note = 'x' where id = '30000000-0000-4000-8000-000000000003' returning 1$$,
  'a Jorhat admin cannot update a report with no municipality');
select isnt_empty($$update public.reports set admin_note = 'checked' where id = '30000000-0000-4000-8000-000000000001' returning 1$$,
  'a Jorhat admin can update a Jorhat report');
select results_eq($$select report_id::text from public.cleanup_proofs where image_url like 'https://res.cloudinary.com/pgtap/%'$$,
  $$values ('30000000-0000-4000-8000-000000000001')$$, 'a Jorhat admin sees cleanup proofs of Jorhat reports only');
select is_empty($$update public.cleanup_proofs set status = 'approved' where report_id = '30000000-0000-4000-8000-000000000002' returning 1$$,
  'a Jorhat admin cannot approve another municipality''s proof');
select results_eq($$select slug from public.municipalities$$, $$values ('jorhat')$$, 'a Jorhat admin sees only their municipality');
select is((select count(*)::int from public.wards), 19, 'a Jorhat admin sees only Jorhat wards');
select results_eq($$select email from public.staff_profiles$$, $$values ('jmb@pgtap.test')$$, 'a municipality admin sees only their own staff profile');
select results_eq($$select entity_id from public.audit_log where action = 'pgtap'$$, $$values ('pgtap-jorhat')$$, 'a Jorhat admin reads only Jorhat audit rows');
select throws_ok($$insert into public.audit_log (entity_type, entity_id, actor_email, action) values ('x', 'x', 'x', 'x')$$, '42501', null, 'staff cannot insert into audit_log');
select throws_ok($$update public.audit_log set action = 'x'$$, '42501', null, 'staff cannot update audit_log');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'staff cannot delete from audit_log');
select throws_ok($$delete from public.reports where id = '30000000-0000-4000-8000-000000000001'$$, '42501', null, 'staff cannot delete a report');
reset role;

-- A valid token whose municipality claim does not match the staff row gets nothing.
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000002', 'role', 'authenticated',
  'email', 'jmb@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.other')))::text, true);
set local role authenticated;
select is_empty($$select 1 from public.reports where area = 'pgtap'$$, 'a forged municipality claim reads nothing');
reset role;

-- ── Other municipality ───────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000003', 'role', 'authenticated',
  'email', 'other@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.other')))::text, true);
set local role authenticated;
select results_eq($$select id::text from public.reports where area = 'pgtap'$$, $$values ('30000000-0000-4000-8000-000000000002')$$,
  'another municipality''s admin cannot read Jorhat reports');
reset role;

-- ── Inactive staff, and a deactivation that takes effect with a still-valid token ──
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000004', 'role', 'authenticated',
  'email', 'inactive@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;
select is_empty($$select 1 from public.reports where area = 'pgtap'$$, 'inactive staff read no reports');
select is_empty($$update public.reports set admin_note = 'x' where id = '30000000-0000-4000-8000-000000000001' returning 1$$, 'inactive staff cannot update');
select is_empty($$select 1 from public.staff_profiles$$, 'inactive staff cannot read even their own profile');
reset role;

update public.staff_profiles set is_active = false where user_id = '20000000-0000-4000-8000-000000000003';
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000003', 'role', 'authenticated',
  'email', 'other@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.other')))::text, true);
set local role authenticated;
select is_empty($$select 1 from public.reports where area = 'pgtap'$$, 'deactivating staff blocks them at once, with the same token');
reset role;

-- ── Super admin (legacy role 'admin') ────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select is((select count(*)::int from public.reports where area = 'pgtap'), 6, 'role admin with an active profile reads every report (super admin)');
select is((select count(*)::int from public.audit_log where action = 'pgtap'), 2, 'a super admin reads audit rows of every municipality');
reset role;

-- Role 'admin' in the token but no staff profile: not staff.
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000005","role":"authenticated","email":"noprofile@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select is_empty($$select 1 from public.reports where area = 'pgtap'$$, 'an admin token without a staff profile reads nothing');
reset role;

select * from finish();
rollback;
