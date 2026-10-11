# Supabase Auth settings to check

These are dashboard settings, not code. Nothing in this repository changes them, and `supabase/config.toml`
only configures the local stack. **Every line is "verify manually"** on both projects: staging
(`uefijiwklnelmwcipwku`) and production (`wukftoblpeybortcnkuw`). Tick the box and note the date when you have checked it.

Jabor staff are invite-only. Roles live in `app_metadata`, which users cannot edit themselves; it is written only
with the service role (the `create-demo-staff` script or a later staff route).

| # | Setting (dashboard location) | Expected | Staging | Production |
|---|---|---|---|---|
| 1 | **Allow new users to sign up** (Authentication, Sign In / Providers, User Signups) | Off. Nobody can create an account; staff are created by the owner. | [ ] | [ ] |
| 2 | **Confirm email** (Authentication, Sign In / Providers, Email) | On, so an address must be confirmed before first sign-in. Accounts made with the admin API are confirmed by the script. | [ ] | [ ] |
| 3 | **Anonymous sign-ins** (same page) | Off | [ ] | [ ] |
| 4 | **Manual linking** (same page) | Off | [ ] | [ ] |
| 5 | **Other sign-in providers** (Phone, Google, GitHub, and so on) | All off. Only email and password is used. | [ ] | [ ] |
| 6 | **Custom SMTP** (Authentication, Emails, SMTP Settings) | On, with Resend: verified sender domain (SPF, DKIM, DMARC), a real sender address, and the Resend API key as the SMTP password. The built-in Supabase mailer is rate limited and not for production use. Staff invites and password resets depend on it. | [ ] | [ ] |
| 7 | **Email templates** (Authentication, Emails, Templates) | Invite, Confirm and Reset read plainly, say "Jabor", and link to the right site (`https://staging.jabor.in` or `https://jabor.in`). | [ ] | [ ] |
| 8 | **Prevent use of leaked passwords** (Authentication, Sign In / Providers, Email, Password Security) | On. This needs the Pro plan; it is the one security advisor warning still open on staging. | [ ] | [ ] |
| 9 | **Minimum password length** (same place) | 12 or more. The demo-staff script rejects shorter passwords. | [ ] | [ ] |
| 10 | **Password requirements** (same place) | Require lowercase, uppercase, digits and symbols. | [ ] | [ ] |
| 11 | **Site URL and Redirect URLs** (Authentication, URL Configuration) | Site URL is the project's own site. Redirect URLs list only that site (and `http://localhost:5173` on staging if you test locally). No wildcards for other domains. | [ ] | [ ] |
| 12 | **Rate limits** (Authentication, Rate Limits) | Review emails sent per hour, sign-ins and sign-ups per 5 minutes per IP, token refreshes, and OTP. Keep sign-ups and sign-ins low. The `/api/admin/login` route adds its own limit (5 per 15 minutes per IP) on top. | [ ] | [ ] |
| 13 | **JWT expiry** (Project Settings, JWT Keys / Auth) | 3600 seconds (1 hour). A deactivated profile is refused on the next request regardless; a shorter expiry only limits the other use of a token. | [ ] | [ ] |
| 14 | **Refresh token rotation and reuse interval** (Authentication, Sessions) | Rotation on, reuse interval 10 seconds or less. | [ ] | [ ] |
| 15 | **Session limits** (Authentication, Sessions; Pro plan) | Optional but recommended for staff: inactivity timeout (for example 8 hours) and a time-box (for example 7 days). The admin cookie lasts 7 days. | [ ] | [ ] |
| 16 | **CAPTCHA protection** (Authentication, Attack Protection) | Optional. Turnstile on sign-in would need the login route to pass the token; not wired. | [ ] | [ ] |
| 17 | **Multi-factor authentication** (Authentication, Sign In / Providers, MFA) | Off for now. TOTP for admins is planned right after the pilot starts. | [ ] | [ ] |
| 18 | **Edge functions: Verify JWT** (Edge Functions, each function, Details) | On for `jabor-recommendations`, `jabor-execute`, `jabor-embed`, and `jabor-notify`. The functions check the caller themselves as well. | [ ] | [ ] |
| 19 | **Edge function secrets** (Edge Functions, Secrets) | `NOTIFY_SHARED_SECRET` is set and equals the Vercel value for that environment. Staging keeps its own value. | [ ] | [ ] |
| 20 | **Staff accounts** (Authentication, Users) | Every user with a staff role has a `staff_profiles` row (query in `docs/MIGRATIONS.md`). No unexpected users. | [ ] | [ ] |

## Checking items 1 to 5 from outside

With the project's public URL and anon key, a sign-up request must be refused:

```bash
curl -s -X POST "$SUPABASE_URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"nobody@example.invalid","password":"Correct-Horse-Battery-9"}'
```

Expected: an error saying signups are not allowed, and no user created. Do not run this against a project whose
signups you intend to keep open.
