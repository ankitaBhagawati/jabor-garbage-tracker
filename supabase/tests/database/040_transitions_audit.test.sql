-- Status transitions, the staff column whitelist, audit rows, the service role and the sweep.
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(46);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.municipalities (id, slug, name) values ('10000000-0000-4000-8000-000000000001', 'pgtap-town', 'pgTAP Town');
insert into public.wards (id, municipality_id, number) values ('10000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 1);
select set_config('test.jorhat', (select id::text from public.municipalities where slug = 'jorhat'), true);
select set_config('test.ward1', (select w.id::text from public.wards w where w.municipality_id = current_setting('test.jorhat')::uuid and w.number = 1), true);

insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'super@pgtap.test', '{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000002', 'jmb@pgtap.test',   '{"role":"municipality_admin"}');
insert into public.staff_profiles (user_id, municipality_id, role, email) values
  ('20000000-0000-4000-8000-000000000001', null, 'super_admin', 'super@pgtap.test'),
  ('20000000-0000-4000-8000-000000000002', current_setting('test.jorhat')::uuid, 'municipality_admin', 'jmb@pgtap.test');

insert into public.reports (id, district, constituency, area, photo_url, status, municipality_id, created_at) values
  ('40000000-0000-4000-8000-000000000001', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/t1.webp', 'verified', current_setting('test.jorhat')::uuid, now()),
  ('40000000-0000-4000-8000-000000000002', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/t2.webp', 'verified', current_setting('test.jorhat')::uuid, now()),
  ('40000000-0000-4000-8000-000000000003', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/t3.webp', 'verified', current_setting('test.jorhat')::uuid, now()),
  -- For the sweep: old enough to be swept.
  ('40000000-0000-4000-8000-000000000004', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/t4.webp', 'verified',    null, now() - interval '20 days'),
  ('40000000-0000-4000-8000-000000000005', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/t5.webp', 'verified',    current_setting('test.jorhat')::uuid, now() - interval '20 days'),
  ('40000000-0000-4000-8000-000000000006', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/t6.webp', 'in_progress', null, now() - interval '20 days'),
  -- For the service role.
  ('40000000-0000-4000-8000-000000000007', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/t7.webp', 'verified',    null, now());

create temporary table audit_start on commit drop as select coalesce(max(id), 0) as id from public.audit_log;
grant select on audit_start to authenticated, service_role;

-- ── Municipality admin on report 1 ───────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000002', 'role', 'authenticated',
  'email', 'jmb@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;

-- Whitelist.
select throws_ok($$update public.reports set area = 'changed' where id = '40000000-0000-4000-8000-000000000001'$$, '42501', null, 'staff cannot change a non-whitelisted column (area)');
select throws_ok($$update public.reports set photo_url = 'https://res.cloudinary.com/pgtap/x.webp' where id = '40000000-0000-4000-8000-000000000001'$$, '42501', null, 'staff cannot change photo_url');
select throws_ok($$update public.reports set municipality_id = null where id = '40000000-0000-4000-8000-000000000001'$$, '42501', null, 'staff cannot change municipality_id');
select throws_ok($$update public.reports set is_deleted = true where id = '40000000-0000-4000-8000-000000000001'$$, '42501', null, 'a municipality admin cannot hide a report');

-- Required fields and forbidden moves.
select throws_ok($$update public.reports set status = 'cleaned' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'cleaned needs who, type and date');
select throws_ok($$update public.reports set status = 'cleaned', cleaned_by_name = 'Team', cleaned_by_type = 'auto', cleaned_at = now() where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'staff cannot mark a report auto-cleaned');
select throws_ok($$update public.reports set status = 'invalid' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'invalid needs a reason');

-- active -> in_progress
select lives_ok($$update public.reports set status = 'in_progress', assigned_to_text = 'Ward 1 team', due_at = now() + interval '2 days' where id = '40000000-0000-4000-8000-000000000001'$$, 'active to in_progress is allowed');
select throws_ok($$update public.reports set status = 'active' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'in_progress back to active is not an allowed move');

-- ward
select lives_ok(format($$update public.reports set ward_id = %L where id = '40000000-0000-4000-8000-000000000001'$$, current_setting('test.ward1')), 'staff can set a ward of their municipality');
select throws_ok($$update public.reports set ward_id = '10000000-0000-4000-8000-0000000000a1' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'a ward of another municipality is rejected');

-- in_progress -> cleaned
select lives_ok($$update public.reports set status = 'cleaned', cleaned_by_name = 'JMB ward 1 team', cleaned_by_type = 'jmb', cleaned_at = now() - interval '1 day',
  cleaned_marked_by = '20000000-0000-4000-8000-000000000001', cleaned_marked_at = '2000-01-01' where id = '40000000-0000-4000-8000-000000000001'$$, 'in_progress to cleaned with details is allowed');
select results_eq($$select cleaned_marked_by::text, cleaned_marked_at > now() - interval '1 minute' from public.reports where id = '40000000-0000-4000-8000-000000000001'$$,
  $$values ('20000000-0000-4000-8000-000000000002', true)$$, 'cleaned_marked_by and cleaned_marked_at come from the server, not from the client');
select throws_ok($$update public.reports set status = 'invalid', invalid_reason = 'spam' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'cleaned to invalid is not an allowed move');

-- cleaned -> active
select throws_ok($$update public.reports set status = 'active' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'cleaned back to active needs a note');
select lives_ok($$update public.reports set status = 'active', admin_note = 'Wrong report marked cleaned' where id = '40000000-0000-4000-8000-000000000001'$$, 'cleaned back to active with a note is allowed');
select results_eq($$select cleaned_by_name, cleaned_by_type, cleaned_at::text, cleaned_marked_by::text from public.reports where id = '40000000-0000-4000-8000-000000000001'$$,
  $$values (null::text, null::text, null::text, null::text)$$, 'reverting to active clears the cleaned details');

-- active -> invalid -> active
select lives_ok($$update public.reports set status = 'invalid', invalid_reason = 'duplicate' where id = '40000000-0000-4000-8000-000000000001'$$, 'active to invalid with a reason is allowed');
select throws_ok($$update public.reports set status = 'in_progress' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'invalid to in_progress is not an allowed move');
select throws_ok($$update public.reports set status = 'active' where id = '40000000-0000-4000-8000-000000000001'$$, '23514', null, 'invalid back to active needs a new note');
select lives_ok($$update public.reports set status = 'active', admin_note = 'Not a duplicate after all' where id = '40000000-0000-4000-8000-000000000001'$$, 'invalid back to active with a note is allowed');

-- Audit rows for report 1: one per status or ward change, with the actor.
select results_eq(
  $$select action, from_value ->> 'status', to_value ->> 'status', actor_email, actor_id::text, note
    from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000001' and action = 'status_change' order by id$$,
  $$values ('status_change', 'verified',    'in_progress', 'jmb@pgtap.test', '20000000-0000-4000-8000-000000000002', null::text),
           ('status_change', 'in_progress', 'cleaned',     'jmb@pgtap.test', '20000000-0000-4000-8000-000000000002', null),
           ('status_change', 'cleaned',     'active',      'jmb@pgtap.test', '20000000-0000-4000-8000-000000000002', 'Wrong report marked cleaned'),
           ('status_change', 'active',      'invalid',     'jmb@pgtap.test', '20000000-0000-4000-8000-000000000002', null),
           ('status_change', 'invalid',     'active',      'jmb@pgtap.test', '20000000-0000-4000-8000-000000000002', 'Not a duplicate after all')$$,
  'every status change wrote one audit row with from, to, actor and note');
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000001' and action = 'ward_change'), 1,
  'the ward change wrote one audit row (the rejected one wrote none)');
select is((select count(*)::int from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000001' and action = 'assignment_change'), 1,
  'the assignment wrote one audit row');
select is((select to_value ->> 'cleaned_by_name' from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000001'
           and to_value ->> 'status' = 'cleaned'), 'JMB ward 1 team', 'the cleaned audit row records who cleaned it');
select is((select municipality_id::text from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000001' limit 1),
  current_setting('test.jorhat'), 'audit rows carry the report''s municipality');
reset role;

-- ── Legacy admin screen (role 'admin'): hide, and approve a citizen proof ────
insert into public.cleanup_proofs (report_id, image_url, submitted_by, status) values
  ('40000000-0000-4000-8000-000000000002', 'https://res.cloudinary.com/pgtap/tp2.webp', 'A Citizen', 'pending');
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;

-- Exactly what the current admin UI sends.
select lives_ok($$update public.cleanup_proofs set status = 'approved', updated_at = now() where report_id = '40000000-0000-4000-8000-000000000002'$$, 'the current admin can approve a cleanup proof');
select lives_ok($$update public.reports set status = 'cleaned', updated_at = now() where id = '40000000-0000-4000-8000-000000000002'$$, 'the current approve flow (status cleaned, no details) still works');
select results_eq($$select cleaned_by_type, cleaned_by_name, cleaned_at is not null, cleaned_marked_by::text from public.reports where id = '40000000-0000-4000-8000-000000000002'$$,
  $$values ('citizen', 'A Citizen', true, '20000000-0000-4000-8000-000000000001')$$, 'cleaned details are taken from the approved citizen proof');
select lives_ok($$update public.reports set is_deleted = true, updated_at = now() where id = '40000000-0000-4000-8000-000000000003'$$, 'the current hide action (is_deleted) still works for a super admin');
select results_eq($$select action, actor_email, (select invalid_reason from public.reports where id = '40000000-0000-4000-8000-000000000003')
    from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000003'$$,
  $$values ('hidden', 'super@pgtap.test', 'other')$$, 'hiding is audited and recorded with a reason');
reset role;

-- ── service_role is not restricted by the trigger ────────────────────────────
-- A service-role request carries a token with no user id or email.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok($$update public.reports set area = 'pgtap', description = 'edited by the server', tweeted_at = now() where id = '40000000-0000-4000-8000-000000000007'$$, 'service_role can change non-whitelisted columns');
select lives_ok($$update public.reports set status = 'cleaned' where id = '40000000-0000-4000-8000-000000000007'$$, 'service_role can set cleaned without the staff-only required fields');
select lives_ok($$update public.reports set status = 'verified' where id = '40000000-0000-4000-8000-000000000007'$$, 'service_role is not bound by the transition table');
select throws_ok($$update public.audit_log set action = 'x' where id > (select id from audit_start)$$, '42501', null, 'service_role cannot update audit_log');
select throws_ok($$delete from public.audit_log where id > (select id from audit_start)$$, '42501', null, 'service_role cannot delete from audit_log');
reset role;
select results_eq($$select distinct actor_email, actor_id::text from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000007'$$,
  $$values ('system', null::text)$$, 'updates without a JWT user are audited as system');

-- ── Auto-clean sweep ─────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '', true);
select lives_ok($$select public.auto_clean_old_reports()$$, 'the sweep runs as postgres with the triggers in place');
select results_eq($$select status, cleaned_by_type, cleaned_marked_at is not null from public.reports where id = '40000000-0000-4000-8000-000000000004'$$,
  $$values ('cleaned', 'auto', true)$$, 'an old report with no municipality is swept and stamped auto');
select results_eq($$select status, cleaned_by_type from public.reports where id = '40000000-0000-4000-8000-000000000005'$$,
  $$values ('verified', null::text)$$, 'an old report that belongs to a municipality is not swept');
select results_eq($$select status from public.reports where id = '40000000-0000-4000-8000-000000000006'$$,
  $$values ('in_progress')$$, 'an in-progress report is not swept');
select results_eq($$select action, actor_email, to_value ->> 'cleaned_by_type' from public.audit_log where id > (select id from audit_start) and entity_id = '40000000-0000-4000-8000-000000000004'$$,
  $$values ('status_change', 'system', 'auto')$$, 'the sweep wrote a system audit row');

-- ── staff_profiles changes are audited; the audit log is append-only for everyone ──
update public.staff_profiles set is_active = false where user_id = '20000000-0000-4000-8000-000000000002';
select results_eq($$select action, from_value ->> 'is_active', to_value ->> 'is_active' from public.audit_log
    where id > (select id from audit_start) and entity_type = 'staff_profile' and entity_id = '20000000-0000-4000-8000-000000000002' and action = 'staff_changed'$$,
  $$values ('staff_changed', 'true', 'false')$$, 'deactivating staff wrote an audit row');
select throws_ok($$update public.audit_log set note = 'tampered' where id > (select id from audit_start)$$, '42501', 'audit_log is append-only', 'even the table owner cannot update audit_log');
select throws_ok($$delete from public.audit_log where id > (select id from audit_start)$$, '42501', 'audit_log is append-only', 'even the table owner cannot delete from audit_log');
select throws_ok($$truncate public.audit_log$$, '42501', 'audit_log is append-only', 'audit_log cannot be truncated');

select * from finish();
rollback;
