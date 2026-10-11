import { useState } from "react";
import { adminRequest, saveFile } from "./adminApi.ts";
import { days, isMonth, monthLabel, monthValue, monthlyCsv, monthlyName } from "./reportTables.ts";
import { monthlyEnvelope, type Scope } from "./queryBuilders.ts";
import { EmptyBox, ErrorBox } from "./Pieces.tsx";
import type { MonthlyRow } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type Props = { scope: Scope; municipalityName: string; overdueDays: number; version: number };

const COLUMNS: { key: keyof MonthlyRow; label: string; hint: string }[] = [
  { key: "received", label: "Received", hint: "Reports received in the month" },
  { key: "cleaned", label: "Cleaned", hint: "Cleaned in the month by JMB or a citizen. The nightly sweep is not counted." },
  { key: "auto_cleaned", label: "Auto-cleaned", hint: "Closed by the nightly sweep in the month. Never counted as cleaned." },
  { key: "active", label: "Active", hint: "Still active at the end of the month, from all reports received up to then" },
  { key: "in_progress", label: "In progress", hint: "In progress at the end of the month" },
  { key: "invalid", label: "Invalid", hint: "Invalid or hidden at the end of the month" },
  { key: "overdue", label: "Overdue", hint: "Active at the end of the month for longer than the overdue limit" },
];

// One month, ward by ward. The same numbers can be saved as CSV or printed (the browser can save a print as PDF).
export default function MonthlyReport({ scope, municipalityName, overdueDays, version }: Props) {
  const current = monthValue();
  const [month, setMonth] = useState(current);
  const valid = isMonth(month) && month <= current;
  const report = useAsync(
    async () => (valid ? (await adminRequest<MonthlyRow[]>(monthlyEnvelope(scope, month))).data : []),
    [scope.municipalityId, month, valid, version],
  );
  const rows = report.data ?? [];
  const received = rows.find(r => r.kind === "total")?.received ?? 0;
  const label = valid ? monthLabel(month) : "";
  const generated = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

  return (
    <section aria-label="Monthly ward report" className="adm-panel adm-report">
      <div className="adm-print-title">
        <p className="adm-eyebrow">JABOR · {municipalityName.toUpperCase()}</p>
        <h2>Monthly ward report{label ? `: ${label}` : ""}</h2>
        <p className="adm-muted">Prepared {generated}</p>
      </div>
      <div className="adm-filters adm-noprint">
        <div className="adm-field">
          <label htmlFor="m-month">Month</label>
          <input id="m-month" className="inp" type="month" value={month} max={current} min="2024-01" onChange={e => setMonth(e.target.value)} />
        </div>
        <button type="button" className="btn-s" disabled={!valid || report.loading || rows.length === 0} onClick={() => saveFile(monthlyCsv(rows), `jabor-monthly-ward-report-${month}.csv`)}>Export CSV</button>
        <button type="button" className="btn-s" disabled={!valid || report.loading || rows.length === 0} onClick={() => window.print()}>Print or save as PDF</button>
      </div>

      {!valid ? (
        <EmptyBox><p>Choose a month, up to the current one.</p></EmptyBox>
      ) : report.error ? (
        <ErrorBox message={report.error} onRetry={report.reload} />
      ) : report.loading && report.data === undefined ? (
        <div className="adm-table-wrap" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="adm-skeleton-row" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyBox><p>No ward information for this municipality yet.</p></EmptyBox>
      ) : (
        <>
          {received === 0 && <p className="adm-note" role="status">No reports were received in {label}. The Active, In progress and Invalid columns still show the reports waiting at the end of the month.</p>}
          <div className={`adm-table-wrap${report.loading ? " is-loading" : ""}`} aria-busy={report.loading}>
            <table className="adm-rtable">
              <caption className="adm-sr">Reports per ward for {label}</caption>
              <thead>
                <tr>
                  <th scope="col">Ward</th>
                  {COLUMNS.map(c => <th key={c.key} scope="col" className="adm-num" title={c.hint}>{c.label}</th>)}
                  <th scope="col" className="adm-num" title="Days from received to cleaned, for the reports counted as cleaned">Median days to clean</th>
                  <th scope="col" className="adm-num" title="Average days from received to cleaned">Average days to clean</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.ward_id ?? row.kind} className={row.kind === "total" ? "adm-row-total" : undefined}>
                    <th scope="row" data-label="Ward">{monthlyName(row)}</th>
                    {COLUMNS.map(c => <td key={c.key} className="adm-num" data-label={c.label}>{String(row[c.key] ?? 0)}</td>)}
                    <td className="adm-num" data-label="Median days">{days(row.median_days)}</td>
                    <td className="adm-num" data-label="Average days">{days(row.avg_days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="adm-notes">
            <p><strong>How to read this.</strong> Received and Cleaned count what happened in {label}. Active, In progress, Invalid and Overdue show where every report received up to the end of {label} stood on its last day, rebuilt from the audit log. For the current month that is today, so these match the dashboard tiles.</p>
            <p>Overdue means Active for more than {overdueDays} days. Cleaned counts reports cleaned by JMB or a citizen. Reports closed by the nightly sweep are shown as Auto-cleaned and are left out of Cleaned and of the days to clean. A report is shown under the ward it has now.</p>
          </div>
        </>
      )}
    </section>
  );
}
