-- T4-lite: the public report form can ask "is this inside the municipal area?" and, for Yes,
-- which ward. Additive only.
--
--   1. municipalities.settings.public_form says where the question is asked. Switching another
--      municipality on is a data change: set this key for it.
--   2. reports.source records where a row came from ('public' form or 'demo' seed data).
--   3. A BEFORE INSERT trigger keeps ward and municipality consistent whoever inserts.
--   4. An AFTER INSERT trigger writes the creation to audit_log, with the source.
--
-- Nothing here is readable by anon: public_reports is unchanged and the new columns stay out of it.

-- ── 1. Where the question is asked ───────────────────────────────────────────
-- Shape: {"district": "...", "constituencies": ["...", ...]}. The question is asked when the
-- reporter picks one of those constituencies in that district.
update public.municipalities
set settings = settings || '{"public_form": {"district": "Jorhat", "constituencies": ["Jorhat"]}}'::jsonb
where slug = 'jorhat'
  and not (settings ? 'public_form');

-- ── 2. Where a report came from ──────────────────────────────────────────────
alter table public.reports add column if not exists source text;
alter table public.reports drop constraint if exists reports_source_check;
alter table public.reports add constraint reports_source_check check (source in ('public', 'demo'));

-- ── 3. Ward and municipality must agree on insert ────────────────────────────
-- The submit route already checks this. The trigger makes it hold for every writer, and it runs
-- for the service role too. (The update trigger has the same rule.)
create or replace function private.reports_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.ward_id is not null then
    if not exists (
      select 1 from public.wards w
      where w.id = new.ward_id and w.municipality_id = new.municipality_id
    ) then
      raise exception 'That ward does not belong to this report''s municipality.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.reports_before_insert() from public;

drop trigger if exists reports_before_insert on public.reports;
create trigger reports_before_insert
before insert on public.reports
for each row execute function private.reports_before_insert();

-- ── 4. Creation is audited ───────────────────────────────────────────────────
-- Security definer because no client role can write audit_log. created_at is the report's own
-- creation time, so rows inserted with a past date (the demo seed) are audited at that date.
-- Public submissions have no signed-in user, so the actor is 'public'.
create or replace function private.reports_audit_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, to_value, created_at)
  values (
    new.municipality_id, 'report', new.id::text, auth.uid(),
    coalesce(nullif(auth.jwt() ->> 'email', ''), case when new.source = 'public' then 'public' else 'system' end),
    'report_created',
    jsonb_strip_nulls(jsonb_build_object(
      'source', coalesce(new.source, 'unknown'),
      'claimed_in_municipality', new.claimed_in_municipality,
      'ward_id', new.ward_id,
      'status', new.status)),
    coalesce(new.created_at, now()));
  return null;
end;
$$;
revoke all on function private.reports_audit_insert() from public;

drop trigger if exists reports_audit_insert on public.reports;
create trigger reports_audit_insert
after insert on public.reports
for each row execute function private.reports_audit_insert();
