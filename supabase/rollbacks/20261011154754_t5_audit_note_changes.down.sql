-- Reverses 20261011154754: the audit trigger function goes back to its T2 definition (no note_change rows).
-- Rows already written stay (audit_log is append-only).

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
