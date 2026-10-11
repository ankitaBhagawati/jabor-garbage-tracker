-- T6/T7: the monthly ward report and the ward hotspot ranking, as two staff-only functions.
-- Expand-only: two new functions, nothing existing is touched.
--
-- Both are SECURITY INVOKER, so row level security on reports, wards and audit_log decides what the caller
-- sees, exactly as for the dashboard. On top of that the functions check the caller themselves:
--   * a municipality admin always gets their own municipality (the argument is ignored),
--   * a super admin names the municipality,
--   * anyone else, including a deactivated staff member, gets no rows,
--   * anon and PUBLIC cannot execute them at all.
-- No coordinates, contact details or free text leave these functions: ward-level counts and averages only.
-- Formulas: docs/REPORTS.md and docs/HOTSPOTS.md.

-- ── Monthly ward report ──────────────────────────────────────────────────────
-- p_month is the first day of the month (Asia/Kolkata). One row per ward, an Unassigned row, and a Total row.
--   received      reports created in the month (any status today)
--   cleaned       reports cleaned in the month, now cleaned, by JMB, a citizen or other (never auto)
--   auto_cleaned  reports closed by the nightly sweep in the month (reported separately, never counted as cleaned)
--   active, in_progress, invalid, overdue
--                 the state at the end of the month of every report received up to then (the backlog).
--                 The state is rebuilt from audit_log; for the current month "the end" is now, so these equal
--                 the dashboard tiles.
--   median_days, avg_days   days from received to cleaned, for the reports counted in "cleaned"
create or replace function public.monthly_ward_report(p_municipality uuid, p_month date)
returns table (
  kind text, ward_id uuid, ward_number integer, ward_name text,
  received integer, cleaned integer, auto_cleaned integer, active integer, in_progress integer, invalid integer, overdue integer,
  median_days numeric, avg_days numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_muni uuid := case when private.is_super_admin() then p_municipality else private.my_municipality_id() end;
  v_start timestamptz;
  v_end timestamptz;
  v_at timestamptz;
  v_threshold integer;
begin
  if not private.is_active_staff() or v_muni is null then
    return;
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'p_month must be the first day of a month' using errcode = '22023';
  end if;

  v_start := p_month::timestamp at time zone 'Asia/Kolkata';
  v_end := (p_month + interval '1 month')::timestamp at time zone 'Asia/Kolkata';
  v_at := least(v_end, now());
  select case when (m.settings ->> 'overdue_after_days') ~ '^\d+$' and (m.settings ->> 'overdue_after_days')::integer > 0
              then (m.settings ->> 'overdue_after_days')::integer else 7 end
    into v_threshold from public.municipalities m where m.id = v_muni;
  v_threshold := coalesce(v_threshold, 7);

  return query
  with state as (
    select r.id, r.ward_id, r.created_at, r.cleaned_by_type,
      coalesce(r.cleaned_at, r.cleaned_marked_at) as cleaned_ts,
      private.normalize_status(r.status, r.is_deleted) as now_status,
      -- the status at the end of the month: the last change up to then, else the first change after
      -- (its "from"), else, with no history at all, today's value (a report cleaned after the month end
      -- was still open at the month end)
      private.normalize_status(
        coalesce(
          (select a.to_value ->> 'status' from public.audit_log a
            where a.entity_type = 'report' and a.entity_id = r.id::text and a.action = 'status_change' and a.created_at <= v_at
            order by a.created_at desc, a.id desc limit 1),
          (select a.from_value ->> 'status' from public.audit_log a
            where a.entity_type = 'report' and a.entity_id = r.id::text and a.action = 'status_change' and a.created_at > v_at
            order by a.created_at, a.id limit 1),
          case when private.normalize_status(r.status, false) = 'cleaned' and coalesce(r.cleaned_at, r.cleaned_marked_at) > v_at
               then 'active' else r.status end),
        coalesce(
          (select a.action = 'hidden' from public.audit_log a
            where a.entity_type = 'report' and a.entity_id = r.id::text and a.action in ('hidden', 'unhidden') and a.created_at <= v_at
            order by a.created_at desc, a.id desc limit 1),
          (select coalesce((a.from_value ->> 'is_deleted')::boolean, false) from public.audit_log a
            where a.entity_type = 'report' and a.entity_id = r.id::text and a.action in ('hidden', 'unhidden') and a.created_at > v_at
            order by a.created_at, a.id limit 1),
          coalesce(r.is_deleted, false))
      ) as end_status
    from public.reports r
    where r.municipality_id = v_muni and r.created_at < v_end
  ),
  per_report as (
    select s.ward_id,
      (s.created_at >= v_start)::integer as received,
      (s.now_status = 'cleaned' and coalesce(s.cleaned_by_type, '') <> 'auto' and s.cleaned_ts >= v_start and s.cleaned_ts < v_end)::integer as cleaned,
      (s.now_status = 'cleaned' and s.cleaned_by_type = 'auto' and s.cleaned_ts >= v_start and s.cleaned_ts < v_end)::integer as auto_cleaned,
      (s.end_status = 'active')::integer as active,
      (s.end_status = 'in_progress')::integer as in_progress,
      (s.end_status = 'invalid')::integer as invalid,
      (s.end_status = 'active' and s.created_at < v_at - make_interval(days => v_threshold))::integer as overdue,
      case when s.now_status = 'cleaned' and coalesce(s.cleaned_by_type, '') <> 'auto' and s.cleaned_ts >= v_start and s.cleaned_ts < v_end
           then greatest(0, extract(epoch from (s.cleaned_ts - s.created_at)) / 86400) end as days
    from state s
  ),
  by_ward as (
    select p.ward_id,
      sum(p.received)::integer as received, sum(p.cleaned)::integer as cleaned, sum(p.auto_cleaned)::integer as auto_cleaned,
      sum(p.active)::integer as active, sum(p.in_progress)::integer as in_progress, sum(p.invalid)::integer as invalid,
      sum(p.overdue)::integer as overdue,
      round((percentile_cont(0.5) within group (order by p.days))::numeric, 1) as median_days,
      round(avg(p.days)::numeric, 1) as avg_days
    from per_report p group by p.ward_id
  ),
  total as (
    select sum(p.received)::integer as received, sum(p.cleaned)::integer as cleaned, sum(p.auto_cleaned)::integer as auto_cleaned,
      sum(p.active)::integer as active, sum(p.in_progress)::integer as in_progress, sum(p.invalid)::integer as invalid,
      sum(p.overdue)::integer as overdue,
      round((percentile_cont(0.5) within group (order by p.days))::numeric, 1) as median_days,
      round(avg(p.days)::numeric, 1) as avg_days
    from per_report p
  )
  select rows.kind, rows.ward_id, rows.ward_number, rows.ward_name, rows.received, rows.cleaned, rows.auto_cleaned, rows.active,
    rows.in_progress, rows.invalid, rows.overdue, rows.median_days, rows.avg_days
  from (
    select 'ward'::text as kind, w.id as ward_id, w.number as ward_number, w.name as ward_name,
      coalesce(b.received, 0) as received, coalesce(b.cleaned, 0) as cleaned, coalesce(b.auto_cleaned, 0) as auto_cleaned,
      coalesce(b.active, 0) as active, coalesce(b.in_progress, 0) as in_progress,
      coalesce(b.invalid, 0) as invalid, coalesce(b.overdue, 0) as overdue, b.median_days as median_days, b.avg_days as avg_days, 1 as sort_key
    from public.wards w left join by_ward b on b.ward_id = w.id
    where w.municipality_id = v_muni
    union all
    select 'unassigned'::text, null::uuid, null::integer, null::text,
      coalesce(b.received, 0), coalesce(b.cleaned, 0), coalesce(b.auto_cleaned, 0), coalesce(b.active, 0), coalesce(b.in_progress, 0),
      coalesce(b.invalid, 0), coalesce(b.overdue, 0), b.median_days, b.avg_days, 2
    from (select 1) one left join by_ward b on b.ward_id is null
    union all
    select 'total'::text, null::uuid, null::integer, null::text,
      coalesce(t.received, 0), coalesce(t.cleaned, 0), coalesce(t.auto_cleaned, 0), coalesce(t.active, 0), coalesce(t.in_progress, 0),
      coalesce(t.invalid, 0), coalesce(t.overdue, 0), t.median_days, t.avg_days, 3
    from total t
  ) rows
  order by rows.sort_key, rows.ward_number;
end;
$$;

-- ── Ward hotspot ranking ─────────────────────────────────────────────────────
-- p_days is 30, 60 or 90. Over the reports received in that window that are not invalid, per ward:
--   reports, active, overdue, repeat_locations (places named by 2 or more reports), avg_days_to_clean
--   (auto-cleaned reports are left out), score = overdue x 3 + active x 1 + repeat_locations x 2, rank.
create or replace function public.ward_hotspots(p_municipality uuid, p_days integer)
returns table (
  ward_id uuid, ward_number integer, ward_name text,
  reports integer, active integer, overdue integer, repeat_locations integer, avg_days_to_clean numeric,
  score integer, rank integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_muni uuid := case when private.is_super_admin() then p_municipality else private.my_municipality_id() end;
  v_threshold integer;
  v_since timestamptz := now() - make_interval(days => coalesce(p_days, 0));
begin
  if not private.is_active_staff() or v_muni is null then
    return;
  end if;
  if p_days is null or p_days not in (30, 60, 90) then
    raise exception 'p_days must be 30, 60 or 90' using errcode = '22023';
  end if;
  select case when (m.settings ->> 'overdue_after_days') ~ '^\d+$' and (m.settings ->> 'overdue_after_days')::integer > 0
              then (m.settings ->> 'overdue_after_days')::integer else 7 end
    into v_threshold from public.municipalities m where m.id = v_muni;
  v_threshold := coalesce(v_threshold, 7);

  return query
  with window_reports as (
    select r.ward_id, r.created_at, r.cleaned_by_type,
      coalesce(r.cleaned_at, r.cleaned_marked_at) as cleaned_ts,
      private.normalize_status(r.status, r.is_deleted) as status,
      -- the place a report names: the landmark, else the locality, ignoring case and spaces
      nullif(lower(btrim(coalesce(nullif(btrim(r.landmark), ''), r.area))), '') as place
    from public.reports r
    where r.municipality_id = v_muni and r.ward_id is not null and r.created_at >= v_since
      and private.normalize_status(r.status, r.is_deleted) <> 'invalid'
  ),
  repeats as (
    select x.ward_id, count(*)::integer as repeat_locations
    from (select ward_id, place from window_reports where place is not null group by ward_id, place having count(*) >= 2) x
    group by x.ward_id
  ),
  stats as (
    select w.ward_id,
      count(*)::integer as reports,
      (count(*) filter (where w.status = 'active'))::integer as active,
      (count(*) filter (where w.status = 'active' and w.created_at < now() - make_interval(days => v_threshold)))::integer as overdue,
      round((avg(greatest(0, extract(epoch from (w.cleaned_ts - w.created_at)) / 86400))
        filter (where w.status = 'cleaned' and coalesce(w.cleaned_by_type, '') <> 'auto' and w.cleaned_ts is not null))::numeric, 1) as avg_days_to_clean
    from window_reports w group by w.ward_id
  ),
  scored as (
    select wd.id, wd.number, wd.name,
      coalesce(s.reports, 0) as reports, coalesce(s.active, 0) as active, coalesce(s.overdue, 0) as overdue,
      coalesce(rp.repeat_locations, 0) as repeat_locations, s.avg_days_to_clean,
      coalesce(s.overdue, 0) * 3 + coalesce(s.active, 0) + coalesce(rp.repeat_locations, 0) * 2 as score
    from public.wards wd
    left join stats s on s.ward_id = wd.id
    left join repeats rp on rp.ward_id = wd.id
    where wd.municipality_id = v_muni
  )
  select sc.id, sc.number, sc.name, sc.reports, sc.active, sc.overdue, sc.repeat_locations, sc.avg_days_to_clean,
    sc.score, (rank() over (order by sc.score desc))::integer
  from scored sc
  order by sc.score desc, sc.reports desc, sc.number;
end;
$$;

revoke all on function public.monthly_ward_report(uuid, date) from public, anon;
revoke all on function public.ward_hotspots(uuid, integer) from public, anon;
grant execute on function public.monthly_ward_report(uuid, date) to authenticated;
grant execute on function public.ward_hotspots(uuid, integer) to authenticated;
