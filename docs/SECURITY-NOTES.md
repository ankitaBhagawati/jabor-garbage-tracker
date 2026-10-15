# Security notes

Items an external review may flag that are accepted by design, with the reason. Triage of the staging
report of 2026-10-15. Change this file whenever one of these decisions changes.

## Accepted by design

| Item | Why it is accepted |
|---|---|
| The Supabase anon key is in the client bundle | It is a public identifier, not a secret. Every table has RLS, anon grants are limited to what the public site reads (`docs/ACCESS-MATRIX.md`), and all writes go through `/api/*` with the service role key on the server. |
| `/api/cloudinary-signature` signs uploads for anyone | Citizens report and send cleanup proofs without an account. It is limited to 20 signatures per address per 10 minutes (Upstash), two allowlisted server-side folders, `jpg,jpeg,png,webp` only and `overwrite=false`, and Cloudinary rejects a signature after 1 hour. A `cleanup-proofs` signature also needs a passed Turnstile check. An upload alone shows nothing on the site: a report or proof row is created only through `/api/reports/submit` or `/api/cleanup-proofs`, which run Turnstile and validation, and proofs stay `pending` until staff approve them. |
| No byte limit on Cloudinary uploads | The Cloudinary upload API has no max-file-size parameter, signed or in an upload preset. The cap is the account's plan limit. The browser rejects files over 10 MB and compresses to about 300 KB before upload. |
| `/admin` is not guarded on the server | It is a static SPA shell with no data in it. Every admin read and write goes through `/api/admin/*`, which checks the session cookie and the caller's active `staff_profiles` row on each request, and RLS backs that up. Hiding the shell would protect nothing. |
| CSP `style-src 'unsafe-inline'` | React inline `style` attributes are used throughout the UI. `script-src` has no `unsafe-inline`, so injected markup still cannot run script; inline styles alone cannot exfiltrate data. |
| `Access-Control-Allow-Origin: *` on static files | This is Vercel's default for static assets, which are public anyway. No `/api/*` route sends a CORS header, and every non-GET route rejects a missing or foreign `Origin` with 403. |

## How the public routes fail

The shared `route()` in `api/_lib/server.js` wraps every POST route. The response is always `{ "error": "..." }`.

| Case | Answer |
|---|---|
| Missing, `null` or foreign `Origin` | 403 |
| Malformed JSON, missing fields, empty Turnstile token | 400 |
| Wrong credentials | 401 |
| Valid account that is not active staff | 403 |
| Over the rate limit | 429 |
| Missing server config (secret, Cloudinary, Supabase) | 503; the detail goes to the log and Sentry only |
| Turnstile service unreachable | 503 |
| Anything else unexpected | 500 `Server error.`, reported to Sentry |

## Cleanup-proof ticket

Turnstile tokens are single-use. A cleanup proof is checked once, when its upload is signed. The signature
route then returns a `proofTicket`: an HMAC (keyed with `CLOUDINARY_API_SECRET`) over an expiry and the
caller's address, valid for 10 minutes. `/api/cleanup-proofs` accepts only that ticket. Within those
10 minutes the same address can reuse it, bounded by that route's 5 per 10 minutes limit.
