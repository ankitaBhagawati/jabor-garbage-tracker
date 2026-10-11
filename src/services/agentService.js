import { adminRestJson } from "./supabaseRest.js";

// Edge functions check for an active super admin themselves; the proxy only supplies the cookie's token.
function callFunction(name, body) {
  return adminRestJson(`/functions/v1/${name}`, { method: "POST", body: body || {} });
}

export function generateRecommendations(reportId) {
  return callFunction("jabor-recommendations", { reportId });
}

export function executeActions(payload) {
  return callFunction("jabor-execute", payload);
}

export function backfillEmbeddings() {
  return callFunction("jabor-embed", {});
}
