// jabor-embed — one-off backfill that seeds gte-small embeddings for existing
// reports so vector similarity search has a candidate pool. Safe to re-run; it
// only processes reports whose embedding is still null. Call repeatedly until
// { remaining: 0 }.
import { corsHeaders, embedText, json, requireAdmin } from "../_shared/auth.ts";
import { reportToText, type ReportRow } from "../_shared/reasoning.ts";

const BATCH_SIZE = 25;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let ctx;
  try {
    ctx = await requireAdmin(req);
  } catch (res) {
    return res instanceof Response ? res : json({ error: "Authorization failed." }, 500);
  }
  const { service } = ctx;

  const { data: rows, error } = await service
    .from("reports")
    .select("id, constituency, district, area, landmark, waste_type, description")
    .is("embedding", null)
    .eq("is_deleted", false)
    .limit(BATCH_SIZE);
  if (error) return json({ error: error.message }, 500);

  let processed = 0;
  for (const row of (rows as ReportRow[]) ?? []) {
    try {
      const embedding = await embedText(reportToText(row));
      await service
        .from("reports")
        .update({ embedding, embedded_at: new Date().toISOString() })
        .eq("id", row.id);
      processed++;
    } catch (e) {
      console.error("embed failed for", row.id, e);
    }
  }

  const { count: remaining } = await service
    .from("reports")
    .select("id", { count: "exact", head: true })
    .is("embedding", null)
    .eq("is_deleted", false);

  return json({ processed, remaining: remaining ?? 0 });
});
