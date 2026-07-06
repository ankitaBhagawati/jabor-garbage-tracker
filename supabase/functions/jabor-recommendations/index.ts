// jabor-recommendations — the agentic RAG pipeline.
// Retrieval (gte-small + pgvector) -> agent reasoning -> Claude caption (RAG
// generation) -> audit row -> structured recommendations for admin review.
import { type AdminContext, corsHeaders, embedText, json, requireAdmin } from "../_shared/auth.ts";
import {
  assembleCaption,
  buildActions,
  buildEmailDraft,
  detectPattern,
  determineEscalations,
  reportToText,
  selectAuthorities,
  severityRank,
  suggestPostTiming,
  type AuthorityContact,
  type Guideline,
  type ReportRow,
  type SimilarReport,
} from "../_shared/reasoning.ts";

// Mentioned on every post: Housing & Urban Affairs minister (Jabor's civic tech
// falls under this dept), CM Office, and Swachh Bharat Mission Urban + Gramin
// Assam. Verified handles.
const ALWAYS_MENTION = ["iKaushikRai", "CMOfficeAssam", "SBMUrbanAssam", "sbmg_assam"];

// Public site — appended as "More: jabor.in" so viewers know reports live there.
const REPORT_LINK = "jabor.in";

// Emailed on every complaint: dept minister, CM office, Swachh Bharat Gramin +
// Urban Assam. The report's MLA/MP official emails (from the roster tables) are
// added on top when present.
const FIXED_EMAILS = [
  "shrikaushikrai@gmail.com",
  "cm@assam.gov.in",
  "sbmg.assam@gmail.com",
  "sbmurbanassam@gmail.com",
];

// Caption target leaves headroom in the 280 limit for the mandatory handles, the
// report's MLA/MP tags and the "More: jabor.in" link, so captions aren't truncated.
const CAPTION_MAX = 160;

const SIMILAR_WINDOW_DAYS = 30;
const SIMILAR_MATCH_COUNT = 10;
const CLAUDE_MODEL = "claude-sonnet-4-6";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let ctx;
  try {
    ctx = await requireAdmin(req);
  } catch (res) {
    return res instanceof Response ? res : json({ error: "Authorization failed." }, 500);
  }
  const { admin, service } = ctx;

  let reportId: string | undefined;
  try {
    ({ reportId } = await req.json());
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (!reportId) return json({ error: "reportId is required." }, 400);

  // 1. Fetch the report.
  const { data: report, error: reportErr } = await service
    .from("reports")
    .select(
      "id, constituency, district, area, landmark, waste_type, description, status, photo_url, mla, mp, created_at",
    )
    .eq("id", reportId)
    .maybeSingle();
  if (reportErr) return json({ error: `Could not load report: ${reportErr.message}` }, 500);
  if (!report) return json({ error: "Report not found." }, 404);

  // 2. RAG retrieval — embed the report, persist the vector, find similar reports.
  const reportText = reportToText(report as ReportRow);
  let similar: SimilarReport[] = [];
  try {
    const embedding = await embedText(reportText);
    await service
      .from("reports")
      .update({ embedding, embedded_at: new Date().toISOString() })
      .eq("id", reportId);

    const createdAfter = new Date(
      Date.now() - SIMILAR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: matches } = await service.rpc("match_reports", {
      query_embedding: embedding,
      match_count: SIMILAR_MATCH_COUNT,
      exclude_id: reportId,
      filter_district: report.district ?? null,
      created_after: createdAfter,
    });
    similar = (matches as SimilarReport[]) ?? [];
  } catch (e) {
    // Retrieval is best-effort; reasoning + generation still run without it.
    console.error("retrieval failed", e);
  }

  // 3. Load knowledge base + agent reasoning.
  const [{ data: guidelines }, { data: contacts }] = await Promise.all([
    service.from("escalation_guidelines").select("*").eq("is_active", true),
    service.from("authority_contacts").select("*").eq("is_active", true),
  ]);

  const pattern = detectPattern(similar);
  const escalations = determineEscalations(
    report as ReportRow,
    (guidelines as Guideline[]) ?? [],
    pattern,
  );
  const authorities = selectAuthorities(
    report as ReportRow,
    escalations,
    (contacts as AuthorityContact[]) ?? [],
  );
  const timing = suggestPostTiming();
  const actions = buildActions(pattern, escalations, authorities);

  // Email draft + recipients (fixed authorities + report's MLA/MP official emails).
  const emailDraft = buildEmailDraft(report as ReportRow, escalations, REPORT_LINK);
  const emailTo = await buildRecipients(service, report.mla, report.mp);

  // 4. RAG generation — Claude writes the caption augmented with context.
  let caption = "";
  let captionError: string | null = null;
  try {
    caption = await generateCaption(report as ReportRow, similar, pattern, escalations);
  } catch (e) {
    captionError = e instanceof Error ? e.message : String(e);
    caption = fallbackCaption(report as ReportRow);
  }

  // 4b. Tag the report's MLA/MP with their *verified* X handle (admin reviews
  // before posting). Only verified handles are appended; unverified/unknown are
  // skipped — wrong-person tagging on a public account is real harm.
  caption = await appendRepHandles(service, caption, report.mla, report.mp);

  // 5. Audit row (human-in-the-loop trail).
  const { data: auditRow } = await service
    .from("recommendations_audit")
    .insert({
      report_id: reportId,
      admin_id: admin.id,
      caption_generated: caption,
      similar_report_ids: similar.map((s) => s.id),
      pattern,
      escalations,
      suggested_authorities: authorities.map((a) => ({
        id: a.id,
        name: a.name,
        authority_type: a.authority_type,
        email: a.email,
      })),
      suggested_actions: actions,
      post_timing: timing,
      status: "generated",
    })
    .select("id")
    .maybeSingle();

  return json({
    auditId: auditRow?.id ?? null,
    report: {
      id: report.id,
      constituency: report.constituency,
      district: report.district,
      area: report.area,
      landmark: report.landmark,
      waste_type: report.waste_type,
    },
    caption,
    captionError,
    severity: severityRank(escalations),
    pattern,
    similar: similar.map((s) => ({
      id: s.id,
      area: s.area,
      landmark: s.landmark,
      waste_type: s.waste_type,
      similarity: Number(s.similarity?.toFixed?.(3) ?? s.similarity),
      created_at: s.created_at,
    })),
    escalations,
    authorities: authorities.map((a) => ({
      id: a.id,
      name: a.name,
      authority_type: a.authority_type,
      email: a.email,
    })),
    actions,
    timing,
    email: { to: emailTo, subject: emailDraft.subject, body: emailDraft.body },
  });
});

async function generateCaption(
  report: ReportRow,
  similar: SimilarReport[],
  pattern: { detected: boolean; count: number },
  escalations: { reason: string }[],
): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

  const location = [report.area, report.landmark, report.constituency, report.district]
    .filter(Boolean)
    .join(", ");
  const contextLines = [
    `Location: ${location || "Assam"}`,
    `Waste type: ${report.waste_type ?? "mixed"}`,
    report.description ? `Reported details: ${report.description}` : "",
    pattern.detected
      ? `Context: ${pattern.count} similar reports nearby recently (recurring issue).`
      : "",
    escalations.length
      ? `Escalation context: ${escalations.map((e) => e.reason).join("; ")}.`
      : "",
  ].filter(Boolean).join("\n");

  const system =
    "You write short, civic-minded social media posts for Jabor, a public garbage-tracking platform in Assam, India. " +
    "Tone: urgent but professional and constructive — never inflammatory. " +
    `Write a single X (Twitter) post of at most ${CAPTION_MAX} characters. ` +
    "Include the location and convey the severity. Do NOT use any hashtags or URLs. " +
    "If the context says it is a recurring issue, mention that. " +
    "Return ONLY the post text — no quotes, no preamble, no explanation.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Write the X post for this garbage report.\n\n${contextLines}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data?.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Empty caption from Anthropic.");
  return text.slice(0, CAPTION_MAX);
}

// Tags the report's MLA + MP (verified handles only) plus the fixed dept
// minister + CMO on the caption, de-duplicating and staying within 280 chars.
async function appendRepHandles(
  service: AdminContext["service"],
  caption: string,
  mlaName?: string | null,
  mpName?: string | null,
): Promise<string> {
  const handle = async (table: string, name?: string | null) => {
    if (!name) return null;
    const { data } = await service
      .from(table).select("x_handle")
      .eq("name", name).eq("x_handle_verified", true).limit(1);
    return (data?.[0]?.x_handle as string | undefined) ?? null;
  };
  const [mla, mp] = await Promise.all([
    handle("mla_list", mlaName),
    handle("mp_list", mpName),
  ]);

  const seen = new Set<string>();
  const dedupe = (handles: (string | null)[]) => {
    const out: string[] = [];
    for (const h of handles) {
      if (!h) continue;
      const key = h.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
    return out;
  };
  const repHandles = dedupe([mla, mp]);
  const mandatory = dedupe(ALWAYS_MENTION);
  return assembleCaption(caption, repHandles, mandatory, REPORT_LINK);
}

// Recipient list for the complaint email: the fixed authorities plus the report's
// MLA/MP official emails from the roster tables (when set), de-duplicated.
async function buildRecipients(
  service: AdminContext["service"],
  mlaName?: string | null,
  mpName?: string | null,
): Promise<string[]> {
  const lookup = async (table: string, name?: string | null) => {
    if (!name) return null;
    const { data } = await service.from(table).select("email").eq("name", name).limit(1);
    const e = data?.[0]?.email as string | undefined;
    return e && e.includes("@") ? e : null;
  };
  const [mla, mp] = await Promise.all([
    lookup("mla_list", mlaName),
    lookup("mp_list", mpName),
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...FIXED_EMAILS, mla, mp]) {
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function fallbackCaption(report: ReportRow): string {
  const loc = [report.area, report.constituency, report.district].filter(Boolean).join(", ");
  return `Garbage reported${loc ? ` at ${loc}` : ""}. Action needed to keep our area clean.`
    .slice(0, CAPTION_MAX);
}
