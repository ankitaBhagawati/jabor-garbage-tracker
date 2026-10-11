-- Reverses 20261011144926_t4_lite_public_ward.sql.
-- Data loss: drops reports.source, and removes the public_form key from every municipality's settings.
-- Audit rows written by the insert trigger stay (audit_log is append-only).
-- Roll the frontend and API back first: they send the new fields.

drop trigger if exists reports_audit_insert on public.reports;
drop trigger if exists reports_before_insert on public.reports;
drop function if exists private.reports_audit_insert();
drop function if exists private.reports_before_insert();

alter table public.reports drop constraint if exists reports_source_check;
alter table public.reports drop column if exists source;

update public.municipalities set settings = settings - 'public_form';
