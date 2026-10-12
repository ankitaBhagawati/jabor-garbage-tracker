-- A municipality admin may hide and unhide reports of their own municipality (soft hide: is_deleted).
-- Expand-only: one function replaced, nothing else touched. Until now only a super admin could.
-- Everything else the trigger enforces stays: the column whitelist, the status moves, the audit rows.
-- Row level security still limits a municipality admin to reports of their own municipality.
-- Down script: supabase/rollbacks/20261012160000_t13_municipality_admin_hide.down.sql

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

  -- Hide and unhide (is_deleted). Any active staff member may do it for the reports they can update: a super
  -- admin for any municipality, a municipality admin for their own (row level security decides which rows).
  -- It never deletes anything. A hide is recorded with a reason so hidden rows are explained in the audit log.
  if new.is_deleted is distinct from old.is_deleted then
    if not private.is_active_staff() then
      raise exception 'Only active staff may hide or unhide a report.' using errcode = '42501';
    end if;
    if coalesce(new.is_deleted, false) and new.invalid_reason is null then
      new.invalid_reason := 'other';
    end if;
  end if;

  if new_status is distinct from old_status then
    if old_status = 'active' and new_status = 'in_progress' then
      null;

    elsif old_status = 'in_progress' and new_status = 'active' then
      -- Undo a mistaken "in progress". A note is optional; the move is audited like any other.
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
