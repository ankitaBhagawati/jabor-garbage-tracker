-- T4-lite: the report source, ward and municipality consistency on insert, the creation audit row,
-- and what anon can read. Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

select set_config('test.jorhat', (select id::text from public.municipalities where slug = 'jorhat'), true);
select set_config('test.ward1', (select w.id::text from public.wards w where w.municipality_id = current_setting('test.jorhat')::uuid and w.number = 1), true);
insert into public.municipalities (id, slug, name) values ('10000000-0000-4000-8000-000000000001', 'pgtap-town', 'pgTAP Town');
insert into public.wards (id, municipality_id, number) values ('10000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 1);

-- ── The setting that drives the question ─────────────────────────────────────
select is((select settings -> 'public_form' ->> 'district' from public.municipalities where slug = 'jorhat'), 'Jorhat', 'Jorhat asks the question for district Jorhat');
select is((select settings -> 'public_form' -> 'constituencies' ->> 0 from public.municipalities where slug = 'jorhat'), 'Jorhat', 'and for constituency Jorhat');
select is((select settings ->> 'auto_clean_enabled' from public.municipalities where slug = 'jorhat'), 'false', 'the earlier settings are kept');
select is((select settings -> 'public_form' from public.municipalities where slug = 'pgtap-town'), null, 'a municipality without the key asks nothing');

-- ── Source ───────────────────────────────────────────────────────────────────
select throws_ok($$insert into public.reports (district, constituency, area, photo_url, source) values ('T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/bad.webp', 'import')$$,
  '23514', null, 'a source other than public or demo is rejected');

-- ── Ward and municipality must agree on insert, for every writer ─────────────
insert into public.reports (id, district, constituency, area, photo_url, status, source, municipality_id, ward_id, claimed_in_municipality) values
  ('60000000-0000-4000-8000-000000000001', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/w1.webp', 'verified', 'public', current_setting('test.jorhat')::uuid, current_setting('test.ward1')::uuid, 'yes');
select pass('a ward of the report''s own municipality is accepted');
select throws_ok(format($$insert into public.reports (district, constituency, area, photo_url, municipality_id, ward_id) values ('Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/w2.webp', %L, '10000000-0000-4000-8000-0000000000a1')$$, current_setting('test.jorhat')),
  '23514', null, 'a ward of another municipality is rejected');
select throws_ok($$insert into public.reports (district, constituency, area, photo_url, ward_id) values ('Kamrup', 'Dispur', 'pgtap', 'https://res.cloudinary.com/pgtap/w3.webp', '10000000-0000-4000-8000-0000000000a1')$$,
  '23514', null, 'a ward on a report with no municipality is rejected');
select lives_ok($$insert into public.reports (district, constituency, area, photo_url, source, claimed_in_municipality) values ('Kamrup', 'Dispur', 'pgtap', 'https://res.cloudinary.com/pgtap/w4.webp', 'public', null)$$,
  'a report with no municipality and no ward still inserts as before');
insert into public.reports (id, district, constituency, area, photo_url, source, municipality_id, claimed_in_municipality) values
  ('60000000-0000-4000-8000-000000000005', 'Jorhat', 'Jorhat', 'pgtap', 'https://res.cloudinary.com/pgtap/w5.webp', 'public', current_setting('test.jorhat')::uuid, 'not_sure');
select is((select ward_id from public.reports where id = '60000000-0000-4000-8000-000000000005'), null, 'not sure keeps the municipality and no ward');

-- ── Creation is audited with the source ──────────────────────────────────────
select results_eq(
  $$select action, actor_email, to_value ->> 'source', to_value ->> 'claimed_in_municipality', to_value ->> 'ward_id', municipality_id::text
    from public.audit_log where entity_id = '60000000-0000-4000-8000-000000000001'$$,
  $$select 'report_created', 'public', 'public', 'yes', current_setting('test.ward1'), current_setting('test.jorhat')$$,
  'a public submission wrote one audit row: actor public, source public, the answer and the ward');
select is((select count(*)::int from public.audit_log where entity_id = '60000000-0000-4000-8000-000000000005'), 1, 'one audit row per created report');
insert into public.reports (id, district, constituency, area, photo_url, source, created_at) values
  ('60000000-0000-4000-8000-000000000006', 'Kamrup', 'Dispur', 'pgtap', 'https://res.cloudinary.com/pgtap/w6.webp', 'demo', now() - interval '30 days');
select results_eq($$select actor_email, to_value ->> 'source', created_at < now() - interval '29 days' from public.audit_log where entity_id = '60000000-0000-4000-8000-000000000006'$$,
  $$values ('system', 'demo', true)$$, 'a demo row is audited as demo, at its own creation time');
select is((select count(*)::int from public.audit_log where entity_id = '60000000-0000-4000-8000-000000000001' and action <> 'report_created'), 0, 'insert wrote no other audit rows');

-- ── Staff are unaffected by the insert triggers; the audit log stays append-only ──
set local role authenticated;
select throws_ok($$insert into public.reports (district, constituency, area, photo_url) values ('T', 'T', 'pgtap', 'https://res.cloudinary.com/pgtap/c.webp')$$, '42501', null, 'staff still cannot insert reports');
reset role;

-- ── What anon can read ───────────────────────────────────────────────────────
select ok(not has_table_privilege('anon', 'public.reports', 'select'), 'anon has no table-wide SELECT on reports any more');
select ok(not has_column_privilege('anon', 'public.reports', 'ward_id', 'select')
      and not has_column_privilege('anon', 'public.reports', 'municipality_id', 'select')
      and not has_column_privilege('anon', 'public.reports', 'claimed_in_municipality', 'select')
      and not has_column_privilege('anon', 'public.reports', 'source', 'select')
      and not has_column_privilege('anon', 'public.reports', 'admin_note', 'select')
      and not has_column_privilege('anon', 'public.reports', 'invalid_reason', 'select')
      and not has_column_privilege('anon', 'public.reports', 'assigned_to_text', 'select')
      and not has_column_privilege('anon', 'public.reports', 'cleaned_marked_by', 'select')
      and not has_column_privilege('anon', 'public.reports', 'embedding', 'select'), 'anon cannot read ward, municipality, answer, source, notes or embedding from reports');
select is((select string_agg(attname::text, ',' order by attname) from pg_attribute
           where attrelid = 'public.reports'::regclass and attnum > 0 and not attisdropped and has_column_privilege('anon', attrelid, attnum, 'select')),
  'area,assigned_to,constituency,created_at,description,district,emailed_at,id,is_deleted,landmark,lat,lng,lok_sabha_seat,mla,mla_party,mp,mp_party,photo_url,rejected_at,status,tweeted_at,updated_at,waste_type',
  'anon can read exactly the columns the live frontend selects');

set local role anon;
select throws_ok($$select ward_id from public.reports limit 1$$, '42501', null, 'anon cannot select ward_id from reports');
select throws_ok($$select claimed_in_municipality from public.reports limit 1$$, '42501', null, 'anon cannot select the municipal-area answer from reports');
select throws_ok($$select * from public.reports limit 1$$, '42501', null, 'anon cannot select * from reports');
select lives_ok($$select id, constituency, district, lok_sabha_seat, mla, mla_party, mp, mp_party, area, landmark, waste_type, description, photo_url, lat, lng, status, assigned_to, rejected_at, is_deleted, created_at, updated_at, tweeted_at, emailed_at
                  from public.reports where is_deleted = false and status in ('verified','pending','active','reported','open','cleaned') order by created_at desc limit 5$$,
  'the live frontend''s query (every column it selects) still works for anon');
select isnt_empty($$select 1 from public.public_reports where id = '60000000-0000-4000-8000-000000000001'$$, 'public_reports still shows the report to anon');
select throws_ok($$select ward_id from public.public_reports limit 1$$, '42703', null, 'the view has no ward column');
select throws_ok($$select municipality_id from public.public_reports limit 1$$, '42703', null, 'the view has no municipality column');
reset role;

select * from finish();
rollback;
