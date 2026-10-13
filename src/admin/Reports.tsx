import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons.tsx";
import { adminRequest, downloadReportsCsv } from "./adminApi.ts";
import HiddenReports from "./HiddenReports.tsx";
import { REPORT_TABS } from "./route.ts";
import { ageDays, ageLabel, isOverdue, statusOf, wardLabel } from "./format.ts";
import { PAGE_SIZE, exportEnvelope, reportsPageEnvelope, tileEnvelope, type Scope, type TileKey } from "./queryBuilders.ts";
import { CheckField, DateField, FilterPanel, SelectField, TextField } from "./Filters.tsx";
import { EmptyBox, ErrorBox, OverdueBadge, Pager, StatusBadge } from "./Pieces.tsx";
import { districtsEnvelope } from "./queryBuilders.ts";
import { EMPTY_FILTERS, type Filters, type ReportRow, type ReportTab, type Sort, type SortKey, type StatusFilter, type Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type TableProps = {
  scope: Scope;
  viewAll: boolean; // a super admin looking at every municipality
  wards: Ward[];
  overdueDays: number;
  version: number;
  tab: ReportTab;
  initial: { status: StatusFilter; overdue: boolean };
  onOpenReport: (id: string) => void;
  onPhotoClick: (url: string) => void;
};

const STATUS_OPTIONS = [
  { value: "active", label: "Active" }, { value: "in_progress", label: "In progress" }, { value: "cleaned", label: "Cleaned" },
  { value: "invalid", label: "Invalid" }, { value: "auto_cleaned", label: "Auto-cleaned" },
];
// The sort choices in the filter panel. The column headers sort the same way and change the same setting.
const SORT_OPTIONS: { value: string; label: string; sort: Sort }[] = [
  { value: "newest", label: "Newest first", sort: { key: "created_at", dir: "desc" } },
  { value: "oldest", label: "Oldest first", sort: { key: "created_at", dir: "asc" } },
  { value: "updated", label: "Recently updated", sort: { key: "updated_at", dir: "desc" } },
  { value: "area", label: "Report name, A to Z", sort: { key: "area", dir: "asc" } },
  { value: "status", label: "Status", sort: { key: "status", dir: "asc" } },
];

const SORT_LABEL: Record<SortKey, string> = { created_at: "Age", updated_at: "Updated", status: "Status", area: "Report" };

function ReportsTable({ scope, viewAll, wards, overdueDays, version, tab, initial, onOpenReport, onPhotoClick }: TableProps) {
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

  // View all: no ward filter or column; a District filter instead.
  const districts = useAsync(async () => (viewAll ? (await adminRequest<{ district: string }[]>(districtsEnvelope(scope))).data : []), [viewAll, version]);
  const districtOptions = useMemo(() => [...new Set((districts.data ?? []).map(r => r.district.trim()).filter(Boolean))].sort().map(d => ({ value: d, label: d })), [districts.data]);
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

  const sortValue = SORT_OPTIONS.find(o => o.sort.key === sort.key && o.sort.dir === sort.dir)?.value ?? "";
  const set = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));
  const clearFilters = () => { setSearch(""); setFilters(EMPTY_FILTERS); };
  const toggleSort = (key: SortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "area" || key === "status" ? "asc" : "desc" }));

  return (
    <div>
      <FilterPanel
        title="Search, sort and filter"
        actions={<button type="button" className="btn-s adm-export" disabled={exporting} onClick={exportCsv}><Icon name="download" size={18} /> {exporting ? "Preparing…" : "Export CSV"}</button>}
        footer={filtersActive ? <button type="button" className="btn-s adm-clear" onClick={clearFilters}>Clear filters</button> : null}
      >
        <TextField label="Search" value={search} onChange={setSearch} placeholder="Area, landmark or description" />
        <SelectField label="Sort" value={sortValue} options={SORT_OPTIONS.map(o => ({ value: o.value, label: o.label }))} placeholder="By column" clearable={false}
          onChange={value => { const found = SORT_OPTIONS.find(o => o.value === value); if (found) setSort(found.sort); }} />
        {tab === "all" && <SelectField label="Status" value={filters.status} placeholder="All statuses" options={STATUS_OPTIONS} onChange={value => set({ status: value as StatusFilter, overdueOnly: false })} />}
        {viewAll && <SelectField label="District" value={filters.district} placeholder="All districts" options={districtOptions} onChange={value => set({ district: value })} />}
        {!viewAll && tab !== "unassigned" && <SelectField label="Ward" value={filters.ward} placeholder="All wards" options={[{ value: "unassigned", label: "Unassigned" }, ...wards.map(w => ({ value: w.id, label: wardLabel(w) }))]} onChange={value => set({ ward: value })} />}
        <DateField label="From" value={filters.from} max={filters.to || undefined} onChange={value => set({ from: value })} />
        <DateField label="To" value={filters.to} min={filters.from || undefined} onChange={value => set({ to: value })} />
        {overdueApplies && <CheckField label="Overdue only" checked={filters.overdueOnly} onChange={checked => set({ overdueOnly: checked, status: checked ? "" : filters.status })} />}
      </FilterPanel>
      {exportMessage && <p className={exportMessage.error ? "adm-export-msg adm-export-error" : "adm-export-msg"} role={exportMessage.error ? "alert" : "status"}>{exportMessage.text}</p>}

      <section aria-label="Reports table" className="adm-panel">
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
                  <th scope="col">{viewAll ? "District" : "Ward"}</th>
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
                        {row.photo_url
                          ? <button type="button" className="adm-thumbbtn" aria-label={`Enlarge the photo of ${row.area || "this report"}`} onClick={e => { e.stopPropagation(); onPhotoClick(row.photo_url as string); }}><img src={row.photo_url} alt="" width={56} height={56} loading="lazy" /></button>
                          : <span className="adm-nophoto" aria-hidden="true" />}
                      </td>
                      <td className="adm-cell-report" data-label="Report">
                        <button type="button" className="adm-link" onClick={e => { e.stopPropagation(); onOpenReport(row.id); }}>
                          {row.area || "Unknown area"}
                        </button>
                        {row.landmark && <span className="adm-sub">{row.landmark}</span>}
                      </td>
                      <td data-label=""><StatusBadge status={status} hidden={Boolean(row.is_deleted)} /></td>
                      <td data-label="Age">{ageLabel(ageDays(row.created_at, now))} {overdue && <OverdueBadge />}</td>
                      <td data-label={viewAll ? "District" : "Ward"}>{viewAll ? (row.district || <span className="adm-muted">Not given</span>) : ward ? wardLabel(ward) : <span className="adm-muted">Unassigned</span>}</td>
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
};

// The number beside a tab: the same count the dashboard tile of that name shows.
const TAB_TILE: Record<ReportTab, TileKey> = { all: "total", unassigned: "unassigned", active: "active", in_progress: "in_progress", cleaned: "cleaned", hidden: "invalid" };
function TabCount({ tab, scope, overdueDays, version }: { tab: ReportTab; scope: Scope; overdueDays: number; version: number }) {
  const count = useAsync(async () => (await adminRequest<unknown[]>(tileEnvelope(TAB_TILE[tab], scope, new Date(), overdueDays))).total, [tab, scope.municipalityId, overdueDays, version]);
  return <span className="adm-tabcount" data-testid={`count-${tab}`}>{count.data ?? (count.error ? "" : "…")}</span>;
}

// The Reports page: segmented tabs over the table. The Hidden tab is the list of hidden and invalid reports with Restore.
export default function Reports({ onTab, onChanged, onPhotoClick, ...table }: PageProps) {
  // View all has no "Unassigned wards" tab: wards belong to one municipality.
  const tabs = !table.viewAll ? REPORT_TABS : REPORT_TABS.filter(t => t.id !== "unassigned");
  const tab = tabs.some(t => t.id === table.tab) ? table.tab : "all";
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.findIndex(t => t.id === tab);
    const move = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -index : e.key === "End" ? tabs.length - 1 - index : 0;
    if (!move) return;
    e.preventDefault();
    const next = tabs[(index + move + tabs.length) % tabs.length].id;
    onTab(next);
    refs.current[next]?.focus();
  };
  return (
    <div>
      <div className="adm-tabrow" role="tablist" aria-label="Report groups">
        {tabs.map(t => (
          <button
            key={t.id}
            ref={node => { refs.current[t.id] = node; }}
            type="button"
            role="tab"
            id={`rt-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="rt-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={`adm-tabitem${tab === t.id ? " is-on" : ""}`}
            onClick={() => onTab(t.id)}
            onKeyDown={onKeyDown}
          >{t.label}{" "}<TabCount tab={t.id} scope={table.scope} overdueDays={table.overdueDays} version={table.version} /></button>
        ))}
      </div>
      <div id="rt-panel" role="tabpanel" aria-labelledby={`rt-${tab}`}>
        {tab === "hidden" ? (
          <div className="adm-panel">
            <HiddenReports municipalityId={table.scope.municipalityId} version={table.version} onChanged={onChanged} onPhotoClick={onPhotoClick} />
          </div>
        ) : (
          <ReportsTable {...table} tab={tab} onPhotoClick={onPhotoClick} />
        )}
      </div>
    </div>
  );
}
