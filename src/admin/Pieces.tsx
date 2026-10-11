import type { ReactNode } from "react";
import { STATUS_LABEL } from "./format.ts";
import type { Status } from "./types.ts";

export function StatusBadge({ status, hidden }: { status: Status; hidden?: boolean }) {
  return <span className={`adm-badge adm-badge-${status}`}>{STATUS_LABEL[status]}{hidden ? " (hidden)" : ""}</span>;
}

export const OverdueBadge = () => <span className="adm-badge adm-badge-overdue">Overdue</span>;

// A message with a retry button, used for every list that can fail to load.
export function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="adm-state" role="alert">
      <p>{message}</p>
      <button type="button" className="btn-s" onClick={onRetry}>Try again</button>
    </div>
  );
}

export const EmptyBox = ({ children }: { children: ReactNode }) => <div className="adm-state">{children}</div>;

export function Pager({ page, pageSize, total, busy, onPage }: { page: number; pageSize: number; total: number | null; busy: boolean; onPage: (page: number) => void }) {
  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = total === null ? page * pageSize : Math.min(total, page * pageSize);
  return (
    <nav className="adm-pager" aria-label="Pages">
      <span aria-live="polite">{total === null ? "" : total === 0 ? "No results" : `Showing ${from} to ${to} of ${total}`}</span>
      <div>
        <button type="button" className="btn-s" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="adm-page-of">Page {page} of {pages}</span>
        <button type="button" className="btn-s" disabled={busy || page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}
