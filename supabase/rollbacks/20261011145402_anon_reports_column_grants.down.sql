-- Restores anon's table-wide SELECT on reports (reopens the admin-only columns to anon).
-- Production rollback only if the live frontend needs a column that is not in the granted list.
revoke select on table public.reports from anon;
grant select on table public.reports to anon;
