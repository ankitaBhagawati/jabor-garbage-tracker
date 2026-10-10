import { scrubEvent } from "./sentryScrub.js";

// Sentry loads only when VITE_SENTRY_DSN is set, and after the app has rendered,
// so it adds nothing to the first paint. Errors caught before it loads are queued.
const DSN = import.meta.env.VITE_SENTRY_DSN;
let sentry = null;
const queued = [];

export async function initSentry() {
  if (!DSN) return;
  // Destructured so the bundler keeps only these two exports.
  const { init, captureException } = await import("@sentry/react");
  init({
    dsn: DSN,
    environment: import.meta.env.APP_ENV || "development",
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
  sentry = { captureException };
  queued.splice(0).forEach(error => captureException(error));
}

export function reportError(error) {
  if (sentry) sentry.captureException(error);
  else if (DSN) queued.push(error);
}
