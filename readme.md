# Jabor

**Version:** 2 Beta
**Release type:** Public Beta

Jabor is an Assam garbage reporting and tracking app. It allows people to report garbage issues with location details and image proof, follow active reports, and see cleanup progress after admin verification.

This release is intended for public testing. User feedback will guide the next improvements.

## Purpose

Jabor helps make local garbage issues visible and trackable by allowing people in Assam to:

- Submit a garbage report with a photo, area, district, and waste type.
- View active garbage reports in a public feed.
- Reply to active reports with cleanup proof.
- See cleaned reports after an admin approves the cleanup proof.

## Tech Stack

- React 18
- Vite 8
- Supabase Database, Auth, REST API, and Row Level Security
- Cloudinary signed uploads through a Vercel serverless signature endpoint
- Vercel deployment

## Main Features

- Anonymous public garbage reporting
- Cloudinary image upload with browser-side resize and WebP compression
- Active and cleaned public report feeds
- Location, district, waste type, and date filters
- Cleanup proof submissions
- Supabase Auth admin login
- Admin-only report moderation and cleanup proof verification
- Responsive dashboard, report form, report details, and admin pages

## Security Model

- Supabase stores only Cloudinary `secure_url` values, not image files.
- The frontend uses only public-safe environment variables.
- Cloudinary uploads use server-generated signed upload parameters.
- Admin authorization uses Supabase Auth and `app_metadata.role = "admin"`.
- Supabase Row Level Security protects admin-only updates and deletes.
- Public users can insert reports and cleanup proofs only through restricted columns and policies.
- Never expose or commit a Supabase `service_role` key, Cloudinary API secret, database password, or other private credential.

## Local Setup

Use Node.js `20.19.0` or newer.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create `.env.local` from `.env.example`:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
VITE_CLOUDINARY_CLOUD_NAME=your-cloudinary-cloud-name
CLOUDINARY_API_KEY=your-cloudinary-api-key
CLOUDINARY_API_SECRET=your-cloudinary-api-secret
```

Use placeholders in documentation and examples. Never commit real environment keys.

### 3. Configure Cloudinary

Use signed uploads only. The app signs uploads through `/api/cloudinary-signature` and allows only:

- `jabor/reports`
- `jabor/cleanup-proofs`

Restrict accepted upload formats to JPG, PNG, and WEBP. Do not use unsigned upload presets for public uploads.

Do not expose `CLOUDINARY_API_SECRET` in client-side code or `VITE_` environment variables.

### 4. Configure Supabase

Run these SQL files in the Supabase SQL Editor in order:

1. `supabase/jabor-v2-migration.sql`
2. `supabase/jabor-auth-and-cleanup-proof.sql`
3. `supabase/jabor-public-report-insert.sql`
4. `supabase/jabor-v2-beta-security-hardening.sql`

Create an admin user in Supabase Authentication, then set the user's **App Metadata**:

```json
{
  "role": "admin"
}
```

Do not use user metadata for authorization roles.

### 5. Start the app

```bash
npm run dev
```

## Build

```bash
npm run build
```

This project currently has no lint script.

## Deployment

Jabor can be deployed to Vercel:

1. Link the repository to a Vercel project.
2. Add Supabase, Cloudinary cloud name, and server-side Cloudinary API variables for Production and Preview.
3. Apply the Supabase security hardening SQL before opening the app publicly.
4. Build and deploy the latest commit.
5. Verify the public report flow and `/admin` login after deployment.

## Pre-Release Data Cleanup

To clear test report activity before deployment, review and run:

```text
supabase/jabor-v2-beta-test-data-cleanup.sql
```

The script preserves Supabase Auth users and lookup/master data such as `mla_list` and `mp_list`.

After database cleanup, remove matching test images from the Cloudinary `jabor/reports` and `jabor/cleanup-proofs` folders. Cloudinary assets are not deleted automatically when database rows are removed.

## Public Beta Notes

Version 2 Beta is not the final production release. Public testing will be used to learn:

- Whether the report form is clear and fast enough.
- Whether location and waste-type information is useful.
- Whether cleanup proof verification is understandable.
- Which moderation, anti-spam, and operational tools are needed next.

Feedback from users will guide the next release.

## Known Limitations

- Anonymous reporting has no per-user ownership or edit history.
- Public beta moderation is manual.
- There is no CAPTCHA, rate limiting, abuse scoring, or automated image moderation yet.
- Database and Cloudinary cleanup are separate operations.

## License

MIT
