-- Close the direct-insert side door that the spam bot used.
--
-- Context: the Supabase anon key ships in the public JS bundle, so as long as
-- an RLS policy allows anon inserts on public.reports, bots can POST straight
-- to /rest/v1/reports and bypass the rate-limited, Turnstile-protected
-- /api/reports/submit route entirely.
--
-- After this runs, the ONLY way to create a report is through the serverless
-- API route, which inserts using the service role key (RLS does not apply to
-- service_role).
--
-- ORDER MATTERS - run this ONLY after both of these are true, or report
-- submission will break for real users:
--   1. SUPABASE_SERVICE_ROLE_KEY is set in Vercel project env vars.
--   2. The deploy containing api/reports/submit.js is live in production.

drop policy if exists public_insert_v2 on public.reports;

-- Belt and braces: revoke the table privilege too, so a future permissive
-- policy cannot accidentally reopen anonymous inserts.
revoke insert on public.reports from anon;

-- NOT touched (still required):
--   - unique_photo_url constraint on public.reports
--   - all SELECT policies (public feed still reads via the anon key)
--   - authenticated/admin policies (admin dashboard, cleanup proofs)
