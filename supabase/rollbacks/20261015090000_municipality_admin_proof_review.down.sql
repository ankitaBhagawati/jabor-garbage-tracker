-- Rollback for 20261015090000_municipality_admin_proof_review. Roll the app code back first: the admin screen
-- calls review_cleanup_proof(). Audit rows already written stay (audit_log is append-only).
drop trigger if exists cleanup_proofs_audit on public.cleanup_proofs;
drop function if exists private.cleanup_proofs_audit();
drop function if exists public.review_cleanup_proof(uuid, uuid, text, text);
grant update on table public.cleanup_proofs to authenticated;
