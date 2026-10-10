import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHiddenReports, restoreReport } from "../services/reportService.js";

// Admin "Hidden" tab: reports that are off the public site, with who hid them and why,
// and a Restore action. Nothing here deletes anything.

type HiddenReport = {
  id: string;
  photo_url: string | null;
  area: string | null;
  landmark: string | null;
  district: string | null;
  status: string;
  is_deleted: boolean | null;
  updated_at: string;
  hidden_at: string | null;
  hidden_by: string | null;
  hidden_reason: string | null;
  hidden_note: string | null;
};

type Props = {
  onChanged?: () => void;
  onPhotoClick: (url: string) => void;
};

const REASONS: Record<string, string> = {
  spam: "Spam",
  duplicate: "Duplicate",
  outside_jurisdiction: "Outside jurisdiction",
  other: "Other",
};

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// What Restore will do, in the words shown to the admin.
function restoreEffect(report: HiddenReport) {
  if (!report.is_deleted) return "It will go back to Active on the public site.";
  if (report.status === "cleaned") return "It will show again on the public site as Cleaned.";
  if (report.status === "invalid" || report.status === "rejected") return "It will be unhidden but stay marked invalid. Restore it once more to make it Active.";
  return "It will show again on the public site as Active.";
}

export default function HiddenReports({ onChanged, onPhotoClick }: Props) {
  const [reports, setReports] = useState<HiddenReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<HiddenReport | null>(null);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReports(await fetchHiddenReports());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load hidden reports.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDialog = (report: HiddenReport) => {
    setSelected(report);
    setNote("");
    dialogRef.current?.showModal();
  };

  const closeDialog = () => {
    dialogRef.current?.close();
    setSelected(null);
  };

  const confirmRestore = async () => {
    if (!selected) return;
    setWorking(true);
    setError("");
    try {
      await restoreReport(selected, note);
      closeDialog();
      await load();
      onChanged?.();
    } catch (e) {
      closeDialog();
      setError(e instanceof Error ? e.message : "Could not restore the report.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 800 }}>Hidden ({reports.length})</h2>
        <button className="btn-s" style={{ padding: "7px 12px", fontSize: 12 }} onClick={load} disabled={loading}>Refresh</button>
      </div>
      <p style={{ color: "#3C4A42", fontSize: 12, marginBottom: 12 }}>
        Reports that are not shown on the public site. Restoring puts a report back; nothing is ever deleted.
      </p>

      {error && <p role="alert" style={{ color: "#DC2626", fontSize: 13, marginBottom: 12 }}>{error}</p>}
      {loading && <p style={{ fontSize: 13, color: "#3C4A42" }}>Loading hidden reports…</p>}
      {!loading && !error && reports.length === 0 && (
        <p style={{ fontSize: 13, color: "#3C4A42", padding: "24px 0", textAlign: "center" }}>No hidden reports.</p>
      )}

      {!loading && reports.length > 0 && (
        <div style={{ display: "grid", gap: 10 }}>
          {reports.map(report => (
            <div key={report.id} className="card admin-card">
              <div className="admin-photo-pair">
                {report.photo_url ? (
                  <button type="button" onClick={() => onPhotoClick(report.photo_url as string)} aria-label="Open photo preview"
                    style={{ border: 0, padding: 0, background: "none", cursor: "zoom-in" }}>
                    <img className="admin-thumb" src={report.photo_url} alt="Hidden report" />
                  </button>
                ) : (
                  <div className="admin-thumb admin-thumb-fallback">No report image</div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>
                  {report.area || "Unknown area"}{report.district ? `, ${report.district}` : ""}
                </div>
                {report.landmark && <div style={{ fontSize: 12, color: "#3C4A42" }}>{report.landmark}</div>}
                <dl style={{ fontSize: 12, color: "#3C4A42", marginTop: 6, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8, rowGap: 2 }}>
                  <dt>Hidden</dt>
                  <dd>{report.hidden_at ? formatDate(report.hidden_at) : `Before the audit log (last changed ${formatDate(report.updated_at)})`}</dd>
                  <dt>By</dt>
                  <dd>{report.hidden_by || "Not recorded"}</dd>
                  <dt>Why</dt>
                  <dd>
                    {report.hidden_reason ? (REASONS[report.hidden_reason] || report.hidden_reason) : "Not recorded"}
                    {report.hidden_note ? `: ${report.hidden_note}` : ""}
                  </dd>
                  <dt>State</dt>
                  <dd>{report.is_deleted ? `Hidden (status ${report.status})` : "Marked invalid"}</dd>
                </dl>
              </div>
              <div className="admin-actions">
                <button className="btn-p" onClick={() => openDialog(report)}>Restore</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <dialog ref={dialogRef} onClose={() => setSelected(null)} aria-labelledby="restore-title"
        // margin auto: the app's CSS reset removes the default that centres a modal dialog.
        style={{ border: "1px solid #BBCABF", borderRadius: 12, padding: 20, maxWidth: 420, width: "calc(100% - 32px)", margin: "auto" }}>
        {selected && (
          <form method="dialog" onSubmit={e => { e.preventDefault(); confirmRestore(); }}>
            <h3 id="restore-title" style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>Restore this report?</h3>
            <p style={{ fontSize: 13, color: "#3C4A42", marginBottom: 12 }}>
              {selected.area || "This report"}: {restoreEffect(selected)}
            </p>
            <label className="lbl" htmlFor="restore-note">NOTE (OPTIONAL)</label>
            <textarea id="restore-note" className="inp" rows={3} maxLength={500} value={note}
              onChange={e => setNote(e.target.value)} placeholder="Why is it being restored?" />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button type="button" className="btn-s" onClick={closeDialog} disabled={working}>Cancel</button>
              <button type="submit" className="btn-p" disabled={working}>{working ? "Restoring…" : "Restore"}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
