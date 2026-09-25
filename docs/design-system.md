# Jabor — Colors & Text Styles

No Tailwind / design-token setup. Styling lives in:

- One big `<style>` block in `Jabor.jsx` (~line 1475)
- `style.css` (admin + support-section styles)
- Small inline color maps in `Jabor.jsx` (`PARTY_CLR` ~line 153, `reportStatusColor` ~line 218)

---

## Fonts

Imported at `Jabor.jsx:1476` via Google Fonts.

| Role | Family | Weights |
|---|---|---|
| Body / UI | `'Inter','DM Sans',sans-serif` | 400 500 600 700 800 |
| Display / headings | `'Sora',sans-serif` | 600 700 800 900 |
| Mono | `'DM Mono'` imported — but inline code mostly uses literal `monospace` | 400 500 |
| Icons | `'Material Symbols Outlined'` | variable (FILL 0..1, wght 100..700) |

Base: `body` background `#F4FBF4`, `-webkit-font-smoothing: antialiased`, global `box-sizing: border-box`, zero margin/padding reset. Custom scrollbar: 3px wide, thumb `#006C49`.

---

## Text styles

| Use | Class | Font | Size | Weight | Tracking / line-height | Color |
|---|---|---|---|---|---|---|
| Hero / typed headline | `.typed-headline` | Sora | 48px (34 mobile) | 900 | −.045em, lh 1.12 | `#161D19` |
| Startup splash title | `.startup-title` | Sora | 34px | 900 | −.04em | `#0F172A` |
| Section title | `.section-title` | Sora | 32px | 800 | −.035em, lh 1.25 | `#161D19` |
| Stat number | `.stat-n` | Sora | 32px (26 mobile) | 800 | lh 1 | `#006C49` |
| Quote text | `.quote-text` | Sora | 24px (20 mobile) | 700 | −.025em, lh 1.45 | `#161D19` |
| Quote mark | `.quote-mark` | Sora | 48px | — | — | `#10B981` |
| Brand wordmark | `.brand-lockup strong` | Sora | 22px (20 mobile) | 700 | −.035em | `#0F172A` |
| Drawer brand | `.drawer-brand h2` | Sora | 22px | — | lh 1.1 | `#006C49` |
| Support title | `.jabor-support-title` | inherit (Sora context) | 1.7rem | 800 | — | inherit (white on CTA) |
| Body copy / section kicker | `.section-kicker` | Inter | 15px | 400 | lh 1.65 | `#3C4A42` |
| Support body text | `.jabor-support-text` | Inter | 0.98rem | — | lh 1.6 | `rgba(255,255,255,.92)` |
| Primary button | `.btn-p` | Inter | 15px | 800 | — | `#00422B` |
| Secondary button | `.btn-s` | Inter | 14px | 700 | — | `#006C49` |
| Input | `.inp` | Inter | 16px | 400 | — | `#161D19` |
| Field label | `.lbl` | Inter | 11px | 800 | .06em | `#3C4A42` |
| Kicker / eyebrow | `.submit-support-kicker`, `.startup-subtitle` | Inter | 10–11px | 800 | .08em, uppercase | `#006C49` |
| Mono micro-labels ("MLA", "MP", "REPORT") | inline | monospace | 9–12px | 800 | .05–.06em | `#006C49` |
| Timestamps | inline | monospace | 11px | — | — | `#64748B` |
| Status pill | `.status-pill` | inherit | 10px | 800 | .04em, uppercase | per-status (below) |
| Admin tab | `.admin-tab` | Sora | 13px | 800 | — | `#3C4A42` (`#fff` when `.on`) |
| Disclaimer | `.disclaimer-shine` | inherit | 12px | — | opacity .7 | `#9A8A7A` |
| Footer link | `.footer-link` | inherit | 14px | — | — | `#CBD5E1` → `#6FFBBE` hover |

---

## Colors

### Brand greens

| Hex | Role |
|---|---|
| `#006C49` | Primary brand green. Also `<meta name="theme-color">`. (`#006949` appears once — typo variant) |
| `#10B981` | Emerald accent / primary button bg / "cleaned" status / map pin (cleaned) |
| `#059669` | Darker emerald — primary button gradient end |
| `#00422B` | Deep green — primary button text |
| `#047857` | Success text ("cleaned" pill text) |
| `#16A34A` | Green (misc) |
| `#6FFBBE` | Mint glow — focus ring, support-panel highlight, footer link hover |

### Surfaces & borders

| Hex | Role |
|---|---|
| `#F4FBF4` | App background (mint-white) |
| `#E8F0E9` | Pale-green surface / `.section-band` / hover state / image placeholders |
| `#ECFDF5` | Cleanup form background |
| `#D1FAE5` | "Cleaned" pill background |
| `#FFFFFF` | Cards, modals, inputs |
| `#DDE4DD` | Card border |
| `#BBCABF` | Green-grey border — inputs, chips, thumbnails, appbar |
| `#E2E8F0` | Feature-card border |

### Text greys

| Hex | Role |
|---|---|
| `#161D19` | Primary text (also incognito background) |
| `#0F172A` | Dark headings |
| `#3C4A42` | Secondary text / labels |
| `#52655B`, `#6B8577` | Muted copy |
| `#8CA394` | Muted green — incognito placeholders / subtitles |
| `#64748B`, `#94A3B8`, `#9CA3AF` | Slate muted / timestamps / badge fallback |
| `#CBD5E1` | Footer link |
| `#1E293B` | Dark feature-card border |

### Incognito / dark mode (`Jabor.jsx:1520`)

| Hex | Role |
|---|---|
| `#161D19` | Background / bar |
| `#212C25` | Card |
| `#3A473E` | Border / toggle track (off) |
| `#E8F0E9`, `#F4FBF4` | Text |

### Status pills (`style.css:42`)

| Status | Text | Background | Border |
|---|---|---|---|
| pending | `#B45309` | `#FEF3C7` | `#F59E0B44` |
| verified | `#BE123C` | `#FFE4E6` | `#FB718544` |
| cleaned | `#047857` | `#D1FAE5` | `#10B98144` |

### Feedback

| Purpose | Colors |
|---|---|
| Danger | `#DC2626` / `#EF4444`; bg `#FEE2E2`, `#FFE8E8`; border `#FECACA` |
| Warning amber | `#D97706` / `#B45309`; tints `#FFFBF1`, `#FAF0DC`, `#F0D9A0` |
| Report map pins (`Jabor.jsx:218`) | `#10B981` if cleaned, else `#006C49` |

### Party badges — `PARTY_CLR` (`Jabor.jsx:153`)

Rendered as `color`, with `+"22"` background (~13% alpha) and `+"44"` border (~27% alpha).

| Party | Hex |
|---|---|
| BJP | `#FF6B2B` |
| INC | `#1A6CBD` |
| AIUDF | `#059669` |
| AGP | `#7C3AED` |
| UPPL | `#D97706` |
| BPF | `#DB2777` |
| RAIJOR DAL | `#DC2626` |
| fallback | `#9CA3AF` |

### Razorpay (payment button / fallback link)

`#2371EC`, `#1F4BB8`, `#1A6CBD`; tints `#F8FBFF`, `#EDF4FF`. Stray blues elsewhere: `#3B82F6`, `#0EA5E9`, `#1D9BF0`.

### Modal overlays

- Admin photo modal: `rgba(15,23,42,.74)`
- Drawer overlay: `rgba(15,23,42,.42)`

---

## Gradients

| Where | Value |
|---|---|
| Primary button / `.admin-ok` | `linear-gradient(135deg, #10B981, #059669)` |
| Progress bar fill (`.pfill`) | `linear-gradient(90deg, #006C49, #10B981)` |
| Quote panel (`.quote-panel`) | `linear-gradient(135deg, #FFFFFF, #E8F0E9)` |
| Shine sweep (`.disclaimer-shine::after`) | `linear-gradient(120deg, transparent, rgba(255,255,255,.8), transparent)` |

---

## Shadows

| Use | Value |
|---|---|
| Card | `0 1px 2px rgba(15,23,42,.04)` |
| Primary button | `0 6px 18px rgba(16,185,129,.22)` → hover `0 8px 24px rgba(16,185,129,.28)` |
| Card hover (`.rcard`) | `0 8px 24px rgba(0,108,73,.10)` |
| Drawer | `0 18px 40px rgba(15,23,42,.22)` |
| CTA panel | `0 18px 40px rgba(0,108,73,.22)` |
| Startup logo | `drop-shadow(0 18px 32px rgba(0,108,73,.18))` |
| Support panel highlight | `0 0 0 3px #6FFBBE, 0 18px 40px rgba(0,108,73,.3)` |

---

## Radii

`4px` badges · `8px` buttons/inputs/thumbnails · `10px` chips/photo buttons · `12px` cards/pills-container · `16px` panels/modals · `20px` CTA panel · `999px` / `50%` pills, icon buttons, toggles, dots

---

## Breakpoints

| Max-width | Effect |
|---|---|
| 860px | `.desk-2col` → single column, sticky sidebar becomes static |
| 760px | Admin cards stack (`style.css`) |
| 640px | Appbar/brand shrink, form grids collapse, hero → 34px, buttons stack |
