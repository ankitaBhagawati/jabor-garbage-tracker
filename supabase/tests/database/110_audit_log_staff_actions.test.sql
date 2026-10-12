-- The audit log and the staff management routes: the table takes the new staff and export rows with no change
-- (so no migration is needed), it stays append-only, and who can read which rows (the export reads as the caller).
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

insert into public.municipalities (id, slug, name) values
  ('30000000-0000-4000-8000-000000000011', 'pgtap-a', 'pgtap a'),
  ('30000000-0000-4000-8000-000000000012', 'pgtap-b', 'pgtap b');
insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000021', 'super@pgtap.test', '{"role":"super_admin"}'),
  ('20000000-0000-4000-8000-000000000022', 'jmb-a@pgtap.test', '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000023', 'jmb-b@pgtap.test', '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000024', 'gone@pgtap.test', '{"role":"municipality_admin"}');
insert into public.staff_profiles (user_id, municipality_id, role, email, is_active) values
  ('20000000-0000-4000-8000-000000000021', null, 'super_admin', 'super@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000022', '30000000-0000-4000-8000-000000000011', 'municipality_admin', 'jmb-a@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000023', '30000000-0000-4000-8000-000000000012', 'municipality_admin', 'jmb-b@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000024', '30000000-0000-4000-8000-000000000011', 'municipality_admin', 'gone@pgtap.test', false);

-- ── The table needs nothing new ──────────────────────────────────────────────
select is((select count(*)::int from pg_constraint where conrelid = 'public.audit_log'::regclass and contype = 'c'), 0,
  'audit_log has no check constraint on entity_type or action');
select is((select string_agg(contype::text, ',' order by contype) from pg_constraint where conrelid = 'public.audit_log'::regclass), 'f,p', 'only the key and the municipality foreign key');

-- Rows the staff routes and the exports write, as the server writes them (service role).
set local role service_role;
select lives_ok($$insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, to_value) values
  ('30000000-0000-4000-8000-000000000011', 'staff_member', '20000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000021', 'super@pgtap.test', 'staff_account_created', '{"email":"jmb-a@pgtap.test","role":"municipality_admin"}')$$,
  'a staff_account_created row is accepted');
select lives_ok($$insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value) values
  ('30000000-0000-4000-8000-000000000011', 'staff_member', '20000000-0000-4000-8000-000000000024', '20000000-0000-4000-8000-000000000021', 'super@pgtap.test', 'staff_account_deactivated', '{"is_active":true}', '{"is_active":false}')$$,
  'a staff_account_deactivated row is accepted');
select lives_ok($$insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, to_value) values
  ('30000000-0000-4000-8000-000000000012', 'export', 'audit_log', '20000000-0000-4000-8000-000000000023', 'jmb-b@pgtap.test', 'export', '{"type":"audit_log","rows":3,"total":3,"truncated":false,"filters":"action=eq.x"}')$$,
  'an export row for the audit log is accepted');
select lives_ok($$insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action) values
  (null, 'export', 'audit_log', '20000000-0000-4000-8000-000000000021', 'super@pgtap.test', 'export')$$, 'and one with no municipality (a super admin exporting everything)');
-- still append-only for the service role
select throws_ok($$update public.audit_log set note = 'changed' where entity_type = 'export'$$, null, null, 'the service role cannot update the audit log');
select throws_ok($$delete from public.audit_log where entity_type = 'export'$$, null, null, 'or delete from it');
reset role;

-- ── Who reads which rows (the export reads with the caller's own token) ──────
create function pg_temp.visible() returns text language sql stable as $$
  select coalesce(string_agg(action || '@' || coalesce(municipality_id::text, 'none'), ',' order by id), '')
  from public.audit_log where entity_type in ('staff_member', 'export')
$$;
grant execute on function pg_temp.visible() to authenticated, anon;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000021","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select is((select count(*)::int from public.audit_log where entity_type in ('staff_member', 'export')), 4, 'a super admin reads every municipality''s rows, and the ones with none');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000022","role":"authenticated","email":"jmb-a@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000011"}}', true);
set local role authenticated;
select is(pg_temp.visible(), 'staff_account_created@30000000-0000-4000-8000-000000000011,staff_account_deactivated@30000000-0000-4000-8000-000000000011', 'a municipality admin reads only their own municipality''s rows');
select is((select count(*)::int from public.audit_log where municipality_id = '30000000-0000-4000-8000-000000000012'), 0, 'asking for another municipality returns nothing');
select is((select count(*)::int from public.audit_log where municipality_id is null), 0, 'and the rows with no municipality are not theirs');
select throws_ok($$insert into public.audit_log (entity_type, entity_id, actor_email, action) values ('export', 'x', 'jmb-a@pgtap.test', 'export')$$, '42501', null, 'a municipality admin cannot write audit rows');
select throws_ok($$update public.audit_log set note = 'x'$$, '42501', null, 'or change them');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000023","role":"authenticated","email":"jmb-b@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000012"}}', true);
set local role authenticated;
select is(pg_temp.visible(), 'export@30000000-0000-4000-8000-000000000012', 'another municipality admin sees only theirs');
reset role;

select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000024","role":"authenticated","email":"gone@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000011"}}', true);
set local role authenticated;
select is(pg_temp.visible(), '', 'a deactivated municipality admin reads nothing');
reset role;

set local role anon;
select throws_ok($$select count(*) from public.audit_log$$, '42501', null, 'anon cannot read the audit log');
reset role;

select * from finish();
rollback;
