import { useState, useEffect, useRef } from "react";
import "/style.css";

// ============================================================
// SUPABASE CONFIG
// ============================================================
const SUPA_URL = "https://fgbcfhlrdyexsdbldcmn.supabase.co";
const KEY      = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZnYmNmaGxyZHlleHNkYmxkY21uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MjA3NDQsImV4cCI6MjA5MTQ5Njc0NH0.2n3g-F-VBpsKNY0QUc7JdheMaIwf5ln6qiFyEakBW80";
const H        = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const LOGO     = "/jabor-logo-2.png";

// ============================================================
// DB LAYER — all errors handled gracefully
// ============================================================
const db = {
  async getMlas() {
    try {
      const res = await fetch(
        `${SUPA_URL}/rest/v1/mla_list?select=*&order=district.asc,constituency.asc`,
        { headers: H }
      );
      return res.ok ? res.json() : [];
    } catch { return []; }
  },

  async getMla(constituency) {
    try {
      const res = await fetch(
        `${SUPA_URL}/rest/v1/mla_list?constituency=eq.${encodeURIComponent(constituency)}&select=*&limit=1`,
        { headers: H }
      );
      const d = res.ok ? await res.json() : [];
      return d[0] || null;
    } catch { return null; }
  },

  async getMp(seat) {
    try {
      const res = await fetch(
        `${SUPA_URL}/rest/v1/mp_list?lok_sabha_seat=eq.${encodeURIComponent(seat)}&select=*&limit=1`,
        { headers: H }
      );
      const d = res.ok ? await res.json() : [];
      return d[0] || null;
    } catch { return null; }
  },

  async getReports() {
    try {
      const res = await fetch(
        `${SUPA_URL}/rest/v1/public_reports?limit=200`,
        { headers: H }
      );
      return res.ok ? res.json() : [];
    } catch { return []; }
  },

  async insertReport(data) {
    try {
      const res = await fetch(`${SUPA_URL}/rest/v1/reports`, {
        method:  "POST",
        headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation" },
        body:    JSON.stringify(data),
      });
      const d = await res.json();
      return res.ok ? d[0] : null;
    } catch { return null; }
  },

  // ── PHOTO UPLOAD — fixed: correct bucket path + error logging
  async uploadPhoto(file, reportId) {
    try {
      const ext  = file.name.split(".").pop().toLowerCase();
      const path = `reports/${reportId}_${Date.now()}.${ext}`;
      const res  = await fetch(
        `${SUPA_URL}/storage/v1/object/garbage-photos/${path}`,
        {
          method:  "POST",
          headers: {
            apikey:        KEY,
            Authorization: `Bearer ${KEY}`,
            "Content-Type": file.type || "image/jpeg",
          },
          body: file,
        }
      );
      if (!res.ok) {
        const err = await res.text();
        console.error("Photo upload failed:", err);
        return null;
      }
      return `${SUPA_URL}/storage/v1/object/public/garbage-photos/${path}`;
    } catch (e) {
      console.error("Photo upload error:", e);
      return null;
    }
  },

  async patchPhoto(id, photo_url) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/reports?id=eq.${id}`, {
        method:  "PATCH",
        headers: { ...H, "Content-Type": "application/json" },
        body:    JSON.stringify({ photo_url }),
      });
    } catch { /* silent */ }
  },
};

// ============================================================
// CONSTANTS
// ============================================================
const WASTE = [
  { id: "mixed",        label: "Mixed Waste",         icon: "🗑️", color: "#9CA3AF" },
  { id: "plastic",      label: "Plastic",             icon: "🧴", color: "#3B82F6" },
  { id: "construction", label: "Construction Debris", icon: "🧱", color: "#D97706" },
  { id: "organic",      label: "Organic / Food",      icon: "🍂", color: "#10B981" },
  { id: "water",        label: "Water Body Dump",     icon: "💧", color: "#0EA5E9" },
  { id: "medical",      label: "Medical / Hazardous", icon: "⚠️", color: "#EF4444" },
];

const PARTY_CLR = {
  BJP: "#FF6B2B", INC: "#1A6CBD", AIUDF: "#059669",
  AGP: "#7C3AED", UPPL: "#D97706", BPF: "#DB2777", "RAIJOR DAL": "#DC2626",
};

const NAV = [
  { id: "dashboard", icon: "📊", label: "Dashboard" },
  { id: "report",    icon: "📸", label: "Report"    },
  { id: "feed",      icon: "📋", label: "Reports"   },
];

// ============================================================
// SMALL COMPONENTS
// ============================================================
function Badge({ party }) {
  const c = PARTY_CLR[party] || "#9CA3AF";
  return (
    <span style={{
      background: c + "22", color: c, border: `1px solid ${c}44`,
      padding: "2px 8px", borderRadius: 4, fontSize: 11,
      fontWeight: 700, fontFamily: "monospace", whiteSpace: "nowrap",
    }}>{party}</span>
  );
}

function TimeAgo({ date }) {
  const ms = Date.now() - new Date(date).getTime();
  const h  = Math.floor(ms / 3600000);
  const d  = Math.floor(h / 24);
  return <span>{d > 0 ? `${d}d` : h > 0 ? `${h}h` : "now"} ago</span>;
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 32 }}>
      <div style={{ width: 28, height: 28, border: "3px solid #F0D9A0", borderTopColor: "#E36A6A", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
    </div>
  );
}

function WIcon({ type, size = 16 }) {
  const w = WASTE.find(t => t.id === type) || WASTE[0];
  return <span style={{ fontSize: size }}>{w.icon}</span>;
}

function MapDots({ reports }) {
  const tx = lng => ((lng - 89.7) / 6.3) * 380;
  const ty = lat => ((28.2 - lat) / 4.1) * 180;
  const gps = reports.filter(r => r.lat && r.lng);
  const nogps = reports.filter(r => !r.lat || !r.lng);
  return (
    <svg viewBox="0 0 380 180" style={{ width: "100%", height: "100%" }}>
      <path d="M55,158 L38,142 L28,118 L44,92 L72,74 L108,56 L144,46 L180,42 L228,40 L274,46 L312,56 L340,74 L350,100 L340,126 L320,144 L294,155 L260,163 L224,168 L184,170 L144,166 L108,162 L74,160 Z"
        fill="#F5E0C0" stroke="#E36A6A" strokeWidth="1.2" />
      {gps.map((r, i) => {
        const w = WASTE.find(t => t.id === r.waste_type);
        return (
          <circle key={i} cx={tx(r.lng)} cy={ty(r.lat)} r={5} fill={w?.color || "#EF4444"} opacity={0.85}>
            <animate attributeName="r" values="5;7;5" dur="2s" repeatCount="indefinite" begin={`${i * .3}s`} />
          </circle>
        );
      })}
      {nogps.map((r, i) => {
        const w = WASTE.find(t => t.id === r.waste_type);
        return <circle key={`n${i}`} cx={70 + (i * 43) % 240} cy={60 + (i * 31) % 100} r={4} fill={w?.color || "#EF4444"} opacity={0.4} />;
      })}
    </svg>
  );
}

function ReportCard({ r, expanded, onClick }) {
  const w = WASTE.find(t => t.id === r.waste_type) || WASTE[0];
  return (
    <div className="rcard" onClick={onClick}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: w.color + "20", border: `1px solid ${w.color}40`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
          {w.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{r.constituency}</span>
            <span style={{ color: "#b87a5a", fontSize: 12 }}>· {r.district}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#b87a5a", fontFamily: "monospace" }}><TimeAgo date={r.created_at} /></span>
          </div>
          {(r.area || r.landmark) && (
            <p style={{ fontSize: 11, color: "#b87a5a", marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              📍 {[r.area, r.landmark].filter(Boolean).join(" · ")}
            </p>
          )}
          <p style={{ fontSize: 13, color: "#5C3A1E", marginBottom: 7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: expanded ? "normal" : "nowrap" }}>{r.description}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#b87a5a" }}>MLA:</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{r.mla}</span><Badge party={r.mla_party} />
            <span style={{ color: "#F0D9A0" }}>·</span>
            <span style={{ fontSize: 11, color: "#b87a5a" }}>MP:</span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{r.mp}</span><Badge party={r.mp_party} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// BOARD OF SHAME
// ============================================================
function ShameBoard({ reports }) {
  const [tab, setTab] = useState("mla");

  const mlaMap = {};
  reports.forEach(r => {
    const k = `${r.mla}||${r.mla_party}||${r.constituency}||${r.district}`;
    if (!mlaMap[k]) mlaMap[k] = { name: r.mla, party: r.mla_party, constituency: r.constituency, district: r.district, count: 0 };
    mlaMap[k].count++;
  });

  const mpMap = {};
  reports.forEach(r => {
    const k = `${r.mp}||${r.mp_party}||${r.lok_sabha_seat}`;
    if (!mpMap[k]) mpMap[k] = { name: r.mp, party: r.mp_party, seat: r.lok_sabha_seat, count: 0, areas: new Set() };
    mpMap[k].count++;
    mpMap[k].areas.add(r.constituency);
  });

  const mlaRank = Object.values(mlaMap).sort((a, b) => b.count - a.count);
  const mpRank  = Object.values(mpMap).map(m => ({ ...m, areas: m.areas.size })).sort((a, b) => b.count - a.count);
  const ranking = tab === "mla" ? mlaRank : mpRank;
  const maxC    = ranking[0]?.count || 1;
  const medals  = ["🥇", "🥈", "🥉"];

  const shame = n => {
    if (n >= 10) return { label: "Chronic Offender",   color: "#DC2626", bg: "#FEE2E2" };
    if (n >= 5)  return { label: "Persistent Problem", color: "#D97706", bg: "#FEF3C7" };
    if (n >= 2)  return { label: "Needs Attention",    color: "#b87a5a", bg: "#FFF2D0" };
    return               { label: "Reported",           color: "#9CA3AF", bg: "#F3F4F6" };
  };

  if (!reports.length) return (
    <div style={{ textAlign: "center", padding: "32px 16px" }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>🏴</div>
      <p style={{ color: "#b87a5a", fontSize: 14 }}>No reports yet. Submit the first one to start the board.</p>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, background: "#FFF2D0", borderRadius: 12, padding: 4 }}>
        {[{ id: "mla", label: "🏛️ MLAs" }, { id: "mp", label: "🏟️ MPs" }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: "10px 8px", borderRadius: 9, border: "none",
            background: tab === t.id ? "#E36A6A" : "transparent",
            color: tab === t.id ? "#fff" : "#b87a5a",
            fontFamily: "inherit", fontWeight: 700, fontSize: 13, cursor: "pointer",
          }}>{t.label}</button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {ranking.map((p, i) => {
          const lv = shame(p.count);
          return (
            <div key={i} className="card" style={{ padding: "14px 14px" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ width: 36, height: 36, borderRadius: 9, background: i < 3 ? "#E36A6A" : "#F0D9A0", color: i < 3 ? "#fff" : "#b87a5a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: i < 3 ? 17 : 12, fontWeight: 700, flexShrink: 0 }}>
                  {i < 3 ? medals[i] : `#${i + 1}`}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 4 }}>
                    <span style={{ fontWeight: 800, fontSize: 14 }}>{p.name}</span>
                    <Badge party={p.party} />
                    <span style={{ background: lv.bg, color: lv.color, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, marginLeft: "auto" }}>{lv.label}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#b87a5a", marginBottom: 8 }}>
                    {tab === "mla" ? `${p.constituency} · ${p.district}` : `${p.seat} Lok Sabha · ${p.areas} areas affected`}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>
                      {Array.from({ length: Math.min(p.count, 5) }).map((_, j) => <span key={j}>🗑️</span>)}
                      {p.count > 5 && <span style={{ fontSize: 11, color: "#E36A6A", fontWeight: 700, marginLeft: 4 }}>+{p.count - 5}</span>}
                    </span>
                    <span style={{ fontSize: 12, fontFamily: "monospace", color: "#E36A6A", fontWeight: 700 }}>{p.count} report{p.count !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="pbar"><div className="pfill" style={{ width: `${(p.count / maxC) * 100}%` }} /></div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function Jabor() {
  const [view,         setView]         = useState("dashboard");
  const [reports,      setReports]      = useState([]);
  const [mlaList,      setMlaList]      = useState([]);
  const [loadingRep,   setLoadingRep]   = useState(true);
  const [loadingMlas,  setLoadingMlas]  = useState(true);
  const [submitting,   setSubmitting]   = useState(false);
  const [submitted,    setSubmitted]    = useState(false);
  const [selReport,    setSelReport]    = useState(null);
  const [preview,      setPreview]      = useState(null);   // { mla, mp }
  const [loadingPrev,  setLoadingPrev]  = useState(false);
  const [form, setForm] = useState({
    district: "", constituency: "", area: "", landmark: "",
    waste_type: "mixed", description: "",
    photo: null, photoPreview: null,
  });
  const fileRef = useRef();

  useEffect(() => { document.title = "Jabor — Assam Garbage Tracker"; }, []);

  useEffect(() => {
    db.getReports().then(d => { setReports(Array.isArray(d) ? d : []); setLoadingRep(false); });
    db.getMlas().then(d    => { setMlaList(Array.isArray(d) ? d : []);  setLoadingMlas(false); });
  }, []);

  const districts   = [...new Set(mlaList.map(m => m.district))].sort();
  const consForDist = mlaList.filter(m => m.district === form.district).sort((a, b) => a.constituency.localeCompare(b.constituency));

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
    const r = new FileReader();
    r.onload = ev => setForm(p => ({ ...p, photo: f, photoPreview: ev.target.result }));
    r.readAsDataURL(f);
  };

  const onSubmit = async () => {
    if (!form.district || !form.constituency || !form.area.trim() || !form.description.trim()) {
      alert("Please fill District, Constituency, Area and Description."); return;
    }
    if (!preview) { alert("Politician data still loading — please wait."); return; }
    setSubmitting(true);

    const payload = {
      district:       form.district,
      constituency:   form.constituency,
      lok_sabha_seat: preview.mla?.lok_sabha_seat || "",
      mla:            preview.mla?.name  || "Unknown",
      mla_party:      preview.mla?.party || "Unknown",
      mp:             preview.mp?.name   || "Unknown",
      mp_party:       preview.mp?.party  || "Unknown",
      area:           form.area.trim(),
      landmark:       form.landmark.trim(),
      waste_type:     form.waste_type,
      description:    form.description.trim(),
      lat: null, lng: null, photo_url: null, status: "open", is_deleted: false,
    };

    const saved = await db.insertReport(payload);

    // ── Upload photo AFTER we have the report ID
    if (saved && form.photo) {
      const url = await db.uploadPhoto(form.photo, saved.id);
      if (url) {
        await db.patchPhoto(saved.id, url);
        saved.photo_url = url;
      }
    }

    if (saved) setReports(prev => [{ ...payload, ...saved }, ...prev]);

    setSubmitting(false); setSubmitted(true); setPreview(null);
    setForm({ district: "", constituency: "", area: "", landmark: "", waste_type: "mixed", description: "", photo: null, photoPreview: null });
    setTimeout(() => { setSubmitted(false); setView("dashboard"); }, 3000);
  };

  const total  = reports.length;
  const uCons  = [...new Set(reports.map(r => r.constituency))].length;
  const week   = reports.filter(r => Date.now() - new Date(r.created_at).getTime() < 7 * 864e5).length;
  const cMap   = {};
  reports.forEach(r => {
    if (!cMap[r.constituency]) cMap[r.constituency] = { count: 0, mla: r.mla, party: r.mla_party, district: r.district };
    cMap[r.constituency].count++;
  });
  const topC = Object.entries(cMap).sort((a, b) => b[1].count - a[1].count).slice(0, 5);

  // ============================================================
  return (
    <div style={{ fontFamily: "'Sora','DM Sans',sans-serif", background: "#FFFBF1", minHeight: "100vh", color: "#2D1A0E" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800;900&family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #FFFBF1; -webkit-font-smoothing: antialiased; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #E36A6A; border-radius: 2px; }

        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes pulse   { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.8)} }
        @keyframes slideIn { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes popIn   { from{opacity:0;transform:scale(.85)} to{opacity:1;transform:scale(1)} }

        .slide-in { animation: slideIn .35s ease; }
        .pop-in   { animation: popIn .4s cubic-bezier(.34,1.56,.64,1); }

        /* ── CARDS ── */
        .card { background:#FFF2D0; border:1px solid #F0D9A0; border-radius:16px; padding:18px; }

        /* ── BUTTONS ── */
        .btn-p {
          background: linear-gradient(135deg,#E36A6A,#c94f4f); color:#fff;
          border:none; border-radius:12px; padding:14px 24px;
          font-family:'Sora',sans-serif; font-weight:700; font-size:15px;
          cursor:pointer; transition:all .2s; box-shadow:0 4px 16px rgba(227,106,106,.3);
          white-space:nowrap; touch-action:manipulation;
        }
        .btn-p:hover  { transform:translateY(-1px); box-shadow:0 6px 22px rgba(227,106,106,.4); }
        .btn-p:active { transform:scale(.97); }
        .btn-p:disabled { opacity:.55; cursor:not-allowed; transform:none; }
        .btn-s {
          background:transparent; color:#E36A6A; border:1.5px solid #FFB2B2;
          border-radius:12px; padding:11px 20px;
          font-family:'Sora',sans-serif; font-weight:600; font-size:14px;
          cursor:pointer; transition:all .2s; white-space:nowrap; touch-action:manipulation;
        }
        .btn-s:hover  { border-color:#E36A6A; background:#FFE8E8; }
        .btn-s:active { transform:scale(.97); }

        /* ── INPUTS ── */
        .inp {
          width:100%; background:#FFFBF1; border:1.5px solid #F0D9A0;
          border-radius:12px; padding:13px 14px; color:#2D1A0E;
          font-family:'DM Sans',sans-serif; font-size:16px; outline:none;
          transition:border-color .2s; -webkit-appearance:none;
        }
        .inp:focus { border-color:#E36A6A; }
        .inp option { background:#FFF2D0; color:#2D1A0E; }
        select.inp { cursor:pointer; }
        textarea.inp { resize:vertical; min-height:92px; }

        /* ── LABEL ── */
        .lbl { font-size:11px; font-weight:700; color:#b87a5a; display:block; margin-bottom:6px; font-family:monospace; letter-spacing:.06em; }

        /* ── REPORT CARDS ── */
        .rcard {
          background:#FFF2D0; border:1px solid #F0D9A0; border-radius:14px;
          padding:14px; cursor:pointer; transition:all .2s; touch-action:manipulation;
        }
        .rcard:active { transform:scale(.985); }
        @media(hover:hover) {
          .rcard:hover { border-color:#E36A6A; transform:translateY(-1px); box-shadow:0 4px 14px rgba(227,106,106,.12); }
        }

        /* ── MISC ── */
        .pbar  { height:3px; border-radius:2px; background:#F0D9A0; overflow:hidden; margin-top:8px; }
        .pfill { height:100%; border-radius:2px; background:linear-gradient(90deg,#E36A6A,#FFB2B2); transition:width .5s; }
        .pulse-dot { width:7px; height:7px; border-radius:50%; background:#E36A6A; display:inline-block; animation:pulse 2s infinite; }
        .chip {
          display:inline-flex; align-items:center; gap:5px; padding:8px 12px;
          border-radius:10px; font-size:13px; font-weight:600; cursor:pointer;
          transition:all .15s; border:2px solid transparent; touch-action:manipulation;
        }
        .chip:active { transform:scale(.95); }

        /* ── DESKTOP NAV ── */
        .desk-nav { display:flex; gap:4px; }
        .nav-btn  {
          padding:9px 16px; border-radius:10px; border:none; background:transparent;
          color:#b87a5a; font-family:'Sora',sans-serif; font-weight:600; font-size:13px;
          cursor:pointer; transition:all .2s; white-space:nowrap;
        }
        .nav-btn.on  { background:#FFB2B2; color:#7A1A1A; }
        .nav-btn:hover:not(.on) { color:#E36A6A; }

        /* ── MOBILE BOTTOM NAV ── */
        .mob-nav {
          display:none; position:fixed; bottom:0; left:0; right:0;
          background:#FFFBF1; border-top:1.5px solid #F0D9A0;
          padding:6px 0 env(safe-area-inset-bottom, 10px);
          z-index:60; justify-content:space-around; align-items:center;
        }
        .mob-btn {
          display:flex; flex-direction:column; align-items:center; gap:2px;
          padding:6px 16px; border:none; background:transparent;
          color:#b87a5a; font-family:'Sora',sans-serif; font-size:10px;
          font-weight:600; cursor:pointer; border-radius:10px; touch-action:manipulation;
          transition:color .15s;
        }
        .mob-btn.on   { color:#E36A6A; }
        .mob-btn span:first-child { font-size:22px; }

        /* ── FAB REPORT BUTTON (mobile) ── */
        .fab {
          display:none; position:fixed; bottom:80px; right:20px; z-index:55;
          width:56px; height:56px; border-radius:50%;
          background:linear-gradient(135deg,#E36A6A,#c94f4f);
          border:none; color:#fff; font-size:24px; cursor:pointer;
          box-shadow:0 4px 20px rgba(227,106,106,.45); touch-action:manipulation;
          align-items:center; justify-content:center;
        }
        .fab:active { transform:scale(.93); }

        /* ── STATS ── */
        .stats-row { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:20px; }
        .stat-n { font-family:'Sora',sans-serif; font-size:32px; font-weight:800; color:#E36A6A; line-height:1; }

        /* ── DESKTOP 2-COL ── */
        .desk-2col { display:grid; grid-template-columns:1fr 320px; gap:22px; align-items:start; }
        .desk-sticky { position:sticky; top:74px; }

        /* ── FORM GRID ── */
        .form-2col { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .acc-grid  { display:grid; grid-template-columns:1fr 1fr; gap:8px;  }

        /* ── RESPONSIVE ── */
        @media (max-width: 860px) {
          .desk-2col { grid-template-columns:1fr; }
          .desk-sticky { position:static; }
        }
        @media (max-width: 640px) {
          .desk-nav { display:none !important; }
          .mob-nav  { display:flex !important; }
          .fab      { display:flex !important; }
          .main-wrap { padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px)) !important; }
          .stats-row { grid-template-columns:repeat(3,1fr); }
          .stat-n { font-size:26px; }
          .form-2col { grid-template-columns:1fr; }
          .acc-grid  { grid-template-columns:1fr; }
          .hero-h1   { font-size:28px !important; }
          .hero-btns { flex-direction:column; }
          .hero-btns .btn-p, .hero-btns .btn-s { width:100%; text-align:center; }
          .card { padding:14px; border-radius:14px; }
          .inp  { font-size:16px; } /* prevent iOS zoom */
        }
        @media (max-width: 380px) {
          .stats-row { grid-template-columns:1fr 1fr; }
        }
      `}</style>

      {/* ── STICKY HEADER ── */}
      <header style={{ background: "#FFFBF1", borderBottom: "1px solid #F0D9A0", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, padding: "0 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => setView("dashboard")}>
            <img src={LOGO} alt="Jabor" style={{ width: 42, height: 42, objectFit: "contain" }} />
            <div>
              <div style={{ fontWeight: 900, fontSize: 19, letterSpacing: "-0.05em", color: "#D9534F", lineHeight: 1, textTransform: "uppercase" }}>JABOR</div>
              <div style={{ fontSize: 10, fontWeight: 500, color: "#D9534F", opacity: .7, letterSpacing: "0.02em" }}>Garbage Tracker</div>
            </div>
          </div>
          <nav className="desk-nav">
            {NAV.map(v => (
              <button key={v.id} className={`nav-btn ${view === v.id ? "on" : ""}`} onClick={() => setView(v.id)}>
                {v.icon} {v.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ── MOBILE BOTTOM NAV ── */}
      <nav className="mob-nav">
        {NAV.map(v => (
          <button key={v.id} className={`mob-btn ${view === v.id ? "on" : ""}`} onClick={() => setView(v.id)}>
            <span>{v.icon}</span><span>{v.label}</span>
          </button>
        ))}
      </nav>

      {/* ── FAB ── */}
      {view !== "report" && (
        <button className="fab" onClick={() => setView("report")} aria-label="Report garbage">📸</button>
      )}

      <main className="main-wrap" style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 16px" }}>

        {/* ══ DASHBOARD ══ */}
        {view === "dashboard" && (
          <div className="slide-in">
            <div className="desk-2col" style={{ marginBottom: 22 }}>
              {/* LEFT */}
              <div>
                <h1 className="hero-h1" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1.15, letterSpacing: "-0.03em", marginBottom: 6 }}>
                  Hold <span style={{ color: "#E36A6A" }}>them</span><br />accountable.
                </h1>
                <p style={{ fontSize: 15, color: "#D9534F", fontWeight: 500, marginBottom: 8 }}>Report. Map. Shame.</p>
                <p style={{ color: "#b87a5a", fontSize: 14, lineHeight: 1.65, marginBottom: 8 }}>
                  Report garbage dumps across Assam. Every report maps to the responsible MLA and MP — creating a live public record.
                </p>

                <div className="hero-btns" style={{ display: "flex", gap: 10 }}>
                  <button className="btn-p" onClick={() => setView("report")}>📸 Report Garbage</button>
                  <button className="btn-s" onClick={() => setView("feed")}>View All</button>
                </div>
                {/* Stats */}
                <div className="stats-row" style={{ marginTop: 20 }}>
                  {[{ n: total, l: "Reports", s: "all time" }, { n: uCons, l: "Areas", s: "affected" }, { n: week, l: "This Week", s: "new" }].map(s => (
                    <div key={s.l} className="card" style={{ padding: 14 }}>
                      <div className="stat-n">{loadingRep ? "—" : s.n}</div>
                      <div style={{ fontWeight: 600, fontSize: 12, color: "#E36A6A", marginTop: 3 }}>{s.l}</div>
                      <div style={{ fontSize: 11, color: "#b87a5a" }}>{s.s}</div>
                    </div>
                  ))}
                </div>
                {/* Hotspots */}
                <div className="card" style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 700, color: "#E36A6A" }}>🔥 Accountability Hotspots</h2>
                    <span style={{ fontSize: 10, color: "#b87a5a", fontFamily: "monospace" }}>MOST REPORTED</span>
                  </div>
                  {!loadingRep && topC.length === 0
                    ? <p style={{ color: "#b87a5a", fontSize: 13, textAlign: "center", padding: 12 }}>No reports yet!</p>
                    : !loadingRep ? topC.map(([name, data], i) => (
                      <div key={name} style={{ marginBottom: i < topC.length - 1 ? 12 : 0 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#b87a5a", width: 18 }}>#{i + 1}</span>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{name}</span>
                            <span style={{ color: "#b87a5a", fontSize: 11 }}>{data.district}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <Badge party={data.party} />
                            <span style={{ fontSize: 12, fontFamily: "monospace", color: "#E36A6A", fontWeight: 700 }}>{data.count}</span>
                          </div>
                        </div>
                        <div className="pbar"><div className="pfill" style={{ width: `${(data.count / topC[0][1].count) * 100}%` }} /></div>
                      </div>
                    )) : null}
                </div>
              </div>

              {/* RIGHT sticky */}
              <div className="desk-sticky">
                
                {/* LIVE MAP */}
                {/* <div className="card" style={{ padding: 12, textAlign: "center", marginBottom: 16 }}>
                  <img src={LOGO} alt="Jabor" style={{ width: 64, height: 64, objectFit: "contain", margin: "0 auto 6px", display: "block" }} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, padding: "0 2px" }}>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "#b87a5a" }}>LIVE MAP</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#E36A6A" }}>
                      <span className="pulse-dot" /> {total} active
                    </span>
                  </div>
                  <MapDots reports={reports} />
                </div> */}

                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 700, color: "#E36A6A" }}>🕐 Recent</h2>
                    <button className="btn-s" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setView("feed")}>All →</button>
                  </div>
                  {!loadingRep && reports.length === 0
                    ? <p style={{ color: "#b87a5a", fontSize: 13 }}>No reports yet.</p>
                    : !loadingRep ? <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{reports.slice(0, 3).map(r => <ReportCard key={r.id} r={r} onClick={() => setSelReport(r)} />)}</div>
                    : null}
                </div>
              </div>
            </div>

            {/* ── BOARD OF SHAME (in dashboard) ── */}
            <div>
              <div style={{ marginBottom: 14 }}>
                <h2 style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>Board of <span style={{ color: "#E36A6A" }}>Shame</span></h2>
                <p style={{ color: "#b87a5a", fontSize: 12, marginTop: 3 }}>Politicians ranked by reports — updated live.</p>
              </div>
              <ShameBoard reports={reports} />
            </div>
          </div>
        )}

        {/* ══ REPORT FORM ══ */}
        {view === "report" && !submitted && (
          <div className="slide-in" style={{ maxWidth: 600, margin: "0 auto" }}>
            <div style={{ marginBottom: 20 }}>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 4 }}>📸 Report Garbage</h1>
              <p style={{ color: "#b87a5a", fontSize: 13, marginBottom: 10 }}>Anonymous · 60 seconds · Permanent public record.</p>
              <p className="disclaimer-shine" style={{ fontSize: 11, color: "#b87a5a", opacity: .6, marginBottom: 20 }}>
                  Disclaimer: MLA mappings are sourced from public data and may not be fully accurate. Will be updated after 2026 election results.
              </p>
            </div>

            {/* Photo */}
            <div className="card" style={{
              marginBottom: 14, cursor: "pointer", textAlign: "center",
              border: form.photoPreview ? "1px solid #E36A6A40" : "2px dashed #F0D9A0",
              minHeight: form.photoPreview ? "auto" : 120,
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: form.photoPreview ? 0 : 20, overflow: "hidden",
            }} onClick={() => fileRef.current.click()}>
              {form.photoPreview ? (
                <div style={{ position: "relative", width: "100%" }}>
                  <img src={form.photoPreview} alt="preview" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 14 }} />
                  <div style={{ position: "absolute", bottom: 8, right: 8, background: "#FFF2D0ee", borderRadius: 8, padding: "3px 10px", fontSize: 11, color: "#E36A6A" }}>📸 Change</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 28, marginBottom: 6 }}>📷</div>
                  <div style={{ fontWeight: 600, color: "#E36A6A", marginBottom: 3 }}>Add a photo</div>
                  <div style={{ fontSize: 12, color: "#b87a5a" }}>Tap to upload</div>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPhoto} />
            </div>

            {/* Location */}
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>📍 Location</div>

              {/* Step 1 — District */}
              <div style={{ marginBottom: 12 }}>
                <label className="lbl">DISTRICT <span style={{ color: "#E36A6A" }}>*</span></label>
                {loadingMlas
                  ? <div style={{ color: "#b87a5a", fontSize: 13, padding: "8px 0" }}>Loading districts…</div>
                  : <select className="inp" value={form.district} onChange={e => setForm(f => ({ ...f, district: e.target.value, constituency: "", area: "", landmark: "" }))}>
                      <option value="">Select district</option>
                      {districts.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>}
              </div>

              {/* Step 2 — Constituency */}
              {form.district && (
                <div style={{ marginBottom: 12 }}>
                  <label className="lbl">CONSTITUENCY <span style={{ color: "#E36A6A" }}>*</span></label>
                  <select className="inp" value={form.constituency} onChange={e => setForm(f => ({ ...f, constituency: e.target.value, area: "", landmark: "" }))}>
                    <option value="">Select constituency</option>
                    {consForDist.map(c => <option key={c.id} value={c.constituency}>{c.constituency}</option>)}
                  </select>
                </div>
              )}

              {/* Step 3 — Area + Landmark */}
              {form.constituency && (
                <>
                  <div className="form-2col" style={{ marginBottom: 12 }}>
                    <div>
                      <label className="lbl">AREA / LOCALITY <span style={{ color: "#E36A6A" }}>*</span></label>
                      <input className="inp" placeholder="e.g. Fancy Bazar" value={form.area} onChange={e => setForm(f => ({ ...f, area: e.target.value }))} />
                    </div>
                    <div>
                      <label className="lbl">LANDMARK <span style={{ color: "#b87a5a", fontWeight: 400 }}>(optional)</span></label>
                      <input className="inp" placeholder="e.g. Near SBI ATM" value={form.landmark} onChange={e => setForm(f => ({ ...f, landmark: e.target.value }))} />
                    </div>
                  </div>

                  {/* Accountability preview */}
                  <div style={{ padding: 12, background: "#FFFBF1", borderRadius: 12, border: "1px solid #F0D9A0" }}>
                    <div style={{ fontSize: 10, color: "#b87a5a", fontFamily: "monospace", letterSpacing: ".06em", marginBottom: 8 }}>YOUR REPORT WILL TAG</div>
                    {loadingPrev
                      ? <div style={{ color: "#b87a5a", fontSize: 13 }}>Looking up…</div>
                      : preview ? (
                        <div className="acc-grid">
                          {[
                            { role: "MLA", name: preview.mla?.name, sub: form.constituency, party: preview.mla?.party },
                            { role: "MP",  name: preview.mp?.name || "—", sub: `${preview.mla?.lok_sabha_seat} Lok Sabha`, party: preview.mp?.party },
                          ].map(p => (
                            <div key={p.role} style={{ padding: 10, background: "#FFF2D0", borderRadius: 10, border: "1px solid #F0D9A0" }}>
                              <div style={{ fontSize: 10, color: "#b87a5a", fontFamily: "monospace", marginBottom: 3 }}>{p.role}</div>
                              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 3 }}>{p.name}</div>
                              <div style={{ fontSize: 11, color: "#b87a5a", marginBottom: 6 }}>{p.sub}</div>
                              {p.party && <Badge party={p.party} />}
                            </div>
                          ))}
                        </div>
                      ) : <div style={{ color: "#b87a5a", fontSize: 13 }}>Politician data not found.</div>}
                  </div>
                </>
              )}
            </div>

            {/* Waste type */}
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>♻️ Waste Type</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {WASTE.map(w => (
                  <div key={w.id} className="chip"
                    style={{ background: form.waste_type === w.id ? w.color + "25" : "#FFFBF1", borderColor: form.waste_type === w.id ? w.color : "#F0D9A0", color: form.waste_type === w.id ? w.color : "#b87a5a" }}
                    onClick={() => setForm(f => ({ ...f, waste_type: w.id }))}>
                    {w.icon} {w.label}
                  </div>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>📝 Description <span style={{ color: "#E36A6A" }}>*</span></div>
              <textarea className="inp" placeholder="Where exactly? How bad? How long has it been there?" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>

            <button className="btn-p" style={{ width: "100%", padding: 16, fontSize: 16 }} onClick={onSubmit} disabled={submitting}>
              {submitting ? "Submitting…" : "🚨 Submit Report"}
            </button>
            <p style={{ textAlign: "center", fontSize: 11, color: "#b87a5a", marginTop: 10 }}>100% anonymous · No login · Data is public</p>
          </div>
        )}

        {/* ══ SUCCESS ══ */}
        {view === "report" && submitted && (
          <div className="pop-in" style={{ maxWidth: 420, margin: "60px auto", textAlign: "center" }}>
            <img src={LOGO} alt="Jabor" style={{ width: 80, height: 80, objectFit: "contain", margin: "0 auto 14px", display: "block" }} />
            <h2 style={{ fontSize: 26, fontWeight: 800, marginBottom: 10, letterSpacing: "-0.03em" }}>Report Submitted!</h2>
            <p style={{ color: "#b87a5a", fontSize: 14, lineHeight: 1.7 }}>Your report is now live.<br />The responsible MLA & MP have been recorded.</p>
            <div style={{ marginTop: 18, padding: 14, background: "#FFE8C8", borderRadius: 12, border: "1px solid #F0D9A0", fontSize: 13, color: "#D9534F", fontWeight: 500 }}>
              Share with your community to amplify the pressure 💪
            </div>
          </div>
        )}

        {/* ══ FEED ══ */}
        {view === "feed" && (
          <div className="slide-in">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
              <div>
                <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>All Reports</h1>
                <p style={{ color: "#b87a5a", fontSize: 12, marginTop: 2 }}>{total} reports · {uCons} constituencies</p>
              </div>
              <button className="btn-p" onClick={() => setView("report")} style={{ padding: "10px 18px", fontSize: 13 }}>+ New</button>
            </div>
            {loadingRep ? <Spinner /> : reports.length === 0 ? (
              <div style={{ textAlign: "center", padding: 60 }}>
                <div style={{ fontSize: 42, marginBottom: 12 }}>🌿</div>
                <p style={{ color: "#b87a5a" }}>No reports yet.</p>
                <button className="btn-p" style={{ marginTop: 16 }} onClick={() => setView("report")}>📸 Report Garbage</button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {reports.map(r => <ReportCard key={r.id} r={r} expanded onClick={() => setSelReport(r)} />)}
              </div>
            )}
          </div>
        )}

        {/* ══ MODAL ══ */}
        {selReport && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(45,26,14,.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100, padding: "0 0 0 0" }}
            onClick={() => setSelReport(null)}>
            <div style={{ background: "#FFFBF1", border: "1px solid #F0D9A0", borderRadius: "20px 20px 0 0", padding: "20px 20px calc(20px + env(safe-area-inset-bottom,0px))", width: "100%", maxWidth: 540, maxHeight: "90vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>
              {/* Handle bar */}
              <div style={{ width: 36, height: 4, background: "#F0D9A0", borderRadius: 2, margin: "0 auto 16px" }} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span style={{ fontSize: 12, fontFamily: "monospace", color: "#b87a5a" }}>REPORT #{selReport.id}</span>
                <button onClick={() => setSelReport(null)} style={{ background: "none", border: "none", color: "#b87a5a", cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
              </div>
              {selReport.photo_url && <img src={selReport.photo_url} alt="garbage" style={{ width: "100%", borderRadius: 12, marginBottom: 14, maxHeight: 240, objectFit: "cover" }} />}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <WIcon type={selReport.waste_type} size={18} />
                <span style={{ fontWeight: 700, fontSize: 15 }}>{selReport.constituency}</span>
                <span style={{ color: "#b87a5a", fontSize: 12 }}>· {selReport.district}</span>
              </div>
              {(selReport.area || selReport.landmark) && <div style={{ fontSize: 12, color: "#b87a5a", marginBottom: 10 }}>📍 {[selReport.area, selReport.landmark].filter(Boolean).join(" · ")}</div>}
              {(() => { const w = WASTE.find(t => t.id === selReport.waste_type); return w ? <span style={{ background: w.color + "20", color: w.color, border: `1px solid ${w.color}40`, padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, display: "inline-block", marginBottom: 12 }}>{w.icon} {w.label}</span> : null; })()}
              <p style={{ color: "#5C3A1E", fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>{selReport.description}</p>
              <div style={{ padding: 12, background: "#FFF2D0", borderRadius: 12, border: "1px solid #F0D9A0" }}>
                <div style={{ fontSize: 10, color: "#b87a5a", fontFamily: "monospace", marginBottom: 10 }}>ACCOUNTABILITY</div>
                {[{ role: "MLA", name: selReport.mla, sub: selReport.constituency, party: selReport.mla_party }, { role: "MP", name: selReport.mp, sub: `${selReport.lok_sabha_seat} Lok Sabha`, party: selReport.mp_party }].map(p => (
                  <div key={p.role} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #F0D9A0" }}>
                    <div><div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div><div style={{ fontSize: 11, color: "#b87a5a" }}>{p.role} · {p.sub}</div></div>
                    {p.party && <Badge party={p.party} />}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#b87a5a" }}>Status: <strong style={{ color: selReport.status === "open" ? "#E36A6A" : "#10B981" }}>{selReport.status}</strong></span>
                <span style={{ fontSize: 11, color: "#b87a5a" }}>Reported <TimeAgo date={selReport.created_at} /></span>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer style={{ borderTop: "1px solid #F0D9A0", padding: "16px 20px", textAlign: "center", marginTop: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 4 }}>
          <img src={LOGO} alt="Jabor" style={{ width: 24, height: 24, objectFit: "contain" }} />
          <span style={{ fontSize: 13, fontWeight: 900, color: "#D9534F", letterSpacing: "-0.04em" }}>JABOR</span>
          <span style={{ color: "#F0D9A0" }}>·</span>
          <span style={{ fontSize: 12, color: "#D9534F", fontWeight: 500 }}>Report. Map. Shame.</span>
        </div>
        <p style={{ fontSize: 11, color: "#c49070", fontFamily: "monospace" }}>BUILT BY @Tech_Bagwitty · OPEN SOURCE · ZERO ADS</p>
      </footer>
    </div>
  );
}