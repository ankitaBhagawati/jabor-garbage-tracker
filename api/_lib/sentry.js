import { scrubEvent } from "../../src/utils/sentryScrub.js";

// Reports a server error to Sentry when SENTRY_DSN is set. Loaded on first use so
// functions without errors never pay for it. Never throws.
let ready = null;

export async function captureError(error) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    ready ??= import("@sentry/node").then(Sentry => {
      Sentry.init({
        dsn,
        environment: process.env.APP_ENV || "development",
        sendDefaultPii: false,
        // ponytail: no auto instrumentation; we only report caught 500s, which keeps cold starts short.
        defaultIntegrations: false,
        beforeSend: scrubEvent,
      });
      return Sentry;
    });
    const Sentry = await ready;
    Sentry.captureException(error);
    await Sentry.flush(2000);
  } catch {
    // Monitoring must never break a request.
  }
}
