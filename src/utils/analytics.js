import ReactGA from "react-ga4";

let isInitialized = false;

// GA runs only on a Vercel production build. A missing VERCEL_ENV (localhost, or anything unexpected) means off.
export const gaEnabled = env => env?.VERCEL_ENV === "production" && env?.APP_ENV !== "staging";

export function initGA(measurementId) {
  if (!measurementId || isInitialized) return;

  ReactGA.initialize(measurementId);
  isInitialized = true;
}

export function trackPageView(path) {
  if (!isInitialized || !path) return;

  ReactGA.send({ hitType: "pageview", page: path });
}

export function trackEvent(name, params = {}) {
  if (!isInitialized || !name) return;

  ReactGA.event(name, params);
}

export const trackReportSubmission = () => {
  trackEvent("report_submission", { category: "reports" });
};

export const trackCleanupProofSubmission = () => {
  trackEvent("cleanup_proof_submission", { category: "cleanup_proofs" });
};
