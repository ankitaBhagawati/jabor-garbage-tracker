import { SUPA_KEY, SUPA_URL, assertSupabaseConfig } from "./supabaseRest.js";
import { getAccessToken } from "./authService.js";

async function callFunction(name, body) {
  assertSupabaseConfig();
  const token = getAccessToken();
  if (!token) throw new Error("Admin session expired. Please sign in again.");

  const res = await fetch(`${SUPA_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status}).`);
  }
  return data;
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
