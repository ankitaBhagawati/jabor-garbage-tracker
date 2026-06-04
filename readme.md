# 🗑️ Jabor — Assam Garbage Tracker

> **Report. Track. Clean.**

A statewide garbage reporting and tracking web app for Assam. Anyone can report a garbage spot with a photo, location details, and waste type. Admin-verified reports appear publicly so active and cleaned locations can be tracked clearly.

Built by [@Tech_Bagwitty](https://instagram.com/tech_bagwitty)

---

## ✨ Features

- **📸 Anonymous Reporting** — Submit garbage reports in under 60 seconds, no login required
- **🗺️ Live Map** — All reports plotted on a real Assam state map
- **✅ Admin Verification** — Reports appear publicly after admin review
- **🧹 Cleanup Proof** — Citizens can upload cleanup proof for active reports
- **📱 Mobile-first** — Native app feel with bottom navigation and FAB button
- **🔥 Reported Hotspots** — Top reported areas ranked by report count
- **📋 Public Feed** — Active and cleaned reports visible to everyone

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite |
| Database | Supabase (PostgreSQL) |
| Storage | Supabase Storage |
| Hosting | Vercel |
| Fonts | Sora, DM Sans, DM Mono |

---

## 🚀 Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/jabor.git
cd jabor
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## 🗄️ Supabase Setup

Run both SQL files in the Supabase SQL Editor:

1. `supabase/jabor-v2-migration.sql`
2. `supabase/jabor-auth-and-cleanup-proof.sql`
3. `supabase/jabor-public-report-insert.sql`

### Admin Authentication

Create an admin user in **Supabase Dashboard → Authentication → Users**, then set the user's app metadata to:

```json
{
  "role": "admin"
}
```

The `/admin` route uses Supabase email/password authentication. Admin authorization is enforced by RLS using `app_metadata.role`; do not use user metadata for roles.

### Database Tables

```sql
-- MLA list (126 MLAs across 35 districts)
create table mla_list (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  party text,
  constituency text unique,
  district text,
  lok_sabha_seat text,
  phone text,
  email text,
  photo_url text,
  updated_at timestamptz default now()
);

-- MP list (14 Lok Sabha MPs)
create table mp_list (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  party text,
  lok_sabha_seat text unique,
  phone text,
  email text,
  photo_url text,
  updated_at timestamptz default now()
);

-- Reports
create table reports (
  id uuid primary key default gen_random_uuid(),
  constituency text,
  district text,
  lok_sabha_seat text,
  mla text,
  mla_party text,
  mp text,
  mp_party text,
  area text,
  landmark text,
  waste_type text default 'mixed',
  description text not null,
  photo_url text,
  lat float8,
  lng float8,
  status text default 'open',
  is_deleted boolean default false,
  created_at timestamptz default now()
);

-- Public view (joins reports with live MLA/MP data)
create view public_reports as
  select r.*, m.name as mla, m.party as mla_party,
         p.name as mp, p.party as mp_party
  from reports r
  left join mla_list m on m.constituency = r.constituency
  left join mp_list p on p.lok_sabha_seat = r.lok_sabha_seat
  where r.is_deleted = false;
```

### Cloudinary Image Storage

Jabor uploads report and cleanup proof images to Cloudinary. Supabase stores only the returned Cloudinary `secure_url` in `reports.photo_url` and `cleanup_proofs.image_url`.

1. In Cloudinary, create an **unsigned** upload preset.
2. Add these values to `.env`:

```bash
CLOUDINARY_CLOUD_NAME=dqqajkvpn
CLOUDINARY_UPLOAD_PRESET=jabor_uploads
```

Do not add `CLOUDINARY_API_SECRET` to the frontend. The browser upload flow does not need it.

The existing database columns remain intentionally unchanged:

- `reports.photo_url` stores the Cloudinary report image URL.
- `cleanup_proofs.image_url` stores the Cloudinary cleanup proof URL.
- `area` and `landmark` store the report address.
- `lat` and `lng` store coordinates when location capture is available.

### RLS Policies for Tables

```sql
-- Reports: anyone can read, anyone can insert
alter table reports enable row level security;
create policy "Public read" on reports for select using (is_deleted = false);
create policy "Public insert" on reports for insert with check (true);

-- MLA/MP: public read only
alter table mla_list enable row level security;
create policy "Public read" on mla_list for select using (true);

alter table mp_list enable row level security;
create policy "Public read" on mp_list for select using (true);
```

---

## 📁 Project Structure

```
jabor/
├── public/
│   └── jabor-logo-2.png        # App logo
├── src/
│   ├── main.jsx                 # React entry point
│   ├── Jabor.jsx                # Main app component
│   └── style.css                # Global styles
├── index.html
├── package.json
├── vite.config.js
├── .gitignore
└── README.md
```

---

## 🌐 Deployment (Vercel)

1. Push to GitHub
2. Import repo at [vercel.com](https://vercel.com)
3. Vercel auto-detects Vite — no config needed
4. Deploy ✅

Live URL will be something like `jabor.vercel.app`

---

## 🗺️ Data Coverage

- **35 districts** across Assam
- **126 MLAs** (2021 Assam Legislative Assembly)
- **14 MPs** (Lok Sabha — Assam constituencies)
- MLA mappings sourced from public data — will be updated after **2026 Assam elections**

---

## ⚠️ Disclaimer

Jabor is not affiliated with any government body. Public reports are user-submitted and should be reviewed before operational use.

---

## 🤝 Contributing

Pull requests welcome! Some ideas:

- [ ] GPS-based auto-constituency detection (needs Assam GeoJSON boundary file)
- [ ] Admin panel for report review and cleanup verification
- [ ] Share link per report
- [ ] WhatsApp share button
- [ ] Email/SMS alerts for admins

---

## 📜 License

MIT — free to use, modify and deploy.

---

*Made with ❤️ for Assam · Report garbage, track cleanup*
