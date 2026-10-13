import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./admin.css";
import { adminRequest, onSessionEnded } from "./adminApi.ts";
import AuditLog from "./AuditLog.tsx";
import Dashboard from "./Dashboard.tsx";
import Hotspots from "./Hotspots.tsx";
import MonthlyReport from "./MonthlyReport.tsx";
import PhotoLightbox from "../ui/PhotoLightbox.tsx";
import { Icon } from "./icons.tsx";
import { navFor, roleBadge } from "./nav.ts";
import Reports from "./Reports.tsx";
import StaffAdmin from "./StaffAdmin.tsx";
import { DEFAULT_ROUTE, formatRoute, parseRoute, type Route } from "./route.ts";
import UserMenu from "./UserMenu.tsx";
import { ErrorBox } from "./Pieces.tsx";
import { municipalitiesEnvelope, wardsEnvelope, type Scope } from "./queryBuilders.ts";
import ReportDrawer from "./ReportDrawer.tsx";
import type { MunicipalityInfo, ReportTab, Session, Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";
import { overdueDaysFrom } from "./format.ts";

// A page supplied by the app that mounts this one (the older owner screens).
export type ExtraTab = { id: string; label: string; render: (api: { onPhotoClick: (url: string) => void; version: number }) => ReactNode };

type Props = {
  session: Session;
  onSignOut: () => void;
  extraTabs?: ExtraTab[];
  onChanged?: () => void;
};

// The address of a page this person does not have (a municipality admin typing #/admins) is replaced by the
// Dashboard's. The server refuses those requests anyway; this is only so the address does not lie.
function settleAddress(route: Route) {
  const first = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  if (first && first !== route.page) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${formatRoute(route)}`);
}

const WIDE = "(min-width: 900px)";
const isWide = () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE).matches : true);

// The admin area: a header with the menu button and the user icon, a sidebar of pages, and the page itself.
// The page is in the URL hash (#/reports/active), so a refresh stays where it was. The report drawer can be
// opened from any page.
export default function AdminApp({ session, onSignOut, extraTabs = [], onChanged }: Props) {
  const isSuper = session.role === "super_admin";
  // A super admin chooses "View all" (chosen is empty) or one municipality.
  const [chosen, setChosen] = useState<string>("");
  const viewAll = isSuper && !chosen;
  const items = useMemo(() => navFor(session.role, extraTabs), [session.role, extraTabs]);
  const pages = useMemo(() => items.map(item => item.id), [items]);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash, pages));
  const [reportsSeq, setReportsSeq] = useState(0); // bumped when something outside the Reports page sends it a new filter
  const [wide, setWide] = useState(isWide);
  const [navOpen, setNavOpen] = useState(isWide);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [photo, setPhoto] = useState("");
  const [version, setVersion] = useState(0);
  const menuRef = useRef<HTMLButtonElement>(null);
  const sideRef = useRef<HTMLElement>(null);

  useEffect(() => { onSessionEnded(onSignOut); return () => onSessionEnded(null); }, [onSignOut]);

  // The menu is open on a wide screen and a drawer on a phone; crossing the width resets it to that default.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(WIDE);
    const onChange = () => { setWide(query.matches); setNavOpen(query.matches); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Back and forward, and a hand-edited address, change the page.
  useEffect(() => {
    const sync = () => { const next = parseRoute(window.location.hash, pages); settleAddress(next); setRoute(next); setReportsSeq(n => n + 1); };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("hashchange", sync); };
  }, [pages]);

  useEffect(() => { settleAddress(route); }, [route]);

  const municipalities = useAsync(async () => (await adminRequest<MunicipalityInfo[]>(municipalitiesEnvelope())).data, []);
  const list = municipalities.data ?? [];
  // A municipality admin's list holds their own municipality only. A super admin starts on View all (no municipality).
  const municipality = isSuper ? list.find(m => m.id === chosen) ?? null : list[0] ?? null;
  const scope: Scope = useMemo(() => ({ municipalityId: isSuper ? municipality?.id ?? null : null }), [isSuper, municipality?.id]);
  const overdueDays = overdueDaysFrom(municipality?.settings);

  const wards = useAsync(async () => (await adminRequest<Ward[]>(wardsEnvelope(scope))).data, [scope.municipalityId, municipality?.id]);
  const changed = useCallback(() => { setVersion(v => v + 1); onChanged?.(); }, [onChanged]);

  // Go to a page. From the menu or a tile this is a new page (the Reports page starts fresh with the filter);
  // switching tabs inside Reports only changes the address.
  const go = useCallback((next: Route, options: { fresh?: boolean } = { fresh: true }) => {
    const hash = formatRoute(next);
    if (window.location.hash !== hash) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    setRoute(next);
    if (options.fresh) { setReportsSeq(n => n + 1); setOpenReport(null); }
  }, []);
  const choosePage = (id: string) => { go({ ...DEFAULT_ROUTE, page: id }); if (!wide) setNavOpen(false); };
  const chooseTab = (tab: ReportTab) => go({ ...DEFAULT_ROUTE, page: "reports", tab }, { fresh: false });

  // On a phone the open menu is a drawer: Esc closes it and focus goes back to the button.
  useEffect(() => {
    if (wide || !navOpen) return;
    sideRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setNavOpen(false); menuRef.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wide, navOpen]);

  const wardList = wards.data ?? [];
  const areaKey = municipality?.id ?? "all";
  const current = items.find(item => item.id === route.page) ?? items[0];
  const badge = roleBadge(session.role, municipality ?? session.municipality);

  let body: ReactNode;
  if (municipalities.error) body = <ErrorBox message={municipalities.error} onRetry={municipalities.reload} />;
  else if (!isSuper && !municipality && municipalities.loading) body = <div className="adm-state" aria-busy="true"><p>Loading…</p></div>;
  else if (!isSuper && !municipality) body = <div className="adm-state"><p>No municipality is set up for this account.</p></div>;
  else if (wards.error) body = <ErrorBox message={wards.error} onRetry={wards.reload} />;
  else if (route.page === "dashboard") body = <Dashboard key={areaKey} scope={scope} viewAll={viewAll} overdueDays={overdueDays} version={version} onNavigate={go} />;
  else if (route.page === "reports") body = (
    <Reports
      key={`${areaKey}-${reportsSeq}`} scope={scope} viewAll={viewAll} wards={wardList} overdueDays={overdueDays} version={version}
      tab={route.tab} initial={{ status: route.status, overdue: route.overdue }} 
      onTab={chooseTab} onOpenReport={setOpenReport} onChanged={changed} onPhotoClick={setPhoto}
    />
  );
  else if (viewAll && (route.page === "monthly" || route.page === "hotspots")) body = <div className="adm-state"><p>Choose a municipality above to see this page. Ward figures are worked out for one municipality at a time.</p></div>;
  else if (route.page === "monthly") body = <MonthlyReport key={areaKey} scope={scope} municipalityName={municipality?.name ?? ""} overdueDays={overdueDays} version={version} />;
  else if (route.page === "hotspots") body = <Hotspots key={areaKey} scope={scope} version={version} />;
  else if (route.page === "admins" && isSuper) body = <StaffAdmin municipalities={list} />;
  else if (route.page === "audit") body = <AuditLog key={areaKey} scope={scope} wards={wardList} version={version} onOpenReport={setOpenReport} />;
  else body = <div className="adm-panel">{extraTabs.find(t => t.id === route.page)?.render({ onPhotoClick: setPhoto, version })}</div>;

  return (
    <div className={`adm${navOpen ? " has-nav" : ""}`}>
      <header className="adm-bar">
        {/* the phone's menu button, left of the title; on a wide screen the sidebar has its own at its top */}
        <button ref={menuRef} type="button" className="adm-iconbtn adm-menu-top" aria-label="Menu" aria-expanded={navOpen} aria-controls="adm-sidebar" onClick={() => setNavOpen(o => !o)}>
          <Icon name="menu" size={24} />
        </button>
        <h1 className="adm-title">{current.label}</h1>
        <div className="adm-bar-right">
          <UserMenu session={session} onSignOut={onSignOut} badge={badge} />
        </div>
      </header>

      {isSuper && list.length > 0 && (
        <div className="adm-muni-bar">
          <div className="adm-field">
            <label htmlFor="municipality">Municipality</label>
            <select id="municipality" className="inp" value={chosen} onChange={e => { setChosen(e.target.value); setOpenReport(null); }}>
              <option value="">View all</option>
              {list.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      )}

      <div className="adm-shell">
        {!wide && navOpen && <div className="adm-backdrop" aria-hidden="true" onClick={() => setNavOpen(false)} />}
        <nav id="adm-sidebar" ref={sideRef} className={`adm-side${navOpen ? " is-open" : ""}${wide && !navOpen ? " is-collapsed" : ""}`} aria-label="Admin sections">
          {/* at the top of the sidebar: collapses it to a narrow rail on a wide screen, closes the drawer on a phone */}
          <button type="button" className="adm-iconbtn adm-menu-side" aria-label="Menu" aria-expanded={navOpen} aria-controls="adm-sidebar" onClick={() => setNavOpen(o => !o)}>
            <Icon name="menu" size={24} />
          </button>
          <button type="button" className="adm-iconbtn adm-close-side" aria-label="Close menu" onClick={() => { setNavOpen(false); menuRef.current?.focus(); }}>
            <Icon name="close" size={22} />
          </button>
          {items.map(item => (
            <a
              key={item.id}
              href={formatRoute({ page: item.id })}
              className={`adm-navitem${current.id === item.id ? " is-on" : ""}`}
              aria-current={current.id === item.id ? "page" : undefined}
              onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); choosePage(item.id); }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className="adm-main">
          {body}
        </div>
      </div>

      {openReport && (
        <ReportDrawer key={openReport} reportId={openReport} wards={wardList} overdueDays={overdueDays} onClose={() => setOpenReport(null)} onChanged={changed} onPhotoClick={setPhoto} />
      )}

      {photo && <PhotoLightbox url={photo} onClose={() => setPhoto("")} />}
    </div>
  );
}
