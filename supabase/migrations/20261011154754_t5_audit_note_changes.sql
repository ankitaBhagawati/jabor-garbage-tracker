-- T5: a change to a report's internal note on its own is audited.
--
-- private.reports_audit() wrote a row for status, cleaned-details, hide, ward and assignment changes, but
-- editing only admin_note left no trace, and "every action writes audit_log with the actor" must hold for
-- the dashboard's Internal note action. Same function, one more row: action 'note_change', from and to
-- {admin_note}, the new text as the note. Nothing else changes, and when the note changes together with a
-- status or ward change that row already carries it, so there is no duplicate.

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
  wrote boolean := false;
begin
  if new.status is distinct from old.status then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'status_change',
      jsonb_build_object('status', old.status),
      jsonb_strip_nulls(jsonb_build_object('status', new.status, 'cleaned_by_name', new.cleaned_by_name,
        'cleaned_by_type', new.cleaned_by_type, 'cleaned_at', new.cleaned_at, 'invalid_reason', new.invalid_reason)),
      change_note);
    wrote := true;
  elsif (new.cleaned_by_name, new.cleaned_by_type, new.cleaned_at) is distinct from (old.cleaned_by_name, old.cleaned_by_type, old.cleaned_at) then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'cleaned_details_change',
      jsonb_build_object('cleaned_by_name', old.cleaned_by_name, 'cleaned_by_type', old.cleaned_by_type, 'cleaned_at', old.cleaned_at),
      jsonb_build_object('cleaned_by_name', new.cleaned_by_name, 'cleaned_by_type', new.cleaned_by_type, 'cleaned_at', new.cleaned_at),
      change_note);
    wrote := true;
  end if;

  if new.is_deleted is distinct from old.is_deleted then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail,
      case when coalesce(new.is_deleted, false) then 'hidden' else 'unhidden' end,
      jsonb_build_object('is_deleted', old.is_deleted), jsonb_build_object('is_deleted', new.is_deleted), change_note);
    wrote := true;
  end if;

  if new.ward_id is distinct from old.ward_id then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'ward_change',
      jsonb_build_object('ward_id', old.ward_id), jsonb_build_object('ward_id', new.ward_id), change_note);
    wrote := true;
  end if;

  if (new.assigned_to_text, new.due_at) is distinct from (old.assigned_to_text, old.due_at) then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'assignment_change',
      jsonb_build_object('assigned_to_text', old.assigned_to_text, 'due_at', old.due_at),
      jsonb_build_object('assigned_to_text', new.assigned_to_text, 'due_at', new.due_at), change_note);
    wrote := true;
  end if;

  -- A change to the note alone (no status, ward, assignment, cleaned-details or hide change) is its own
  -- audit row. When the note changes together with something else, that row already carries the note.
  if not wrote and new.admin_note is distinct from old.admin_note then
    insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
    values (new.municipality_id, 'report', new.id::text, actor, actor_mail, 'note_change',
      jsonb_build_object('admin_note', old.admin_note), jsonb_build_object('admin_note', new.admin_note), new.admin_note);
  end if;

  return null;
end;
$$;
