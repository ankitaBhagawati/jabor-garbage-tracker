// jabor-execute — agent ACTION step. Takes the admin-reviewed caption/email +
// selected actions and executes them. X posting is live (OAuth 1.0a via
// _shared/x.ts); authority email is live via Resend (needs RESEND_API_KEY +
// EMAIL_FROM function secrets).
import { corsHeaders, json, requireAdmin } from "../_shared/auth.ts";
import { postToX } from "../_shared/x.ts";

interface ExecuteBody {
  auditId?: string;
  reportId?: string;
  caption?: string;
  selectedActions?: string[];
  authorities?: { id: string; name: string; email: string | null }[];
  email?: { to?: string[]; subject?: string; body?: string };
}

interface ActionResult {
  action: string;
  status: "executed" | "stubbed" | "skipped" | "error";
  detail: string;
}

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

  let body: ExecuteBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const caption = (body.caption ?? "").trim();
  const selected = new Set(body.selectedActions ?? []);
  const authorities = body.authorities ?? [];
  if (!body.reportId) return json({ error: "reportId is required." }, 400);

  const { data: reportRow } = await service
    .from("reports").select("photo_url").eq("id", body.reportId).maybeSingle();
  const photoUrl: string | null = reportRow?.photo_url ?? null;

  const results: ActionResult[] = [];

  // ── Post to X ──────────────────────────────────────────────────────────────
  if (selected.has("post_to_x")) {
    if (!caption) {
      results.push({ action: "post_to_x", status: "skipped", detail: "Empty caption." });
    } else {
      try {
        const tweetId = await postToX(caption, photoUrl);
        results.push({
          action: "post_to_x",
          status: "executed",
          detail: tweetId ? `Posted to X (id ${tweetId}).` : "Posted to X.",
        });
        await service.from("reports")
          .update({ tweeted_at: new Date().toISOString() }).eq("id", body.reportId);
      } catch (e) {
        results.push({
          action: "post_to_x",
          status: "error",
          detail: e instanceof Error ? e.message : "Failed to post to X.",
        });
      }
    }
  }

  // ── Email authorities (live via Resend) ─────────────────────────────────────
  if (selected.has("email_authority")) {
    // Recipients come from the admin-reviewed email panel; fall back to the
    // authority list's emails if the panel didn't send any.
    const to = (body.email?.to ?? authorities.map((a) => a.email).filter(Boolean) as string[])
      .map((e) => e.trim())
      .filter((e) => e.includes("@"));
    const emailResult = await sendEmails(to, body.email?.subject ?? "", body.email?.body ?? "", photoUrl);
    results.push(emailResult);
    if (emailResult.status === "executed") {
      await service.from("reports")
        .update({ emailed_at: new Date().toISOString() }).eq("id", body.reportId);
    }
  }

  // ── Create follow-up task ────────────────────────────────────────────────────
  if (selected.has("create_followup_task")) {
    results.push({
      action: "create_followup_task",
      status: "executed",
      detail: "Follow-up recorded in the recommendations audit log.",
    });
  }

  // ── Flag for escalation ──────────────────────────────────────────────────────
  if (selected.has("flag_for_escalation")) {
    results.push({
      action: "flag_for_escalation",
      status: "executed",
      detail: "Escalation flagged in the recommendations audit log.",
    });
  }

  // Persist the outcome to the audit row (or create one if missing).
  const auditPayload = {
    caption_final: caption,
    executed_actions: results,
    status: results.some((r) => r.status === "error") ? "error" : "executed",
    updated_at: new Date().toISOString(),
  };

  if (body.auditId) {
    await service.from("recommendations_audit").update(auditPayload).eq("id", body.auditId);
  } else {
    await service.from("recommendations_audit").insert({
      report_id: body.reportId,
      admin_id: admin.id,
      ...auditPayload,
    });
  }

  return json({ ok: true, results });
});

// Sends the complaint email via Resend. Function secrets:
//   RESEND_API_KEY — your Resend API key
//   EMAIL_FROM     — a verified sender, e.g. "Jabor <alerts@jabor.in>"
//   EMAIL_REPLY_TO — where authority replies land (defaults to the Jabor inbox)
async function sendEmails(
  to: string[],
  subject: string,
  body: string,
  photoUrl: string | null,
): Promise<ActionResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") ?? "Jabor <alerts@jabor.in>";
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") ?? "jaborassam@gmail.com";
  if (!apiKey) {
    return { action: "email_authority", status: "error", detail: "RESEND_API_KEY is not configured." };
  }
  if (to.length === 0) {
    return { action: "email_authority", status: "skipped", detail: "No recipient email addresses." };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      reply_to: replyTo,
      subject: subject || "Garbage complaint",
      text: body,
      html: emailHtml(body, photoUrl),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.message || (data && JSON.stringify(data).slice(0, 200)) || res.statusText;
    return { action: "email_authority", status: "error", detail: `Email API ${res.status}: ${msg}` };
  }
  return {
    action: "email_authority",
    status: "executed",
    detail: `Emailed ${to.length} recipient(s): ${to.join(", ")}.`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// HTML version of the complaint email: the plain-text body (escaped, newlines
// preserved) plus the report photo embedded and linked. Only http(s) URLs are
// embedded — anything else is dropped so a bad photo_url can't inject markup.
function emailHtml(body: string, photoUrl: string | null): string {
  const safeBody = escapeHtml(body).replace(/\n/g, "<br>");
  const url = photoUrl && /^https?:\/\//i.test(photoUrl) ? photoUrl : null;
  const photo = url
    ? `<p style="margin-top:20px"><img src="${escapeHtml(url)}" alt="Reported garbage" ` +
      `style="max-width:100%;border-radius:8px" /></p>` +
      `<p><a href="${escapeHtml(url)}">View the report photo</a></p>`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#161D19;line-height:1.6">` +
    `${safeBody}${photo}</div>`;
}

// Self-check: run `deno run supabase/functions/jabor-execute/index.ts`.
if (import.meta.main) {
  const h = emailHtml("Line 1\n<script>bad</script>", "https://res.cloudinary.com/x/a.jpg");
  if (!h.includes("Line 1<br>")) throw new Error("newline not converted");
  if (h.includes("<script>")) throw new Error("body not escaped");
  if (!h.includes(`<img src="https://res.cloudinary.com/x/a.jpg"`)) throw new Error("photo not embedded");
  if (emailHtml("x", "javascript:alert(1)").includes("javascript:")) throw new Error("non-http url embedded");
  if (emailHtml("x", null).includes("<img")) throw new Error("null photo produced img");
  console.log("jabor-execute self-check OK");
}
