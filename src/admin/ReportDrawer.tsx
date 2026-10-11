import { useEffect, useMemo, useRef, useState } from "react";
import { restJson } from "../services/supabaseRest.js";
import { AdminApiError, adminRequest } from "./adminApi.ts";
import {
  ACTION_LABEL_TEXT, INVALID_REASONS, WASTE_LABEL, actionsFor, actorLabel, ageDays, ageLabel, buildNotePatch, buildStatusPatch,
  describeAudit, formatDate, formatDateTime, isOverdue, statusOf, todayISO, wardLabel, type ActionId,
} from "./format.ts";
import { historyEnvelope, patchReportEnvelope, reportEnvelope } from "./queryBuilders.ts";
import { ErrorBox, OverdueBadge, StatusBadge } from "./Pieces.tsx";
import type { AuditRow, ReportDetail, Ward } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type Props = {
  reportId: string;
  wards: Ward[];
  overdueDays: number;
  onClose: () => void;
  onChanged: () => void;
  onPhotoClick: (url: string) => void;
};

type Message = { kind: "ok" | "error"; text: string } | null;

// The cleaned report's "after" photo is the approved citizen proof, which the public view already shows.
async function afterPhoto(reportId: string): Promise<string | null> {
  try {
    const rows = await restJson(`/rest/v1/public_reports?select=cleanup_photo_url&id=eq.${encodeURIComponent(reportId)}&limit=1`);
    return Array.isArray(rows) && rows[0]?.cleanup_photo_url ? String(rows[0].cleanup_photo_url) : null;
  } catch {
    return null; // an optional extra: never an error on the page
  }
}

export default function ReportDrawer({ reportId, wards, overdueDays, onClose, onChanged, onPhotoClick }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const detail = useAsync(async () => (await adminRequest<ReportDetail[]>(reportEnvelope(reportId))).data[0] ?? null, [reportId]);
  const history = useAsync(async () => (await adminRequest<AuditRow[]>(historyEnvelope(reportId))).data, [reportId]);
  const after = useAsync(() => afterPhoto(reportId), [reportId]);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [open, setOpen] = useState<ActionId | null>(null);
  const [form, setForm] = useState({ name: "JMB team", date: todayISO(), reason: "", note: "" });
  const [wardChoice, setWardChoice] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const report = detail.data ?? null;
  const wardById = useMemo(() => new Map(wards.map(w => [w.id, w])), [wards]);
  const now = new Date();
  const status = report ? statusOf(report) : null;
  const hidden = Boolean(report?.is_deleted);
  const currentWard = report?.ward_id ?? "";
  const selectedWard = wardChoice ?? currentWard;
  const note = noteDraft ?? report?.admin_note ?? "";

  // Sends one update through the proxy, then reloads this report, its history and the lists behind the drawer.
  async function send(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      const { data } = await adminRequest<ReportDetail[]>(patchReportEnvelope(reportId, body));
      if (!Array.isArray(data) || data.length === 0) throw new AdminApiError("That report could not be updated. It may have been changed or removed; reload and try again.", 0);
      setMessage({ kind: "ok", text: success });
      setOpen(null);
      setWardChoice(null);
      setNoteDraft(null);
      setForm(f => ({ ...f, reason: "", note: "" }));
      detail.reload();
      history.reload();
      after.reload();
      onChanged();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  function runAction(action: ActionId) {
    const result = buildStatusPatch(action, { name: form.name, date: form.date, reason: form.reason, note: form.note, currentNote: report?.admin_note ?? null });
    if ("error" in result) { setMessage({ kind: "error", text: result.error }); return; }
    const done: Record<ActionId, string> = {
      start: "Marked In progress.", back_to_active: "Moved back to Active.", clean: "Marked Cleaned.", invalid: "Marked Invalid.", reopen: "Reopened as Active.",
    };
    send(result.body, done[action]);
  }

  function chooseAction(action: ActionId) {
    setMessage(null);
    if (action === "start" || action === "back_to_active") runAction(action);
    else setOpen(open === action ? null : action);
  }

  function saveNote() {
    const result = buildNotePatch(note, report?.admin_note ?? null);
    if ("error" in result) { setMessage({ kind: "error", text: result.error }); return; }
    send(result.body, "Note saved.");
  }

  function saveWard() {
    send({ ward_id: selectedWard || null }, selectedWard ? "Ward saved." : "Ward cleared.");
  }

  const isOpenForm = (action: ActionId) => open === action;
  const history_ = history.data ?? [];

  return (
    <dialog ref={dialogRef} className="adm-drawer" aria-labelledby="drawer-title" onClose={onClose} onClick={e => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}>
      <div className="adm-drawer-body">
        <header className="adm-drawer-head">
          <div>
            <h2 id="drawer-title">{report?.area || (detail.loading ? "Loading report" : "Report")}</h2>
            {report?.landmark && <p className="adm-sub">{report.landmark}</p>}
          </div>
          <button type="button" className="btn-s" onClick={() => dialogRef.current?.close()} autoFocus>Close</button>
        </header>

        {detail.error ? (
          <ErrorBox message={detail.error} onRetry={detail.reload} />
        ) : detail.loading && !report ? (
          <div aria-busy="true"><div className="adm-skeleton-row" /><div className="adm-skeleton-row" /><div className="adm-skeleton-row" /></div>
        ) : !report || !status ? (
          <div className="adm-state"><p>This report was not found. It may belong to another municipality or have been removed.</p></div>
        ) : (
          <>
            <div className="adm-drawer-status">
              <StatusBadge status={status} hidden={hidden} />
              {isOverdue(report, overdueDays, now) && <OverdueBadge />}
              <span className="adm-muted">{ageDays(report.created_at, now) === 0 ? "Received today" : `${ageLabel(ageDays(report.created_at, now))} old, received ${formatDate(report.created_at)}`}</span>
            </div>

            {message && <p className={`adm-message adm-message-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}

            <section className="adm-photos" aria-label="Photos">
              <figure>
                {report.photo_url ? (
                  <button type="button" className="adm-photo" onClick={() => onPhotoClick(report.photo_url as string)} aria-label="Open the report photo">
                    <img src={report.photo_url} alt="Garbage as reported" />
                  </button>
                ) : <div className="adm-nophoto-large">No photo</div>}
                <figcaption>As reported</figcaption>
              </figure>
              {after.data && (
                <figure>
                  <button type="button" className="adm-photo" onClick={() => onPhotoClick(after.data as string)} aria-label="Open the cleanup photo">
                    <img src={after.data} alt="After cleanup" />
                  </button>
                  <figcaption>After cleanup</figcaption>
                </figure>
              )}
            </section>

            <dl className="adm-facts">
              <dt>Waste</dt><dd>{WASTE_LABEL[report.waste_type ?? ""] ?? report.waste_type ?? "Not given"}</dd>
              <dt>Location</dt><dd>{[report.district, report.constituency].filter(Boolean).join(", ") || "Not given"}</dd>
              <dt>Ward</dt><dd>{report.ward_id && wardById.get(report.ward_id) ? wardLabel(wardById.get(report.ward_id) as Ward) : <span className="adm-muted">Unassigned</span>}</dd>
              {report.claimed_in_municipality && <><dt>Reporter said</dt><dd>{{ yes: "Inside the municipal area", no: "Outside the municipal area", not_sure: "Not sure" }[report.claimed_in_municipality] ?? report.claimed_in_municipality}</dd></>}
              {status === "cleaned" && <>
                <dt>Cleaned by</dt><dd>{report.cleaned_by_name || "Not recorded"}{report.cleaned_by_type ? ` (${report.cleaned_by_type === "auto" ? "automatic sweep" : report.cleaned_by_type.toUpperCase()})` : ""}</dd>
                {report.cleaned_at && <><dt>Cleaned on</dt><dd>{formatDate(report.cleaned_at)}</dd></>}
              </>}
              {status === "invalid" && report.invalid_reason && <><dt>Reason</dt><dd>{INVALID_REASONS.find(r => r.value === report.invalid_reason)?.label ?? report.invalid_reason}</dd></>}
              {report.assigned_to_text && <><dt>Assigned to</dt><dd>{report.assigned_to_text}{report.due_at ? `, due ${formatDate(report.due_at)}` : ""}</dd></>}
            </dl>
            {report.description && <p className="adm-description">{report.description}</p>}

            {hidden ? (
              <p className="adm-message adm-message-info">This report is hidden from the public site. It can be restored from the Hidden tab by the owner.</p>
            ) : (
              <>
                <section aria-label="Status" className="adm-block">
                  <h3>Status</h3>
                  <div className="adm-actions">
                    {actionsFor(status).map(action => (
                      <button key={action} type="button" className={action === "clean" ? "btn-p" : "btn-s"} disabled={busy} aria-expanded={action === "start" || action === "back_to_active" ? undefined : isOpenForm(action)} onClick={() => chooseAction(action)}>
                        {ACTION_LABEL_TEXT[action]}
                      </button>
                    ))}
                  </div>

                  {isOpenForm("clean") && (
                    <form className="adm-form" onSubmit={e => { e.preventDefault(); runAction("clean"); }}>
                      <label htmlFor="d-name">Cleaned by</label>
                      <input id="d-name" className="inp" value={form.name} maxLength={120} onChange={e => { const value = e.target.value; setForm(f => ({ ...f, name: value })); }} />
                      <label htmlFor="d-date">Date cleaned</label>
                      <input id="d-date" className="inp" type="date" value={form.date} max={todayISO()} onChange={e => { const value = e.target.value; setForm(f => ({ ...f, date: value })); }} />
                      <label htmlFor="d-cnote">Note (optional)</label>
                      <textarea id="d-cnote" className="inp" rows={2} maxLength={1000} value={form.note} onChange={e => { const value = e.target.value; setForm(f => ({ ...f, note: value })); }} />
                      <p className="adm-muted">Recorded as cleaned by JMB.</p>
                      <div className="adm-actions"><button type="submit" className="btn-p" disabled={busy}>{busy ? "Saving…" : "Confirm cleaned"}</button><button type="button" className="btn-s" disabled={busy} onClick={() => setOpen(null)}>Cancel</button></div>
                    </form>
                  )}
                  {isOpenForm("invalid") && (
                    <form className="adm-form" onSubmit={e => { e.preventDefault(); runAction("invalid"); }}>
                      <label htmlFor="d-reason">Reason</label>
                      <select id="d-reason" className="inp" value={form.reason} onChange={e => { const value = e.target.value; setForm(f => ({ ...f, reason: value })); }}>
                        <option value="">Choose a reason</option>
                        {INVALID_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                      <label htmlFor="d-inote">Note (required)</label>
                      <textarea id="d-inote" className="inp" rows={3} maxLength={1000} value={form.note} onChange={e => { const value = e.target.value; setForm(f => ({ ...f, note: value })); }} />
                      <div className="adm-actions"><button type="submit" className="btn-p" disabled={busy}>{busy ? "Saving…" : "Confirm invalid"}</button><button type="button" className="btn-s" disabled={busy} onClick={() => setOpen(null)}>Cancel</button></div>
                    </form>
                  )}
                  {isOpenForm("reopen") && (
                    <form className="adm-form" onSubmit={e => { e.preventDefault(); runAction("reopen"); }}>
                      <label htmlFor="d-rnote">Why is it being reopened? (required)</label>
                      <textarea id="d-rnote" className="inp" rows={3} maxLength={1000} value={form.note} onChange={e => { const value = e.target.value; setForm(f => ({ ...f, note: value })); }} />
                      <div className="adm-actions"><button type="submit" className="btn-p" disabled={busy}>{busy ? "Saving…" : "Confirm reopen"}</button><button type="button" className="btn-s" disabled={busy} onClick={() => setOpen(null)}>Cancel</button></div>
                    </form>
                  )}
                </section>

                <section aria-label="Ward" className="adm-block">
                  <h3>Ward</h3>
                  <div className="adm-inline">
                    <label htmlFor="d-ward" className="adm-sr">Ward</label>
                    <select id="d-ward" className="inp" value={selectedWard} disabled={busy} onChange={e => setWardChoice(e.target.value)}>
                      <option value="">Unassigned</option>
                      {wards.map(w => <option key={w.id} value={w.id}>{wardLabel(w)}</option>)}
                    </select>
                    <button type="button" className="btn-s" disabled={busy || selectedWard === currentWard} onClick={saveWard}>Save ward</button>
                  </div>
                </section>

                <section aria-label="Internal note" className="adm-block">
                  <h3>Internal note</h3>
                  <label htmlFor="d-note" className="adm-sr">Internal note</label>
                  <textarea id="d-note" className="inp" rows={3} maxLength={1000} value={note} placeholder="Only staff can see this" disabled={busy} onChange={e => setNoteDraft(e.target.value)} />
                  <div className="adm-actions"><button type="button" className="btn-s" disabled={busy || note.trim() === (report.admin_note ?? "").trim()} onClick={saveNote}>Save note</button></div>
                </section>
              </>
            )}
          </>
        )}

        <section aria-label="History" className="adm-block">
          <h3>History</h3>
          {history.error ? (
            <ErrorBox message={history.error} onRetry={history.reload} />
          ) : history.loading && history.data === undefined ? (
            <div aria-busy="true"><div className="adm-skeleton-row" /><div className="adm-skeleton-row" /></div>
          ) : history_.length === 0 ? (
            <p className="adm-muted">No history yet.</p>
          ) : (
            <ol className="adm-timeline">
              {history_.map(row => (
                <li key={row.id}>
                  <time dateTime={row.created_at}>{formatDateTime(row.created_at)}</time>
                  <p>{describeAudit(row, wardById)}</p>
                  <p className="adm-muted">by {actorLabel(row.actor_email)}</p>
                  {row.note && <blockquote>{row.note}</blockquote>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </dialog>
  );
}
