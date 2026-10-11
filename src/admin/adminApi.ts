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
