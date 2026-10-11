-- private.normalize_status must agree with statusOf() in src/admin/format.ts. The same table is asserted
-- in api/_lib/dashboard.check.js. If one changes, both tests must change.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

select is(private.normalize_status('verified', false), 'active', 'verified is active');
select is(private.normalize_status('pending', false), 'active', 'pending is active');
select is(private.normalize_status('active', false), 'active', 'active is active');
select is(private.normalize_status('reported', false), 'active', 'reported is active');
select is(private.normalize_status('open', false), 'active', 'open is active');
select is(private.normalize_status('in_progress', false), 'in_progress', 'in_progress');
select is(private.normalize_status('cleaned', false), 'cleaned', 'cleaned');
select is(private.normalize_status('invalid', false), 'invalid', 'invalid');
select is(private.normalize_status('rejected', false), 'invalid', 'rejected is invalid');
select is(private.normalize_status(null, false), 'invalid', 'no status is invalid');
select is(private.normalize_status('whatever', false), 'invalid', 'an unknown status is invalid');
select is(private.normalize_status('verified', true), 'invalid', 'a hidden report is invalid');
select is(private.normalize_status('cleaned', true), 'invalid', 'a hidden cleaned report is invalid');
select is(private.normalize_status('in_progress', true), 'invalid', 'a hidden in-progress report is invalid');
select is(private.normalize_status('active', true), 'invalid', 'a hidden active report is invalid');
select is(private.normalize_status('verified', null), 'active', 'a null hidden flag counts as not hidden');

select * from finish();
rollback;
