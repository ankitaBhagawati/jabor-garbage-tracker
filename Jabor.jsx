import { lazy, Suspense, useCallback, useState, useEffect, useRef } from "react";
import "./style.css";
import SupportJaborSection from "./SupportJaborSection";
import Select from "./src/ui/Select.tsx";
import PhotoLightbox from "./src/ui/PhotoLightbox.tsx";
import { Glyph, WasteIcon } from "./src/ui/glyphs.tsx";
import MunicipalityQuestion from "./src/report/MunicipalityQuestion.tsx";
import { findMunicipality, loadMunicipalities, placementError, placementFields } from "./src/report/placement.ts";
import {
  fetchActiveReports,
  fetchAdminReports,
  fetchCleanedReports,
  hideReport,
} from "./src/services/reportService.js";
import {
  approveCleanupProof,
  fetchPendingCleanupProofs,
  rejectCleanupProof,
  uploadCleanupProof,
} from "./src/services/cleanupService.js";
import {
  checkAdminSession,
  signInAdmin,
  signOutAdmin,
} from "./src/services/authService.js";
import {
  assertSupabaseConfig,
  SUPA_KEY,
  SUPA_URL,
} from "./src/services/supabaseRest.js";
import { uploadImageToCloudinary, validateUploadImage } from "./src/services/cloudinaryService.js";
import { executeActions, generateRecommendations } from "./src/services/agentService.js";
import {
  gaEnabled,
  initGA,
  trackCleanupProofSubmission,
  trackPageView,
  trackReportSubmission,
} from "./src/utils/analytics.js";

const H        = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
// A deployed build without a site key cannot pass the server's bot check, so say so up front.
const TURNSTILE_MISSING = !TURNSTILE_SITE_KEY && import.meta.env.PROD;
const TURNSTILE_MISSING_MESSAGE = "The security check is not configured on this site, so this cannot be submitted right now.";
const LOGO     = "/jabor-logo-green-removebg-preview.png";
const GA_MEASUREMENT_ID = "G-X5MPQVHB44";
// mpLabel: "Gaurav Gogoi (Jorhat)" - MP name with their Lok Sabha seat
const mpLabel = (name, seat, fb) => name ? (seat ? `${name} (${seat})` : name) : fb;
// MP seats can be vacant (e.g. Nagaon awaiting a by-election); say that
// instead of a confusing "Not mapped yet" label. Reports store "Unknown"
// when no MP was mapped at submission time.
const MP_VACANT = "Currently none (by-election yet to be conducted)";
const mpDisplay = (name, seat) => (!name || name === "Unknown") ? MP_VACANT : mpLabel(name, seat, MP_VACANT);

const db = {
  async getMlas() {
    try {
      assertSupabaseConfig();
      const res = await fetch(`${SUPA_URL}/rest/v1/mla_list?select=*&order=district.asc,constituency.asc`, { headers: H });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  },
  async getMla(constituency) {
    try {
      assertSupabaseConfig();
      const res = await fetch(`${SUPA_URL}/rest/v1/mla_list?constituency=eq.${encodeURIComponent(constituency)}&select=*&limit=1`, { headers: H });
      if (!res.ok) return null;
      const d = await res.json();
      return d[0] || null;
    } catch {
      return null;
    }
  },
  async getMp(seat) {
    try {
      assertSupabaseConfig();
      const res = await fetch(`${SUPA_URL}/rest/v1/mp_list?lok_sabha_seat=eq.${encodeURIComponent(seat)}&select=*&limit=1`, { headers: H });
      if (!res.ok) return null;
      const d = await res.json();
      return d[0] || null;
    } catch {
      return null;
    }
  },
  async getReports() {
    try {
      assertSupabaseConfig();
      const select = [
        "id", "constituency", "district", "lok_sabha_seat", "mla", "mla_party", "mp", "mp_party",
        "area", "landmark", "waste_type", "description", "photo_url", "lat", "lng", "status",
        "assigned_to", "rejected_at", "is_deleted", "created_at", "updated_at", "tweeted_at", "emailed_at",
      ].join(",");
      const res = await fetch(`${SUPA_URL}/rest/v1/reports?select=${select}&status=in.(verified,pending,active,reported,open,cleaned)&is_deleted=eq.false&order=created_at.desc&limit=200`, { headers: H });
      if (!res.ok) return [];
      return res.json();
    } catch {
      return [];
    }
  },
  // Reports go through the serverless API so rate limiting and bot
  // verification run before anything reaches Supabase.
  async submitReport(data, turnstileToken) {
    const res = await fetch("/api/reports/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, turnstileToken }),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      throw new Error(body?.error || "Could not submit the report. Please try again.");
    }
    return body;
  },
  async uploadPhoto(file) {
    // Supabase stores only the Cloudinary secure URL returned by this upload.
    return (await uploadImageToCloudinary(file, "reports")).url;
  },
};

// Cloudflare Turnstile widget. Renders nothing until VITE_TURNSTILE_SITE_KEY
// is configured, so the form keeps working while the keys are being set up.
// controlRef receives { reset } so the parent can discard a consumed token
// after each submission attempt. Load/render failures are shown on screen
// (with the Cloudflare error code) instead of failing silently, because a
// silent failure blocks every submission with no clue why.
function TurnstileWidget({ onToken, controlRef }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [errorCode, setErrorCode] = useState("");
  const [retryTick, setRetryTick] = useState(0);
  const autoRetriesRef = useRef(0);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return undefined;
    let widgetId = null;
    let cancelled = false;
    let pollTimer = null;
    let failTimer = null;

    const fail = code => {
      if (cancelled) return;
      // One silent retry with a fresh script request before bothering the
      // user - transient stalls to challenges.cloudflare.com are common on
      // flaky mobile connections.
      if (autoRetriesRef.current < 1 && !window.turnstile) {
        autoRetriesRef.current += 1;
        setRetryTick(t => t + 1);
        return;
      }
      setStatus("failed");
      setErrorCode(String(code || ""));
      onToken("");
    };

    const render = () => {
      if (cancelled || widgetId !== null || !containerRef.current || !window.turnstile) return;
      clearInterval(pollTimer);
      clearTimeout(failTimer);
      try {
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: token => {
            if (cancelled) return;
            setStatus("ready");
            setErrorCode("");
            onToken(token);
          },
          "expired-callback": () => onToken(""),
          "error-callback": code => { fail(code); return true; },
          "refresh-expired": "auto",
        });
        if (widgetId === undefined || widgetId === null) {
          fail("widget-not-created");
          return;
        }
        setStatus("ready");
        if (controlRef) {
          controlRef.current = {
            reset: () => {
              try { window.turnstile.reset(widgetId); } catch { /* widget already gone */ }
              onToken("");
            },
          };
        }
      } catch (error) {
        fail(error?.message || "render-failed");
      }
    };

    if (window.turnstile) {
      render();
    } else {
      let script = document.getElementById("cf-turnstile-script");
      // A leftover script tag that never produced the turnstile global is a
      // dead request (hung fetch, earlier failure) - listeners on it will
      // never fire again. Replace it so every attempt is a fresh fetch.
      if (script && retryTick > 0) {
        script.remove();
        script = null;
      }
      if (!script) {
        script = document.createElement("script");
        script.id = "cf-turnstile-script";
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render);
      script.addEventListener("error", () => fail("script-blocked-or-offline"));
      // The load event can fire before this mount attaches its listener, and
      // some in-app browsers delay it; poll for the global as a fallback.
      pollTimer = setInterval(render, 300);
      failTimer = setTimeout(() => {
        if (!cancelled && widgetId === null) fail("load-timeout");
      }, 8000);
    }

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearTimeout(failTimer);
      if (controlRef) controlRef.current = null;
      if (widgetId !== null && window.turnstile) {
        try { window.turnstile.remove(widgetId); } catch { /* already removed */ }
      }
    };
  }, [onToken, controlRef, retryTick]);

  if (TURNSTILE_MISSING) {
    return <p role="alert" style={{ textAlign: "center", fontSize: 12, color: "#B42318", margin: "0 0 14px" }}><Glyph name="alert" /> {TURNSTILE_MISSING_MESSAGE}</p>;
  }
  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div ref={containerRef} style={{ display: "flex", justifyContent: "center" }} />
      {status === "loading" && (
        <p style={{ textAlign: "center", fontSize: 12, color: "#3C4A42", margin: "6px 0 0" }}>
          Loading security check…
        </p>
      )}
      {status === "failed" && (
        <div style={{ textAlign: "center", margin: "6px 0 0" }}>
          <p style={{ fontSize: 12, color: "#B42318", margin: 0 }}>
            <Glyph name="alert" /> Security check could not load{errorCode ? ` (${errorCode})` : ""}. If retrying does not help, switch between Wi-Fi and mobile data, or turn off any VPN, Private DNS, or ad blocker.
          </p>
          <button type="button" className="btn-s" style={{ marginTop: 8, padding: "8px 16px", fontSize: 13 }}
            onClick={() => { autoRetriesRef.current = 0; setStatus("loading"); setErrorCode(""); setRetryTick(t => t + 1); }}>
            Retry security check
          </button>
        </div>
      )}
    </div>
  );
}

function logReportPhotos(source, reports) {
  if (!import.meta.env.DEV) return;
  const safeReports = Array.isArray(reports) ? reports : [];
  console.debug(`[Jabor] ${source}`, safeReports);
  safeReports.forEach(report => {
    console.debug(`[Jabor] ${source} report ${report.id || "unknown"} photo_url`, report.photo_url || null);
  });
}

function withPreservedReport(fetchedReports, preservedReport) {
  const reports = Array.isArray(fetchedReports) ? fetchedReports : [];
  if (!preservedReport) return reports;
  const alreadyLoaded = reports.some(report =>
    (preservedReport.id && report.id === preservedReport.id) ||
    (preservedReport.photo_url && report.photo_url === preservedReport.photo_url)
  );
  return alreadyLoaded ? reports : [preservedReport, ...reports];
}

// The page's icon names (as they are written in the lists below) and the drawing used for each.
const ICON = { report: "flag", rss_feed: "feed", format_quote: "quote", info: "info", groups: "users", favorite: "heart", task_alt: "checkCircle", verified: "shieldCheck",
  bolt: "bolt", schedule: "clock", visibility: "eye", dashboard: "grid", analytics: "chart" };

const WASTE = [
  { id: "mixed",        label: "Mixed Waste",         color: "#9CA3AF" },
  { id: "plastic",      label: "Plastic",             color: "#3B82F6" },
  { id: "construction", label: "Construction Debris", color: "#D97706" },
  { id: "organic",      label: "Organic / Food",      color: "#10B981" },
  { id: "water",        label: "Water Body Dump",     color: "#0EA5E9" },
  { id: "medical",      label: "Medical / Hazardous", color: "#EF4444" },
];
const WASTE_OPTIONS = WASTE.map(w => ({ value: w.id, label: w.label }));

const PARTY_CLR = {
  BJP: "#FF6B2B", INC: "#1A6CBD", AIUDF: "#059669",
  AGP: "#7C3AED", UPPL: "#D97706", BPF: "#DB2777", "RAIJOR DAL": "#DC2626",
};

const DATE_RANGES = [
  { id: "", label: "Any time", days: null },
  { id: "7", label: "Last week", days: 7 },
  { id: "15", label: "Last 15 days", days: 15 },
  { id: "30", label: "Last month", days: 30 },
  { id: "60", label: "Last 2 months", days: 60 },
  { id: "90", label: "Last 3 months", days: 90 },
  { id: "180", label: "Last 6 months", days: 180 },
];

// Options for the feed filters. "Any time" and "All waste types" are the empty state, shown as the placeholder.
const DATE_OPTIONS = DATE_RANGES.filter(range => range.id).map(range => ({ value: range.id, label: range.label }));

const CLEAN_QUOTES = [
  {
    quote: "Clean streets begin with small civic habits repeated every day.",
    author: "Jabor Civic Note",
  },
  {
    quote: "A cleaner neighborhood is not someone else's job. It starts where we stand.",
    author: "Community Reminder",
  },
  {
    quote: "Public spaces improve when public attention becomes consistent.",
    author: "Jabor Tracker",
  },
  {
    quote: "Reporting a problem is the first step toward making it visible, trackable, and fixable.",
    author: "Civic Sense",
  },
];

function Badge({ party }) {
  const c = PARTY_CLR[party] || "#9CA3AF";
  return (
    <span style={{ background: c+"22", color: c, border: `1px solid ${c}44`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap" }}>{party}</span>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
      <div style={{ width: 28, height: 28, border: "3px solid #DDE4DD", borderTopColor: "#10B981", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
    </div>
  );
}

function WIcon({ type, size = 16 }) {
  const w = WASTE.find(t => t.id === type) || WASTE[0];
  return <WasteIcon type={w.id} size={size} />;
}

function reportStatusColor(status) {
  return status === "cleaned" ? "#10B981" : "#006C49";
}

// ── REPORT CARD - with thumbnail + MLA/MP on separate lines
// A photo that opens enlarged when clicked, without opening the report behind it.
function ZoomPhoto({ url, alt, onPhoto }) {
  const image = <img src={url} alt={alt} />;
  if (!onPhoto) return image;
  return <button type="button" className="photo-zoom" aria-label={`Enlarge photo: ${alt}`} onClick={e => { e.stopPropagation(); onPhoto(url); }}>{image}</button>;
}

function ReportCard({ r, expanded, onClick, onPhoto, showCleanupAction = false, cleanupOpen, onToggleCleanup, onCleanupSubmitted }) {
  const report = r;
  const w = WASTE.find(t => t.id === report.waste_type) || WASTE[0];
  const isCleaned = report.status === "cleaned";
  const leaderFallback = "Not mapped yet";
  return (
    <div className="rcard" onClick={onClick}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {report.photo_url ? (
          <div className="report-photo-stack">
            <ZoomPhoto url={report.photo_url} alt="Garbage report" onPhoto={onPhoto} />
            {isCleaned && report.cleanup_photo_url && <ZoomPhoto url={report.cleanup_photo_url} alt="Approved cleanup proof" onPhoto={onPhoto} />}
          </div>
        ) : (
          <div style={{ width: 58, height: 58, borderRadius: 10, flexShrink: 0, background: w.color + "20", border: `1px solid ${w.color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>
            <WasteIcon type={w.id} size={24} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, width: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{r.constituency}</span>
            <span style={{ color: "#3C4A42", fontSize: 12 }}>· {r.district}</span>
            <span className={`status-pill ${isCleaned ? "cleaned" : "verified"}`}>{isCleaned ? "Cleaned" : "Active"}</span>
          </div>
          {(r.area || r.landmark) && (
            <p style={{ fontSize: 11, color: "#3C4A42", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
              <Glyph name="pin" size={13} /> {[r.area, r.landmark].filter(Boolean).join(" · ")}
            </p>
          )}
          <p style={{
            fontSize: 13, color: "#161D19", marginBottom: 6,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: expanded ? "unset" : 2,
            WebkitBoxOrient: "vertical",
            whiteSpace: expanded ? "normal" : "normal",
            wordBreak: "break-word",
          }}>{r.description}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <WIcon type={r.waste_type} />
            <span style={{ fontSize: 12, fontWeight: 700, color: w.color }}>{w.label}</span>
            {r.assigned_to && <span style={{ fontSize: 11, color: "#3C4A42" }}>Assigned: {r.assigned_to}</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
            <div style={{ padding: "7px 8px", background: "#E8F0E9", border: "1px solid #DDE4DD", borderRadius: 8, minWidth: 0 }}>
              <div style={{ fontSize: 9, color: "#006C49", fontFamily: "monospace", letterSpacing: ".05em", fontWeight: 800 }}>MLA</div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#161D19", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.mla || leaderFallback}</div>
            </div>
            <div style={{ padding: "7px 8px", background: "#E8F0E9", border: "1px solid #DDE4DD", borderRadius: 8, minWidth: 0 }}>
              <div style={{ fontSize: 9, color: "#006C49", fontFamily: "monospace", letterSpacing: ".05em", fontWeight: 800 }}>MP</div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#161D19", overflowWrap: "break-word" }}>{mpDisplay(r.mp, r.lok_sabha_seat)}</div>
            </div>
          </div>
          {showCleanupAction && !isCleaned && r.cleanup_proof_status !== "pending" && (
            <div onClick={e => e.stopPropagation()} style={{ marginTop: 10 }}>
              <button
                className="btn-s"
                style={{ width: "100%", padding: "9px 12px", fontSize: 12, borderColor: "#10B981", color: "#047857" }}
                onClick={onToggleCleanup}
              >
                {cleanupOpen ? "Hide Cleanup Reply" : "Reply: Report Cleaned Up"}
              </button>
              {cleanupOpen && <CleanupProofUploadForm reportId={r.id} onSuccess={onCleanupSubmitted} />}
            </div>
          )}
          {!isCleaned && r.cleanup_proof_status === "pending" && (
            <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 10, background: "#FEF3C7", color: "#B45309", fontSize: 12, fontWeight: 800 }}>
              Cleanup proof is waiting for admin verification
            </div>
          )}
          {isCleaned && (
            <>
              {r.cleanup_photo_url && (
                <div className="cleaned-photo-pair">
                  {report.photo_url && <figure><ZoomPhoto url={report.photo_url} alt="Garbage before cleanup" onPhoto={onPhoto} /><figcaption>Before</figcaption></figure>}
                  <figure><ZoomPhoto url={r.cleanup_photo_url} alt="Area after cleanup" onPhoto={onPhoto} /><figcaption>After</figcaption></figure>
                </div>
              )}
              <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 10, background: "#D1FAE5", color: "#047857", fontSize: 12, fontWeight: 800 }}>
                <Glyph name="check" size={14} /> Cleanup verified by admin
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── SUCCESS SCREEN with 3s progress bar + redirect
function SuccessScreen({ onDone }) {
  const [progress, setProgress] = useState(0);
  const [complete, setComplete] = useState(false);
  const MESSAGES = [
    "Your report is live on the tracker…",
    "Location details have been saved…",
    "The community can now track this spot…",
    "Report submitted. You can return when ready.",
  ];
  const [msgIdx, setMsgIdx] = useState(0);
  const DURATION = 3000; // 3 seconds

  useEffect(() => {
    // The form leaves the page scrolled near the submit button; the success
    // screen renders at the top, so bring the viewport back up to it.
    window.scrollTo({ top: 0, behavior: "auto" });
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.min((elapsed / DURATION) * 100, 100);
      setProgress(pct);
      setMsgIdx(Math.min(Math.floor((pct / 100) * MESSAGES.length), MESSAGES.length - 1));
      if (pct >= 100) {
        clearInterval(interval);
        setComplete(true);
      }
    }, 30);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="pop-in" style={{ maxWidth: 420, margin: "60px auto", textAlign: "center", padding: "0 16px" }}>
      <img src={LOGO} alt="Jabor" style={{ width: 180, maxWidth: "80%", height: "auto", objectFit: "contain", margin: "0 auto 16px", display: "block" }} />
      <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8, letterSpacing: "-0.03em" }}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#006C49" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ verticalAlign: "-4px", marginRight: 8 }}><circle cx="12" cy="12" r="10" /><path d="m7.5 12.5 3 3 6-7" /></svg>
        Report Submitted!
      </h2>
      <p style={{ color: "#3C4A42", fontSize: 14, lineHeight: 1.7, marginBottom: 24 }}>
        Your report was received.<br />It is now live in Active Reports.
      </p>

      {/* Progress bar */}
      <div style={{ background: "#DDE4DD", borderRadius: 3, height: 6, overflow: "hidden", marginBottom: 12 }}>
        <div style={{
          height: "100%", borderRadius: 3,
          background: "linear-gradient(90deg, #006C49, #10B981)",
          width: `${progress}%`,
          transition: "width 0.03s linear",
        }} />
      </div>

      {/* Loading message */}
      <p style={{ fontSize: 13, color: "#006C49", fontWeight: 800, fontFamily: "monospace", letterSpacing: "0.02em" }}>
        {MESSAGES[msgIdx]}
      </p>

      <div style={{ marginTop: 20, padding: 12, background: "#E8F0E9", borderRadius: 12, border: "1px solid #BBCABF", fontSize: 12, color: "#006C49", fontWeight: 700 }}>
        Share with your community so the issue can be tracked and cleaned.
      </div>

      {complete && (
        <button className="btn-p" type="button" onClick={onDone} style={{ width: "100%", marginTop: 12, padding: 12 }}>
          Back to dashboard
        </button>
      )}

    </div>
  );
}

function Footer({ onAbout, onHowItWorks, onSupport }) {
  return (
    <footer style={{ background: "#0F172A", color: "#CBD5E1", marginTop: 0 }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "40px 20px", display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 340 }}>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", background: "#F4FBF4", borderRadius: 8, padding: "4px 8px" }}>
                  <img src={LOGO} alt="Jabor" style={{ width: 34, height: 34, objectFit: "contain" }} />
                  <strong style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, color: "#0F172A", marginLeft: 7 }}>Jabor</strong>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", border: "1px solid #10B98166", borderRadius: 6, padding: "3px 8px", color: "#6FFBBE", fontSize: 12, fontWeight: 800 }}>v2</span>
              </div>
              <p style={{ fontSize: 12, color: "#94A3B8", marginTop: 3 }}>Track. Report. Clean.</p>
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: "#94A3B8" }}>A public garbage tracker for Assam, built to make sanitation issues visible and easier to follow up.</p>
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 180 }}>
            <button className="footer-link" type="button" onClick={onAbout}>About Jabor</button>
            <button className="footer-link" type="button" onClick={onHowItWorks}>How It Works</button>
            <button className="footer-link" type="button" onClick={onSupport}>Support Jabor</button>
            <a href="/privacy" style={{ color: "#CBD5E1", textDecoration: "none", fontSize: 14 }}>Privacy Policy</a>
            <a href="/terms" style={{ color: "#CBD5E1", textDecoration: "none", fontSize: 14 }}>Terms and Conditions</a>
            <a href="mailto:jaborassam@gmail.com?subject=Jabor%20contact" style={{ color: "#CBD5E1", textDecoration: "none", fontSize: 14 }}>Contact us</a>
            <a href="https://instagram.com/Tech_Bagwitty" target="_blank" rel="noopener noreferrer" style={{ color: "#CBD5E1", textDecoration: "none", fontSize: 14 }}>Built by @Tech_Bagwitty</a>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
              <a href="https://x.com/jaborassam" target="_blank" rel="noopener noreferrer" title="@jaborassam on X" aria-label="Jabor on X" style={{ color: "#CBD5E1", display: "inline-flex" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/></svg>
              </a>
              <span title="Coming soon" aria-label="Instagram - coming soon" style={{ color: "#64748B", display: "inline-flex", cursor: "default" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>
              </span>
              <span title="Coming soon" aria-label="Facebook - coming soon" style={{ color: "#64748B", display: "inline-flex", cursor: "default" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.44 2.89h-2.34v6.99A10 10 0 0 0 22 12Z"/></svg>
              </span>
            </div>
          </nav>
        </div>
        <div style={{ borderTop: "1px solid #1E293B", paddingTop: 22, fontSize: 13, color: "#64748B" }}>
          © 2026 Jabor. Empowering communities through public sanitation tracking.
        </div>
      </div>
    </footer>
  );
}

// FIX 4: Disclaimer popup shown before first report
function DisclaimerPopup({ onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(45,26,14,.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20 }}>
      <div style={{ background: "#FFFFFF", border: "1px solid #DDE4DD", borderRadius: 20, padding: 28, maxWidth: 420, width: "100%", animation: "popIn .2s ease" }}>
        <div style={{ textAlign: "center", marginBottom: 12, color: "#B45309" }}><Glyph name="alert" size={36} /></div>
        <h2 style={{ fontSize: 18, fontWeight: 800, textAlign: "center", marginBottom: 12, letterSpacing: "-0.02em", color: "#161D19" }}>
          Before you report
        </h2>
        <p style={{ fontSize: 14, color: "#3C4A42", lineHeight: 1.75, marginBottom: 24, textAlign: "center" }}>
          Reports go public immediately. Please submit clear photos and accurate location details.
        </p>
        <button className="btn-p" style={{ width: "100%", padding: 14 }} onClick={onClose}>
          I understand - Continue
        </button>
      </div>
    </div>
  );
}

function AdminLoginGate({ onUnlock }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      onUnlock(await signInAdmin(email.trim(), password));
    } catch (e) {
      setError(e.message || "Could not sign in.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 420, margin: "40px auto", padding: 24 }}>
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <div style={{ color: "#006C49", marginBottom: 10 }}><Glyph name="shield" size={34} /></div>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Admin Access</h1>
        <p style={{ color: "#3C4A42", fontSize: 13, marginTop: 6 }}>Moderate public reports and verify cleanup proof replies.</p>
      </div>
      <form onSubmit={handleSubmit}>
        <label className="lbl">ADMIN EMAIL</label>
        <input className="inp" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Admin email" required />
        <label className="lbl" style={{ marginTop: 12 }}>PASSWORD</label>
        <input
          className="inp"
          type="password"
          value={password}
          onChange={e => { setPassword(e.target.value); setError(""); }}
          placeholder="Enter password"
        />
        {error && <p style={{ color: "#DC2626", fontSize: 12, marginTop: 8 }}>{error}</p>}
        <button className="btn-p" disabled={loading} style={{ width: "100%", marginTop: 14 }} type="submit">{loading ? "Signing in..." : "Sign In"}</button>
      </form>
    </div>
  );
}

function AdminEmpty({ icon, title, text }) {
  return (
    <div style={{ textAlign: "center", padding: "44px 16px" }}>
      <div style={{ fontSize: 38, marginBottom: 10 }}>{icon}</div>
      <p style={{ color: "#006C49", fontWeight: 800, fontSize: 15 }}>{title}</p>
      <p style={{ color: "#3C4A42", fontSize: 12, marginTop: 6 }}>{text}</p>
    </div>
  );
}

// AI recommendation review modal (human-in-the-loop step of the agentic RAG flow).
function RecommendationModal({ report, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rec, setRec] = useState(null);
  const [tab, setTab] = useState("x");
  const [caption, setCaption] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [executing, setExecuting] = useState("");
  const [results, setResults] = useState([]);
  const [tweetedAt, setTweetedAt] = useState(report.tweeted_at || null);
  const [emailedAt, setEmailedAt] = useState(report.emailed_at || null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    generateRecommendations(report.id)
      .then(data => {
        if (cancelled) return;
        setRec(data);
        setCaption(data.caption || "");
        setEmailTo((data.email?.to || []).join(", "));
        setEmailSubject(data.email?.subject || "");
        setEmailBody(data.email?.body || "");
      })
      .catch(e => { if (!cancelled) setError(e.message || "Could not generate recommendations."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [report.id]);

  const runAction = async (action, extra) => {
    setExecuting(action);
    setError("");
    try {
      const res = await executeActions({
        auditId: rec.auditId,
        reportId: report.id,
        selectedActions: [action],
        ...extra,
      });
      const rs = res.results || [];
      setResults(prev => [...prev, ...rs]);
      if (rs.some(r => r.action === "post_to_x" && r.status === "executed")) setTweetedAt(new Date().toISOString());
      if (rs.some(r => r.action === "email_authority" && r.status === "executed")) setEmailedAt(new Date().toISOString());
    } catch (e) {
      setError(e.message || "Could not execute action.");
    } finally {
      setExecuting("");
    }
  };

  const postX = () => runAction("post_to_x", { caption });
  const sendEmail = () => runAction("email_authority", {
    email: {
      to: emailTo.split(",").map(s => s.trim()).filter(Boolean),
      subject: emailSubject,
      body: emailBody,
    },
  });

  const sevColor = { high: "#DC2626", medium: "#D97706", low: "#16A34A" }[rec?.severity] || "#3C4A42";

  return (
    <div className="admin-photo-modal" onClick={onClose}>
      <div className="rec-modal-inner" onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 17, fontWeight: 900 }}>AI Post Recommendation</h2>
          <button className="admin-photo-close" style={{ position: "static" }} onClick={onClose} aria-label="Close">×</button>
        </div>

        {loading && <div style={{ padding: "32px 0" }}><Spinner /><p style={{ textAlign: "center", color: "#3C4A42", fontSize: 13, marginTop: 10 }}>Retrieving context, reasoning, and drafting…</p></div>}
        {error && <p style={{ color: "#DC2626", fontSize: 13, marginBottom: 12 }}>{error}</p>}

        {!loading && rec && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, fontSize: 12 }}>
              <span style={{ background: sevColor + "20", color: sevColor, border: `1px solid ${sevColor}55`, padding: "3px 10px", borderRadius: 6, fontWeight: 800 }}>
                {(rec.severity || "low").toUpperCase()} priority
              </span>
              {rec.pattern?.detected && (
                <span style={{ background: "#DC262620", color: "#DC2626", border: "1px solid #DC262655", padding: "3px 10px", borderRadius: 6, fontWeight: 800 }}>
                  Recurring · {rec.pattern.count} similar
                </span>
              )}
              <span style={{ color: "#3C4A42", padding: "3px 0" }}><Glyph name="clock" size={13} /> {rec.timing}</span>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 12, background: "#E8F0E9", border: "1px solid #BBCABF", borderRadius: 12, padding: 4 }}>
              {[{ id: "x", label: "Post to X" }, { id: "email", label: "Email authorities" }].map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  flex: 1, padding: "9px 8px", border: 0, borderRadius: 9,
                  background: tab === t.id ? "#006C49" : "transparent",
                  color: tab === t.id ? "#fff" : "#3C4A42",
                  fontFamily: "inherit", fontWeight: 800, cursor: "pointer",
                }}>{t.label}</button>
              ))}
            </div>

            {tab === "x" && (
              <>
                <label style={{ fontWeight: 800, fontSize: 13 }}>Caption {rec.captionError ? "(fallback - Claude unavailable)" : ""}</label>
                <textarea className="inp" style={{ marginTop: 6, minHeight: 110 }} value={caption} onChange={e => setCaption(e.target.value)} maxLength={280} />
                <p style={{ fontSize: 11, color: caption.length > 280 ? "#DC2626" : "#3C4A42", textAlign: "right", marginTop: 2 }}>{caption.length}/280</p>
                {tweetedAt && <p style={{ fontSize: 12, color: "#16A34A", fontWeight: 800, marginTop: 6 }}><Glyph name="check" size={14} /> Already posted to X for this report.</p>}
                <button className="btn-p" style={{ width: "100%", marginTop: 8 }} onClick={postX} disabled={!!executing || !caption.trim() || caption.length > 280 || !!tweetedAt}>
                  {tweetedAt ? "Posted to X" : executing === "post_to_x" ? "Posting…" : "Post to X"}
                </button>
              </>
            )}

            {tab === "email" && (
              <>
                <label style={{ fontWeight: 800, fontSize: 13 }}>To (comma-separated)</label>
                <textarea className="inp" style={{ marginTop: 6, minHeight: 54 }} value={emailTo} onChange={e => setEmailTo(e.target.value)} />
                <label style={{ fontWeight: 800, fontSize: 13, marginTop: 8, display: "block" }}>Subject</label>
                <input className="inp" style={{ marginTop: 6 }} value={emailSubject} onChange={e => setEmailSubject(e.target.value)} />
                <label style={{ fontWeight: 800, fontSize: 13, marginTop: 8, display: "block" }}>Body</label>
                <textarea className="inp" style={{ marginTop: 6, minHeight: 150 }} value={emailBody} onChange={e => setEmailBody(e.target.value)} />
                {emailedAt && <p style={{ fontSize: 12, color: "#16A34A", fontWeight: 800, marginTop: 6 }}><Glyph name="check" size={14} /> Already emailed authorities for this report.</p>}
                <button className="btn-p" style={{ width: "100%", marginTop: 8 }} onClick={sendEmail} disabled={!!executing || !emailTo.trim() || !emailBody.trim() || !!emailedAt}>
                  {emailedAt ? "Emailed" : executing === "email_authority" ? "Sending…" : "Send Email"}
                </button>
              </>
            )}

            {rec.escalations?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Escalations</div>
                {rec.escalations.map((e, i) => (
                  <p key={i} style={{ fontSize: 12, color: "#3C4A42", marginBottom: 4 }}><Glyph name="alert" size={13} /> <strong>{e.reason}</strong> ({e.severity}) - {e.guidance}</p>
                ))}
              </div>
            )}

            {rec.similar?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Similar past reports ({rec.similar.length})</div>
                {rec.similar.slice(0, 5).map(s => (
                  <p key={s.id} style={{ fontSize: 12, color: "#3C4A42", marginBottom: 2 }}>• {[s.area, s.landmark].filter(Boolean).join(", ") || "Unknown area"} - {Math.round((s.similarity || 0) * 100)}% match</p>
                ))}
              </div>
            )}

            {results.length > 0 && (
              <div style={{ marginTop: 14, borderTop: "1px solid #DDE4DD", paddingTop: 12 }}>
                {results.map((r, i) => (
                  <p key={i} style={{ fontSize: 12, color: r.status === "error" ? "#DC2626" : "#3C4A42", marginBottom: 6 }}>
                    <strong>{r.action}</strong> - <em>{r.status}</em>: {r.detail}
                  </p>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <button className="btn-s" style={{ width: "100%" }} onClick={onClose} disabled={!!executing}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReportsManagementView({ onChanged, onPhotoClick }) {
  const [recReport, setRecReport] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("verified");

  const loadReports = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchAdminReports(status);
      setReports(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || "Could not load reports.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadReports(); }, [status]);

  const handleHide = async report => {
    if (!confirm("Hide this report from the public site?")) return;
    setWorkingId(report.id);
    setError("");
    try {
      await hideReport(report.id);
      await loadReports();
      onChanged?.();
    } catch (e) {
      setError(e.message || "Could not hide report.");
    } finally {
      setWorkingId("");
    }
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800 }}>Reports ({reports.length})</h2>
        <button className="btn-s" style={{ padding: "7px 12px", fontSize: 12 }} onClick={loadReports}>Refresh</button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, background: "#E8F0E9", border: "1px solid #BBCABF", borderRadius: 12, padding: 4 }}>
        {[
          { id: "verified", label: "Active" },
          { id: "cleaned", label: "Cleaned" },
        ].map(tab => (
          <button key={tab.id} onClick={() => setStatus(tab.id)} style={{
            flex: 1,
            padding: "9px 8px",
            border: 0,
            borderRadius: 9,
            background: status === tab.id ? (tab.id === "verified" ? "#006C49" : "#10B981") : "transparent",
            color: status === tab.id ? "#fff" : "#3C4A42",
            fontFamily: "inherit",
            fontWeight: 800,
            cursor: "pointer",
          }}>{tab.label}</button>
        ))}
      </div>
      {error && <p style={{ color: "#DC2626", fontSize: 12, marginBottom: 12 }}>{error}</p>}
      {reports.length === 0 ? (
        <AdminEmpty icon={<Glyph name={status === "verified" ? "pin" : "checkCircle"} size={38} />} title={`No ${status === "verified" ? "active" : "cleaned"} reports`} text="Public reports will appear here for admin moderation." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {reports.map(report => (
            <div key={report.id} className="card admin-card">
              <div className="admin-photo-pair">
                {report.photo_url && (
                  <button className="photo-btn" type="button" onClick={() => onPhotoClick?.(report.photo_url)} aria-label="Open report photo">
                    <img className="admin-thumb" src={report.photo_url} alt="Garbage report" />
                  </button>
                )}
                {!report.photo_url && <div className="admin-thumb admin-thumb-fallback">No report image</div>}
                {report.cleanup_photo_url && (
                  <button className="photo-btn" type="button" onClick={() => onPhotoClick?.(report.cleanup_photo_url)} aria-label="Open cleanup photo">
                    <img className="admin-thumb" src={report.cleanup_photo_url} alt="Approved cleanup proof" />
                  </button>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <strong>{report.constituency || "Unknown constituency"}</strong>
                  <span style={{ color: "#3C4A42", fontSize: 12 }}>· {report.district || "Unknown district"}</span>
                  <span className={`status-pill ${report.status === "cleaned" ? "cleaned" : "verified"}`}>{report.status === "cleaned" ? "Cleaned" : "Active"}</span>
                </div>
                <p style={{ color: "#3C4A42", fontSize: 12, marginBottom: 4 }}><Glyph name="pin" size={13} /> {[report.area, report.landmark].filter(Boolean).join(" · ") || "No area details"}</p>
                <p style={{ color: "#161D19", fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>{report.description || "No description provided."}</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><div style={{ fontSize: 11, color: "#3C4A42" }}>Waste type</div><div style={{ fontWeight: 700, fontSize: 13 }}><WIcon type={report.waste_type} /> {WASTE.find(w => w.id === report.waste_type)?.label || report.waste_type}</div></div>
                  <div><div style={{ fontSize: 11, color: "#3C4A42" }}>MLA</div><div style={{ fontWeight: 700, fontSize: 13 }}>{report.mla || "Not mapped yet"}</div></div>
                  <div style={{ gridColumn: "1 / -1" }}><div style={{ fontSize: 11, color: "#3C4A42" }}>MP</div><div style={{ fontWeight: 700, fontSize: 13 }}>{mpDisplay(report.mp, report.lok_sabha_seat)}</div></div>
                </div>
              </div>
              <div className="admin-actions">
                {report.status !== "cleaned" && (
                  <button className="btn-p" style={{ padding: "7px 12px", fontSize: 12 }} onClick={() => setRecReport(report)}>
                    Generate Post
                  </button>
                )}
                <button className="btn-s admin-danger" disabled={workingId === report.id} onClick={() => handleHide(report)}>
                  {workingId === report.id ? "Working..." : "Hide/Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {recReport && <RecommendationModal report={recReport} onClose={() => { setRecReport(null); loadReports(); }} />}
    </div>
  );
}

function CleanupVerificationQueue({ onChanged, onPhotoClick }) {
  const [proofs, setProofs] = useState([]);
  const [notes, setNotes] = useState({});
  const [workingId, setWorkingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadProofs = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchPendingCleanupProofs();
      setProofs(Array.isArray(data) ? data : []);
    } catch (e) {
      const missingTable = String(e.message || "").includes("cleanup_proofs") || String(e.message || "").includes("PGRST205");
      setError(missingTable ? "Cleanup verification is not ready yet. Run the Jabor v2 Supabase migration to create the cleanup_proofs table." : "Could not load cleanup proofs. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadProofs(); }, []);

  const handleApprove = async proof => {
    setWorkingId(proof.id);
    setError("");
    try {
      await approveCleanupProof(proof.id, proof.report_id);
      await loadProofs();
      onChanged?.();
    } catch (e) {
      setError(e.message || "Cleanup approval failed.");
    } finally {
      setWorkingId("");
    }
  };

  const handleReject = async proof => {
    setWorkingId(proof.id);
    setError("");
    try {
      await rejectCleanupProof(proof.id, notes[proof.id] || "");
      await loadProofs();
      onChanged?.();
    } catch (e) {
      setError(e.message || "Cleanup rejection failed.");
    } finally {
      setWorkingId("");
    }
  };

  if (loading) return <Spinner />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800 }}>Cleanup Proofs ({proofs.length})</h2>
        <button className="btn-s" style={{ padding: "7px 12px", fontSize: 12 }} onClick={loadProofs}>Refresh</button>
      </div>
      {error && <p style={{ color: "#DC2626", fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>{error}</p>}
      {proofs.length === 0 ? (
        <AdminEmpty icon={<Glyph name="checkCircle" size={38} />} title="No cleanup proofs waiting" text="Citizen cleanup proof submissions will appear here for verification." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {proofs.map(proof => {
            const report = proof.reports || {};
            return (
              <div key={proof.id} className="card admin-proof-card">
                <div className="admin-proof-col">
                  <div className="lbl">ORIGINAL REPORT</div>
                  {report.photo_url && (
                    <button className="photo-btn" type="button" onClick={() => onPhotoClick?.(report.photo_url)} aria-label="Open original report photo">
                      <img className="admin-proof-img" src={report.photo_url} alt="Original report" />
                    </button>
                  )}
                  {!report.photo_url && <div className="admin-proof-img admin-thumb-fallback">No report image</div>}
                  <strong>{report.constituency || "Unknown"} · {report.district || "Unknown"}</strong>
                  <p style={{ color: "#3C4A42", fontSize: 12 }}><Glyph name="pin" size={13} /> {[report.area, report.landmark].filter(Boolean).join(" · ") || "No area details"}</p>
                  <p style={{ fontSize: 13, color: "#161D19", lineHeight: 1.5 }}>{report.description || "No description."}</p>
                  <p style={{ fontSize: 12, color: "#3C4A42", marginTop: 6 }}>MLA: <strong>{report.mla || "Not mapped yet"}</strong> · MP: <strong>{mpDisplay(report.mp, report.lok_sabha_seat)}</strong></p>
                </div>
                <div className="admin-proof-col">
                  <div className="lbl">CLEANUP PROOF</div>
                  <button className="photo-btn" type="button" onClick={() => onPhotoClick?.(proof.image_url)} aria-label="Open cleanup proof photo">
                    <img className="admin-proof-img" src={proof.image_url} alt="Cleanup proof" />
                  </button>
                  <p style={{ fontSize: 12, color: "#3C4A42", marginTop: 8 }}>Cleaned: <strong>{proof.cleaned_date_estimate || "Not provided"}</strong></p>
                  <p style={{ fontSize: 12, color: "#3C4A42" }}>Submitted by: <strong>{proof.submitted_by || "Anonymous"}</strong></p>
                </div>
                <div className="admin-actions">
                  <textarea
                    className="inp admin-note"
                    placeholder="Admin notes for rejection"
                    value={notes[proof.id] || ""}
                    onChange={e => setNotes(prev => ({ ...prev, [proof.id]: e.target.value }))}
                  />
                  <button className="btn-p admin-ok" disabled={workingId === proof.id} onClick={() => handleApprove(proof)}>
                    {workingId === proof.id ? "Working..." : "Approve Cleanup"}
                  </button>
                  <button className="btn-s admin-danger" disabled={workingId === proof.id} onClick={() => handleReject(proof)}>Reject Proof</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CleanupProofUploadForm({ reportId, onSuccess }) {
  const [image, setImage] = useState(null);
  const [cleanedDateEstimate, setCleanedDateEstimate] = useState("");
  const [submittedBy, setSubmittedBy] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef(null);
  const onTurnstileToken = useCallback(token => setTurnstileToken(token), []);

  const submit = async e => {
    e.preventDefault();
    if (!navigator.onLine) {
      setMessage("You are offline. Please reconnect to submit cleanup proof.");
      return;
    }
    if (!image || !cleanedDateEstimate.trim()) {
      setMessage("Please add a cleanup photo and cleaning date estimate.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await uploadCleanupProof(reportId, image, cleanedDateEstimate.trim(), submittedBy.trim() || null, turnstileToken);
      trackCleanupProofSubmission();
      setImage(null);
      setCleanedDateEstimate("");
      setSubmittedBy("");
      setMessage("Cleanup reply submitted for admin verification.");
      onSuccess?.();
    } catch (e) {
      setMessage(e.message || "Could not submit cleanup proof.");
    } finally {
      // Turnstile tokens are single-use; get a fresh one for the next attempt.
      setTurnstileToken("");
      turnstileRef.current?.reset();
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="cleanup-form">
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 10, color: "#10B981" }}>Reply with cleanup proof</div>
      <input
        className="inp"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={e => {
          const file = e.target.files?.[0] || null;
          try {
            if (file) validateUploadImage(file, "Cleanup proof");
            setImage(file);
            setMessage("");
          } catch (error) {
            e.target.value = "";
            setImage(null);
            setMessage(error.message || "Please choose a valid cleanup proof image.");
          }
        }}
      />
      <input
        className="inp"
        value={cleanedDateEstimate}
        onChange={e => setCleanedDateEstimate(e.target.value)}
        placeholder="When was it cleaned? e.g. today, yesterday"
      />
      <input
        className="inp"
        value={submittedBy}
        onChange={e => setSubmittedBy(e.target.value)}
        placeholder="Your name (optional)"
      />
      <TurnstileWidget onToken={onTurnstileToken} controlRef={turnstileRef} />
      {message && <p style={{ fontSize: 12, color: message.includes("submitted") ? "#059669" : "#DC2626" }}>{message}</p>}
      <button className="btn-p" disabled={loading} type="submit" style={{ width: "100%", padding: 12 }}>
        {loading ? "Submitting..." : "Submit Cleanup Reply"}
      </button>
    </form>
  );
}

// Loaded only when someone opens /admin, so the public bundle does not grow.
const AdminApp = lazy(() => import("./src/admin/AdminApp.tsx"));

function AdminDashboard({ onChanged }) {
  // null while checking, false when signed out, otherwise { email, role, municipality } from the server.
  const [session, setSession] = useState(null);

  useEffect(() => {
    checkAdminSession().then(found => setSession(found || false));
  }, []);

  const signOut = useCallback(async () => { await signOutAdmin(); setSession(false); }, []);

  if (session === null) return <AdminEmpty icon={<Glyph name="clock" size={38} />} title="Checking admin session…" text="" />;
  if (!session) return <AdminLoginGate onUnlock={setSession} />;

  // The dashboard, audit log and Hidden tabs are in src/admin for both roles. The owner also keeps the
  // older moderation screens (AI recommendations and proof review), which stay here.
  const extraTabs = session.role === "super_admin" ? [
    { id: "cleanup", label: "Cleanup Verification", render: ({ onPhotoClick }) => <CleanupVerificationQueue onChanged={onChanged} onPhotoClick={onPhotoClick} /> },
    { id: "moderation", label: "Moderation", render: ({ onPhotoClick }) => <ReportsManagementView onChanged={onChanged} onPhotoClick={onPhotoClick} /> },
  ] : [];

  return (
    <Suspense fallback={<Spinner />}>
      <AdminApp session={session} onSignOut={signOut} extraTabs={extraTabs} onChanged={onChanged} />
    </Suspense>
  );
}


export default function Jabor() {
  assertSupabaseConfig();
  const isAdminRoute = window.location.pathname === "/admin" || window.location.hash === "#admin";
  const [view,           setView]           = useState(isAdminRoute ? "admin" : "dashboard");
  const [reports,        setReports]        = useState([]);
  const [mlaList,        setMlaList]        = useState([]);
  const [loadingRep,     setLoadingRep]     = useState(true);
  const [loadingMlas,    setLoadingMlas]    = useState(true);
  const [submitting,     setSubmitting]     = useState(false);
  const [submitStep,     setSubmitStep]     = useState("");
  const [submitted,      setSubmitted]      = useState(false);
  const [selReport,      setSelReport]      = useState(null);
  const [zoomPhoto,      setZoomPhoto]      = useState("");
  const [preview,        setPreview]        = useState(null);
  const [loadingPrev,    setLoadingPrev]    = useState(false);
  const [feedTab,        setFeedTab]        = useState("active");
  const [feedFilters,    setFeedFilters]    = useState({ place: "", wasteType: "", dateRange: "" });
  const [feedVisible,    setFeedVisible]    = useState(5);
  const [cleanupOpenId,  setCleanupOpenId]  = useState("");
  const [drawerOpen,     setDrawerOpen]     = useState(false);
  const [quoteIndex,     setQuoteIndex]     = useState(0);
  const [form, setForm] = useState({
    district: "", constituency: "", area: "", landmark: "",
    waste_type: "mixed", description: "", photo: null, photoPreview: null,
    anonymous: true, reporterName: "", reporterEmail: "",
    muniAnswer: "", wardChoice: "",
  });
  // Municipalities that ask the municipal-area question (null while loading). A failed load leaves
  // an empty list; the server then asks for the answer itself if the location needs one.
  const [municipalities, setMunicipalities] = useState(null);
  const fileRef = useRef();
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef(null);
  const onTurnstileToken = useCallback(token => setTurnstileToken(token), []);
  const dashboardReportsRef = useRef(null);
  const aboutRef = useRef(null);
  const statsRef = useRef(null);
  const howItWorksRef = useRef(null);

  useEffect(() => { document.title = "Jabor - Assam Garbage Tracker"; }, []);

  useEffect(() => {
    const currentPath = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const sendPageView = () => trackPageView(currentPath());
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    // Production deployments only: never localhost, Preview or staging.
    if (gaEnabled(import.meta.env)) initGA(GA_MEASUREMENT_ID);
    sendPageView();

    window.history.pushState = function pushState(...args) {
      originalPushState.apply(this, args);
      sendPageView();
    };
    window.history.replaceState = function replaceState(...args) {
      originalReplaceState.apply(this, args);
      sendPageView();
    };
    window.addEventListener("popstate", sendPageView);
    window.addEventListener("hashchange", sendPageView);

    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener("popstate", sendPageView);
      window.removeEventListener("hashchange", sendPageView);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setQuoteIndex(index => (index + 1) % CLEAN_QUOTES.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { setFeedVisible(5); }, [feedTab, feedFilters]);

  const normalizeFilters = filters => {
    const selectedRange = DATE_RANGES.find(range => range.id === filters.dateRange);
    if (!selectedRange?.days) {
      return { place: filters.place, wasteType: filters.wasteType };
    }
    const start = new Date(Date.now() - selectedRange.days * 24 * 60 * 60 * 1000);
    return {
      place: filters.place,
      wasteType: filters.wasteType,
      startDate: start.toISOString(),
    };
  };

  const loadPublicReports = async (filters = feedFilters, preservedReport = null) => {
    setLoadingRep(true);
    try {
      const queryFilters = normalizeFilters(filters);
      const [active, cleaned] = await Promise.all([
        fetchActiveReports(queryFilters),
        fetchCleanedReports(queryFilters),
      ]);
      const fetchedReports = [...(Array.isArray(active) ? active : []), ...(Array.isArray(cleaned) ? cleaned : [])];
      logReportPhotos("public reports", fetchedReports);
      setReports(withPreservedReport(fetchedReports, preservedReport));
    } catch {
      const fallback = await db.getReports();
      logReportPhotos("fallback public reports", fallback);
      setReports(withPreservedReport(fallback, preservedReport));
    } finally {
      setLoadingRep(false);
    }
  };

  useEffect(() => {
    loadPublicReports();
    db.getMlas().then(d    => { setMlaList(Array.isArray(d) ? d : []);  setLoadingMlas(false); });
  }, []);

  useEffect(() => {
    loadPublicReports(feedFilters);
  }, [feedFilters.place, feedFilters.wasteType, feedFilters.dateRange]);

  const districts   = [...new Set(mlaList.map(m => m.district))].sort();
  const consForDist = mlaList.filter(m => m.district === form.district).sort((a, b) => a.constituency.localeCompare(b.constituency));
  const districtOptions = districts.map(d => ({ value: d, label: d }));
  const constituencyOptions = consForDist.map(c => ({ value: c.constituency, label: c.constituency.trim() }));

  useEffect(() => {
    if (!form.constituency) { setPreview(null); return; }
    setLoadingPrev(true);
    db.getMla(form.constituency).then(async mla => {
      if (!mla) { setPreview(null); setLoadingPrev(false); return; }
      const mp = await db.getMp(mla.lok_sabha_seat);
      setPreview({ mla, mp });
      setLoadingPrev(false);
    });
  }, [form.constituency]);

  const onPhoto = e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      validateUploadImage(f, "Photo");
    } catch (error) {
      e.target.value = "";
      alert(error.message || "Please choose a valid image file.");
      return;
    }
    const r = new FileReader();
    r.onload = ev => setForm(p => ({ ...p, photo: f, photoPreview: ev.target.result }));
    r.readAsDataURL(f);
  };

  const setAppView = nextView => {
    if (window.location.pathname === "/admin" && nextView !== "admin") {
      window.history.pushState({}, "", "/");
    }
    setView(nextView);
  };

  const scrollToSection = ref => {
    if (view !== "dashboard") setAppView("dashboard");
    setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  const goToReport = () => {
    setAppView("report");
    setTimeout(() => window.scrollTo({ top: 0, behavior: "auto" }), 0);
  };

  const goToSupport = () => {
    if (view !== "dashboard") setAppView("dashboard");
    setTimeout(() => {
      const el = document.getElementById("support-jabor");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => window.dispatchEvent(new Event("jabor:highlight-support")), 400);
      }
    }, 60);
  };

  useEffect(() => {
    if (view !== "report" || municipalities !== null) return;
    loadMunicipalities()
      .then(setMunicipalities)
      .catch(error => { console.warn("[Jabor] municipal area question unavailable", error); setMunicipalities([]); });
  }, [view, municipalities]);

  const askedMunicipality = municipalities ? findMunicipality(municipalities, form.district, form.constituency) : null;

  const onSubmit = async () => {
    if (!navigator.onLine) {
      alert("You are offline. Please reconnect to submit the report.");
      return;
    }
    if (!form.district || !form.constituency || !form.area.trim()) {
      alert("Please fill District, Constituency and Area."); return;
    }
    if (!form.photo) {
      alert("Please add a photo of the garbage dump."); return;
    }
    if (!preview) { alert("Area details are still loading - please wait."); return; }
    if (municipalities === null) { alert("Area details are still loading - please wait."); return; }
    const placementProblem = placementError(askedMunicipality, form.muniAnswer, form.wardChoice);
    if (placementProblem) { alert(placementProblem); return; }
    const email = form.reporterEmail.trim();
    const wantsContact = !form.anonymous && email;
    if (wantsContact && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      alert("Please enter a valid email, or choose to report anonymously."); return;
    }
    if (TURNSTILE_MISSING) { alert(TURNSTILE_MISSING_MESSAGE); return; }
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      alert("Please wait for the security check above the submit button to finish, then try again."); return;
    }
    setSubmitting(true);
    try {
      setSubmitStep("uploading");
      const photo_url = await db.uploadPhoto(form.photo);
      if (import.meta.env.DEV) console.debug("[Jabor] uploaded report photo_url", photo_url);
      setSubmitStep("saving");
      const payload = {
        district: form.district, constituency: form.constituency,
        area: form.area.trim(), landmark: form.landmark.trim(),
        waste_type: form.waste_type, description: form.description.trim(),
        lat: null, lng: null, photo_url,
      };
      // The server stores the contact and sends the confirmation email (jabor-notify is server-only).
      await db.submitReport({
        ...payload,
        ...placementFields(askedMunicipality, form.muniAnswer, form.wardChoice),
        reporter_name: wantsContact ? form.reporterName.trim() : "",
        reporter_email: wantsContact ? email : "",
      }, turnstileToken);
      trackReportSubmission();
      const now = new Date().toISOString();
      const localReport = {
        ...payload,
        id: `local-${Date.now()}`,
        status: "verified",
        is_deleted: false,
        created_at: now,
        updated_at: now,
      };
      setReports(prev => withPreservedReport(prev, localReport));
      await loadPublicReports(feedFilters, localReport);
      setPreview(null);
      setForm({ district: "", constituency: "", area: "", landmark: "", waste_type: "mixed", description: "", photo: null, photoPreview: null, anonymous: true, reporterName: "", reporterEmail: "", muniAnswer: "", wardChoice: "" });
      setTurnstileToken("");
      setSubmitted(true);
    } catch (e) {
      // Turnstile tokens are single-use; get a fresh one before a retry.
      turnstileRef.current?.reset();
      alert(e.message || "Could not submit the report. Please try again.");
    } finally {
      setSubmitting(false);
      setSubmitStep("");
    }
  };

  const activeReports = reports.filter(r => r.status === "verified");
  const cleanedReports = reports.filter(r => r.status === "cleaned");
  const displayedFeedReports = feedTab === "active" ? activeReports : cleanedReports;
  const dashboardTabReports = feedTab === "active" ? activeReports : cleanedReports;
  const total = reports.length;
  const uCons = [...new Set(reports.map(r => r.constituency))].length;
  const week  = reports.filter(r => Date.now() - new Date(r.created_at).getTime() < 7 * 864e5).length;
  const districtMap  = {};
  activeReports.forEach(r => {
    const district = r.district || "Unknown district";
    if (!districtMap[district]) districtMap[district] = { count: 0, district };
    districtMap[district].count++;
  });
  const actionDistricts = Object.entries(districtMap)
    .filter(([, data]) => data.count > 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  return (
    <div style={{ fontFamily: "'Inter','DM Sans',sans-serif", background: "#F4FBF4", minHeight: "100vh", color: "#161D19", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Sora:wght@600;700;800;900&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }
        body { background: #F4FBF4; -webkit-font-smoothing: antialiased; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #006C49; border-radius: 2px; }
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes slideIn { from{opacity:0} to{opacity:1} }
        @keyframes popIn   { from{opacity:0} to{opacity:1} }
        .slide-in { animation: slideIn .2s ease; }
        .pop-in   { animation: popIn .2s ease; }
        .card { background:#FFFFFF; border:1px solid #DDE4DD; border-radius:12px; padding:18px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
        .btn-p { background:#10B981; color:#00422B; border:none; border-radius:8px; padding:14px 24px; font-family:'Inter',sans-serif; font-weight:800; font-size:15px; cursor:pointer; transition:all .2s; box-shadow:0 6px 18px rgba(16,185,129,.22); white-space:nowrap; touch-action:manipulation; }
        .btn-p:hover  { transform:translateY(-1px); filter:brightness(1.03); box-shadow:0 8px 24px rgba(16,185,129,.28); }
        .btn-p:active { transform:scale(.97); }
        .btn-p:disabled { opacity:.55; cursor:not-allowed; transform:none; }
        .btn-s { background:transparent; color:#006C49; border:1.5px solid #BBCABF; border-radius:8px; padding:11px 20px; font-family:'Inter',sans-serif; font-weight:700; font-size:14px; cursor:pointer; transition:all .2s; white-space:nowrap; touch-action:manipulation; }
        .btn-s:hover  { border-color:#006C49; background:#E8F0E9; }
        .btn-s:active { transform:scale(.97); }
        .razorpay-fallback-link { display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:10px 18px; border:1.5px solid #2371EC; border-radius:6px; background:#F8FBFF; color:#1F4BB8; font-weight:800; font-size:14px; text-decoration:none; }
        .razorpay-fallback-link:hover { background:#EDF4FF; }
        .contact-card-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
        .anonymous-inline-toggle { display:flex; flex-direction:column; align-items:center; gap:7px; color:#006C49; font-size:11px; font-weight:800; cursor:pointer; white-space:nowrap; }
        .inp { width:100%; background:#FFFFFF; border:1.5px solid #BBCABF; border-radius:8px; padding:13px 14px; color:#161D19; font-family:'Inter',sans-serif; font-size:16px; outline:none; transition:border-color .2s, box-shadow .2s; -webkit-appearance:none; }
        .inp:focus { border-color:#006C49; box-shadow:0 0 0 4px rgba(16,185,129,.12); }
        .inp option { background:#FFFFFF; color:#161D19; }
        select.inp { cursor:pointer; }
        textarea.inp { resize:vertical; min-height:92px; }
        .lbl { font-size:11px; font-weight:800; color:#3C4A42; display:block; margin-bottom:6px; font-family:'Inter',sans-serif; letter-spacing:.06em; }
        /* Incognito mode - form goes dark while staying readable/usable. */
        .incognito { background:#161D19; border-radius:16px; padding:10px; transition:background .25s; }
        .incognito .card { background:#212C25; border-color:#3A473E; box-shadow:none; color:#E8F0E9; }
        .incognito .card div, .incognito .card p, .incognito .card span, .incognito .card label, .incognito .card strong { color:#E8F0E9; }
        .incognito .inp { background:#161D19; border-color:#3A473E; color:#F4FBF4; }
        .incognito .inp::placeholder { color:#8CA394; }
        .incognito .inp option { background:#212C25; color:#F4FBF4; }
        .incognito-bar { display:flex; align-items:center; justify-content:space-between; gap:14px; background:#161D19; color:#E8F0E9; border:1px solid #3A473E; border-radius:12px; padding:14px 16px; margin-bottom:14px; }
        .incognito-copy { display:flex; align-items:center; gap:10px; min-width:0; }
        .incognito-copy-icon { font-size:20px; display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; flex:none; }
        .incognito-title { font-weight:700; font-size:14px; line-height:1.25; }
        .incognito-subtitle { font-size:11px; line-height:1.35; color:#8CA394; margin-top:2px; }
        .incognito-toggle { display:flex; flex-direction:column; align-items:center; gap:8px; font-size:13px; cursor:pointer; white-space:nowrap; color:#E8F0E9; flex:none; }
        .switch { position:relative; display:inline-flex; width:44px; height:24px; flex:none; }
        .switch input { opacity:0; width:0; height:0; position:absolute; margin:0; }
        .switch .slider { position:absolute; inset:0; background:#3A473E; border-radius:999px; transition:background .2s; cursor:pointer; }
        .switch .slider::before { content:""; position:absolute; height:18px; width:18px; left:3px; top:3px; background:#F4FBF4; border-radius:50%; transition:transform .2s; }
        .switch input:checked + .slider { background:#10B981; }
        .switch input:checked + .slider::before { transform:translateX(20px); }
        .rcard { background:#FFFFFF; border:1px solid #DDE4DD; border-radius:12px; padding:14px; cursor:pointer; transition:all .2s; touch-action:manipulation; overflow:hidden; min-width:0; }
        .rcard:active { transform:scale(.985); }
        @media(hover:hover) { .rcard:hover { border-color:#10B981; transform:translateY(-1px); box-shadow:0 8px 24px rgba(0,108,73,.10); } }
        .pbar  { height:3px; border-radius:2px; background:#DDE4DD; overflow:hidden; margin-top:8px; }
        .pfill { height:100%; border-radius:2px; background:linear-gradient(90deg,#006C49,#10B981); transition:width .5s; }
        .chip { display:inline-flex; align-items:center; gap:5px; padding:8px 12px; border-radius:10px; font-size:13px; font-weight:600; cursor:pointer; transition:all .15s; border:2px solid transparent; touch-action:manipulation; }
        .chip:active { transform:scale(.95); }
        .top-appbar { background:#F4FBF4; border-bottom:1px solid #BBCABF; position:sticky; top:0; z-index:50; box-shadow:0 1px 4px rgba(15,23,42,.05); }
        .top-appbar-inner { max-width:1200px; margin:0 auto; min-height:60px; padding:0 20px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .icon-action { width:44px; height:44px; border:0; border-radius:8px; background:transparent; color:#006C49; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; transition:background .2s, transform .2s; }
        .icon-action:hover { background:#E8F0E9; }
        .icon-action:active { transform:scale(.95); }
        .back-link { display:inline-flex; align-items:center; gap:6px; min-height:44px; margin:0 0 4px -4px; padding:0 8px 0 4px; border:0; border-radius:8px; background:transparent; color:#006C49; font:inherit; font-size:14px; font-weight:700; cursor:pointer; }
        .back-link:hover { background:#E8F0E9; }
        .brand-lockup { display:flex; align-items:center; gap:9px; border:0; background:transparent; cursor:pointer; text-align:left; color:#006C49; }
        .brand-lockup img { width:34px; height:34px; object-fit:contain; }
        .brand-lockup strong { display:block; font-family:'Sora',sans-serif; font-size:22px; line-height:1; letter-spacing:-.035em; text-transform:none; color:#0F172A; }
        .brand-lockup small { display:block; color:#3C4A42; font-size:11px; margin-top:3px; }
        .appbar-cta { padding:10px 16px; box-shadow:0 2px 8px rgba(16,185,129,.18); }
        .drawer-overlay { position:fixed; inset:0; z-index:100; background:rgba(15,23,42,.42); animation:fadeIn .2s ease; }
        .nav-drawer { width:min(288px, 86vw); height:100%; background:#E8F0E9; border-radius:0 12px 12px 0; padding:24px 12px; box-shadow:0 18px 40px rgba(15,23,42,.22); animation:drawerIn .24s ease; }
        .drawer-brand { display:flex; align-items:center; gap:12px; padding:0 12px 28px; }
        .drawer-brand img { width:40px; height:40px; object-fit:contain; }
        .drawer-brand h2 { font-family:'Sora',sans-serif; color:#006C49; font-size:22px; line-height:1.1; }
        .drawer-brand p { color:#3C4A42; font-size:12px; margin-top:3px; }
        .drawer-link { width:100%; display:flex; align-items:center; gap:16px; border:0; background:transparent; color:#3C4A42; border-radius:8px; padding:13px 16px; font-family:'Inter',sans-serif; font-size:14px; font-weight:700; cursor:pointer; text-align:left; transition:background .2s, color .2s; }
        .drawer-link:hover { background:#DDE4DD; color:#006C49; }
        @keyframes drawerIn { from{transform:translateX(-100%)} to{transform:translateX(0)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        .hero-title { display:flex; justify-content:center; flex-wrap:wrap; gap:.3em; font-family:'Sora',sans-serif; font-size:48px; font-weight:900; line-height:1.12; letter-spacing:-.045em; margin-bottom:10px; }
        .hero-word { display:inline-block; }
        .quote-panel { position:relative; overflow:hidden; border:1px solid #BBCABF; background:linear-gradient(135deg,#FFFFFF,#E8F0E9); border-radius:16px; padding:34px 26px; box-shadow:0 12px 32px rgba(0,108,73,.08); }
        .quote-mark { font-family:'Sora',sans-serif; color:#10B981; font-size:48px; line-height:1; }
        .quote-text { font-family:'Sora',sans-serif; font-size:24px; line-height:1.45; font-weight:700; letter-spacing:-.025em; color:#161D19; }
        .quote-author { color:#006C49; font-size:13px; font-weight:800; margin-top:14px; letter-spacing:.04em; text-transform:uppercase; }
        .quote-dots { display:flex; gap:6px; justify-content:center; margin-top:20px; }
        .quote-dot { width:7px; height:7px; border-radius:2px; background:#BBCABF; transition:all .25s; }
        .quote-dot.on { width:22px; background:#10B981; }
        .quote-nav { position:absolute; top:50%; transform:translateY(-50%); width:44px; height:44px; border-radius:8px; border:1px solid #BBCABF; background:#FFFFFFdd; color:#006C49; cursor:pointer; display:flex; align-items:center; justify-content:center; z-index:2; }
        .quote-nav.prev { left:12px; }
        .quote-nav.next { right:12px; }
        .quote-panel-content { padding:0 34px; }
        .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:20px; }
        .stat-n { font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#006C49; line-height:1; }
        .desk-2col { display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:22px; align-items:start; }
        .desk-sticky { position:sticky; top:74px; }
        .form-2col { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .acc-grid  { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
        .about-grid { grid-template-columns:1.2fr .8fr; }
        .page-section { max-width:1200px; margin:0 auto; padding:60px 20px; }
        .section-band { background:#E8F0E9; }
        .section-title { font-family:'Sora',sans-serif; font-size:32px; line-height:1.25; font-weight:800; letter-spacing:-.035em; color:#161D19; }
        .section-kicker { color:#3C4A42; font-size:15px; line-height:1.65; }
        .timeline { max-width:440px; margin:0 auto; position:relative; padding:0 8px 0 56px; }
        .timeline::before { content:""; position:absolute; left:33px; top:4px; bottom:4px; width:2px; background:rgba(16,185,129,.28); }
        .timeline-step { position:relative; margin-bottom:26px; }
        .timeline-step:last-child { margin-bottom:0; }
        .timeline-icon { position:absolute; left:-42px; top:0; width:40px; height:40px; border-radius:999px; background:#10B981; color:#fff; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px rgba(16,185,129,.24); }
        .feature-card { background:#FFFFFF; border:1px solid #E2E8F0; border-radius:12px; padding:24px; box-shadow:0 1px 3px rgba(15,23,42,.05); }
        .feature-icon { width:48px; height:48px; border-radius:8px; background:rgba(0,108,73,.1); color:#006C49; display:flex; align-items:center; justify-content:center; margin-bottom:16px; }
        .dark-feature { background:#0F172A; border-color:#1E293B; color:#FFFFFF; box-shadow:0 10px 24px rgba(15,23,42,.18); }
        .cta-panel { background:#006C49; color:#fff; border-radius:20px; padding:40px; text-align:center; box-shadow:0 18px 40px rgba(0,108,73,.22); position:relative; overflow:hidden; }
        .hero-btns .btn-p, .hero-btns .btn-s { padding:10px 18px; font-size:14px; min-width:0; box-shadow:0 4px 14px rgba(16,185,129,.18); }
        .footer-link { color:#CBD5E1; background:none; border:0; padding:0; text-align:left; font:inherit; font-size:14px; cursor:pointer; }
        .footer-link:hover { color:#6FFBBE; }
        .photo-zoom { display:block; padding:0; border:0; background:none; border-radius:10px; cursor:zoom-in; line-height:0; width:100%; }
        .photo-zoom:focus-visible { outline:3px solid #1B6EF3; outline-offset:2px; }
        .report-photo-stack { width:58px; min-width:58px; flex-shrink:0; display:flex; flex-direction:column; gap:4px; }
        .report-photo-stack img { display:block; width:58px; height:58px; border-radius:10px; object-fit:cover; border:1px solid #BBCABF; background:#E8F0E9; }
        .report-photo-stack > * + * img { height:34px; border-color:#10B981; }
        .cleaned-photo-pair { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
        .cleaned-photo-pair figure { margin:0; }
        .cleaned-photo-pair img { display:block; width:100%; height:130px; object-fit:cover; border-radius:9px; border:1px solid #BBCABF; background:#E8F0E9; }
        .cleaned-photo-pair figcaption { margin-top:3px; font-size:10px; color:#3C4A42; text-align:center; font-weight:800; text-transform:uppercase; letter-spacing:.05em; }
        @media (prefers-reduced-motion: reduce) {
          }
        @media (max-width:860px) { .desk-2col { grid-template-columns:1fr; } .desk-sticky { position:static; } }
        @media (max-width:640px) {
          .top-appbar-inner { padding:0 14px; }
          .brand-lockup img { width:32px; height:32px; }
          .brand-lockup strong { font-size:20px; }
          .appbar-cta { padding:9px 12px; font-size:13px; }
          .stat-n { font-size:26px; }
          .form-2col { grid-template-columns:1fr; }
          .acc-grid  { grid-template-columns:1fr; }
          .about-grid { grid-template-columns:1fr !important; }
          .hero-h1, .hero-title { font-size:34px !important; }
          .quote-text { font-size:20px; }
          .hero-btns { flex-direction:column; }
          .hero-btns .btn-p, .hero-btns .btn-s { width:auto; text-align:center; }
          .card { padding:14px; border-radius:12px; }
          .contact-card-head { align-items:flex-start; }
          .anonymous-inline-toggle { font-size:10px; }
          .incognito { padding:8px; border-radius:14px; }
          .incognito-bar { align-items:stretch; gap:12px; padding:13px; }
          .incognito-copy { flex:1; align-items:flex-start; }
          .incognito-copy-icon { width:28px; height:28px; margin-top:1px; }
          .incognito-title { font-size:13px; }
          .incognito-subtitle { font-size:10.5px; max-width:190px; }
          .incognito-toggle { align-self:center; min-width:86px; font-size:11px; text-align:center; gap:7px; }
          .page-section { padding:44px 16px; }
          .section-title { font-size:28px; }
          .cta-panel { padding:28px 18px; }
          .inp  { font-size:16px; }
        }
        @media (max-width:380px) {
          .stats-row { grid-template-columns:1fr 1fr; }
          .incognito-bar { flex-direction:column; }
          .incognito-toggle { flex-direction:row; justify-content:space-between; width:100%; min-width:0; }
          .incognito-subtitle { max-width:none; }
        }
      `}</style>

      {/* HEADER */}
      <header className="top-appbar">
        <div className="top-appbar-inner">
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* the admin area has its own menu button */}
            {view !== "admin" && <button className="icon-action" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
              <Glyph name="menu" size={24} />
            </button>}
            <button className="brand-lockup" onClick={() => setAppView("dashboard")} aria-label="Go to dashboard">
              <img src={LOGO} alt="Jabor" />
              <span>
                <strong>Jabor</strong>
                <small>Assam Garbage Tracker</small>
              </span>
            </button>
          </div>
        </div>
      </header>

      {drawerOpen && (
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <nav className="nav-drawer" onClick={e => e.stopPropagation()} aria-label="Jabor menu">
            <div className="drawer-brand">
              <img src={LOGO} alt="Jabor" />
              <div>
                <h2>Jabor Menu</h2>
                <p>Assam Garbage Tracker</p>
              </div>
            </div>
            {[
              { icon: "report", label: "Report Garbage", action: goToReport },
              { icon: "rss_feed", label: "Live Feed", action: () => scrollToSection(dashboardReportsRef) },
              { icon: "format_quote", label: "Civic Quotes", action: () => scrollToSection(statsRef) },
              { icon: "info", label: "How It Works", action: () => scrollToSection(howItWorksRef) },
              { icon: "groups", label: "About Jabor", action: () => scrollToSection(aboutRef) },
              { icon: "favorite", label: "Support Jabor", action: goToSupport },
            ].map(item => (
              <button
                key={item.label}
                className="drawer-link"
                onClick={() => {
                  setDrawerOpen(false);
                  item.action();
                }}
              >
                <Glyph name={ICON[item.icon]} size={22} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
      )}

      <main className="main-wrap" style={{ width: "100%", maxWidth: view === "dashboard" ? "none" : 1100, margin: "0 auto", padding: view === "dashboard" ? 0 : "20px 16px", flex: 1 }}>

        {/* DASHBOARD */}
        {view === "dashboard" && (
          <div className="slide-in">
            <section className="page-section" style={{ textAlign: "center", paddingTop: 56 }}>
              <div style={{ maxWidth: 760, margin: "0 auto" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#006C49", fontSize: 12, fontWeight: 900, letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 14 }}>
                  Assam Garbage Tracker
                </div>
                <h1 className="hero-h1 hero-title" aria-label="Track. Report. Clean.">
                  <span className="hero-word">Track.</span>
                  <span className="hero-word">Report.</span>
                  <span className="hero-word">Clean.</span>
                </h1>
                <p className="section-kicker" style={{ maxWidth: 560, margin: "0 auto 32px" }}>
                  A simple statewide garbage tracker where anyone can report a garbage spot with a photo, location, and waste type.
                </p>
                <div className="hero-btns" style={{ display: "flex", justifyContent: "center", gap: 12 }}>
                  <button className="btn-p" onClick={goToReport}>Report Garbage Now</button>
                  <button className="btn-s" onClick={() => scrollToSection(dashboardReportsRef)}>View Live Reports</button>
                </div>
              </div>
            </section>

            <section ref={statsRef} className="section-band" style={{ scrollMarginTop: 80 }}>
              <div className="page-section" style={{ paddingTop: 40, paddingBottom: 40 }}>
                <div className="quote-panel" key={quoteIndex}>
                  <button className="quote-nav prev" type="button" aria-label="Previous quote" onClick={() => setQuoteIndex(index => (index - 1 + CLEAN_QUOTES.length) % CLEAN_QUOTES.length)}>
                    <Glyph name="chevronLeft" size={22} />
                  </button>
                  <button className="quote-nav next" type="button" aria-label="Next quote" onClick={() => setQuoteIndex(index => (index + 1) % CLEAN_QUOTES.length)}>
                    <Glyph name="chevronRight" size={22} />
                  </button>
                  <div className="quote-panel-content">
                    <div className="quote-mark">“</div>
                    <p className="quote-text">{CLEAN_QUOTES[quoteIndex].quote}</p>
                    <p className="quote-author">{CLEAN_QUOTES[quoteIndex].author}</p>
                  </div>
                  <div className="quote-dots" aria-hidden="true">
                    {CLEAN_QUOTES.map((quote, index) => (
                      <span key={quote.quote} className={`quote-dot ${index === quoteIndex ? "on" : ""}`} />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section ref={howItWorksRef} className="page-section" style={{ scrollMarginTop: 80, background: "#fff", maxWidth: "none" }}>
              <div style={{ maxWidth: 1200, margin: "0 auto" }}>
                <div style={{ textAlign: "center", marginBottom: 26 }}>
                  <h2 className="section-title">How It Works</h2>
                  <p className="section-kicker" style={{ marginTop: 6 }}>Simple steps to a cleaner community</p>
                </div>
                <div className="timeline">
                  {[
                    { icon: "report", title: "Report", text: "Snap a photo and add the location details in seconds." },
                    { icon: "rss_feed", title: "Track", text: "The report goes live in the public tracker as an active issue." },
                    { icon: "task_alt", title: "Reply Cleaned", text: "Anyone can reply with cleanup proof and a photo." },
                    { icon: "verified", title: "Verify", text: "Admin approves cleanup proof before the report moves to Cleaned." },
                  ].map(step => (
                    <div className="timeline-step" key={step.title}>
                      <div className="timeline-icon"><Glyph name={ICON[step.icon]} size={22} /></div>
                      <h3 style={{ fontSize: 15, fontWeight: 900, marginBottom: 4 }}>{step.title}</h3>
                      <p style={{ color: "#3C4A42", fontSize: 14, lineHeight: 1.55 }}>{step.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section ref={dashboardReportsRef} className="page-section" style={{ scrollMarginTop: 80 }}>
              <div style={{ marginBottom: 28 }}>
                <h2 className="section-title">Live Garbage Tracker</h2>
                <p className="section-kicker" style={{ marginTop: 8 }}>{activeReports.length} active · {cleanedReports.length} cleaned · {uCons} areas covered</p>
              </div>
              <div className="desk-2col">
                <div>
                  <div className="card" style={{ marginBottom: 18 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                      <div>
                        <h3 style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, fontWeight: 800 }}>Garbage Reports</h3>
                        <p style={{ color: "#3C4A42", fontSize: 13 }}>{feedTab === "active" ? "Open issues waiting for cleanup" : "Admin-verified cleaned reports"}</p>
                      </div>
                      <button className="btn-p" onClick={goToReport} style={{ padding: "10px 14px", fontSize: 13 }}>+ New Report</button>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 14, background: "#E8F0E9", border: "1px solid #BBCABF", borderRadius: 12, padding: 4 }}>
                      {[
                        { id: "active", label: `Active (${activeReports.length})` },
                        { id: "cleaned", label: `Cleaned (${cleanedReports.length})` },
                      ].map(tab => (
                        <button key={tab.id} onClick={() => setFeedTab(tab.id)} style={{
                          flex: 1, padding: "10px 8px", borderRadius: 8, border: "none",
                          background: feedTab === tab.id ? (tab.id === "active" ? "#006C49" : "#10B981") : "transparent",
                          color: feedTab === tab.id ? "#fff" : "#3C4A42",
                          fontFamily: "inherit", fontWeight: 800, fontSize: 13, cursor: "pointer",
                        }}>{tab.label}</button>
                      ))}
                    </div>
                    <div className="form-2col" style={{ marginBottom: 10 }}>
                      <input className="inp" placeholder="Filter by area, landmark, district" value={feedFilters.place} onChange={e => setFeedFilters(f => ({ ...f, place: e.target.value }))} />
                      <Select label="waste type" placeholder="All waste types" clearable value={feedFilters.wasteType} options={WASTE_OPTIONS} onChange={wasteType => setFeedFilters(f => ({ ...f, wasteType }))} />
                    </div>
                    <Select label="date range" placeholder="Any time" clearable value={feedFilters.dateRange} options={DATE_OPTIONS} onChange={dateRange => setFeedFilters(f => ({ ...f, dateRange }))} />
                  </div>
                  {loadingRep ? <Spinner /> : dashboardTabReports.length === 0 ? (
                    <div className="card" style={{ textAlign: "center", padding: "44px 16px" }}>
                      <div style={{ marginBottom: 8, color: "#006C49" }}><Glyph name={feedTab === "active" ? "pin" : "checkCircle"} size={34} /></div>
                      <p style={{ color: "#3C4A42", fontSize: 14 }}>No {feedTab} reports for this filter.</p>
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {dashboardTabReports.slice(0, feedVisible).map(r => (
                        <ReportCard
                          key={r.id}
                          r={r}
                          expanded
                          onClick={() => setSelReport(r)}
                    onPhoto={setZoomPhoto}
                          showCleanupAction={feedTab === "active"}
                          cleanupOpen={cleanupOpenId === r.id}
                          onToggleCleanup={() => setCleanupOpenId(id => id === r.id ? "" : r.id)}
                          onCleanupSubmitted={() => {
                            setCleanupOpenId("");
                            loadPublicReports(feedFilters);
                          }}
                        />
                      ))}
                      {dashboardTabReports.length > feedVisible && (
                        <button className="btn-p" onClick={() => setFeedVisible(n => n + 5)} style={{ alignSelf: "center", marginTop: 4 }}>
                          Load more
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <aside className="desk-sticky">
                  <div className="card">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 900 }}>Districts Needing Action</h3>
                    </div>
                    {!loadingRep && actionDistricts.length === 0
                      ? <p style={{ color: "#3C4A42", fontSize: 13 }}>No district needs extra attention right now.</p>
                      : !loadingRep ? actionDistricts.map(([name, data], i) => (
                        <div key={name} style={{ marginBottom: i < actionDistricts.length - 1 ? 14 : 0 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                            <span style={{ fontWeight: 800, fontSize: 13 }}>{name}</span>
                            <span style={{ fontSize: 12, color: "#006C49", fontWeight: 900 }}>{data.count}</span>
                          </div>
                          <div className="pbar"><div className="pfill" style={{ width: `${(data.count / actionDistricts[0][1].count) * 100}%` }} /></div>
                        </div>
                      )) : null}
                  </div>
                </aside>
              </div>
            </section>

            <section ref={aboutRef} className="page-section" style={{ scrollMarginTop: 80 }}>
              <div style={{ marginBottom: 28 }}>
                <h2 className="section-title">Modern Civic Tools</h2>
                <p className="section-kicker" style={{ marginTop: 8 }}>Designed for citizens who want to keep their neighborhoods clean.</p>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginBottom: 28 }}>
                {[
                  { icon: "bolt", title: "Simplicity First", text: "Anonymous reporting with a clear photo, location, and waste type." },
                  { icon: "schedule", title: "Real-time Status", text: "Reports are visible as Active and move to Cleaned after admin-approved proof." },
                  { icon: "visibility", title: "Public Transparency", text: "A public feed makes garbage issues easier to track across Assam." },
                ].map(feature => (
                  <div className="feature-card" key={feature.title}>
                    <div className="feature-icon"><Glyph name={ICON[feature.icon]} size={24} /></div>
                    <h3 style={{ fontSize: 15, fontWeight: 900, marginBottom: 8 }}>{feature.title}</h3>
                    <p style={{ color: "#3C4A42", fontSize: 14, lineHeight: 1.55 }}>{feature.text}</p>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                {[
                  { icon: "dashboard", title: "Monitor Real Data", text: "Moderate live reports and verify cleanup proof submissions." },
                  { icon: "analytics", title: "Action Analytics", text: "Identify districts where active garbage reports are piling up." },
                ].map(feature => (
                  <div className="feature-card dark-feature" key={feature.title}>
                    <div className="feature-icon" style={{ background: "#10B981", color: "#00422B" }}><Glyph name={ICON[feature.icon]} size={24} /></div>
                    <h3 style={{ fontSize: 15, fontWeight: 900, marginBottom: 8 }}>{feature.title}</h3>
                    <p style={{ color: "#CBD5E1", fontSize: 14, lineHeight: 1.55 }}>{feature.text}</p>
                  </div>
                ))}
              </div>
            </section>

            <SupportJaborSection />

          </div>
        )}

        {/* REPORT FORM */}
        {view === "report" && !submitted && (
          <div className={"slide-in" + (form.anonymous ? " incognito" : "")} style={{ maxWidth: 600, margin: "0 auto" }}>
            <div style={{ marginBottom: 14, color: form.anonymous ? "#E8F0E9" : undefined }}>
              <button type="button" className="back-link" style={{ color: form.anonymous ? "#8CA394" : undefined }} onClick={() => { setAppView("dashboard"); setTimeout(() => window.scrollTo({ top: 0, behavior: "auto" }), 0); }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
                Back to dashboard
              </button>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 4 }}>Report Garbage</h1>
              <p style={{ color: form.anonymous ? "#8CA394" : "#3C4A42", fontSize: 13 }}>30 seconds · Helps track garbage reports across Assam.</p>
            </div>

            {/* Anonymous mode toggle - top of the form. */}
            <div className="incognito-bar">
              <div className="incognito-copy">
                <span className="incognito-copy-icon">
                  {form.anonymous
                    ? <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="12" fill="#E8F0E9" />
                        <g fill="#161D19">
                          <path d="M8.5 8 L9.2 4.4 C9.35 3.6 10.1 3.35 10.9 3.6 L11.6 3.85 C11.85 3.95 12.15 3.95 12.4 3.85 L13.1 3.6 C13.9 3.35 14.65 3.6 14.8 4.4 L15.5 8 Z" />
                          <rect x="5.4" y="8.7" width="13.2" height="1.9" rx="0.95" />
                          <circle cx="8.4" cy="14.4" r="2.7" />
                          <circle cx="15.6" cy="14.4" r="2.7" />
                          <path d="M10.7 13.7 C11.5 13.2 12.5 13.2 13.3 13.7 L13.1 14.7 C12.4 14.3 11.6 14.3 10.9 14.7 Z" />
                        </g>
                      </svg>
                    : <Glyph name="user" size={22} />}
                </span>
                <div>
                  <div className="incognito-title">{form.anonymous ? "Anonymous mode on" : "Reporting as yourself"}</div>
                  <div className="incognito-subtitle">{form.anonymous ? "We won't collect or store any of your details." : "Add your contact below to get updates."}</div>
                </div>
              </div>
              <label className="incognito-toggle">
                <span>Report anonymously?</span>
                <span className="switch">
                  <input type="checkbox" checked={form.anonymous}
                    onChange={e => setForm(f => ({
                      ...f,
                      anonymous: e.target.checked,
                      reporterName: e.target.checked ? "" : f.reporterName,
                      reporterEmail: e.target.checked ? "" : f.reporterEmail,
                    }))} />
                  <span className="slider" />
                </span>
              </label>
            </div>

            {/* Photo */}
            <div className="card" style={{
              marginBottom: 14, cursor: "pointer", textAlign: "center",
              border: form.photoPreview ? "1px solid #10B98166" : "2px dashed #BBCABF",
              minHeight: form.photoPreview ? "auto" : 120,
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: form.photoPreview ? 0 : 20, overflow: "hidden",
            }} onClick={() => fileRef.current.click()}>
              {form.photoPreview ? (
                <div style={{ position: "relative", width: "100%" }}>
                  <img src={form.photoPreview} alt="preview" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 14 }} />
                  <div style={{ position: "absolute", bottom: 8, right: 8, background: "#E8F0E9ee", borderRadius: 8, padding: "3px 10px", fontSize: 11, color: "#006C49", fontWeight: 800 }}>Change photo</div>
                </div>
              ) : (
                <div>
                  <div style={{ marginBottom: 6, color: "#006C49" }}><Glyph name="camera" size={30} /></div>
                  <div style={{ fontWeight: 700, color: "#006C49", marginBottom: 3 }}>Add a photo <span style={{ color: "#10B981" }}>*</span></div>
                  <div style={{ fontSize: 12, color: "#3C4A42" }}>Required · Tap to upload</div>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} onChange={onPhoto} />
            </div>

            {/* Location */}
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Location</div>
              <div style={{ marginBottom: 12 }}>
                <label className="lbl" id="district-label" htmlFor="district-select">DISTRICT <span style={{ color: "#10B981" }}>*</span></label>
                {loadingMlas
                  ? <div style={{ color: "#3C4A42", fontSize: 13, padding: "8px 0" }}>Loading districts…</div>
                  : <Select id="district-select" labelledBy="district-label" label="district" placeholder="Select district" value={form.district} options={districtOptions} onChange={district => setForm(f => ({ ...f, district, constituency: "", area: "", landmark: "", muniAnswer: "", wardChoice: "" }))} />}
              </div>
              {form.district && (
                <div style={{ marginBottom: 12 }}>
                  <label className="lbl" id="constituency-label" htmlFor="constituency-select">CONSTITUENCY <span style={{ color: "#10B981" }}>*</span></label>
                  <Select id="constituency-select" labelledBy="constituency-label" label="constituency" placeholder="Select constituency" value={form.constituency} options={constituencyOptions} onChange={constituency => setForm(f => ({ ...f, constituency, area: "", landmark: "", muniAnswer: "", wardChoice: "" }))} />
                </div>
              )}
              {askedMunicipality && (
                <MunicipalityQuestion
                  municipality={askedMunicipality}
                  answer={form.muniAnswer}
                  wardChoice={form.wardChoice}
                  onAnswer={muniAnswer => setForm(f => ({ ...f, muniAnswer, wardChoice: "" }))}
                  onWard={wardChoice => setForm(f => ({ ...f, wardChoice }))}
                />
              )}
              {form.constituency && (
                <>
                  <div className="form-2col" style={{ marginBottom: 12 }}>
                    <div>
                      <label className="lbl">AREA / LOCALITY <span style={{ color: "#10B981" }}>*</span></label>
                      <input className="inp" placeholder="e.g. Fancy Bazar" value={form.area} onChange={e => setForm(f => ({ ...f, area: e.target.value }))} />
                    </div>
                    <div>
                      <label className="lbl">LANDMARK <span style={{ color: "#64748B", fontWeight: 400 }}>(optional)</span></label>
                      <input className="inp" placeholder="e.g. Near SBI ATM" value={form.landmark} onChange={e => setForm(f => ({ ...f, landmark: e.target.value }))} />
                    </div>
                  </div>
                  <div style={{ padding: 12, background: "#E8F0E9", borderRadius: 12, border: "1px solid #BBCABF" }}>
                    <div style={{ fontSize: 10, color: "#006C49", fontFamily: "monospace", letterSpacing: ".06em", marginBottom: 8, fontWeight: 800 }}>REPORT LOCATION</div>
                    {loadingPrev
                      ? <div style={{ color: "#3C4A42", fontSize: 13 }}>Checking area details…</div>
                      : preview ? (
                        <div className="acc-grid">
                          {[
                            { label: "District", value: form.district, sub: "Selected district" },
                            { label: "Constituency", value: form.constituency, sub: "Selected area" },
                            { label: "MLA", value: preview.mla?.name || "Not mapped yet", sub: preview.mla?.party || "Leader mapping" },
                            { label: "MP", value: mpDisplay(preview.mp?.name, preview.mp?.lok_sabha_seat), sub: preview.mp?.party || "Leader mapping" },
                          ].map(p => (
                            <div key={p.label} style={{ padding: 10, background: "#FFFFFF", borderRadius: 10, border: "1px solid #DDE4DD" }}>
                              <div style={{ fontSize: 10, color: "#006C49", fontFamily: "monospace", marginBottom: 3, fontWeight: 800 }}>{p.label}</div>
                              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3, color: "#161D19" }}>{p.value}</div>
                              <div style={{ fontSize: 11, color: "#3C4A42", marginBottom: 6 }}>{p.sub}</div>
                            </div>
                          ))}
                        </div>
                      ) : <div style={{ color: "#3C4A42", fontSize: 13 }}>Area details not found.</div>}
                  </div>
                </>
              )}
            </div>

            {/* Waste type */}
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Waste Type</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {WASTE.map(w => (
                  <div key={w.id} className="chip"
                    style={{ background: form.waste_type === w.id ? w.color + "22" : "#F4FBF4", borderColor: form.waste_type === w.id ? w.color : "#BBCABF", color: form.waste_type === w.id ? w.color : "#3C4A42" }}
                    onClick={() => setForm(f => ({ ...f, waste_type: w.id }))}>
                    <WasteIcon type={w.id} size={15} /> {w.label}
                  </div>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>Description <span style={{ color: "#64748B", fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
              <textarea className="inp" placeholder="Where exactly? How bad? How long has it been there? (optional)" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>

            {/* Contact - hidden entirely in anonymous mode (we store nothing). */}
            {!form.anonymous && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="contact-card-head">
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Your Contact <span style={{ color: "#64748B", fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
                  <label className="anonymous-inline-toggle">
                    <span>Report anonymously?</span>
                    <span className="switch">
                      <input
                        type="checkbox"
                        checked={form.anonymous}
                        onChange={e => setForm(f => ({
                          ...f,
                          anonymous: e.target.checked,
                          reporterName: e.target.checked ? "" : f.reporterName,
                          reporterEmail: e.target.checked ? "" : f.reporterEmail,
                        }))}
                        aria-label="Report anonymously"
                      />
                      <span className="slider" />
                    </span>
                  </label>
                </div>
                <input className="inp" style={{ marginBottom: 8 }} placeholder="Name (optional)"
                  value={form.reporterName}
                  onChange={e => setForm(f => ({ ...f, reporterName: e.target.value }))} />
                <input className="inp" type="email" placeholder="Email - to get updates on your report"
                  value={form.reporterEmail}
                  onChange={e => setForm(f => ({ ...f, reporterEmail: e.target.value }))} />
                <p style={{ fontSize: 11, color: "#3C4A42", marginTop: 8 }}>Shared only with the admins - it won't show on the public dashboard.</p>
              </div>
            )}

            <TurnstileWidget onToken={onTurnstileToken} controlRef={turnstileRef} />

            <button className="btn-p" style={{ width: "100%", padding: 16, fontSize: 16 }} onClick={onSubmit} disabled={submitting}>
              {submitting && submitStep === "saving"    ? "Saving report…"    :
               submitting && submitStep === "uploading" ? "Optimizing & uploading photo…" :
               submitting                               ? "Please wait…"        : "Submit Report"}
            </button>
            <p style={{ textAlign: "center", fontSize: 11, color: "#3C4A42", marginTop: 10 }}>Your identity stays private · No login · Report data is public</p>
            <p style={{ textAlign: "center", fontSize: 11, color: form.anonymous ? "#8CA394" : "#3C4A42", marginTop: 4, lineHeight: 1.6 }}>
              By sending a report you agree to the <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: form.anonymous ? "#8CA394" : "#006C49", fontWeight: 700 }}>Terms and Conditions</a> and the <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: form.anonymous ? "#8CA394" : "#006C49", fontWeight: 700 }}>Privacy Policy</a>.
            </p>
          </div>
        )}

        {/* SUCCESS - 3s loading bar then redirect */}
        {view === "report" && submitted && (
          <SuccessScreen onDone={() => { setSubmitted(false); setAppView("dashboard"); }} />
        )}

        {/* FEED */}
        {view === "feed" && (
          <div className="slide-in">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div>
                <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Public Reports</h1>
                <p style={{ color: "#3C4A42", fontSize: 12, marginTop: 2 }}>{activeReports.length} active · {cleanedReports.length} cleaned · {uCons} constituencies</p>
              </div>
              <button className="btn-p" onClick={goToReport} style={{ padding: "10px 18px", fontSize: 13 }}>+ New</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, background: "#E8F0E9", border: "1px solid #BBCABF", borderRadius: 12, padding: 4 }}>
              {[
                { id: "active", label: `Active (${activeReports.length})` },
                { id: "cleaned", label: `Cleaned (${cleanedReports.length})` },
              ].map(tab => (
                <button key={tab.id} onClick={() => setFeedTab(tab.id)} style={{
                  flex: 1, padding: "10px 8px", borderRadius: 9, border: "none",
                  background: feedTab === tab.id ? (tab.id === "active" ? "#006C49" : "#10B981") : "transparent",
                  color: feedTab === tab.id ? "#fff" : "#3C4A42",
                  fontFamily: "inherit", fontWeight: 800, fontSize: 13, cursor: "pointer",
                }}>{tab.label}</button>
              ))}
            </div>
            <div className="card" style={{ marginBottom: 14, padding: 12 }}>
              <div className="form-2col" style={{ marginBottom: 10 }}>
                <input className="inp" placeholder="Filter by area, landmark, district" value={feedFilters.place} onChange={e => setFeedFilters(f => ({ ...f, place: e.target.value }))} />
                <Select label="waste type" placeholder="All waste types" clearable value={feedFilters.wasteType} options={WASTE_OPTIONS} onChange={wasteType => setFeedFilters(f => ({ ...f, wasteType }))} />
              </div>
              <div className="form-2col">
                <Select label="date range" placeholder="Any time" clearable value={feedFilters.dateRange} options={DATE_OPTIONS} onChange={dateRange => setFeedFilters(f => ({ ...f, dateRange }))} />
              </div>
            </div>
            {/* Disclaimer with sparkle effect */}
            <p style={{ fontSize: 12, color: "#3C4A42", marginBottom: 16 }}>
              Reports are public immediately. Cleanup replies appear here after admin approval.
            </p>
            {loadingRep ? <Spinner /> : displayedFeedReports.length === 0 ? (
              <div style={{ textAlign: "center", padding: 60 }}>
                <div style={{ marginBottom: 12, color: "#006C49" }}><Glyph name={feedTab === "active" ? "leaf" : "checkCircle"} size={42} /></div>
                <p style={{ color: "#3C4A42" }}>No {feedTab} reports yet.</p>
                <button className="btn-p" style={{ marginTop: 16 }} onClick={goToReport}>Report Garbage</button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {displayedFeedReports.slice(0, feedVisible).map(r => (
                  <ReportCard
                    key={r.id}
                    r={r}
                    expanded
                    onClick={() => setSelReport(r)}
                    onPhoto={setZoomPhoto}
                    showCleanupAction={feedTab === "active"}
                    cleanupOpen={cleanupOpenId === r.id}
                    onToggleCleanup={() => setCleanupOpenId(id => id === r.id ? "" : r.id)}
                    onCleanupSubmitted={() => {
                      setCleanupOpenId("");
                      loadPublicReports(feedFilters);
                    }}
                  />
                ))}
                {displayedFeedReports.length > feedVisible && (
                  <button className="btn-p" onClick={() => setFeedVisible(n => n + 5)} style={{ alignSelf: "center", marginTop: 4 }}>
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {view === "admin" && (
          <AdminDashboard onChanged={() => loadPublicReports(feedFilters)} />
        )}

        {zoomPhoto && <PhotoLightbox url={zoomPhoto} onClose={() => setZoomPhoto("")} />}

        {/* MODAL */}
        {selReport && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100 }}
            onClick={() => setSelReport(null)}>
            <div style={{ background: "#FFFFFF", border: "1px solid #DDE4DD", borderRadius: "20px 20px 0 0", padding: "20px 20px calc(20px + env(safe-area-inset-bottom,0px))", width: "100%", maxWidth: 540, maxHeight: "90vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ width: 36, height: 4, background: "#BBCABF", borderRadius: 2, margin: "0 auto 16px" }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: "#006C49", fontWeight: 800 }}>REPORT</span>
                <button onClick={() => setSelReport(null)} style={{ background: "none", border: "none", color: "#006C49", cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
              </div>
              {selReport.photo_url
                ? <button type="button" className="photo-zoom" style={{ marginBottom: 14 }} aria-label="Enlarge photo: garbage" onClick={() => setZoomPhoto(selReport.photo_url)}><img src={selReport.photo_url} alt="garbage" style={{ width: "100%", borderRadius: 12, maxHeight: 260, objectFit: "cover" }} /></button>
                : <div style={{ width: "100%", borderRadius: 12, marginBottom: 14, minHeight: 140, background: "#E8F0E9", border: "1px solid #BBCABF", color: "#3C4A42", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800 }}>No report image</div>}
              {selReport.cleanup_photo_url && <button type="button" className="photo-zoom" style={{ marginBottom: 14 }} aria-label="Enlarge photo: approved cleanup proof" onClick={() => setZoomPhoto(selReport.cleanup_photo_url)}><img src={selReport.cleanup_photo_url} alt="approved cleanup proof" style={{ width: "100%", borderRadius: 12, maxHeight: 260, objectFit: "cover", border: "2px solid #10B981" }} /></button>}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <WIcon type={selReport.waste_type} size={18} />
                <span style={{ fontWeight: 700, fontSize: 15 }}>{selReport.constituency}</span>
                <span style={{ color: "#3C4A42", fontSize: 12 }}>· {selReport.district}</span>
              </div>
              {(selReport.area || selReport.landmark) && <div style={{ fontSize: 12, color: "#3C4A42", marginBottom: 10 }}><Glyph name="pin" size={13} /> {[selReport.area, selReport.landmark].filter(Boolean).join(" · ")}</div>}
              {(() => { const w = WASTE.find(t => t.id === selReport.waste_type); return w ? <span style={{ background: w.color + "20", color: w.color, border: `1px solid ${w.color}40`, padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, display: "inline-block", marginBottom: 12 }}><WasteIcon type={w.id} size={15} /> {w.label}</span> : null; })()}
              <p style={{ color: "#161D19", fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>{selReport.description}</p>
              <div style={{ padding: 12, background: "#E8F0E9", borderRadius: 12, border: "1px solid #BBCABF" }}>
                <div style={{ fontSize: 10, color: "#006C49", fontFamily: "monospace", marginBottom: 10, fontWeight: 800 }}>REPORT DETAILS</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><div style={{ fontSize: 11, color: "#3C4A42" }}>District</div><div style={{ fontWeight: 700, fontSize: 13 }}>{selReport.district || "Unknown"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#3C4A42" }}>Area</div><div style={{ fontWeight: 700, fontSize: 13 }}>{selReport.constituency || "Unknown"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#3C4A42" }}>Waste type</div><div style={{ fontWeight: 700, fontSize: 13 }}>{WASTE.find(t => t.id === selReport.waste_type)?.label || selReport.waste_type}</div></div>
                  <div><div style={{ fontSize: 11, color: "#3C4A42" }}>MLA</div><div style={{ fontWeight: 700, fontSize: 13 }}>{selReport.mla || "Not mapped yet"}</div></div>
                  <div style={{ gridColumn: "1 / -1" }}><div style={{ fontSize: 11, color: "#3C4A42" }}>MP</div><div style={{ fontWeight: 700, fontSize: 13 }}>{mpDisplay(selReport.mp, selReport.lok_sabha_seat)}</div></div>
                </div>
              </div>
              <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#3C4A42" }}>Status: <strong style={{ color: selReport.status === "cleaned" ? "#10B981" : "#006C49" }}>{selReport.status === "verified" ? "active" : selReport.status}</strong></span>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* FIX 3: Footer on ALL screens/tabs */}
      <Footer onAbout={() => scrollToSection(aboutRef)} onHowItWorks={() => scrollToSection(howItWorksRef)} onSupport={goToSupport} />
    </div>
  );
}
