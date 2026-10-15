-- A municipality admin reviews cleanup proofs of their own municipality's reports, and no one else's.
-- Two throwaway municipalities; everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(28);

insert into public.municipalities (id, slug, name) values
  ('30000000-0000-4000-8000-000000000031', 'pgtap-p1', 'pgtap p1'),
  ('30000000-0000-4000-8000-000000000032', 'pgtap-p2', 'pgtap p2');
insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000041', 'super@pgtap.test',  '{"role":"super_admin"}'),
  ('20000000-0000-4000-8000-000000000042', 'jmb1@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000043', 'jmb2@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000044', 'gone@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000045', 'citizen@pgtap.test','{}');
insert into public.staff_profiles (user_id, municipality_id, role, email, is_active) values
  ('20000000-0000-4000-8000-000000000041', null, 'super_admin', 'super@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000042', '30000000-0000-4000-8000-000000000031', 'municipality_admin', 'jmb1@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000043', '30000000-0000-4000-8000-000000000032', 'municipality_admin', 'jmb2@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000044', '30000000-0000-4000-8000-000000000031', 'municipality_admin', 'gone@pgtap.test', false);
-- reports: three in p1, one in p2, one outside every municipality
insert into public.reports (id, district, constituency, area, photo_url, status, municipality_id) values
  ('61000000-0000-4000-8000-000000000001', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/r1.webp', 'verified', '30000000-0000-4000-8000-000000000031'),
  ('61000000-0000-4000-8000-000000000002', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/r2.webp', 'verified', '30000000-0000-4000-8000-000000000031'),
  ('61000000-0000-4000-8000-000000000003', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/r3.webp', 'verified', '30000000-0000-4000-8000-000000000031'),
  ('61000000-0000-4000-8000-000000000004', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/r4.webp', 'verified', '30000000-0000-4000-8000-000000000032'),
  ('61000000-0000-4000-8000-000000000005', 'T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/r5.webp', 'verified', null);
insert into public.cleanup_proofs (id, report_id, image_url, submitted_by, status) values
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 'https://res.cloudinary.com/pgtap/p1.webp', 'Ravi', 'pending'),
  ('62000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', 'https://res.cloudinary.com/pgtap/p2.webp', null, 'pending'),
  ('62000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000003', 'https://res.cloudinary.com/pgtap/p3.webp', null, 'pending'),
  ('62000000-0000-4000-8000-000000000004', '61000000-0000-4000-8000-000000000004', 'https://res.cloudinary.com/pgtap/p4.webp', null, 'pending'),
  ('62000000-0000-4000-8000-000000000005', '61000000-0000-4000-8000-000000000005', 'https://res.cloudinary.com/pgtap/p5.webp', null, 'pending');
create temp table audit_start as select coalesce(max(id), 0) as id from public.audit_log;
grant select on audit_start to authenticated, anon;

-- ── A municipality admin, own municipality ───────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000042","role":"authenticated","email":"jmb1@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000031"}}', true);
set local role authenticated;
select results_eq($$select id::text from public.cleanup_proofs where image_url like 'https://res.cloudinary.com/pgtap/p%' order by id$$,
  $$values ('62000000-0000-4000-8000-000000000001'), ('62000000-0000-4000-8000-000000000002'), ('62000000-0000-4000-8000-000000000003')$$,
  'a municipality admin lists the proofs of their own municipality only');
select lives_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000001', 'approved', null)$$,
  'a municipality admin can approve a proof of their municipality');
select results_eq($$select p.status, r.status, r.cleaned_by_type, r.cleaned_by_name, r.cleaned_marked_by::text from public.cleanup_proofs p join public.reports r on r.id = p.report_id where p.id = '62000000-0000-4000-8000-000000000001'$$,
  $$values ('approved', 'cleaned', 'citizen', 'Ravi', '20000000-0000-4000-8000-000000000042')$$, 'approving closes the report as before, cleaned by the citizen who sent the proof');
select results_eq($$select action, actor_email, municipality_id::text, to_value ->> 'status' from public.audit_log where id > (select id from audit_start) and entity_id = '61000000-0000-4000-8000-000000000001' order by id$$,
  $$values ('proof_approved', 'jmb1@pgtap.test', '30000000-0000-4000-8000-000000000031', 'approved'), ('status_change', 'jmb1@pgtap.test', '30000000-0000-4000-8000-000000000031', 'cleaned')$$,
  'the approval and the status change are audited with the actor');
select lives_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000002', 'rejected', '  Blurry photo ')$$,
  'a municipality admin can reject a proof of their municipality');
select results_eq($$select p.status, p.admin_notes, r.status from public.cleanup_proofs p join public.reports r on r.id = p.report_id where p.id = '62000000-0000-4000-8000-000000000002'$$,
  $$values ('rejected', 'Blurry photo', 'verified')$$, 'rejecting keeps the note and leaves the report open');
select results_eq($$select action, actor_email, note from public.audit_log where id > (select id from audit_start) and entity_id = '61000000-0000-4000-8000-000000000002'$$,
  $$values ('proof_rejected', 'jmb1@pgtap.test', 'Blurry photo')$$, 'the rejection is audited with the actor and the note');
select results_eq($$select count(*)::int from public.audit_log where action in ('proof_approved', 'proof_rejected') and id > (select id from audit_start)$$,
  $$values (2)$$, 'the municipality admin reads both review rows in the audit log');
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000001', 'rejected', null)$$,
  'P0002', null, 'a proof already reviewed cannot be reviewed again');
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000003', 'cleaned', null)$$,
  '22023', null, 'the decision is approved or rejected only');
-- another municipality's proof: invisible and unchangeable
select is_empty($$select 1 from public.cleanup_proofs where id = '62000000-0000-4000-8000-000000000004'$$, 'another municipality''s proof is invisible');
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000004', 'approved', null)$$,
  'P0002', null, 'and cannot be reviewed under the admin''s own municipality');
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000032', '62000000-0000-4000-8000-000000000004', 'approved', null)$$,
  '42501', null, 'nor by naming the other municipality');
select is_empty($$update public.cleanup_proofs set status = 'approved' where id = '62000000-0000-4000-8000-000000000004' returning 1$$,
  'nor by a direct update (row level security)');
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000005', 'approved', null)$$,
  'P0002', null, 'a proof outside every municipality is not theirs either');
select throws_ok($$update public.cleanup_proofs set image_url = 'https://example.test/x.webp' where id = '62000000-0000-4000-8000-000000000003'$$,
  '42501', null, 'staff may write only the review columns of a proof');
select throws_ok($$insert into public.audit_log (entity_type, entity_id, actor_email, action) values ('report', 'x', 'jmb1@pgtap.test', 'proof_approved')$$,
  '42501', null, 'staff cannot write audit rows themselves');
reset role;
select is((select status from public.cleanup_proofs where id = '62000000-0000-4000-8000-000000000004'), 'pending', 'the other municipality''s proof is untouched');

-- ── Deactivated staff, a signed-in non-staff user, the public ────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000044","role":"authenticated","email":"gone@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000031"}}', true);
set local role authenticated;
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000003', 'approved', null)$$,
  '42501', null, 'a deactivated municipality admin cannot review');
reset role;
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000045","role":"authenticated","email":"citizen@pgtap.test","app_metadata":{}}', true);
set local role authenticated;
select throws_ok($$select public.review_cleanup_proof(null, '62000000-0000-4000-8000-000000000005', 'approved', null)$$,
  '42501', null, 'a signed-in user who is not staff cannot review');
reset role;
set local role anon;
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000031', '62000000-0000-4000-8000-000000000003', 'approved', null)$$,
  '42501', null, 'anon cannot call the review function');
select is_empty($$select 1 from public.cleanup_proofs where status = 'pending' and image_url like 'https://res.cloudinary.com/pgtap/p%'$$, 'anon sees no pending proof');
select throws_ok($$update public.cleanup_proofs set status = 'approved' where id = '62000000-0000-4000-8000-000000000003'$$, '42501', null, 'anon cannot update a proof');
reset role;

-- ── The other municipality's admin and the super admin ───────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000043","role":"authenticated","email":"jmb2@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000032"}}', true);
set local role authenticated;
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000032', '62000000-0000-4000-8000-000000000003', 'approved', null)$$,
  'P0002', null, 'the other municipality''s admin cannot review the first one''s proof');
reset role;
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000041","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select lives_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000032', '62000000-0000-4000-8000-000000000004', 'approved', null)$$,
  'a super admin can review a proof of any municipality');
select lives_ok($$select public.review_cleanup_proof(null, '62000000-0000-4000-8000-000000000005', 'rejected', 'Wrong place')$$,
  'and of a report outside every municipality');
select throws_ok($$select public.review_cleanup_proof('30000000-0000-4000-8000-000000000032', '62000000-0000-4000-8000-000000000003', 'approved', null)$$,
  '42501', null, 'but must name the report''s own municipality');
reset role;
select results_eq($$select status from public.reports where id in ('61000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000004') order by id$$,
  $$values ('verified'), ('cleaned')$$, 'only the approved proof closed its report');

select * from finish();
rollback;
