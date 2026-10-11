-- Public (anon) reads of reports after the RLS hotfix. Rows are inserted inside this transaction
-- and rolled back at the end, so the test leaves nothing behind on any database.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

insert into public.reports (id, district, constituency, area, photo_url, status, is_deleted) values
  ('00000000-0000-4000-8000-000000000001', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/1.webp', 'verified', false),
  ('00000000-0000-4000-8000-000000000002', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/2.webp', 'pending',  false),
  ('00000000-0000-4000-8000-000000000003', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/3.webp', 'cleaned',  false),
  ('00000000-0000-4000-8000-000000000004', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/4.webp', 'cleaned',  true),
  ('00000000-0000-4000-8000-000000000005', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/5.webp', 'pending',  true),
  ('00000000-0000-4000-8000-000000000006', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/6.webp', 'verified', true),
  ('00000000-0000-4000-8000-000000000007', 'Test', 'Test', 'pgtap', 'https://res.cloudinary.com/pgtap/7.webp', 'rejected', false);
insert into public.cleanup_proofs (report_id, image_url, status) values
  ('00000000-0000-4000-8000-000000000003', 'https://res.cloudinary.com/pgtap/after-3.webp', 'approved');

-- Policy shape: one strict public SELECT policy per table.
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'reports'
           and cmd = 'SELECT' and 'anon' = any(roles)), 1, 'reports has exactly one SELECT policy for anon');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'mla_list' and cmd = 'SELECT'), 1,
          'mla_list has exactly one SELECT policy');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'mp_list' and cmd = 'SELECT'), 1,
          'mp_list has exactly one SELECT policy');

set local role anon;

-- Hidden and rejected rows are not readable.
select is_empty($$select 1 from public.reports where id = '00000000-0000-4000-8000-000000000004'$$, 'anon cannot read a hidden cleaned report');
select is_empty($$select 1 from public.reports where id = '00000000-0000-4000-8000-000000000005'$$, 'anon cannot read a hidden pending report');
select is_empty($$select 1 from public.reports where id = '00000000-0000-4000-8000-000000000006'$$, 'anon cannot read a hidden verified report');
select is_empty($$select 1 from public.reports where id = '00000000-0000-4000-8000-000000000007'$$, 'anon cannot read a rejected report');

-- What the public feed, Active and Cleaned tabs and cleanup proof form read.
select results_eq(
  $$select id::text from public.reports where area = 'pgtap' and is_deleted = false
    and status in ('verified','pending','active','reported','open','cleaned') order by id$$,
  $$values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002'), ('00000000-0000-4000-8000-000000000003')$$,
  'anon reads the visible verified, pending and cleaned reports the feed queries');
select results_eq(
  $$select status from public.reports where id = '00000000-0000-4000-8000-000000000001'$$,
  $$values ('verified')$$, 'cleanup proof form can read a verified report status');
select results_eq(
  $$select image_url from public.cleanup_proofs where report_id = '00000000-0000-4000-8000-000000000003' and status in ('pending','approved')$$,
  $$values ('https://res.cloudinary.com/pgtap/after-3.webp')$$, 'anon reads the approved after photo of a cleaned report');
select isnt_empty($$select 1 from public.public_reports where id = '00000000-0000-4000-8000-000000000003'$$,
  'public_reports still shows a visible cleaned report');
select lives_ok($$select 1 from public.mla_list limit 1$$, 'anon can query mla_list (used by /api/health)');
select lives_ok($$select 1 from public.mp_list limit 1$$, 'anon can query mp_list');

reset role;
select * from finish();
rollback;
