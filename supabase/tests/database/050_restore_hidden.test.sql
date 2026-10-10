-- Restore from the admin "Hidden" tab: the exact updates src/services/reportService.js sends.
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

select set_config('test.jorhat', (select id::text from public.municipalities where slug = 'jorhat'), true);
insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'super@pgtap.test', '{"role":"admin"}'),
  ('20000000-0000-4000-8000-000000000002', 'jmb@pgtap.test',   '{"role":"municipality_admin"}');
insert into public.staff_profiles (user_id, municipality_id, role, email) values
  ('20000000-0000-4000-8000-000000000001', null, 'super_admin', 'super@pgtap.test'),
  ('20000000-0000-4000-8000-000000000002', current_setting('test.jorhat')::uuid, 'municipality_admin', 'jmb@pgtap.test');

insert into public.reports (id, district, constituency, area, photo_url, status, is_deleted, invalid_reason, municipality_id) values
  -- Hidden with the old flag, before the audit log existed.
  ('50000000-0000-4000-8000-000000000001', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/r1.webp', 'cleaned',  true,  null,    null),
  ('50000000-0000-4000-8000-000000000002', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/r2.webp', 'verified', true,  'other', null),
  -- Marked invalid, and an old rejected row.
  ('50000000-0000-4000-8000-000000000003', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/r3.webp', 'invalid',  false, 'spam',  current_setting('test.jorhat')::uuid),
  ('50000000-0000-4000-8000-000000000004', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/r4.webp', 'rejected', false, null,    null),
  ('50000000-0000-4000-8000-000000000005', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/r5.webp', 'verified', true,  null,    current_setting('test.jorhat')::uuid),
  -- Not hidden: must not appear in the list.
  ('50000000-0000-4000-8000-000000000006', 'Test',   'Test',   'pgtap', 'https://res.cloudinary.com/pgtap/r6.webp', 'verified', false, null,    null);

create temporary table audit_start on commit drop as select coalesce(max(id), 0) as id from public.audit_log;
grant select on audit_start to authenticated;

-- ── Super admin ──────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"admin"}}', true);
set local role authenticated;

-- The list query: is_deleted = true or status in (invalid, rejected).
select results_eq(
  $$select id::text from public.reports where area = 'pgtap' and (is_deleted = true or status in ('invalid', 'rejected')) order by 1$$,
  $$values ('50000000-0000-4000-8000-000000000001'), ('50000000-0000-4000-8000-000000000002'), ('50000000-0000-4000-8000-000000000003'),
           ('50000000-0000-4000-8000-000000000004'), ('50000000-0000-4000-8000-000000000005')$$,
  'the Hidden list has hidden, invalid and rejected reports, and nothing else');

-- Hidden cleaned report: clear the flag, keep the status. No note given.
select lives_ok($$update public.reports set is_deleted = false, invalid_reason = null where id = '50000000-0000-4000-8000-000000000001'$$,
  'a hidden cleaned report can be restored without a note');
select results_eq($$select status, is_deleted from public.reports where id = '50000000-0000-4000-8000-000000000001'$$,
  $$values ('cleaned', false)$$, 'it stays cleaned; it is not turned into active');

-- Hidden active report, with a note.
select lives_ok($$update public.reports set is_deleted = false, invalid_reason = null, admin_note = 'Hidden by mistake' where id = '50000000-0000-4000-8000-000000000002'$$,
  'a hidden active report can be restored with a note');
select results_eq($$select status, is_deleted, invalid_reason from public.reports where id = '50000000-0000-4000-8000-000000000002'$$,
  $$values ('verified', false, null::text)$$, 'it keeps its status and the hide reason is cleared');

-- Invalid report: back to active under the transition rules (a note is required by the database).
select throws_ok($$update public.reports set status = 'active' where id = '50000000-0000-4000-8000-000000000003'$$, '23514', null,
  'invalid back to active without a note is rejected, so the tab always sends one');
select lives_ok($$update public.reports set status = 'active', admin_note = 'Restored from the Hidden tab on 2026-10-10T00:00:00.000Z' where id = '50000000-0000-4000-8000-000000000003'$$,
  'an invalid report is restored to active with the default note');
select results_eq($$select status, invalid_reason from public.reports where id = '50000000-0000-4000-8000-000000000003'$$,
  $$values ('active', null::text)$$, 'it is active and the invalid reason is cleared');
select lives_ok($$update public.reports set status = 'active', admin_note = 'Not spam' where id = '50000000-0000-4000-8000-000000000004'$$,
  'an old rejected report is restored to active');

-- Audit rows with actor and note.
select results_eq(
  $$select entity_id, action, actor_email, note from public.audit_log where id > (select id from audit_start) and entity_type = 'report' order by id$$,
  $$values ('50000000-0000-4000-8000-000000000001', 'unhidden',      'super@pgtap.test', null::text),
           ('50000000-0000-4000-8000-000000000002', 'unhidden',      'super@pgtap.test', 'Hidden by mistake'),
           ('50000000-0000-4000-8000-000000000003', 'status_change', 'super@pgtap.test', 'Restored from the Hidden tab on 2026-10-10T00:00:00.000Z'),
           ('50000000-0000-4000-8000-000000000004', 'status_change', 'super@pgtap.test', 'Not spam')$$,
  'every restore wrote one audit row with the actor and the note');
select is_empty($$select 1 from public.reports where area = 'pgtap' and id <> '50000000-0000-4000-8000-000000000005' and (is_deleted = true or status in ('invalid', 'rejected'))$$,
  'restored reports leave the Hidden list');
select throws_ok($$delete from public.reports where id = '50000000-0000-4000-8000-000000000005'$$, '42501', null, 'a super admin cannot hard-delete a report');
reset role;

-- Restored reports are public again, with the right status.
set local role anon;
select results_eq($$select id::text, status from public.public_reports where area = 'pgtap' order by 1$$,
  $$values ('50000000-0000-4000-8000-000000000001', 'cleaned'), ('50000000-0000-4000-8000-000000000002', 'active'),
           ('50000000-0000-4000-8000-000000000003', 'active'),  ('50000000-0000-4000-8000-000000000004', 'active'),
           ('50000000-0000-4000-8000-000000000006', 'active')$$,
  'restored reports are back on the public site; the one still hidden is not');
reset role;

-- ── Municipality admin: may restore an invalid report of theirs, may not unhide ──
update public.reports set status = 'invalid', invalid_reason = 'duplicate' where id = '50000000-0000-4000-8000-000000000003';
select set_config('request.jwt.claims', json_build_object('sub', '20000000-0000-4000-8000-000000000002', 'role', 'authenticated',
  'email', 'jmb@pgtap.test', 'app_metadata', json_build_object('role', 'municipality_admin', 'municipality_id', current_setting('test.jorhat')))::text, true);
set local role authenticated;
select throws_ok($$update public.reports set is_deleted = false where id = '50000000-0000-4000-8000-000000000005'$$, '42501', null,
  'a municipality admin cannot unhide a report (super admin only)');
select lives_ok($$update public.reports set status = 'active', admin_note = 'Checked on site' where id = '50000000-0000-4000-8000-000000000003'$$,
  'a municipality admin can restore an invalid report of their municipality');
select is_empty($$update public.reports set status = 'active', admin_note = 'x' where id = '50000000-0000-4000-8000-000000000004' returning 1$$,
  'a municipality admin cannot restore a report outside their municipality');
select throws_ok($$delete from public.reports where id = '50000000-0000-4000-8000-000000000003'$$, '42501', null, 'a municipality admin cannot hard-delete a report');
reset role;

select * from finish();
rollback;
