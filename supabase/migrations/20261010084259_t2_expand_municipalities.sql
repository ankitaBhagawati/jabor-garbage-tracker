-- T2 expand: municipalities, wards, staff, audit log, new report columns, staff RLS, triggers.
-- Additive only. Existing status values and is_deleted are not rewritten, and anon keeps its
-- SELECT on the base reports table (the live site still reads it). The contract step is a
-- later, separate migration.
--
-- Order matters: backfills run before the triggers exist, so they create no audit rows.

-- ── 1. Extensions (in the extensions schema; types and operator classes are qualified) ──
create extension if not exists postgis with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ── 2. Private schema and status normalisation ───────────────────────────────
create schema if not exists private;
revoke all on schema private from public;
-- anon needs USAGE because the security-invoker view public_reports calls normalize_status.
-- The private schema is not exposed through the REST API, so nothing here is callable as an RPC.
grant usage on schema private to anon, authenticated, service_role;

-- Legacy and new status values, mapped to the four statuses of the JMB workflow.
-- A hidden report (is_deleted = true) counts as invalid whatever its status says.
create or replace function private.normalize_status(p_status text, p_is_deleted boolean default false)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_is_deleted, false) then 'invalid'
    when p_status in ('verified', 'pending', 'active', 'reported', 'open') then 'active'
    when p_status = 'in_progress' then 'in_progress'
    when p_status = 'cleaned' then 'cleaned'
    else 'invalid'  -- rejected, invalid, null or anything unknown
  end
$$;
revoke all on function private.normalize_status(text, boolean) from public;
grant execute on function private.normalize_status(text, boolean) to anon, authenticated, service_role;

-- ── 3. New tables ────────────────────────────────────────────────────────────
create table if not exists public.municipalities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_url text,
  is_active boolean not null default true,
  settings jsonb not null default '{"overdue_after_days":7}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.wards (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references public.municipalities(id),
  number integer not null,
  name text,
  geom extensions.geometry(MultiPolygon, 4326),
  unique (municipality_id, number)
);

create table if not exists public.ward_localities (
  id uuid primary key default gen_random_uuid(),
  ward_id uuid not null references public.wards(id) on delete cascade,
  municipality_id uuid not null references public.municipalities(id),
  name text not null,
  aliases text[] not null default '{}'
);
create index if not exists idx_ward_localities_name_trgm
  on public.ward_localities using gin (lower(name) extensions.gin_trgm_ops);
create index if not exists idx_ward_localities_ward on public.ward_localities (ward_id);
create index if not exists idx_ward_localities_municipality on public.ward_localities (municipality_id);

create table if not exists public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  municipality_id uuid references public.municipalities(id),
  role text not null check (role in ('super_admin', 'municipality_admin')),
  email text not null,
  full_name text,
  designation text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  -- A municipality admin always belongs to a municipality; a super admin never does.
  constraint staff_profiles_role_scope check ((role = 'municipality_admin') = (municipality_id is not null))
);
create index if not exists idx_staff_profiles_municipality on public.staff_profiles (municipality_id);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  municipality_id uuid references public.municipalities(id),
  entity_type text not null,
  entity_id text not null,
  actor_id uuid,
  actor_email text not null,
  action text not null,
  from_value jsonb,
  to_value jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_log_entity on public.audit_log (entity_type, entity_id, created_at);
create index if not exists idx_audit_log_municipality on public.audit_log (municipality_id, created_at);

-- Supabase default privileges give anon and authenticated ALL on every new object in public.
-- Clear them, then grant only what each table's policy needs (all five: staff SELECT only).
alter table public.municipalities enable row level security;
alter table public.wards enable row level security;
alter table public.ward_localities enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.audit_log enable row level security;

revoke all on table public.municipalities, public.wards, public.ward_localities,
  public.staff_profiles, public.audit_log from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;
grant select on table public.municipalities, public.wards, public.ward_localities,
  public.staff_profiles, public.audit_log to authenticated;
-- The audit log is append-only for server code too (a trigger below also enforces this).
revoke update, delete, truncate on table public.audit_log from service_role;

-- ── 4. Seed: Jorhat and wards 1 to 19, names null until JMB supplies them ────
insert into public.municipalities (slug, name)
values ('jorhat', 'Jorhat Municipal Board')
on conflict (slug) do nothing;

insert into public.wards (municipality_id, number)
select m.id, n
from public.municipalities m, generate_series(1, 19) as n
where m.slug = 'jorhat'
on conflict (municipality_id, number) do nothing;

-- ── 5. reports: new nullable columns and a wider status check ────────────────
alter table public.reports
  add column if not exists municipality_id uuid references public.municipalities(id),
  add column if not exists ward_id uuid references public.wards(id) on delete set null,
  add column if not exists gps_accuracy double precision,
  add column if not exists gps_source text,
  add column if not exists claimed_in_municipality text,
  add column if not exists in_municipality boolean,
  add column if not exists invalid_reason text,
  add column if not exists cleaned_by_name text,
  add column if not exists cleaned_by_type text,
  add column if not exists cleaned_at timestamptz,
  add column if not exists cleaned_marked_at timestamptz,
  add column if not exists cleaned_marked_by uuid,
  add column if not exists assigned_to_text text,
  add column if not exists due_at timestamptz,
  add column if not exists admin_note text;

alter table public.reports drop constraint if exists reports_gps_source_check;
alter table public.reports add constraint reports_gps_source_check
  check (gps_source in ('device', 'pin', 'text'));
alter table public.reports drop constraint if exists reports_claimed_in_municipality_check;
alter table public.reports add constraint reports_claimed_in_municipality_check
  check (claimed_in_municipality in ('yes', 'no', 'not_sure'));
alter table public.reports drop constraint if exists reports_cleaned_by_type_check;
alter table public.reports add constraint reports_cleaned_by_type_check
  check (cleaned_by_type in ('jmb', 'citizen', 'other', 'auto'));
alter table public.reports drop constraint if exists reports_invalid_reason_check;
alter table public.reports add constraint reports_invalid_reason_check
  check (invalid_reason in ('spam', 'duplicate', 'outside_jurisdiction', 'other'));

-- Legacy values stay valid; the three new ones are added. The default stays 'verified'.
alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports add constraint reports_status_check
  check (status in ('pending', 'verified', 'cleaned', 'rejected', 'active', 'in_progress', 'invalid'));

create index if not exists idx_reports_municipality_status_created
  on public.reports (municipality_id, status, created_at);
create index if not exists idx_reports_ward on public.reports (ward_id);
create index if not exists idx_reports_lat_lng on public.reports (lat, lng);

-- ── 6. Backfills (before any trigger exists; all re-runnable) ────────────────
-- district is a fixed dropdown value, so 'Jorhat' is an exact marker. This is tentative:
-- in_municipality stays null until ward boundaries are loaded.
update public.reports r
set municipality_id = m.id
from public.municipalities m
where m.slug = 'jorhat'
  and r.district = 'Jorhat'
  and r.municipality_id is null;

-- A cleaned report with an approved citizen proof was cleaned by a citizen. Every other
-- cleaned report was marked by the 15-day sweep, the only other path to 'cleaned' until now.
update public.reports r
set cleaned_by_type = case
  when exists (select 1 from public.cleanup_proofs p where p.report_id = r.id and p.status = 'approved')
  then 'citizen' else 'auto' end
where r.status = 'cleaned'
  and r.cleaned_by_type is null;

-- The helpers below require an active staff_profiles row, so existing admins get one.
-- Role 'admin' is treated as super_admin during the transition.
insert into public.staff_profiles (user_id, municipality_id, role, email)
select u.id, null, 'super_admin', coalesce(u.email, '')
from auth.users u
where u.raw_app_meta_data ->> 'role' in ('admin', 'super_admin')
on conflict (user_id) do nothing;

-- ── 7. Staff helpers (read the JWT app_metadata and require an active staff row) ──
create or replace function private.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_profiles sp
    where sp.user_id = (select auth.uid()) and sp.is_active
  )
$$;

create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_profiles sp
    where sp.user_id = (select auth.uid())
      and sp.is_active
      and sp.role = 'super_admin'
      -- 'admin' is the pre-pilot role name. Remove it here once every account is migrated.
      and ((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('super_admin', 'admin')
  )
$$;

-- The municipality comes from the JWT claim. It only counts when the active staff row agrees,
-- so deactivating a user or moving them takes effect before their token expires.
create or replace function private.my_municipality_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.municipality_id
  from public.staff_profiles sp
  where sp.user_id = (select auth.uid())
    and sp.is_active
    and sp.role = 'municipality_admin'
    and ((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'municipality_admin'
    and sp.municipality_id::text = ((select auth.jwt()) -> 'app_metadata' ->> 'municipality_id')
$$;

revoke all on function private.is_active_staff(), private.is_super_admin(), private.my_municipality_id() from public;
grant execute on function private.is_active_staff(), private.is_super_admin(), private.my_municipality_id()
  to authenticated, service_role;

-- ── 8. Policies on the new tables: one SELECT policy each, no client writes ───
drop policy if exists "Staff read municipalities" on public.municipalities;
create policy "Staff read municipalities" on public.municipalities for select to authenticated
using ((select private.is_super_admin()) or id = (select private.my_municipality_id()));

drop policy if exists "Staff read wards" on public.wards;
create policy "Staff read wards" on public.wards for select to authenticated
using ((select private.is_super_admin()) or municipality_id = (select private.my_municipality_id()));

drop policy if exists "Staff read ward localities" on public.ward_localities;
create policy "Staff read ward localities" on public.ward_localities for select to authenticated
using ((select private.is_super_admin()) or municipality_id = (select private.my_municipality_id()));

drop policy if exists "Staff read staff profiles" on public.staff_profiles;
create policy "Staff read staff profiles" on public.staff_profiles for select to authenticated
using ((select private.is_super_admin()) or (user_id = (select auth.uid()) and is_active));

drop policy if exists "Staff read audit log" on public.audit_log;
create policy "Staff read audit log" on public.audit_log for select to authenticated
using ((select private.is_super_admin()) or municipality_id = (select private.my_municipality_id()));

-- ── 9. Staff policies on reports and cleanup_proofs (replace the role = 'admin' ones) ──
drop policy if exists "Admin read reports" on public.reports;
drop policy if exists "Admin update reports" on public.reports;
drop policy if exists "Admin delete rejected reports" on public.reports;
drop policy if exists "Staff read reports" on public.reports;
drop policy if exists "Staff update reports" on public.reports;

create policy "Staff read reports" on public.reports for select to authenticated
using ((select private.is_super_admin()) or municipality_id = (select private.my_municipality_id()));

create policy "Staff update reports" on public.reports for update to authenticated
using ((select private.is_super_admin()) or municipality_id = (select private.my_municipality_id()))
with check ((select private.is_super_admin()) or municipality_id = (select private.my_municipality_id()));

-- The public policy now uses normalize_status, so the policy, the view and the trigger share one
-- definition of "publicly visible": not hidden, and active, in progress or cleaned.
drop policy if exists "Public read reports" on public.reports;
create policy "Public read reports" on public.reports for select to anon
using (private.normalize_status(status, is_deleted) in ('active', 'in_progress', 'cleaned'));

-- No client role may delete reports. The old policy allowed admins to delete rejected rows;
-- nothing in the app used it.
revoke delete on table public.reports from authenticated;

-- cleanup_proofs follow their report: staff see and update a proof when they may see its report.
-- The public policy becomes anon-only so authenticated has exactly one SELECT policy.
drop policy if exists "Public read approved cleanup proofs" on public.cleanup_proofs;
create policy "Public read approved cleanup proofs" on public.cleanup_proofs for select to anon
using (status = 'approved');

drop policy if exists "Admin read cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Admin update cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Staff read cleanup proofs" on public.cleanup_proofs;
drop policy if exists "Staff update cleanup proofs" on public.cleanup_proofs;

create policy "Staff read cleanup proofs" on public.cleanup_proofs for select to authenticated
using (exists (
  select 1 from public.reports r
  where r.id = cleanup_proofs.report_id
    and ((select private.is_super_admin()) or r.municipality_id = (select private.my_municipality_id()))
));

create policy "Staff update cleanup proofs" on public.cleanup_proofs for update to authenticated
using (exists (
  select 1 from public.reports r
  where r.id = cleanup_proofs.report_id
    and ((select private.is_super_admin()) or r.municipality_id = (select private.my_municipality_id()))
))
with check (exists (
  select 1 from public.reports r
  where r.id = cleanup_proofs.report_id
    and ((select private.is_super_admin()) or r.municipality_id = (select private.my_municipality_id()))
));

-- ── 10. Public view: only what the public UI shows ───────────────────────────
-- Replaces the existing view in place (a view cannot lose columns with CREATE OR REPLACE).
-- Dropped from the old view: assigned_to, rejected_at, is_deleted, lat, lng. Never exposed:
-- embedding, admin_note, claimed_in_municipality, assigned_to_text, cleaned_marked_by,
-- invalid_reason. status is normalised to 'active' or 'cleaned'; in_progress shows as active.
drop view if exists public.public_reports;
create view public.public_reports
with (security_invoker = on)
as
select
  r.id,
  r.constituency,
  r.district,
  r.lok_sabha_seat,
  coalesce(m.name, r.mla) as mla,
  coalesce(m.party, r.mla_party) as mla_party,
  coalesce(p.name, r.mp) as mp,
  coalesce(p.party, r.mp_party) as mp_party,
  r.area,
  r.landmark,
  r.waste_type,
  r.description,
  r.photo_url,
  approved_proof.image_url as cleanup_photo_url,
  case private.normalize_status(r.status, r.is_deleted)
    when 'cleaned' then 'cleaned' else 'active' end as status,
  r.created_at,
  r.updated_at
from public.reports r
left join public.mla_list m on m.constituency = r.constituency
left join public.mp_list p on p.lok_sabha_seat = r.lok_sabha_seat
left join lateral (
  select proof.image_url
  from public.cleanup_proofs proof
  where proof.report_id = r.id
    and proof.status = 'approved'
  order by proof.updated_at desc, proof.created_at desc
  limit 1
) approved_proof on true
where private.normalize_status(r.status, r.is_deleted) in ('active', 'in_progress', 'cleaned');

revoke all on table public.public_reports from public, anon, authenticated;
grant select on table public.public_reports to anon, authenticated;

-- ── 11. Audit log is append-only ─────────────────────────────────────────────
create or replace function private.audit_log_block_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;
revoke all on function private.audit_log_block_change() from public;

drop trigger if exists audit_log_no_update_delete on public.audit_log;
create trigger audit_log_no_update_delete
before update or delete on public.audit_log
for each row execute function private.audit_log_block_change();

drop trigger if exists audit_log_no_truncate on public.audit_log;
create trigger audit_log_no_truncate
before truncate on public.audit_log
for each statement execute function private.audit_log_block_change();

-- ── 12. reports BEFORE UPDATE: column whitelist and status transitions for staff ──
-- Security invoker on purpose: current_user is the caller's role, so the rules apply only to
-- 'authenticated' (staff through the admin proxy). service_role, postgres and the pg_cron sweep
-- (a security definer function owned by postgres) pass through untouched.
create or replace function private.reports_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  staff_columns constant text[] := array[
    'status', 'ward_id', 'assigned_to_text', 'due_at', 'cleaned_by_name', 'cleaned_by_type',
    'cleaned_at', 'cleaned_marked_at', 'cleaned_marked_by', 'invalid_reason', 'admin_note',
    'updated_at', 'is_deleted'];
  old_status text := private.normalize_status(old.status);
  new_status text := private.normalize_status(new.status);
  proof_name text;
begin
  -- A ward must belong to the report's municipality, whoever sets it.
  if new.ward_id is distinct from old.ward_id and new.ward_id is not null then
    if not exists (select 1 from public.wards w where w.id = new.ward_id and w.municipality_id = new.municipality_id) then
      raise exception 'That ward does not belong to this report''s municipality.' using errcode = '23514';
    end if;
  end if;

  if current_user <> 'authenticated' then
    return new;
  end if;

  if (to_jsonb(new) - staff_columns) is distinct from (to_jsonb(old) - staff_columns) then
    raise exception 'Staff may change only status, ward, assignment, cleaned details, invalid reason and note.'
      using errcode = '42501';
  end if;

  -- Legacy "hide" from the current admin screen (is_deleted). Super admins only; it is
  -- recorded as invalid with a reason so hidden rows are explained in the audit log.
  if new.is_deleted is distinct from old.is_deleted then
    if not private.is_super_admin() then
      raise exception 'Only a super admin may hide or unhide a report.' using errcode = '42501';
    end if;
    if coalesce(new.is_deleted, false) and new.invalid_reason is null then
      new.invalid_reason := 'other';
    end if;
  end if;

  if new_status is distinct from old_status then
    if old_status = 'active' and new_status = 'in_progress' then
      null;

    elsif old_status in ('active', 'in_progress') and new_status = 'cleaned' then
      -- The citizen proof flow marks a report cleaned right after approving its proof and sends
      -- no cleaned-by details. Take them from the approved proof.
      if new.cleaned_by_name is null and new.cleaned_by_type is null then
        select coalesce(nullif(btrim(p.submitted_by), ''), 'Citizen') into proof_name
        from public.cleanup_proofs p
        where p.report_id = new.id and p.status = 'approved'
        order by p.updated_at desc limit 1;
        if found then
          new.cleaned_by_type := 'citizen';
          new.cleaned_by_name := proof_name;
          new.cleaned_at := coalesce(new.cleaned_at, now());
        end if;
      end if;
      if nullif(btrim(new.cleaned_by_name), '') is null or new.cleaned_by_type is null or new.cleaned_at is null then
        raise exception 'Marking a report cleaned needs who cleaned it, the type and the date.' using errcode = '23514';
      end if;
      if new.cleaned_by_type = 'auto' then
        raise exception 'Only the system may mark a report as auto-cleaned.' using errcode = '23514';
      end if;
      new.cleaned_marked_at := now();
      new.cleaned_marked_by := auth.uid();

    elsif old_status in ('active', 'in_progress') and new_status = 'invalid' then
      if new.invalid_reason is null then
        raise exception 'Marking a report invalid needs a reason.' using errcode = '23514';
      end if;

    elsif old_status in ('cleaned', 'invalid') and new_status = 'active' then
      if nullif(btrim(new.admin_note), '') is null or new.admin_note is not distinct from old.admin_note then
        raise exception 'Moving a report back to active needs a note.' using errcode = '23514';
      end if;
      new.cleaned_by_name := null;
      new.cleaned_by_type := null;
      new.cleaned_at := null;
      new.cleaned_marked_at := null;
      new.cleaned_marked_by := null;
      new.invalid_reason := null;

    else
      raise exception 'A report cannot move from % to %.', old_status, new_status using errcode = '23514';
    end if;
  else
    -- Staff never set the system stamps directly.
    new.cleaned_marked_at := old.cleaned_marked_at;
    new.cleaned_marked_by := old.cleaned_marked_by;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.reports_before_update() from public;

drop trigger if exists reports_before_update on public.reports;
create trigger reports_before_update
before update on public.reports
for each row execute function private.reports_before_update();

-- ── 13. reports AFTER UPDATE: audit rows for every caller ────────────────────
-- Security definer so it can insert into audit_log, which no client role can write.
-- Updates without a JWT user (service role, pg_cron) are recorded as 'system'.
create or replace function private.reports_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_mail text := coalesce(nullif(auth.jwt() ->> 'email', ''), 'system');
  change_note text := case when new.admin_note is distinct from old.admin_note then new.admin_note end;
begin
  if new.status is distinct from old.status then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'status_change',
      jsonb_build_object('status', old.status),
      jsonb_strip_nulls(jsonb_build_object('status', new.status, 'cleaned_by_name', new.cleaned_by_name,
        'cleaned_by_type', new.cleaned_by_type, 'cleaned_at', new.cleaned_at, 'invalid_reason', new.invalid_reason)),
      change_note);
  elsif (new.cleaned_by_name, new.cleaned_by_type, new.cleaned_at) is distinct from (old.cleaned_by_name, old.cleaned_by_type, old.cleaned_at) then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'cleaned_details_change',
      jsonb_build_object('cleaned_by_name', old.cleaned_by_name, 'cleaned_by_type', old.cleaned_by_type, 'cleaned_at', old.cleaned_at),
      jsonb_build_object('cleaned_by_name', new.cleaned_by_name, 'cleaned_by_type', new.cleaned_by_type, 'cleaned_at', new.cleaned_at),
      change_note);
  end if;

  if new.is_deleted is distinct from old.is_deleted then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail,
      case when coalesce(new.is_deleted, false) then 'hidden' else 'unhidden' end,
      jsonb_build_object('is_deleted', old.is_deleted), jsonb_build_object('is_deleted', new.is_deleted), change_note);
  end if;

  if new.ward_id is distinct from old.ward_id then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'ward_change',
      jsonb_build_object('ward_id', old.ward_id), jsonb_build_object('ward_id', new.ward_id), change_note);
  end if;

  if (new.assigned_to_text, new.due_at) is distinct from (old.assigned_to_text, old.due_at) then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'assignment_change',
      jsonb_build_object('assigned_to_text', old.assigned_to_text, 'due_at', old.due_at),
      jsonb_build_object('assigned_to_text', new.assigned_to_text, 'due_at', new.due_at), change_note);
  end if;

  return null;
end;
$$;
revoke all on function private.reports_audit() from public;

drop trigger if exists reports_audit on public.reports;
create trigger reports_audit
after update on public.reports
for each row execute function private.reports_audit();

-- ── 14. staff_profiles changes are audited too ───────────────────────────────
create or replace function private.staff_profiles_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_mail text := coalesce(nullif(auth.jwt() ->> 'email', ''), 'system');
  before_value jsonb := case when tg_op <> 'INSERT' then jsonb_build_object(
    'role', old.role, 'municipality_id', old.municipality_id, 'is_active', old.is_active, 'designation', old.designation) end;
  after_value jsonb := case when tg_op <> 'DELETE' then jsonb_build_object(
    'role', new.role, 'municipality_id', new.municipality_id, 'is_active', new.is_active, 'designation', new.designation) end;
begin
  if tg_op = 'UPDATE' and before_value = after_value then
    return null;
  end if;
  insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value)
  values (
    case when tg_op = 'DELETE' then old.municipality_id else new.municipality_id end,
    'staff_profile',
    (case when tg_op = 'DELETE' then old.user_id else new.user_id end)::text,
    actor, actor_mail,
    case tg_op when 'INSERT' then 'staff_created' when 'DELETE' then 'staff_deleted' else 'staff_changed' end,
    before_value, after_value);
  return null;
end;
$$;
revoke all on function private.staff_profiles_audit() from public;

drop trigger if exists staff_profiles_audit on public.staff_profiles;
create trigger staff_profiles_audit
after insert or update or delete on public.staff_profiles
for each row execute function private.staff_profiles_audit();

-- ── 15. Auto-clean sweep ─────────────────────────────────────────────────────
-- Same job name and daily schedule. Changes: rows are stamped cleaned_by_type = 'auto', and
-- reports that belong to a municipality are skipped (their staff decide when they are cleaned).
-- in_progress rows are never swept because they are not in the status list.
-- The AFTER UPDATE trigger writes one 'system' audit row per swept report.
-- Dashboards and exports must count 'auto' separately from 'jmb' and 'citizen', and leave it
-- out of days-to-clean and cleaned-without-proof.
create or replace function public.auto_clean_old_reports()
returns void
language sql
security definer
set search_path = public
as $$
  update public.reports
  set status = 'cleaned',
      cleaned_by_type = 'auto',
      cleaned_at = now(),
      cleaned_marked_at = now(),
      updated_at = now()
  -- 'pending' left out: unmoderated reports shouldn't surface publicly as Cleaned.
  where status in ('verified', 'active', 'reported', 'open')
    and is_deleted = false
    and municipality_id is null
    and created_at <= now() - interval '15 days';
$$;

-- ── 16. Grant hygiene on older tables ────────────────────────────────────────
-- report_activity: RLS on, no policies, not used by the app, api or edge functions.
revoke all on table public.report_activity from public, anon, authenticated;

-- Reference data: read-only for clients.
revoke all on table public.constituencies, public.mla_list, public.mp_list from public, anon, authenticated;
grant select on table public.constituencies, public.mla_list, public.mp_list to anon, authenticated;
revoke all on sequence public.constituencies_id_seq from public, anon, authenticated;

-- Reporter contacts: admins read them through RLS; nobody else needs any privilege.
revoke all on table public.report_contacts from public, anon, authenticated;
grant select on table public.report_contacts to authenticated;

notify pgrst, 'reload schema';
