import { useState } from "react";
import { adminRequest, saveFile } from "./adminApi.ts";
import { wardLabel } from "./format.ts";
import { HOTSPOT_FORMULA, SMALL_SAMPLE, days, hotspotCsv, isSmallSample } from "./reportTables.ts";
import { hotspotsEnvelope, type Scope } from "./queryBuilders.ts";
import { EmptyBox, ErrorBox } from "./Pieces.tsx";
import type { HotspotRow, HotspotWindow } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type Props = { scope: Scope; version: number };

const WINDOWS: HotspotWindow[] = [30, 60, 90];
const TOP = 10;

// A plain SVG bar chart of the highest scores. No map, no coordinates: wards only.
function ScoreChart({ rows }: { rows: HotspotRow[] }) {
  const top = rows.slice(0, TOP);
  const max = Math.max(1, ...top.map(r => r.score));
  const rowH = 28, labelW = 120, width = 560, barW = width - labelW - 44;
  return (
    <svg className="adm-chart" viewBox={`0 0 ${width} ${top.length * rowH + 4}`} role="img" aria-label={`Bar chart of the ${top.length} highest hotspot scores by ward`}>
      {top.map((r, i) => (
        <g key={r.ward_id} transform={`translate(0 ${i * rowH + 2})`}>
          <text x={labelW - 8} y={rowH / 2 + 4} textAnchor="end" className="adm-chart-label">{`Ward ${r.ward_number}`}</text>
          <rect x={labelW} y={4} width={Math.max(2, (r.score / max) * barW)} height={rowH - 10} rx={4} className={isSmallSample(r) ? "adm-bar adm-bar-small" : "adm-bar"} />
          <text x={labelW + Math.max(2, (r.score / max) * barW) + 6} y={rowH / 2 + 4} className="adm-chart-value">{r.score}</text>
        </g>
      ))}
    </svg>
  );
}

export default function Hotspots({ scope, version }: Props) {
  const [span, setSpan] = useState<HotspotWindow>(30);
  const result = useAsync(async () => (await adminRequest<HotspotRow[]>(hotspotsEnvelope(scope, span))).data, [scope.municipalityId, span, version]);
  const rows = result.data ?? [];
  const anyReports = rows.some(r => r.reports > 0);

  return (
    <section aria-label="Ward hotspots" className="adm-panel">
      <p className="adm-muted adm-intro">Which wards need attention first. Staff only: this is never shown to the public, and it shows wards, not places on a map.</p>
      <div className="adm-filters">
        <div className="adm-field">
          <label htmlFor="h-window">Reports from the last</label>
          <select id="h-window" className="inp" value={span} onChange={e => setSpan(Number(e.target.value) as HotspotWindow)}>
            {WINDOWS.map(w => <option key={w} value={w}>{w} days</option>)}
          </select>
        </div>
        <button type="button" className="btn-s" disabled={result.loading || rows.length === 0} onClick={() => saveFile(hotspotCsv(rows), `jabor-ward-hotspots-${span}-days.csv`)}>Export CSV</button>
      </div>

      {result.error ? (
        <ErrorBox message={result.error} onRetry={result.reload} />
      ) : result.loading && result.data === undefined ? (
        <div className="adm-table-wrap" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="adm-skeleton-row" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyBox><p>No ward information for this municipality yet.</p></EmptyBox>
      ) : (
        <>
          {!anyReports && <p className="adm-note" role="status">No reports in the last {span} days, so no ward stands out.</p>}
          <p className="adm-formula">
            <strong>Score</strong> = <span title="An overdue report is also active, so it counts 3 + 1.">{HOTSPOT_FORMULA}</span>. Higher means more attention needed.
          </p>
          {anyReports && <ScoreChart rows={rows} />}
          <div className={`adm-table-wrap${result.loading ? " is-loading" : ""}`} aria-busy={result.loading}>
            <table className="adm-rtable">
              <caption className="adm-sr">Wards ranked by hotspot score, reports from the last {span} days</caption>
              <thead>
                <tr>
                  <th scope="col" className="adm-num">Rank</th>
                  <th scope="col">Ward</th>
                  <th scope="col" className="adm-num" title="Reports received in the window, not counting invalid ones">Reports</th>
                  <th scope="col" className="adm-num" title="Of those, still active">Active</th>
                  <th scope="col" className="adm-num" title="Of those, active for longer than the overdue limit">Overdue</th>
                  <th scope="col" className="adm-num" title="Places (landmark, else locality) named by two or more reports">Repeat places</th>
                  <th scope="col" className="adm-num" title="Days from received to cleaned. Reports closed by the nightly sweep are left out.">Avg days to clean</th>
                  <th scope="col" className="adm-num" title={`Score = ${HOTSPOT_FORMULA}`}>Score</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.ward_id}>
                    <td className="adm-num" data-label="Rank">{r.rank}</td>
                    <th scope="row" data-label="Ward">
                      {wardLabel({ number: r.ward_number, name: r.ward_name })}
                      {isSmallSample(r) && <span className="adm-badge adm-badge-small" title={`Fewer than ${SMALL_SAMPLE} reports: do not read too much into this rank`}>Small sample</span>}
                    </th>
                    <td className="adm-num" data-label="Reports">{r.reports}</td>
                    <td className="adm-num" data-label="Active">{r.active}</td>
                    <td className="adm-num" data-label="Overdue">{r.overdue}</td>
                    <td className="adm-num" data-label="Repeat places">{r.repeat_locations}</td>
                    <td className="adm-num" data-label="Avg days">{days(r.avg_days_to_clean)}</td>
                    <td className="adm-num" data-label="Score"><strong>{r.score}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="adm-muted adm-note-small">A ward with fewer than {SMALL_SAMPLE} reports in the window is marked <em>Small sample</em>; its place in the ranking says little. Reports without a ward are not ranked.</p>
        </>
      )}
    </section>
  );
}
