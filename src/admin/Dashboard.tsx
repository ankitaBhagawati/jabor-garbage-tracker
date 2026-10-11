import { useEffect, useMemo, useState } from "react";
import { adminRequest, downloadReportsCsv } from "./adminApi.ts";
import { ageDays, ageLabel, isOverdue, statusOf, wardLabel } from "./format.ts";
import { PAGE_SIZE, TILE_KEYS, exportEnvelope, reportsPageEnvelope, tileEnvelope, type Scope, type TileKey } from "./queryBuilders.ts";
import { EmptyBox, ErrorBox, OverdueBadge, Pager, StatusBadge } from "./Pieces.tsx";
import { EMPTY_FILTERS, type Filters, type ReportRow, type Sort, type SortKey, type StatusFilter, type Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type Props = {
  scope: Scope;
  wards: Ward[];
  overdueDays: number;
  version: number;
  onOpenReport: (id: string) => void;
};

const TILE_INFO: Record<TileKey, { label: string; hint: string }> = {
  total: { label: "Total", hint: "Every report" },
  active: { label: "Active", hint: "Waiting for action" },
  in_progress: { label: "In progress", hint: "Being worked on" },
  cleaned: { label: "Cleaned", hint: "Cleaned by JMB or citizens" },
  invalid: { label: "Invalid", hint: "Spam, duplicates, hidden" },
  overdue: { label: "Overdue", hint: "" },
  auto_cleaned: { label: "Auto-cleaned", hint: "Closed by the nightly sweep, not counted as cleaned" },
};

// What clicking a tile does to the filters.
const TILE_FILTER: Record<TileKey, Partial<Filters>> = {
  total: { status: "", overdueOnly: false },
  active: { status: "active", overdueOnly: false },
  in_progress: { status: "in_progress", overdueOnly: false },
  cleaned: { status: "cleaned", overdueOnly: false },
  invalid: { status: "invalid", overdueOnly: false },
  overdue: { status: "", overdueOnly: true },
  auto_cleaned: { status: "auto_cleaned", overdueOnly: false },
};

// A tile needs only the count the server reports (one cheap request per tile, so a slow one never blocks the others).
function TileCount({ tile, scope, overdueDays, version, selected, onPick }: { tile: TileKey; scope: Scope; overdueDays: number; version: number; selected: boolean; onPick: () => void }) {
  const result = useAsync(async () => ({ total: (await adminRequest<unknown[]>(tileEnvelope(tile, scope, new Date(), overdueDays))).total }), [tile, scope.municipalityId, overdueDays, version]);
  const info = TILE_INFO[tile];
  const hint = tile === "overdue" ? `Active for more than ${overdueDays} days` : info.hint;
  return (
    <button
      type="button"
      className={`adm-tile adm-tile-${tile}${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={result.error ? result.reload : onPick}
      title={hint}
    >
      <span className="adm-tile-label">{info.label}</span>
      <span className="adm-tile-value" aria-live="polite">
        {result.error ? <span className="adm-tile-error">n/a</span> : result.data === undefined ? <span className="adm-skeleton" aria-label="Loading" /> : result.data.total ?? 0}
      </span>
      <span className="adm-tile-hint">{result.error ? "Could not load. Click to try again." : hint}</span>
    </button>
  );
}

const SORT_LABEL: Record<SortKey, string> = { created_at: "Age", updated_at: "Updated", status: "Status", area: "Report" };

export default function Dashboard({ scope, wards, overdueDays, version, onOpenReport }: Props) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
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
  useEffect(() => { setPage(1); }, [filters, sort]);

  const wardById = useMemo(() => new Map(wards.map(w => [w.id, w])), [wards]);
  const list = useAsync(
    () => adminRequest<ReportRow[]>(reportsPageEnvelope(scope, filters, sort, page, new Date(), overdueDays)),
    [scope.municipalityId, filters, sort.key, sort.dir, page, overdueDays, version],
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
      const { rows: count } = await downloadReportsCsv(exportEnvelope(scope, filters, new Date(), overdueDays));
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
  const pickTile = (tile: TileKey) => setFilters(f => ({ ...f, ...TILE_FILTER[tile] }));
  const tileSelected = (tile: TileKey) => filters.status === (TILE_FILTER[tile].status ?? "") && filters.overdueOnly === TILE_FILTER[tile].overdueOnly;

  return (
    <div>
      <section aria-label="Summary" className="adm-tiles">
        {TILE_KEYS.map(tile => (
          <TileCount key={tile} tile={tile} scope={scope} overdueDays={overdueDays} version={version} selected={tileSelected(tile)} onPick={() => pickTile(tile)} />
        ))}
      </section>

      <section aria-label="Reports" className="adm-panel">
        <div className="adm-filters">
          <div className="adm-field adm-field-search">
            <label htmlFor="f-search">Search</label>
            <input id="f-search" className="inp" type="search" value={search} placeholder="Area, landmark or description" maxLength={80} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="adm-field">
            <label htmlFor="f-status">Status</label>
            <select id="f-status" className="inp" value={filters.status} onChange={e => set({ status: e.target.value as StatusFilter, overdueOnly: false })}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="in_progress">In progress</option>
              <option value="cleaned">Cleaned</option>
              <option value="invalid">Invalid</option>
              <option value="auto_cleaned">Auto-cleaned</option>
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="f-ward">Ward</label>
            <select id="f-ward" className="inp" value={filters.ward} onChange={e => set({ ward: e.target.value })}>
              <option value="">All wards</option>
              <option value="unassigned">Unassigned</option>
              {wards.map(w => <option key={w.id} value={w.id}>{wardLabel(w)}</option>)}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="f-from">From</label>
            <input id="f-from" className="inp" type="date" value={filters.from} max={filters.to || undefined} onChange={e => set({ from: e.target.value })} />
          </div>
          <div className="adm-field">
            <label htmlFor="f-to">To</label>
            <input id="f-to" className="inp" type="date" value={filters.to} min={filters.from || undefined} onChange={e => set({ to: e.target.value })} />
          </div>
          <label className="adm-check">
            <input type="checkbox" checked={filters.overdueOnly} onChange={e => set({ overdueOnly: e.target.checked, status: e.target.checked ? "" : filters.status })} />
            Overdue only
          </label>
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
            <p>{filtersActive ? "No reports match these filters." : "There are no reports yet."}</p>
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
