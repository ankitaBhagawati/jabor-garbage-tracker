-- Rollback for 20261011170000_t6_t7_report_functions. Nothing else depends on these functions.
drop function if exists public.monthly_ward_report(uuid, date);
drop function if exists public.ward_hotspots(uuid, integer);
