import type { Envelope } from "./queryBuilders.ts";

// Calls the admin proxy (/api/admin/rest). Errors are turned into a short sentence for the person; raw
// database messages are never shown, apart from the status rules' own sentences (code 23514).
export class AdminApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let sessionEnded: (() => void) | null = null;
// The app registers what to do when the server says the session is over (401).
export const onSessionEnded = (handler: (() => void) | null) => { sessionEnded = handler; };

export function friendlyError(status: number, code?: unknown, message?: unknown): string {
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 403 || code === "42501") return "You do not have permission to do that.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  // The status rules (database trigger) write their own plain sentences, for example "Marking a report cleaned needs...".
  if (code === "23514" && typeof message === "string" && message.length < 200) return message;
  if (status >= 500) return "The server had a problem. Please try again.";
  return "Something went wrong. Please try again.";
}

const totalFrom = (range: string | null) => {
  const match = range && /\/(\d+|\*)$/.exec(range);
  return match && match[1] !== "*" ? Number(match[1]) : range ? 0 : null;
};

export async function adminRequest<T>(envelope: Envelope): Promise<{ data: T; total: number | null }> {
  let res: Response;
  try {
    res = await fetch("/api/admin/rest", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
  } catch {
    throw new AdminApiError("Could not reach the server. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401) sessionEnded?.();
    const error = (body ?? {}) as { code?: unknown; message?: unknown };
    throw new AdminApiError(friendlyError(res.status, error.code, error.message), res.status);
  }
  return { data: (body ?? []) as T, total: totalFrom(res.headers.get("content-range")) };
}

// Saves text or a blob as a file in the browser.
export function saveFile(content: Blob | string, filename: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A CSV built on the server (reports, or the audit log with type "audit_log"): role and municipality scoped and logged
// in the audit log. The result says how many rows came, and whether the audit export was cut at the cap (X-Truncated).
// A 413 carries a plain sentence about the row limit; it is shown as it is.
export type CsvResult = { rows: number; total: number | null; truncated: boolean };
export async function downloadCsv(envelope: { path: string; type?: "audit_log" }): Promise<CsvResult> {
  let res: Response;
  try {
    res = await fetch("/api/admin/export", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope),
    });
  } catch {
    throw new AdminApiError("Could not reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    if (res.status === 401) sessionEnded?.();
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message = res.status === 413 && typeof body?.error === "string" && body.error.length < 300 ? body.error : friendlyError(res.status);
    throw new AdminApiError(message, res.status);
  }
  const fallback = envelope.type === "audit_log" ? "jabor-audit-log.csv" : "jabor-reports.csv";
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  saveFile(await res.blob(), name);
  const total = res.headers.get("x-total-rows");
  return { rows: Number(res.headers.get("x-row-count") ?? 0), total: total === null ? null : Number(total), truncated: res.headers.get("x-truncated") === "true" };
}
export const downloadReportsCsv = downloadCsv;

// ── Staff management (PR #28: /api/admin/staff) ──────────────────────────────
// In plain words for the person. A raw server message is shown only for a 400, and only when it is a short
// sentence (the server's validation messages); everything else is one of these.
export function staffErrorMessage(status: number, serverMessage?: unknown): string {
  switch (status) {
    case 0: return "Could not reach the server. Check your connection and try again.";
    case 400: return typeof serverMessage === "string" && /^[A-Z][^<>{}\n]{3,150}[.]$/.test(serverMessage) ? serverMessage : "Check the details and try again.";
    case 401: return "Your session has ended. Please sign in again.";
    case 403: return "You do not have permission to do that.";
    case 404: return "That account was not found. Refresh the list and try again.";
    case 409: return "An account with this email already exists. Nothing was changed.";
    case 429: return "Too many attempts. Please wait a while and try again.";
    case 503: return "This is temporarily unavailable. Please try again in a few minutes.";
    default: return "Something went wrong. Please try again.";
  }
}

export async function staffRequest<T>(path: "/api/admin/staff" | "/api/admin/staff/status", method: "GET" | "POST", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: "same-origin",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new AdminApiError(staffErrorMessage(0), 0);
  }
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    if (res.status === 401) sessionEnded?.();
    throw new AdminApiError(staffErrorMessage(res.status, data?.error), res.status);
  }
  return data as T;
}
