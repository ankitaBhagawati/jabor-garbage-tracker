-- A municipality admin may hide and unhide reports of their own municipality (soft: is_deleted), and nothing more.
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

insert into public.municipalities (id, slug, name) values
  ('30000000-0000-4000-8000-000000000021', 'pgtap-h1', 'pgtap h1'),
  ('30000000-0000-4000-8000-000000000022', 'pgtap-h2', 'pgtap h2');
insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000031', 'super@pgtap.test',  '{"role":"super_admin"}'),
  ('20000000-0000-4000-8000-000000000032', 'jmb1@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000033', 'jmb2@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000034', 'gone@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000035', 'citizen@pgtap.test','{}');
insert into public.staff_profiles (user_id, municipality_id, role, email, is_active) values
  ('20000000-0000-4000-8000-000000000031', null, 'super_admin', 'super@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000032', '30000000-0000-4000-8000-000000000021', 'municipality_admin', 'jmb1@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000033', '30000000-0000-4000-8000-000000000022', 'municipality_admin', 'jmb2@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000034', '30000000-0000-4000-8000-000000000021', 'municipality_admin', 'gone@pgtap.test', false);
insert into public.reports (id, district, constituency, area, photo_url, status, municipality_id) values
  ('60000000-0000-4000-8000-000000000001', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/h1.webp', 'verified', '30000000-0000-4000-8000-000000000021'),
  ('60000000-0000-4000-8000-000000000002', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/h2.webp', 'verified', '30000000-0000-4000-8000-000000000022'),
  ('60000000-0000-4000-8000-000000000003', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/h3.webp', 'in_progress', '30000000-0000-4000-8000-000000000021');
create temp table audit_start as select coalesce(max(id), 0) as id from public.audit_log;
grant select on audit_start to authenticated, anon;

-- ── A municipality admin, own municipality ───────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000032","role":"authenticated","email":"jmb1@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000021"}}', true);
set local role authenticated;
select lives_ok($$update public.reports set is_deleted = true, invalid_reason = 'spam', admin_note = 'Not a real report' where id = '60000000-0000-4000-8000-000000000001'$$,
  'a municipality admin can hide a report of their municipality');
select results_eq($$select is_deleted, invalid_reason, status from public.reports where id = '60000000-0000-4000-8000-000000000001'$$,
  $$values (true, 'spam', 'verified')$$, 'it is hidden with the reason, and its status is untouched');
select results_eq($$select action, actor_email, municipality_id::text, note from public.audit_log where id > (select id from audit_start) and entity_id = '60000000-0000-4000-8000-000000000001'$$,
  $$values ('hidden', 'jmb1@pgtap.test', '30000000-0000-4000-8000-000000000021', 'Not a real report')$$, 'the hide is audited with the actor, the municipality and the note');
select lives_ok($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000003'$$, 'hiding without a reason is accepted');
select is((select invalid_reason from public.reports where id = '60000000-0000-4000-8000-000000000003'), 'other', 'and records the reason as other');
select lives_ok($$update public.reports set is_deleted = false, invalid_reason = null, admin_note = 'Hidden by mistake' where id = '60000000-0000-4000-8000-000000000003'$$, 'a municipality admin can unhide a report of their municipality');
select is((select action from public.audit_log where id > (select id from audit_start) and entity_id = '60000000-0000-4000-8000-000000000003' order by id desc limit 1), 'unhidden', 'the unhide is audited');
-- the limits that stay
select is_empty($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000002' returning 1$$, 'but not a report of another municipality');
select throws_ok($$update public.reports set area = 'changed', is_deleted = true where id = '60000000-0000-4000-8000-000000000003'$$, '42501', null, 'hiding does not open other columns');
select throws_ok($$delete from public.reports where id = '60000000-0000-4000-8000-000000000001'$$, '42501', null, 'nothing is ever deleted');
reset role;

-- hidden reports are off the public site
set local role anon;
select is_empty($$select 1 from public.public_reports where id = '60000000-0000-4000-8000-000000000001'$$, 'a hidden report is not on the public site');
select throws_ok($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000003'$$, '42501', null, 'anon cannot hide');
reset role;

-- ── Others ───────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000034","role":"authenticated","email":"gone@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000021"}}', true);
set local role authenticated;
select is_empty($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000003' returning 1$$, 'a deactivated municipality admin cannot hide');
reset role;
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000035","role":"authenticated","email":"citizen@pgtap.test","app_metadata":{}}', true);
set local role authenticated;
select is_empty($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000003' returning 1$$, 'a signed-in user who is not staff cannot hide');
reset role;
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000033","role":"authenticated","email":"jmb2@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000022"}}', true);
set local role authenticated;
select is_empty($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000001' returning 1$$, 'another municipality''s admin cannot hide this one');
select lives_ok($$update public.reports set is_deleted = true where id = '60000000-0000-4000-8000-000000000002'$$, 'but can hide their own');
reset role;
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000031","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select lives_ok($$update public.reports set is_deleted = false where id = '60000000-0000-4000-8000-000000000002'$$, 'a super admin can still unhide any report');
reset role;

select * from finish();
rollback;
