-- anon may read only the reports columns the live frontend selects.
--
-- Until now anon had SELECT on every column of public.reports, so the admin-only and newer columns
-- (admin_note, invalid_reason, assigned_to_text, cleaned_marked_by, claimed_in_municipality,
-- municipality_id, ward_id, source, embedding) could be read straight from /rest/v1/reports even
-- though public_reports leaves them out. RLS only limits which rows.
--
-- The list below is exactly the REPORT_SELECT list of the frontend on main
-- (src/services/reportService.js), so the live site keeps working before and after this runs.
-- The public_reports view (security invoker) reads only columns in this list too. The full
-- contract step (public pages on the view only, anon off the base table) comes later.
-- The staff and service roles are not affected.

revoke select on table public.reports from anon;

grant select (
  id, constituency, district, lok_sabha_seat, mla, mla_party, mp, mp_party,
  area, landmark, waste_type, description, photo_url, lat, lng, status,
  assigned_to, rejected_at, is_deleted, created_at, updated_at, tweeted_at, emailed_at
) on table public.reports to anon;
