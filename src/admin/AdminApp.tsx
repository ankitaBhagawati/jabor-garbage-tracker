import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import "./admin.css";
import { adminRequest, onSessionEnded } from "./adminApi.ts";
import AuditLog from "./AuditLog.tsx";
import Dashboard from "./Dashboard.tsx";
import Hotspots from "./Hotspots.tsx";
import MonthlyReport from "./MonthlyReport.tsx";
import HiddenReports from "./HiddenReports.tsx";
import { ErrorBox } from "./Pieces.tsx";
import { municipalitiesEnvelope, wardsEnvelope, type Scope } from "./queryBuilders.ts";
import ReportDrawer from "./ReportDrawer.tsx";
import type { MunicipalityInfo, Session, Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";
import { overdueDaysFrom } from "./format.ts";

// A tab supplied by the page that mounts the app (the older super admin screens).
export type ExtraTab = { id: string; label: string; render: (api: { onPhotoClick: (url: string) => void; version: number }) => ReactNode };

type Props = {
  session: Session;
  onSignOut: () => void;
  extraTabs?: ExtraTab[];
  onChanged?: () => void;
};

const ROLE_LABEL = { super_admin: "Owner", municipality_admin: "Municipality admin" } as const;

// The admin area: header, the municipality (a super admin chooses one, a municipality admin has one),
// the tabs, and the report drawer that every tab can open.
export default function AdminApp({ session, onSignOut, extraTabs = [], onChanged }: Props) {
  const isSuper = session.role === "super_admin";
  const [tab, setTab] = useState("dashboard");
  const [chosen, setChosen] = useState<string>("");
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [photo, setPhoto] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => { onSessionEnded(onSignOut); return () => onSessionEnded(null); }, [onSignOut]);

  const municipalities = useAsync(async () => (await adminRequest<MunicipalityInfo[]>(municipalitiesEnvelope())).data, []);
  const list = municipalities.data ?? [];
  // A municipality admin's list holds their own municipality only. A super admin starts on Jorhat.
  const municipality = list.find(m => m.id === chosen) ?? list.find(m => m.slug === "jorhat") ?? list[0] ?? null;
  const scope: Scope = useMemo(() => ({ municipalityId: isSuper ? municipality?.id ?? null : null }), [isSuper, municipality?.id]);
  const overdueDays = overdueDaysFrom(municipality?.settings);

  const wards = useAsync(async () => (await adminRequest<Ward[]>(wardsEnvelope(scope))).data, [scope.municipalityId, municipality?.id]);
  const changed = useCallback(() => { setVersion(v => v + 1); onChanged?.(); }, [onChanged]);

  const tabs: { id: string; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "monthly", label: "Monthly report" },
    { id: "hotspots", label: "Hotspots" },
    { id: "audit", label: "Audit log" },
    { id: "hidden", label: "Hidden" },
    ...extraTabs.map(({ id, label }) => ({ id, label })),
  ];
  const wardList = wards.data ?? [];
  const title = isSuper ? "Admin" : municipality?.name ?? session.municipality?.name ?? "Your municipality";

  let body: ReactNode;
  if (municipalities.error) body = <ErrorBox message={municipalities.error} onRetry={municipalities.reload} />;
  else if (!municipality && municipalities.loading) body = <div className="adm-state" aria-busy="true"><p>Loading…</p></div>;
  else if (!municipality) body = <div className="adm-state"><p>No municipality is set up for this account.</p></div>;
  else if (wards.error) body = <ErrorBox message={wards.error} onRetry={wards.reload} />;
  else if (tab === "dashboard") body = <Dashboard key={municipality.id} scope={scope} wards={wardList} overdueDays={overdueDays} version={version} onOpenReport={setOpenReport} />;
  else if (tab === "monthly") body = <MonthlyReport key={municipality.id} scope={scope} municipalityName={municipality.name} overdueDays={overdueDays} version={version} />;
  else if (tab === "hotspots") body = <Hotspots key={municipality.id} scope={scope} version={version} />;
  else if (tab === "audit") body = <AuditLog key={municipality.id} scope={scope} wards={wardList} version={version} onOpenReport={setOpenReport} />;
  else if (tab === "hidden") body = <div className="adm-panel"><HiddenReports key={municipality.id} role={session.role} municipalityId={scope.municipalityId} version={version} onChanged={changed} onPhotoClick={setPhoto} /></div>;
  else body = <div className="adm-panel">{extraTabs.find(t => t.id === tab)?.render({ onPhotoClick: setPhoto, version })}</div>;

  return (
    <div className="adm">
      <header className="adm-head">
        <div>
          <p className="adm-eyebrow">JABOR ADMIN · {ROLE_LABEL[session.role].toUpperCase()}</p>
          <h1>{title}</h1>
        </div>
        <div className="adm-head-right">
          {isSuper && list.length > 0 && (
            <div className="adm-field">
              <label htmlFor="municipality">Municipality</label>
              <select id="municipality" className="inp" value={municipality?.id ?? ""} onChange={e => { setChosen(e.target.value); setOpenReport(null); }}>
                {list.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}
          <span className="adm-who" title={session.email}>{session.email}</span>
          <button type="button" className="btn-s" onClick={onSignOut}>Sign Out</button>
        </div>
      </header>

      <nav className="adm-tabs" aria-label="Admin sections">
        {tabs.map(t => (
          <button key={t.id} type="button" className={`adm-tab${tab === t.id ? " is-on" : ""}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="adm-main">{body}</div>

      {openReport && municipality && (
        <ReportDrawer key={openReport} reportId={openReport} wards={wardList} overdueDays={overdueDays} onClose={() => setOpenReport(null)} onChanged={changed} onPhotoClick={setPhoto} />
      )}

      {photo && (
        <div className="admin-photo-modal" onClick={() => setPhoto("")}>
          <div className="admin-photo-modal-inner" onClick={e => e.stopPropagation()}>
            <button className="admin-photo-close" onClick={() => setPhoto("")} aria-label="Close photo preview">×</button>
            <img src={photo} alt="Enlarged report" />
          </div>
        </div>
      )}
    </div>
  );
}
