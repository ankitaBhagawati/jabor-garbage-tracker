import { adminRequest } from "./adminApi.ts";
import { TILE_ROUTE, formatRoute, type Route } from "./route.ts";
import { TILE_KEYS, districtsEnvelope, tileEnvelope, type Scope, type TileKey } from "./queryBuilders.ts";
import { useAsync } from "./useAsync.ts";

type Props = {
  scope: Scope;
  viewAll: boolean; // a super admin looking at every municipality: no ward figures
  overdueDays: number;
  version: number;
  onNavigate: (route: Route) => void;
};

const TILE_INFO: Record<TileKey, { label: string; hint: string }> = {
  total: { label: "Total", hint: "Every report" },
  active: { label: "Active", hint: "Waiting for action" },
  in_progress: { label: "In progress", hint: "Being worked on" },
  cleaned: { label: "Cleaned", hint: "Cleaned by JMB or citizens" },
  invalid: { label: "Invalid", hint: "Spam, duplicates, hidden" },
  overdue: { label: "Overdue", hint: "" },
  unassigned: { label: "Unassigned wards", hint: "No ward yet, not invalid or hidden" },
  auto_cleaned: { label: "Auto-cleaned", hint: "Closed by the nightly sweep, not counted as cleaned" },
};

// A tile needs only the count the server reports (one cheap request per tile, so a slow one never blocks the others).
function Tile({ tile, scope, overdueDays, version, onOpen }: { tile: TileKey; scope: Scope; overdueDays: number; version: number; onOpen: () => void }) {
  const result = useAsync(async () => ({ total: (await adminRequest<unknown[]>(tileEnvelope(tile, scope, new Date(), overdueDays))).total }), [tile, scope.municipalityId, overdueDays, version]);
  const info = TILE_INFO[tile];
  const hint = tile === "overdue" ? `Active for more than ${overdueDays} days` : info.hint;
  return (
    <a
      className={`adm-tile adm-tile-${tile}`}
      href={formatRoute(TILE_ROUTE[tile])}
      title={hint}
      onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in a new tab" work
        e.preventDefault();
        if (result.error) result.reload(); else onOpen();
      }}
    >
      <span className="adm-tile-label">{info.label}</span>
      <span className="adm-tile-value" aria-live="polite">
        {result.error ? <span className="adm-tile-error">n/a</span> : result.data === undefined ? <span className="adm-skeleton" aria-label="Loading" /> : result.data.total ?? 0}
      </span>
      <span className="adm-tile-hint">{result.error ? "Could not load. Click to try again." : hint}</span>
    </a>
  );
}

// View all: the districts the reports come from, with how many reports each has. Counted from the latest reports
// (the server returns at most DISTRICT_SAMPLE rows), and says so when the list was cut.
const DISTRICT_SAMPLE = 1000;
function Districts({ scope, version }: { scope: Scope; version: number }) {
  const result = useAsync(async () => (await adminRequest<{ district: string }[]>(districtsEnvelope(scope))).data, [scope.municipalityId, version]);
  const rows = result.data ?? [];
  const counts = new Map<string, number>();
  for (const { district } of rows) { const name = district.trim(); if (name) counts.set(name, (counts.get(name) ?? 0) + 1); }
  const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return (
    <section aria-label="Districts" className="adm-panel">
      <h2 className="adm-h2">Districts{result.data ? <span className="adm-muted"> ({list.length})</span> : null}</h2>
      {result.error ? <p className="adm-muted">Could not load the districts.</p>
        : result.data === undefined ? <p className="adm-muted" aria-busy="true">Loading…</p>
        : list.length === 0 ? <p className="adm-muted">No reports with a district yet.</p>
        : (
          <>
            <p className="adm-muted">{list.length} {list.length === 1 ? "district has" : "districts have"} reports. The number is how many reports each has.</p>
            <ul className="adm-districts">{list.map(([name, count]) => <li key={name}><span>{name}</span><strong>{count}</strong></li>)}</ul>
            {rows.length >= DISTRICT_SAMPLE && <p className="adm-muted adm-note-small">Counted from the latest {DISTRICT_SAMPLE} reports.</p>}
          </>
        )}
    </section>
  );
}

export default function Dashboard({ scope, viewAll, overdueDays, version, onNavigate }: Props) {
  // View all (no municipality) has no ward figures: wards belong to one municipality.
  const tiles = !viewAll ? TILE_KEYS : TILE_KEYS.filter(tile => tile !== "unassigned");
  return (
    <div>
      <p className="adm-muted adm-intro">Select a number to see those reports.</p>
      <section aria-label="Summary" className="adm-tiles">
        {tiles.map(tile => (
          <Tile key={tile} tile={tile} scope={scope} overdueDays={overdueDays} version={version} onOpen={() => onNavigate(TILE_ROUTE[tile])} />
        ))}
      </section>
      {viewAll && <Districts scope={scope} version={version} />}
    </div>
  );
}
