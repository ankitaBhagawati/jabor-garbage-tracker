# Jabor Version 2 Beta Features

**Release type:** Public Beta

## Summary

Jabor Version 2 Beta expands the app from a basic garbage reporting prototype into a public testing release for reporting, tracking, and verifying garbage cleanup across Assam.

## New Features

- Anonymous garbage report submission with image proof
- Active and cleaned public report feeds
- Report filters for location, waste type, and date
- Cleanup proof replies with a single active proof per report
- Admin verification for cleanup proof submissions
- Admin report hide/moderation flow
- Before-and-after images for cleaned reports
- Responsive dashboard, report details, and admin pages
- Updated Jabor branding, favicon, navigation, and dashboard animations

## Technical Improvements

- Cloudinary image storage for reports and cleanup proofs
- Browser-side image resize, WebP conversion, and compression
- Supabase stores only Cloudinary `secure_url` values
- Supabase Auth email/password admin login
- Dedicated frontend service modules for auth, reports, cleanup proofs, Cloudinary, and Supabase REST requests
- Vercel route support for `/admin`
- Environment-only frontend configuration using `VITE_` variables

## Security Improvements

- Removed hardcoded Supabase project configuration from source code
- Removed real project-specific values from tracked environment examples and documentation
- Confirmed no Cloudinary API secret or Supabase `service_role` key is used in the frontend
- Admin authorization uses `app_metadata.role = "admin"`
- Removed demo-era anonymous update and delete policies
- Added least-privilege grants for public report and cleanup proof inserts
- Restricted public report visibility to active and cleaned reports
- Restricted public image URLs to Cloudinary delivery URLs
- Added a Version 2 Beta Supabase security hardening script

## Known Limitations

- Anonymous reports do not have user ownership, editing, or deletion controls
- Public uploads rely on an unsigned Cloudinary preset
- No CAPTCHA, rate limiting, spam detection, or automated image moderation is implemented
- Admin moderation is manual
- Cloudinary assets must be cleaned separately from Supabase data
- Location coordinates are not yet captured automatically

## Feedback Plan

Version 2 Beta will be opened for public testing. Feedback will be collected on report submission, location accuracy, cleanup verification, mobile usability, moderation needs, and abuse prevention.

## Next Possible Improvements

- CAPTCHA and rate limiting for public submissions
- Server-side signed Cloudinary uploads or upload validation
- Automated image moderation and duplicate detection
- GPS-based location capture and map accuracy improvements
- Report ownership for authenticated users
- Admin audit logs and moderation history
- Notifications for report and cleanup status changes
- Analytics for districts, cleanup time, and recurring hotspots
