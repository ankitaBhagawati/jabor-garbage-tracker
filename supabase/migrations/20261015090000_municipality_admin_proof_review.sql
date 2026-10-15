-- A municipality admin may review (approve or reject) cleanup proofs for reports of their own municipality.
-- Expand-only: one new function, one new audit trigger, and the UPDATE grant on cleanup_proofs narrowed to the
-- three columns a review writes. Nothing existing is replaced or dropped. Re-runnable.
--
-- Row level security on cleanup_proofs already follows the report ("Staff read/update cleanup proofs", T2): a
-- municipality admin sees and updates proofs of their own municipality's reports only. What was missing:
--   * approving was two separate updates from the browser (proof, then report), so a failure in between left an
--     approved proof on an open report. review_cleanup_proof() does both in one transaction;
--   * a rejection left no trace in audit_log, and an approval only the report's status change. The trigger
--     below writes a proof_approved or proof_rejected row with the actor for every review, whoever runs it.
-- Down script: supabase/rollbacks/20261015090000_municipality_admin_proof_review.down.sql

-- ── Review a proof ───────────────────────────────────────────────────────────
-- SECURITY INVOKER: row level security on cleanup_proofs and reports decides what the caller may touch, and
-- reports_before_update() still checks the status move and fills "cleaned by" from the approved proof.
-- p_municipality is the report's municipality: the admin proxy sends a municipality admin's own; a super admin
-- names the report's (null for a report outside every municipality). A mismatch is refused.
create or replace function public.review_cleanup_proof(p_municipality uuid, p_proof uuid, p_decision text, p_note text)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_report uuid;
  v_report_muni uuid;
begin
  if not private.is_active_staff() then
    raise exception 'Only active staff may review cleanup proofs.' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'The decision must be approved or rejected.' using errcode = '22023';
  end if;
  if not private.is_super_admin() and p_municipality is distinct from private.my_municipality_id() then
    raise exception 'You may review proofs of your own municipality only.' using errcode = '42501';
  end if;

  -- Row level security hides a proof of another municipality, so it reads as "not waiting".
  select p.report_id, r.municipality_id into v_report, v_report_muni
  from public.cleanup_proofs p
  join public.reports r on r.id = p.report_id
  where p.id = p_proof and p.status = 'pending'
  for update of p;
  if not found then
    raise exception 'That cleanup proof is not waiting for review.' using errcode = 'P0002';
  end if;
  if v_report_muni is distinct from p_municipality then
    raise exception 'That cleanup proof belongs to another municipality.' using errcode = '42501';
  end if;

  update public.cleanup_proofs
  set status = p_decision,
      admin_notes = coalesce(nullif(btrim(p_note), ''), admin_notes),
      updated_at = now()
  where id = p_proof;

  -- Approving closes the report, as before. The proof is approved first, so the status trigger finds it.
  if p_decision = 'approved' then
    update public.reports set status = 'cleaned' where id = v_report;
    if not found then
      raise exception 'You may not close this report.' using errcode = '42501';
    end if;
  end if;

  return p_decision;
end;
$$;

revoke all on function public.review_cleanup_proof(uuid, uuid, text, text) from public, anon;
grant execute on function public.review_cleanup_proof(uuid, uuid, text, text) to authenticated;

-- ── Audit every review ───────────────────────────────────────────────────────
-- Security definer so it can insert into audit_log, which no client role can write. The row is filed under the
-- report (entity_type 'report'), so it shows in the report's history and in a municipality admin's audit log.
create or replace function private.cleanup_proofs_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (municipality_id, entity_type, entity_id, actor_id, actor_email, action, from_value, to_value, note)
  select r.municipality_id, 'report', new.report_id::text, auth.uid(), coalesce(nullif(auth.jwt() ->> 'email', ''), 'system'),
    case new.status when 'approved' then 'proof_approved' else 'proof_rejected' end,
    jsonb_build_object('proof_id', new.id, 'status', old.status),
    jsonb_build_object('proof_id', new.id, 'status', new.status),
    nullif(btrim(new.admin_notes), '')
  from public.reports r
  where r.id = new.report_id;
  return null;
end;
$$;

revoke all on function private.cleanup_proofs_audit() from public;

drop trigger if exists cleanup_proofs_audit on public.cleanup_proofs;
create trigger cleanup_proofs_audit
after update of status on public.cleanup_proofs
for each row
when (new.status is distinct from old.status and new.status in ('approved', 'rejected'))
execute function private.cleanup_proofs_audit();

-- ── Staff may write only the review columns ──────────────────────────────────
-- Row level security already limits the rows; this limits the columns (never the image, the report or the name).
revoke update on table public.cleanup_proofs from authenticated;
grant update (status, admin_notes, updated_at) on table public.cleanup_proofs to authenticated;
