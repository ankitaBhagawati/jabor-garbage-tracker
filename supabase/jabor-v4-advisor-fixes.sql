-- Fixes the Supabase Security Advisor warnings. Safe to run any time; re-runnable.

-- 0011 function_search_path_mutable + 0014 extension_in_public:
-- move pgvector out of the exposed public schema, then pin match_reports' search_path.
create schema if not exists extensions;
alter extension vector set schema extensions;
alter function public.match_reports(extensions.vector, int, uuid, text, timestamptz)
  set search_path = public, extensions;

-- 0028 / 0029: only the pg_cron job should run the auto-clean sweep.
revoke execute on function public.auto_clean_old_reports() from public, anon, authenticated;

-- 0025 public_bucket_allows_listing: public buckets serve object URLs without a
-- SELECT policy; this one only let clients list every file. (Photos now live on Cloudinary.)
-- If this errors with "must be owner", delete the policy in Storage → Policies instead.
drop policy if exists "Allow public image reads" on storage.objects;

-- auth_leaked_password_protection is a dashboard toggle, not SQL:
-- Authentication → Sign In / Providers → Email → "Prevent use of leaked passwords" (Pro plan).
