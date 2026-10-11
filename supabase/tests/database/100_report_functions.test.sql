-- The monthly ward report and the hotspot ranking: who may call them, what each role sees, and the numbers.
-- Everything is created here and rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(28);

-- ── Fixtures: three municipalities with their own wards, staff and reports ───
insert into public.municipalities (id, slug, name) values
  ('30000000-0000-4000-8000-000000000001', 'pgtap-m1', 'pgtap one'),
  ('30000000-0000-4000-8000-000000000002', 'pgtap-m2', 'pgtap two'),
  ('30000000-0000-4000-8000-000000000003', 'pgtap-m3', 'pgtap three');
insert into public.wards (id, municipality_id, number, name) values
  ('31000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001', 1, 'A'),
  ('31000000-0000-4000-8000-00000000000b', '30000000-0000-4000-8000-000000000001', 2, 'B'),
  ('32000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000002', 1, 'M2 ward'),
  ('33000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 1, null),
  ('33000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 2, null),
  ('33000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 3, null);

insert into auth.users (id, email, raw_app_meta_data) values
  ('20000000-0000-4000-8000-000000000011', 'super@pgtap.test',  '{"role":"super_admin"}'),
  ('20000000-0000-4000-8000-000000000012', 'jmb1@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000013', 'jmb2@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000014', 'jmb3@pgtap.test',   '{"role":"municipality_admin"}'),
  ('20000000-0000-4000-8000-000000000015', 'gone@pgtap.test',   '{"role":"municipality_admin"}');
insert into public.staff_profiles (user_id, municipality_id, role, email, is_active) values
  ('20000000-0000-4000-8000-000000000011', null, 'super_admin', 'super@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000012', '30000000-0000-4000-8000-000000000001', 'municipality_admin', 'jmb1@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000013', '30000000-0000-4000-8000-000000000002', 'municipality_admin', 'jmb2@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000014', '30000000-0000-4000-8000-000000000003', 'municipality_admin', 'jmb3@pgtap.test', true),
  ('20000000-0000-4000-8000-000000000015', '30000000-0000-4000-8000-000000000001', 'municipality_admin', 'gone@pgtap.test', false);

-- Municipality one, August 2026 (Asia/Kolkata). id, ward, created, status, cleaned by, cleaned at.
create function pg_temp.r(n int, muni int, ward uuid, created timestamptz, st text, by_type text default null, cleaned timestamptz default null, area text default 'area')
returns void language sql as $$
  insert into public.reports (id, district, constituency, area, photo_url, municipality_id, ward_id, status, created_at, cleaned_by_type, cleaned_by_name, cleaned_at)
  values (('40000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'T', 'T', area, 'https://res.cloudinary.com/pgtap/r' || n || '.webp',
    ('30000000-0000-4000-8000-00000000000' || muni)::uuid, ward, st, created, by_type, case when by_type is null then null else 'pgtap' end, cleaned)
$$;
select pg_temp.r(1, 1, '31000000-0000-4000-8000-00000000000a', '2026-08-05 12:00+05:30', 'verified');                                          -- active, overdue at month end
select pg_temp.r(2, 1, '31000000-0000-4000-8000-00000000000a', '2026-08-10 12:00+05:30', 'cleaned', 'jmb',     '2026-08-12 12:00+05:30');       -- 2 days
select pg_temp.r(3, 1, '31000000-0000-4000-8000-00000000000a', '2026-08-10 12:00+05:30', 'cleaned', 'citizen', '2026-08-20 12:00+05:30');       -- 10 days
select pg_temp.r(4, 1, '31000000-0000-4000-8000-00000000000a', '2026-08-15 12:00+05:30', 'cleaned', 'auto',    '2026-08-31 15:00+05:30');       -- swept, not cleaned
select pg_temp.r(5, 1, '31000000-0000-4000-8000-00000000000b', '2026-08-20 12:00+05:30', 'in_progress');
select pg_temp.r(6, 1, null,                                   '2026-08-22 12:00+05:30', 'invalid');
select pg_temp.r(7, 1, '31000000-0000-4000-8000-00000000000b', '2026-07-20 12:00+05:30', 'cleaned', 'jmb',     '2026-09-03 12:00+05:30');       -- received in July, cleaned in September
select pg_temp.r(8, 1, '31000000-0000-4000-8000-00000000000b', '2026-09-05 12:00+05:30', 'verified');                                          -- after the month
select pg_temp.r(9, 1, '31000000-0000-4000-8000-00000000000a', '2026-08-12 12:00+05:30', 'verified');
select pg_temp.r(11, 1, '31000000-0000-4000-8000-00000000000b', '2026-08-16 12:00+05:30', 'verified');
select pg_temp.r(12, 2, '32000000-0000-4000-8000-00000000000a', '2026-08-03 12:00+05:30', 'verified');
-- Changed after the month end: the audit log says what they were at the end of August.
update public.reports set status = 'cleaned', cleaned_by_type = 'jmb', cleaned_by_name = 'pgtap', cleaned_at = '2026-09-02 12:00+05:30'
  where id = '40000000-0000-4000-8000-000000000009';                                  -- still active on 31 August
update public.reports set is_deleted = true where id = '40000000-0000-4000-8000-000000000011';  -- not hidden on 31 August

-- Municipality three: hotspots. now()-relative.
select pg_temp.r(21, 3, '33000000-0000-4000-8000-000000000001', now() - interval '10 days', 'verified', null, null, 'Market Gate');
select pg_temp.r(22, 3, '33000000-0000-4000-8000-000000000001', now() - interval '9 days',  'verified', null, null, ' market gate ');
select pg_temp.r(23, 3, '33000000-0000-4000-8000-000000000001', now() - interval '2 days',  'verified', null, null, 'Bus Stand');
select pg_temp.r(24, 3, '33000000-0000-4000-8000-000000000001', now() - interval '20 days', 'cleaned', 'jmb', now() - interval '16 days', 'Old Road');
select pg_temp.r(25, 3, '33000000-0000-4000-8000-000000000001', now() - interval '25 days', 'cleaned', 'auto', now() - interval '5 days', 'Lane');
select pg_temp.r(26, 3, '33000000-0000-4000-8000-000000000001', now() - interval '5 days',  'invalid', null, null, 'Market Gate');
select pg_temp.r(27, 3, '33000000-0000-4000-8000-000000000001', now() - interval '100 days', 'verified', null, null, 'Market Gate');
select pg_temp.r(28, 3, '33000000-0000-4000-8000-000000000002', now() - interval '1 day',   'verified', null, null, 'Solo');
select pg_temp.r(29, 3, '33000000-0000-4000-8000-000000000002', now() - interval '45 days', 'verified', null, null, 'Other');

create function pg_temp.report_rows(p_muni uuid, p_month date) returns text language sql stable as $$
  select coalesce(string_agg(concat_ws(':', kind, coalesce(ward_number::text, '-'), received, cleaned, auto_cleaned, active, in_progress, invalid, overdue, coalesce(median_days::text, '-'), coalesce(avg_days::text, '-')), ' ' order by ward_number nulls last, kind), '')
  from public.monthly_ward_report(p_muni, p_month)
$$;
create function pg_temp.hot_rows(p_muni uuid, p_days int) returns text language sql stable as $$
  select coalesce(string_agg(concat_ws(':', rank, ward_number, reports, active, overdue, repeat_locations, coalesce(avg_days_to_clean::text, '-'), score), ' ' order by rank, ward_number), '')
  from public.ward_hotspots(p_muni, p_days)
$$;
grant execute on function pg_temp.report_rows(uuid, date), pg_temp.hot_rows(uuid, int) to authenticated, anon;

-- ── Shape ────────────────────────────────────────────────────────────────────
select is((select count(*)::int from pg_proc where proname in ('monthly_ward_report', 'ward_hotspots') and pronamespace = 'public'::regnamespace and prosecdef), 0, 'both functions are security invoker');
select is((select count(*)::int from pg_proc p, unnest(p.proargnames) as a
  where p.proname in ('monthly_ward_report', 'ward_hotspots') and p.pronamespace = 'public'::regnamespace and a ~* '(^|_)(lat|lng|lon|gps|email|phone|contact|embedding|description|geom)(_|$)'), 0,
  'no coordinates, contact details or free text in either result');
select is((select string_agg(r.rolname, ',' order by r.rolname) from pg_proc p, aclexplode(p.proacl) x join pg_roles r on r.oid = x.grantee
  where p.proname = 'ward_hotspots' and p.pronamespace = 'public'::regnamespace and x.privilege_type = 'EXECUTE' and r.rolname in ('anon', 'authenticated')), 'authenticated', 'only authenticated may execute the ranking');
select is((select string_agg(r.rolname, ',' order by r.rolname) from pg_proc p, aclexplode(p.proacl) x join pg_roles r on r.oid = x.grantee
  where p.proname = 'monthly_ward_report' and p.pronamespace = 'public'::regnamespace and x.privilege_type = 'EXECUTE' and r.rolname in ('anon', 'authenticated')), 'authenticated', 'and the monthly report');

-- ── Anonymous and signed-out callers are refused ─────────────────────────────
set local role anon;
select throws_ok($$select * from public.monthly_ward_report('30000000-0000-4000-8000-000000000001', '2026-08-01')$$, '42501', null, 'anon cannot run the monthly report');
select throws_ok($$select * from public.ward_hotspots('30000000-0000-4000-8000-000000000003', 30)$$, '42501', null, 'anon cannot run the ranking');
reset role;

-- ── A municipality admin gets their own municipality, whatever they ask for ──
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000012","role":"authenticated","email":"jmb1@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000001"}}', true);
set local role authenticated;
select is(pg_temp.report_rows('30000000-0000-4000-8000-000000000001', '2026-08-01'),
  'ward:1:5:2:1:2:0:0:2:6.0:6.0 ward:2:2:0:0:2:1:0:2:-:- total:-:8:2:1:4:1:1:4:6.0:6.0 unassigned:-:1:0:0:0:0:1:0:-:-', 'August numbers, per ward, Unassigned and Total');
select is(pg_temp.report_rows('30000000-0000-4000-8000-000000000002', '2026-08-01'), pg_temp.report_rows('30000000-0000-4000-8000-000000000001', '2026-08-01'), 'asking for another municipality returns their own anyway');
select is(pg_temp.report_rows(null, '2026-08-01'), pg_temp.report_rows('30000000-0000-4000-8000-000000000001', '2026-08-01'), 'asking for none returns their own');
select is((select count(*)::int from public.monthly_ward_report('30000000-0000-4000-8000-000000000002', '2026-08-01') where ward_id = '32000000-0000-4000-8000-00000000000a'), 0, 'the other municipality''s ward never appears');
select throws_ok($$select * from public.monthly_ward_report('30000000-0000-4000-8000-000000000001', '2026-08-15')$$, '22023', 'p_month must be the first day of a month', 'a month must start on the 1st');
select throws_ok($$select * from public.ward_hotspots(null, 45)$$, '22023', 'p_days must be 30, 60 or 90', 'the window is 30, 60 or 90 days');
select is(pg_temp.hot_rows('30000000-0000-4000-8000-000000000003', 30), '1:1:0:0:0:0:-:0 1:2:0:0:0:0:-:0', 'asking for municipality three returns the caller''s own two wards (nothing in the last 30 days), never ward 3');
reset role;

-- ── A super admin chooses the municipality ───────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000011","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select is((select received from public.monthly_ward_report('30000000-0000-4000-8000-000000000002', '2026-08-01') where kind = 'total'), 1, 'municipality two: one report in August');
select is((select received from public.monthly_ward_report('30000000-0000-4000-8000-000000000001', '2026-08-01') where kind = 'total'), 8, 'municipality one: eight');
select is((select count(*)::int from public.monthly_ward_report(null, '2026-08-01')), 0, 'no municipality chosen: no rows');
select is((select count(*)::int from public.ward_hotspots(null, 30)), 0, 'no municipality chosen: no ranking');
reset role;

-- ── A deactivated staff member gets nothing ──────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000015","role":"authenticated","email":"gone@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000001"}}', true);
set local role authenticated;
select is((select count(*)::int from public.monthly_ward_report('30000000-0000-4000-8000-000000000001', '2026-08-01')), 0, 'a deactivated municipality admin gets no monthly report');
select is((select count(*)::int from public.ward_hotspots('30000000-0000-4000-8000-000000000001', 30)), 0, 'and no ranking');
reset role;

-- ── A signed-in user who is not staff gets nothing ───────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-0000000000ff","role":"authenticated","email":"citizen@pgtap.test","app_metadata":{}}', true);
set local role authenticated;
select is((select count(*)::int from public.monthly_ward_report('30000000-0000-4000-8000-000000000001', '2026-08-01')), 0, 'a signed-in non-staff user gets no monthly report');
select is((select count(*)::int from public.ward_hotspots('30000000-0000-4000-8000-000000000003', 30)), 0, 'and no ranking');
reset role;

-- ── Hotspot numbers (municipality three) ─────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000014","role":"authenticated","email":"jmb3@pgtap.test","app_metadata":{"role":"municipality_admin","municipality_id":"30000000-0000-4000-8000-000000000003"}}', true);
set local role authenticated;
-- rank:ward:reports:active:overdue:repeat:avg days:score
select is(pg_temp.hot_rows(null, 30), '1:1:5:3:2:1:4.0:11 2:2:1:1:0:0:-:1 3:3:0:0:0:0:-:0',
  'ward 1: 5 reports (the invalid one and the 100 day old one left out), 3 active, 2 overdue, 1 repeat place, 4.0 days to clean (the auto-cleaned one left out), score 2x3 + 3 + 1x2 = 11');
select is(pg_temp.hot_rows(null, 90), '1:1:5:3:2:1:4.0:11 2:2:2:2:1:0:-:5 3:3:0:0:0:0:-:0', 'a wider window brings in the 45 day old report: ward 2 scores 1x3 + 2 = 5');
select is((select count(*)::int from public.ward_hotspots(null, 30)), 3, 'every ward of the municipality is listed, including one with no reports');
select is((select score from public.ward_hotspots(null, 30) where ward_number = 3), 0, 'a ward with no reports scores 0');
reset role;

-- ── Ties share a rank ────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000011","role":"authenticated","email":"super@pgtap.test","app_metadata":{"role":"super_admin"}}', true);
set local role authenticated;
select is((select string_agg(rank::text, ',' order by ward_number) from public.ward_hotspots('30000000-0000-4000-8000-000000000001', 30)), '1,1', 'wards with the same score share a rank (both zero in municipality one for 30 days)');
select is((select count(*)::int from public.ward_hotspots('30000000-0000-4000-8000-000000000002', 60)), 1, 'a super admin may rank another municipality');
select is((select count(distinct ward_id)::int from public.ward_hotspots('30000000-0000-4000-8000-000000000003', 30) h join public.wards w on w.id = h.ward_id where w.municipality_id = '30000000-0000-4000-8000-000000000003'), 3, 'only that municipality''s wards');
reset role;

select * from finish();
rollback;
