import { useEffect, useRef, useState, type FormEvent } from "react";
import { AdminApiError, staffRequest } from "./adminApi.ts";
import { formatDate } from "./format.ts";
import { Icon } from "./icons.tsx";
import { EmptyBox, ErrorBox } from "./Pieces.tsx";
import { generatePassword, passwordProblem } from "./password.ts";
import type { MunicipalityInfo, StaffRow } from "./types.ts";
import { useAsync } from "./useAsync.ts";

type Props = { municipalities: MunicipalityInfo[] };
type Created = { email: string; password: string };
type Confirm = { row: StaffRow; activate: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const messageOf = (e: unknown) => (e instanceof AdminApiError ? e.message : "Something went wrong. Please try again.");

// Add admins (super admin only; the server refuses everyone else). Lists staff, adds a municipality admin,
// and switches one on or off. A password exists in this component only while the form is open and in the
// one-time panel after creating: it is never put in the address, storage, a log or an analytics event.
export default function StaffAdmin({ municipalities }: Props) {
  const list = useAsync(() => staffRequest<StaffRow[]>("/api/admin/staff", "GET"), []);
  const rows = list.data ?? [];

  const defaultMunicipality = (municipalities.find(m => m.slug === "jorhat") ?? municipalities[0])?.id ?? "";
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [municipalityId, setMunicipalityId] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<"" | "yes" | "failed">("");

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (confirm) { if (!dialogRef.current?.open) dialogRef.current?.showModal(); } else dialogRef.current?.close();
  }, [confirm]);

  const resetForm = () => { setEmail(""); setPassword(""); setShow(false); setFormError(""); setMunicipalityId(""); };
  const closeForm = () => { resetForm(); setAdding(false); };
  const dismissCreated = () => { setCreated(null); setCopied(""); }; // the password leaves memory here

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    const chosen = municipalityId || defaultMunicipality;
    if (!EMAIL.test(address)) return setFormError("Enter a valid email address.");
    if (!chosen) return setFormError("Choose a municipality.");
    const problem = passwordProblem(password);
    if (problem) return setFormError(problem);
    setSubmitting(true);
    setFormError("");
    try {
      await staffRequest("/api/admin/staff", "POST", { email: address, password, municipality_id: chosen });
      setCreated({ email: address, password });
      setCopied("");
      closeForm(); // clears the password from the form; it now lives only in the one-time panel
      list.reload();
    } catch (error) {
      setFormError(messageOf(error)); // the password stays in the form so the person can try again
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(`Email: ${created.email}\nPassword: ${created.password}`);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };

  const change = async () => {
    if (!confirm) return;
    setWorking(true);
    setActionError("");
    try {
      await staffRequest("/api/admin/staff/status", "POST", { user_id: confirm.row.user_id, is_active: confirm.activate });
      setNotice(`${confirm.row.email} is now ${confirm.activate ? "active" : "inactive"}.`);
      setConfirm(null);
      list.reload();
    } catch (error) {
      setConfirm(null);
      setNotice("");
      setActionError(messageOf(error));
    } finally {
      setWorking(false);
    }
  };

  const problem = passwordProblem(password);
  const strong = password.length > 0 && !problem;

  return (
    <section aria-label="Add admins" className="adm-panel">
      <div className="adm-toolbar">
        <p className="adm-muted adm-intro">People who can sign in to the admin area. A municipal admin sees only their own municipality.</p>
        {!adding && <button type="button" className="btn-p adm-add" onClick={() => { setAdding(true); setMunicipalityId(defaultMunicipality); setNotice(""); setActionError(""); }}><Icon name="plus" size={18} /> Add municipal admin</button>}
      </div>

      {created && (
        <div className="adm-secret" role="status" aria-label="New account details">
          <h3>Account created</h3>
          <dl className="adm-secret-list">
            <dt>Email</dt><dd>{created.email}</dd>
            <dt>Password</dt><dd><code className="adm-secret-code">{created.password}</code></dd>
          </dl>
          <p className="adm-secret-note">Send this to the admin through a secure channel. It will not be shown again.</p>
          <div className="adm-actions">
            <button type="button" className="btn-s" onClick={copy}><Icon name="copy" size={18} /> Copy email and password</button>
            <button type="button" className="btn-p" onClick={dismissCreated}>Done</button>
          </div>
          {copied === "yes" && <p className="adm-message adm-message-ok" role="status">Copied.</p>}
          {copied === "failed" && <p className="adm-message adm-message-error" role="alert">Could not copy. Select the password above and copy it by hand.</p>}
        </div>
      )}

      {adding && (
        <form className="adm-form adm-staff-form" onSubmit={submit} noValidate aria-label="Add municipal admin">
          <h3>Add municipal admin</h3>
          <div className="adm-field">
            <label htmlFor="s-email">Email</label>
            <input id="s-email" className="inp" type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="adm-field">
            <label htmlFor="s-muni">Municipality</label>
            <select id="s-muni" className="inp" value={municipalityId} onChange={e => setMunicipalityId(e.target.value)}>
              {municipalities.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="adm-field">
            <label htmlFor="s-password">Password</label>
            <div className="adm-password">
              <input id="s-password" className="inp" type={show ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={72} value={password} onChange={e => setPassword(e.target.value)} aria-describedby="s-password-help" />
              <button type="button" className="adm-iconbtn" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow(v => !v)}><Icon name={show ? "eyeoff" : "eye"} size={20} /></button>
            </div>
            <p id="s-password-help" className={`adm-hint${strong ? " is-ok" : ""}`}>{strong ? "Long enough." : "At least 12 characters."}</p>
            <button type="button" className="btn-s adm-generate" onClick={() => { setPassword(generatePassword(20)); setShow(true); }}><Icon name="key" size={18} /> Generate strong password</button>
          </div>
          {formError && <p className="adm-message adm-message-error" role="alert">{formError}</p>}
          <div className="adm-actions">
            <button type="submit" className="btn-p" disabled={submitting}>{submitting ? "Creating…" : "Create account"}</button>
            <button type="button" className="btn-s" onClick={closeForm} disabled={submitting}>Cancel</button>
          </div>
        </form>
      )}

      {notice && <p className="adm-message adm-message-ok" role="status">{notice}</p>}
      {actionError && <p className="adm-message adm-message-error" role="alert">{actionError}</p>}

      {list.error ? (
        <ErrorBox message={list.error} onRetry={list.reload} />
      ) : list.loading && list.data === undefined ? (
        <div className="adm-table-wrap" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="adm-skeleton-row" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyBox><p>There are no staff accounts yet.</p></EmptyBox>
      ) : (
        <div className={`adm-table-wrap${list.loading ? " is-loading" : ""}`} aria-busy={list.loading}>
          <table className="adm-table adm-table-staff">
            <thead>
              <tr><th scope="col">Email</th><th scope="col">Municipality</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col"><span className="adm-sr">Actions</span></th></tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const isSuper = row.role === "super_admin";
                return (
                  <tr key={row.user_id}>
                    <td data-label="Email" className="adm-cell-email">{row.email}{isSuper && <span className="adm-sub">Super admin</span>}</td>
                    <td data-label="Municipality">{isSuper ? <span className="adm-muted">All municipalities</span> : row.municipality_name ?? "Unknown"}</td>
                    <td data-label="Status"><span className={`adm-badge ${row.is_active ? "adm-badge-on" : "adm-badge-off"}`}>{row.is_active ? "Active" : "Inactive"}</span></td>
                    <td data-label="Created">{formatDate(row.created_at)}</td>
                    <td data-label="">
                      {!isSuper && (row.is_active
                        ? <button type="button" className="btn-s" onClick={() => { setNotice(""); setActionError(""); setConfirm({ row, activate: false }); }}>Deactivate</button>
                        : <button type="button" className="btn-s" onClick={() => { setNotice(""); setActionError(""); setConfirm({ row, activate: true }); }}>Reactivate</button>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <dialog ref={dialogRef} className="adm-dialog" aria-labelledby="staff-confirm-title" onClose={() => setConfirm(null)}>
        {confirm && (
          <div>
            <h3 id="staff-confirm-title">{confirm.activate ? "Reactivate this account?" : "Deactivate this account?"}</h3>
            <p className="adm-dialog-text">
              {confirm.activate
                ? <>{confirm.row.email} will be able to sign in again.</>
                : <>{confirm.row.email} will lose access <strong>immediately</strong>. Their next request is refused, even if they are signed in now. You can reactivate the account later.</>}
            </p>
            <div className="adm-actions">
              <button type="button" className="btn-s" onClick={() => setConfirm(null)} disabled={working}>Cancel</button>
              <button type="button" className="btn-p" onClick={change} disabled={working}>{working ? "Working…" : confirm.activate ? "Reactivate" : "Deactivate"}</button>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
}
