// jabor-notify - citizen report confirmation. PUBLIC endpoint (no admin).
// Called by the frontend right after a report is inserted, only when the
// reporter chose to share an email. Stores their contact (service role, so it
// stays off the public client) and sends a confirmation via Resend.
// Reused function secrets: RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/auth.ts";

interface NotifyBody {
  report_id?: string;
  name?: string;
  email?: string;
  area?: string;
  waste_type?: string;
  district?: string;
  constituency?: string;
}

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: NotifyBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const reportId = (body.report_id ?? "").trim();
  const email = (body.email ?? "").trim();
  const name = (body.name ?? "").trim().slice(0, 120);
  if (!reportId) return json({ error: "report_id is required." }, 400);
  if (!isEmail(email)) return json({ error: "A valid email is required." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server is not configured." }, 500);
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Store contact for admin follow-up. upsert so a retry can't duplicate.
  const { error: dbErr } = await service
    .from("report_contacts")
    .upsert({ report_id: reportId, name: name || null, email }, { onConflict: "report_id" });
  if (dbErr) return json({ error: `Could not store contact: ${dbErr.message}` }, 500);

  // Confirmation email is best-effort - the contact is already saved.
  const emailResult = await sendConfirmation(email, name, body);
  return json({ ok: true, email: emailResult });
});

async function sendConfirmation(to: string, name: string, b: NotifyBody) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM") ?? "Jabor <alerts@jabor.in>";
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") ?? "jaborassam@gmail.com";
  if (!apiKey) return { status: "error", detail: "RESEND_API_KEY is not configured." };

  const place = [b.area, b.constituency, b.district].filter(Boolean).join(", ") || "your area";
  const waste = (b.waste_type ?? "garbage").replace(/_/g, " ");
  const greetName = name || "citizen";
  const subject = "Thank you - your Jabor report has been submitted";
  const text =
`Dear ${greetName},

Thank you for being a responsible citizen of Assam. Your report about ${waste} at ${place} has been submitted and forwarded to the concerned authorities.

We will send you another email if and when this spot is marked cleaned.

- Team Jabor`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text, html: html(greetName, waste, place) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { status: "error", detail: `Email API ${res.status}: ${data?.message ?? res.statusText}` };
  return { status: "sent", detail: `Emailed ${to}.` };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function html(name: string, waste: string, place: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;color:#161D19;line-height:1.6">
  <p>Dear ${esc(name)},</p>
  <p>Thank you for being a responsible citizen of Assam. Your report about <strong>${esc(waste)}</strong> at <strong>${esc(place)}</strong> has been submitted and forwarded to the concerned authorities.</p>
  <p>We will send you another email if and when this spot is marked <strong>cleaned</strong>.</p>
  <p>- Team Jabor</p>
</div>`;
}
