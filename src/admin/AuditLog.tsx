import { useEffect, useMemo, useState } from "react";
import { adminRequest, downloadCsv } from "./adminApi.ts";
import { ACTION_LABEL, actorLabel, describeAudit, formatDateTime } from "./format.ts";
import { EMPTY_AUDIT_FILTERS, PAGE_SIZE, auditExportEnvelope, auditFiltersActive, auditPageEnvelope, type AuditFilters, type Scope } from "./queryBuilders.ts";
import { EmptyBox, ErrorBox, Pager } from "./Pieces.tsx";
import type { AuditRow, Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type Props = { scope: Scope; wards: Ward[]; version: number; onOpenReport: (id: string) => void };

// Read-only list of what staff and the system did, newest first. A municipality admin sees only their
// own municipality's rows; the server enforces that.
export default function AuditLog({ scope, wards, version, onOpenReport }: Props) {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ text: string; kind: "ok" | "notice" | "error" } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setFilters(f => (f.actor === actor ? f : { ...f, actor })), 300);
    return () => clearTimeout(timer);
  }, [actor]);
  useEffect(() => { setPage(1); }, [filters]);

  const wardById = useMemo(() => new Map(wards.map(w => [w.id, w])), [wards]);
  const list = useAsync(() => adminRequest<AuditRow[]>(auditPageEnvelope(scope, filters, page)), [scope.municipalityId, filters, page, version]);
  const rows = list.data?.data ?? [];
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_AUDIT_FILTERS);
  const exportFiltered = auditFiltersActive(filters);
  const clear = () => { setActor(""); setFilters(EMPTY_AUDIT_FILTERS); };

  // The file is built on the server from the same filters, through the same builder, as the list above.
  const exportCsv = async () => {
    setExporting(true);
    setExportMessage(null);
    try {
      const result = await downloadCsv(auditExportEnvelope(scope, filters));
      const rowsText = `${result.rows.toLocaleString("en-IN")} ${result.rows === 1 ? "row" : "rows"}`;
      setExportMessage(result.truncated
        ? { kind: "notice", text: `Downloaded the newest ${rowsText}. This is the most one file can hold${result.total ? ` (${result.total.toLocaleString("en-IN")} rows match)` : ""}. Narrow the filters or the dates to get the rest.` }
        : { kind: "ok", text: `Downloaded ${rowsText}.` });
    } catch (e) {
      setExportMessage({ kind: "error", text: e instanceof Error ? e.message : "The export failed. Please try again." });
    } finally {
      setExporting(false);
    }
  };

  return (
    <section aria-label="Audit log" className="adm-panel">
      <p className="adm-muted adm-intro">Every change to a report, newest first. This list cannot be edited.</p>
      <div className="adm-filters">
        <div className="adm-field">
          <label htmlFor="a-action">Action</label>
          <select id="a-action" className="inp" value={filters.action} onChange={e => { const value = e.target.value; setFilters(f => ({ ...f, action: value })); }}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="adm-field adm-field-search">
          <label htmlFor="a-actor">Done by</label>
          <input id="a-actor" className="inp" type="search" value={actor} placeholder="Email, public or system" maxLength={80} onChange={e => setActor(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="a-from">From</label>
          <input id="a-from" className="inp" type="date" value={filters.from} max={filters.to || undefined} onChange={e => { const value = e.target.value; setFilters(f => ({ ...f, from: value })); }} />
        </div>
        <div className="adm-field">
          <label htmlFor="a-to">To</label>
          <input id="a-to" className="inp" type="date" value={filters.to} min={filters.from || undefined} onChange={e => { const value = e.target.value; setFilters(f => ({ ...f, to: value })); }} />
        </div>
        {filtersActive && <button type="button" className="btn-s adm-clear" onClick={clear}>Clear filters</button>}
        <button type="button" className="btn-s adm-export" disabled={exporting} onClick={exportCsv}>{exporting ? "Preparing…" : exportFiltered ? "Export filtered CSV" : "Export all CSV"}</button>
      </div>
      {exportFiltered && <p className="adm-muted adm-export-line">Exports only the rows matching your filters</p>}
      {exportMessage && <p className={`adm-message adm-message-${exportMessage.kind === "error" ? "error" : exportMessage.kind === "notice" ? "info" : "ok"}`} role={exportMessage.kind === "error" ? "alert" : "status"}>{exportMessage.text}</p>}

      {list.error ? (
        <ErrorBox message={list.error} onRetry={list.reload} />
      ) : list.loading && list.data === undefined ? (
        <div className="adm-table-wrap" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="adm-skeleton-row" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyBox>
          <p>{filtersActive ? "Nothing matches these filters." : "Nothing has been recorded yet."}</p>
          {filtersActive && <button type="button" className="btn-s" onClick={clear}>Clear filters</button>}
        </EmptyBox>
      ) : (
        <div className={`adm-table-wrap${list.loading ? " is-loading" : ""}`} aria-busy={list.loading}>
          <table className="adm-table adm-table-audit">
            <thead>
              <tr><th scope="col">When</th><th scope="col">Done by</th><th scope="col">What happened</th><th scope="col"><span className="adm-sr">Open</span></th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td data-label="When"><time dateTime={row.created_at}>{formatDateTime(row.created_at)}</time></td>
                  <td data-label="Done by">{actorLabel(row.actor_email)}</td>
                  <td data-label="What happened">
                    <strong>{ACTION_LABEL[row.action] ?? row.action}</strong>
                    <span className="adm-sub">{describeAudit(row, wardById)}</span>
                    {row.note && <span className="adm-quote">“{row.note}”</span>}
                  </td>
                  <td data-label="">
                    {row.entity_type === "report" && <button type="button" className="btn-s" onClick={() => onOpenReport(row.entity_id)}>Open report</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!list.error && (rows.length > 0 || page > 1) && <Pager page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? null} busy={list.loading} onPage={setPage} />}
    </section>
  );
}
