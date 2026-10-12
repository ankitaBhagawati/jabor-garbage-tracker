import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { adminRequest, downloadReportsCsv } from "./adminApi.ts";
import HiddenReports from "./HiddenReports.tsx";
import { REPORT_TABS } from "./route.ts";
import { ageDays, ageLabel, isOverdue, statusOf, wardLabel } from "./format.ts";
import { PAGE_SIZE, exportEnvelope, reportsPageEnvelope, type Scope } from "./queryBuilders.ts";
import { EmptyBox, ErrorBox, OverdueBadge, Pager, StatusBadge } from "./Pieces.tsx";
import { EMPTY_FILTERS, type Filters, type ReportRow, type ReportTab, type Sort, type SortKey, type StatusFilter, type Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type TableProps = {
  scope: Scope;
  wards: Ward[];
  overdueDays: number;
  version: number;
  tab: ReportTab;
  initial: { status: StatusFilter; overdue: boolean };
  onOpenReport: (id: string) => void;
};

const SORT_LABEL: Record<SortKey, string> = { created_at: "Age", updated_at: "Updated", status: "Status", area: "Report" };

function ReportsTable({ scope, wards, overdueDays, version, tab, initial, onOpenReport }: TableProps) {
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, status: initial.status, overdueOnly: initial.overdue });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "created_at", dir: "desc" });
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ text: string; error: boolean } | null>(null);

  // The search box waits a moment after typing before it asks the server.
  useEffect(() => {
    const timer = setTimeout(() => setFilters(f => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { setPage(1); }, [filters, sort, tab]);
  // "Overdue only" means Active, so it has no meaning on the In progress and Cleaned tabs
  const overdueApplies = tab === "all" || tab === "active" || tab === "unassigned";
  const applied = useMemo<Filters>(() => (overdueApplies ? filters : { ...filters, overdueOnly: false }), [filters, overdueApplies]);

  const wardById = useMemo(() => new Map(wards.map(w => [w.id, w])), [wards]);
  const list = useAsync(
    () => adminRequest<ReportRow[]>(reportsPageEnvelope(scope, applied, sort, page, new Date(), overdueDays, tab)),
    [scope.municipalityId, applied, tab, sort.key, sort.dir, page, overdueDays, version],
  );
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? null;
  const now = new Date();
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  // The server builds the file from the same filters the table uses, and records the export in the audit log.
  const exportCsv = async () => {
    setExporting(true);
    setExportMessage(null);
    try {
      const { rows: count } = await downloadReportsCsv(exportEnvelope(scope, applied, new Date(), overdueDays, tab));
      setExportMessage({ text: `Downloaded ${count.toLocaleString("en-IN")} ${count === 1 ? "report" : "reports"}.`, error: false });
    } catch (e) {
      setExportMessage({ text: e instanceof Error ? e.message : "The export failed. Please try again.", error: true });
    } finally {
      setExporting(false);
    }
  };

  const set = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));
  const clearFilters = () => { setSearch(""); setFilters(EMPTY_FILTERS); };
  const toggleSort = (key: SortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "area" || key === "status" ? "asc" : "desc" }));

  return (
    <div>
      <section aria-label="Reports table" className="adm-panel">
        <div className="adm-filters">
          <div className="adm-field adm-field-search">
            <label htmlFor="f-search">Search</label>
            <input id="f-search" className="inp" type="search" value={search} placeholder="Area, landmark or description" maxLength={80} onChange={e => setSearch(e.target.value)} />
          </div>
          {tab === "all" && <div className="adm-field">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" className="inp" value={filters.status} onChange={e => set({ status: e.target.value as StatusFilter, overdueOnly: false })}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="in_progress">In progress</option>
              <option value="cleaned">Cleaned</option>
              <option value="invalid">Invalid</option>
              <option value="auto_cleaned">Auto-cleaned</option>
            </select>
          </div>}
          {tab !== "unassigned" && <div className="adm-field">
            <label htmlFor="f-ward">Ward</label>
            <select id="f-ward" className="inp" value={filters.ward} onChange={e => set({ ward: e.target.value })}>
              <option value="">All wards</option>
              <option value="unassigned">Unassigned</option>
              {wards.map(w => <option key={w.id} value={w.id}>{wardLabel(w)}</option>)}
            </select>
          </div>}
          <div className="adm-field">
            <label htmlFor="f-from">From</label>
            <input id="f-from" className="inp" type="date" value={filters.from} max={filters.to || undefined} onChange={e => set({ from: e.target.value })} />
          </div>
          <div className="adm-field">
            <label htmlFor="f-to">To</label>
            <input id="f-to" className="inp" type="date" value={filters.to} min={filters.from || undefined} onChange={e => set({ to: e.target.value })} />
          </div>
          {overdueApplies && <label className="adm-check">
            <input type="checkbox" checked={filters.overdueOnly} onChange={e => set({ overdueOnly: e.target.checked, status: e.target.checked ? "" : filters.status })} />
            Overdue only
          </label>}
          {filtersActive && <button type="button" className="btn-s adm-clear" onClick={clearFilters}>Clear filters</button>}
          <button type="button" className="btn-s adm-export" disabled={exporting} onClick={exportCsv}>{exporting ? "Preparing…" : "Export CSV"}</button>
        </div>
        {exportMessage && <p className={exportMessage.error ? "adm-export-msg adm-export-error" : "adm-export-msg"} role={exportMessage.error ? "alert" : "status"}>{exportMessage.text}</p>}

        {list.error ? (
          <ErrorBox message={list.error} onRetry={list.reload} />
        ) : list.loading && list.data === undefined ? (
          <div className="adm-table-wrap" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="adm-skeleton-row" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyBox>
            <p>{filtersActive ? "No reports match these filters." : tab === "all" ? "There are no reports yet." : "There are no reports in this tab."}</p>
            {filtersActive && <button type="button" className="btn-s" onClick={clearFilters}>Clear filters</button>}
          </EmptyBox>
        ) : (
          <div className={`adm-table-wrap${list.loading ? " is-loading" : ""}`} aria-busy={list.loading}>
            <table className="adm-table">
              <thead>
                <tr>
                  <th scope="col"><span className="adm-sr">Photo</span></th>
                  {(["area", "status", "created_at"] as SortKey[]).map(key => (
                    <th key={key} scope="col" aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={key === "area" ? "adm-col-report" : undefined}>
                      <button type="button" className="adm-sort" onClick={() => toggleSort(key)}>
                        {SORT_LABEL[key]}{sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    </th>
                  ))}
                  <th scope="col">Ward</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const status = statusOf(row);
                  const ward = row.ward_id ? wardById.get(row.ward_id) : undefined;
                  const overdue = isOverdue(row, overdueDays, now);
                  return (
                    <tr key={row.id} onClick={() => onOpenReport(row.id)}>
                      <td className="adm-cell-photo" data-label="">
                        {row.photo_url ? <img src={row.photo_url} alt="" width={56} height={56} loading="lazy" /> : <span className="adm-nophoto" aria-hidden="true" />}
                      </td>
                      <td className="adm-cell-report" data-label="Report">
                        <button type="button" className="adm-link" onClick={e => { e.stopPropagation(); onOpenReport(row.id); }}>
                          {row.area || "Unknown area"}
                        </button>
                        {row.landmark && <span className="adm-sub">{row.landmark}</span>}
                      </td>
                      <td data-label=""><StatusBadge status={status} hidden={Boolean(row.is_deleted)} /></td>
                      <td data-label="Age">{ageLabel(ageDays(row.created_at, now))} {overdue && <OverdueBadge />}</td>
                      <td data-label="Ward">{ward ? wardLabel(ward) : <span className="adm-muted">Unassigned</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!list.error && (rows.length > 0 || page > 1) && <Pager page={page} pageSize={PAGE_SIZE} total={total} busy={list.loading} onPage={setPage} />}
      </section>
    </div>
  );
}

type PageProps = TableProps & {
  onTab: (tab: ReportTab) => void;
  onChanged: () => void;
  onPhotoClick: (url: string) => void;
};

// The Reports page: segmented tabs over the table. The Hidden tab is the list of hidden and invalid reports with Restore.
export default function Reports({ onTab, onChanged, onPhotoClick, ...table }: PageProps) {
  const tab = table.tab;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const index = REPORT_TABS.findIndex(t => t.id === tab);
    const move = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -index : e.key === "End" ? REPORT_TABS.length - 1 - index : 0;
    if (!move) return;
    e.preventDefault();
    const next = REPORT_TABS[(index + move + REPORT_TABS.length) % REPORT_TABS.length].id;
    onTab(next);
    refs.current[next]?.focus();
  };
  return (
    <div>
      <div className="adm-segments" role="tablist" aria-label="Report groups">
        {REPORT_TABS.map(t => (
          <button
            key={t.id}
            ref={node => { refs.current[t.id] = node; }}
            type="button"
            role="tab"
            id={`rt-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="rt-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`adm-segment${tab === t.id ? " is-on" : ""}`}
            onClick={() => onTab(t.id)}
            onKeyDown={onKeyDown}
          >{t.label}</button>
        ))}
      </div>
      <div id="rt-panel" role="tabpanel" aria-labelledby={`rt-${tab}`}>
        {tab === "hidden" ? (
          <div className="adm-panel">
            <HiddenReports municipalityId={table.scope.municipalityId} version={table.version} onChanged={onChanged} onPhotoClick={onPhotoClick} />
          </div>
        ) : (
          <ReportsTable {...table} />
        )}
      </div>
    </div>
  );
}
