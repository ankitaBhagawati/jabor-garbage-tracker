# Jabor — What the App Does

**Jabor** is a statewide garbage tracker for Assam. Anyone can report a garbage
spot with a photo and location; the public can follow whether it gets cleaned;
an admin moderates everything and pushes issues to authorities.

- **Frontend:** React single-page app (Vite), one big file `Jabor.jsx`
- **Backend:** Supabase (database + auth + edge functions)
- **Images:** Cloudinary (only the image URL is stored in Supabase)
- **Donations:** Razorpay payment button
- **Extras:** Google Analytics, PWA / offline-aware, AI agent for admin

There are **two roles**: the **public citizen** (no login at all) and the
**admin** (email + password, at `/admin`).

---

## Public / Citizen — no account needed

Everything below works anonymously. There is no citizen sign-up or login.

### Browse & track

| Feature | What it does |
|---|---|
| Landing dashboard | Hero ("Track. Report. Clean."), rotating civic quotes, a "How It Works" timeline, feature cards |
| Live garbage tracker | Feed of reports with two tabs: **Active** (open issues) and **Cleaned** (admin-verified) |
| Filters | By text (area / landmark / district / constituency), by waste type, by date range (last week → last 6 months) |
| Report detail | Tap a report to see photo, location, description, waste type, and the mapped **MLA** and **MP**. Cleaned reports show a **Before / After** photo pair and a "verified by admin" badge |
| Districts Needing Action | Sidebar ranking districts by how many active reports they have |
| Counts | "X active · Y cleaned · Z areas covered" |

### Report a garbage spot

1. Pick **District** and **Constituency** (from the MLA roster). The app
   auto-attaches the **MLA, MP, their parties, and Lok Sabha seat**.
2. Enter **Area**, optional **Landmark**, pick a **Waste type**
   (Mixed / Plastic / Construction / Organic / Water body / Medical-hazardous),
   optional **description**.
3. Add a **photo** (required). It's resized and compressed in the browser, then
   uploaded to Cloudinary; only the resulting URL is saved.
4. **Anonymous by default** — the form goes into a dark "incognito" style. The
   reporter *may* add name + email to get a confirmation email; that contact is
   stored for admin eyes only, never shown publicly.
5. On submit the report immediately appears in the feed as **Active**. A success
   screen plays and invites the user to support Jabor.
6. Offline is detected and blocks submission until reconnected.

### Reply that a spot was cleaned

- On any active report, "**Reply: Report Cleaned Up**" opens a small form.
- Upload an "after" photo + rough cleaned date ("today", "yesterday") + optional name.
- It goes into a **pending queue for the admin**. Until approved, the card shows
  "Cleanup proof is waiting for admin verification".
- Once the admin approves, the report moves to **Cleaned** with the before/after pair.

### Support

- A **Razorpay** "Support Jabor" button for donations (covers hosting, AI, domain, etc.), with a fallback link if the widget fails to load.

---

## Admin — login required (`/admin`)

Admin signs in with Supabase email + password. The account must carry the
`admin` role; the session is kept in the browser and expires automatically.
Admin has two tabs.

### Tab 1 — Reports

| Action | What it does |
|---|---|
| List reports | All reports (including hidden-from-public logic), split into **Active** and **Cleaned** tabs |
| See reporter | Shows the reporter's name + email if they provided one, otherwise "Anonymous" |
| Status badges | Active / Cleaned, plus "Posted to X" and "Emailed" once those actions have run |
| Hide / Delete | Soft-deletes a report (`is_deleted = true`) so it disappears from the public site |
| Generate Post | Opens the **AI recommendation** modal for an active report |

### AI Post Recommendation (the agent)

Runs as Supabase edge functions — a retrieval-augmented pipeline with Claude:

1. **Retrieval** — finds similar past reports using vector similarity
   (gte-small embeddings + pgvector), within a 30-day window.
2. **Reasoning** — assigns a **severity** (high / medium / low), detects a
   **recurring pattern** ("Recurring · N similar"), suggests **post timing**,
   and lists **escalations** and matching past reports.
3. **Drafting** —
   - A **tweet caption** (≤ 280 chars, written by Claude, with a safe fallback)
     that always tags fixed government handles (Housing & Urban Affairs minister,
     CM office, Swachh Bharat Urban + Gramin Assam) plus the report's MLA/MP and
     a `jabor.in` link.
   - An **email to authorities** (to / subject / body) — fixed minister/CM/Swachh
     Bharat addresses plus the report's MLA/MP official emails when known.
4. **Review & execute** — the admin edits the caption/email, then:
   - **Post to X** — live, via OAuth 1.0a.
   - **Send Email** — live, via Resend.
   - Each is marked done (`tweeted_at` / `emailed_at`) so it can't be sent twice.

### Tab 2 — Cleanup Verification

| Action | What it does |
|---|---|
| Pending queue | Lists citizen cleanup-proof submissions: original report photo and the "after" photo side by side, cleaned-date estimate, who submitted |
| Approve Cleanup | Marks the proof approved **and** flips the report to **Cleaned** (before/after now public) |
| Reject Proof | Marks it rejected, with optional admin notes |

### Maintenance

- A one-off "backfill embeddings" function seeds vector embeddings for older
  reports so similarity search has data to work with.

---

## Report lifecycle

```
Citizen submits ──▶ Active ──▶ Citizen replies with cleanup photo ──▶ Pending proof
                     │                                                    │
                     │                                         Admin approves │ rejects
                     │                                                    ▼        ▼
                     └── Admin can Hide/Delete anytime            Cleaned      back to Active
```

Alongside this, for any Active report the admin can run the AI agent to **post
it to X** and **email the responsible authorities**.

---

## Data (Supabase tables)

| Table | Holds |
|---|---|
| `reports` | The garbage reports (location, waste type, photo URL, MLA/MP, status, embeddings, tweeted/emailed timestamps) |
| `report_contacts` | Reporter name/email — admin-only, separate from the public report |
| `cleanup_proofs` | Citizen "it's cleaned" submissions awaiting / after admin review |
| `mla_list`, `mp_list` | Assam MLA/MP roster used to auto-map constituencies to representatives |
| agent audit rows | Record of each AI recommendation run and executed action |
