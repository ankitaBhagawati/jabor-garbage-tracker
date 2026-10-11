-- A note-only change is audited once; a note that rides along with another change adds no extra row.
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

select set_config('test.jorhat', (select id::text from public.municipalities where slug = 'jorhat'), true);
select set_config('test.ward1', (select w.id::text from public.wards w where w.municipality_id = current_setting('test.jorhat')::uuid and w.number = 1), true);
insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'super@pgtap.test', '{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000002', 'jmb@pgtap.test',   '{"role":"municipality_admin"}');
insert into public.staff_profiles (user_id, municipality_id, role, email) values
  ('20000000-0000-4000-8000-000000000001', null, 'super_admin', 'super@pgtap.test'),
  ('20000000-0000-4000-8000-000000000002', current_setting('test.jorhat')::uuid, 'municipality_admin', 'jmb@pgtap.test');
insert into public.reports (id, district, constituency, area, photo_url, status, municipality_id) values
  ('a0000000-0000-4000-8000-000000000001', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/n1.webp', 'verified', current_setting('test.jorhat')::uuid);
create temporary table audit_start on commit drop as select coalesce(max(id), 0) as id from public.audit_log;
grant select on audit_start to authenticated, service_role;

create function pg_temp.rows(p_action text default null) returns text language sql as $$
  select coalesce(string_agg(action || ':' || actor_email, ',' order by id), '')
  from public.audit_log where id > (select id from audit_start) and entity_id = 'a0000000-0000-4000-8000-000000000001'
    and (p_action is null or action = p_action)
$$;
grant execute on function pg_temp.rows(text) to authenticated, service_role;

select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000002', 'role', 'authenticated', 'email', 'jmb@pgtap.test',
  'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;

-- note alone
update public.reports set admin_note = 'First note' where id = 'a0000000-0000-4000-8000-000000000001';
select is(pg_temp.rows(), 'note_change:jmb@pgtap.test', 'a note-only change writes one audit row, by the signed-in admin');
select results_eq($$select from_value ->> 'admin_note', to_value ->> 'admin_note', note from public.audit_log
  where id > (select id from audit_start) and action = 'note_change' order by id desc limit 1$$,
  $$values (null::text, 'First note', 'First note')$$, 'it records the old note, the new note, and the text as the note');

-- editing it again keeps the old text in the log
update public.reports set admin_note = 'Second note' where id = 'a0000000-0000-4000-8000-000000000001';
select results_eq($$select from_value ->> 'admin_note', to_value ->> 'admin_note' from public.audit_log
  where id > (select id from audit_start) and action = 'note_change' order by id desc limit 1$$,
  $$values ('First note', 'Second note')$$, 'editing the note again keeps the previous text in the log');

-- the same text again: nothing changed, nothing logged
update public.reports set admin_note = 'Second note' where id = 'a0000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and action = 'note_change'), 2, 'saving an unchanged note writes nothing');

-- clearing the note is a change too
update public.reports set admin_note = null where id = 'a0000000-0000-4000-8000-000000000001';
select results_eq($$select to_value ->> 'admin_note', note from public.audit_log where id > (select id from audit_start) and action = 'note_change' order by id desc limit 1$$,
  $$values (null::text, null::text)$$, 'clearing the note is logged');

-- a note that rides along with another change adds no second row
update public.reports set status = 'in_progress', admin_note = 'On it' where id = 'a0000000-0000-4000-8000-000000000001';
select is(pg_temp.rows('status_change'), 'status_change:jmb@pgtap.test', 'a status change with a note writes the status row');
select results_eq($$select note from public.audit_log where id > (select id from audit_start) and action = 'status_change'$$, $$values ('On it')$$, 'which carries the note');
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and action = 'note_change'), 3, 'and no extra note_change row');

update public.reports set ward_id = current_setting('test.ward1')::uuid, admin_note = 'Ward set' where id = 'a0000000-0000-4000-8000-000000000001';
select is(pg_temp.rows('ward_change'), 'ward_change:jmb@pgtap.test', 'a ward change with a note writes the ward row');
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and action = 'note_change'), 3, 'and no extra note_change row');

-- a change with no note change writes no note row
update public.reports set status = 'active' where id = 'a0000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and action = 'note_change'), 3, 'a status change without a note change writes no note row');
reset role;

-- the server's own updates are attributed to the system
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
update public.reports set admin_note = 'From the server' where id = 'a0000000-0000-4000-8000-000000000001';
select is(pg_temp.rows('note_change'), 'note_change:jmb@pgtap.test,note_change:jmb@pgtap.test,note_change:jmb@pgtap.test,note_change:system', 'a server update of the note is logged as system');
reset role;

-- a super admin hiding a report with a note: the hide row only
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
update public.reports set is_deleted = true, admin_note = 'Hidden for testing' where id = 'a0000000-0000-4000-8000-000000000001';
select is(pg_temp.rows('hidden'), 'hidden:super@pgtap.test', 'hiding with a note writes the hide row');
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and action = 'note_change'), 4, 'and no extra note_change row');
reset role;

select * from finish();
rollback;
