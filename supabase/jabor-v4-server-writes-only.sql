-- Public writes now go through api/reports.js and api/cleanup-proofs.js (Turnstile +
-- rate limit + validation, then a service-role insert). Remove direct anon writes.
--
-- RUN ONLY AFTER the new frontend and api/ functions are deployed and env vars are set,
-- otherwise the live site can't submit reports.

drop policy if exists "Public insert reports" on public.reports;
drop policy if exists "Public insert cleanup proofs" on public.cleanup_proofs;
revoke insert on public.reports, public.cleanup_proofs from anon, authenticated;

-- Contacts are written only by the jabor-notify edge function (service role).
revoke insert, update, delete on public.report_contacts from anon, authenticated;
