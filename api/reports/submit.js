import crypto from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Server-side chokepoint for public report submissions. The frontend no longer
// inserts into Supabase directly; every report passes through rate limiting,
// Turnstile bot verification, and payload validation here. RLS
// (public_insert_v2) and the unique_photo_url constraint remain the second
// layer of defense at the DB.

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW = "10 m";

const WASTE_TYPES = new Set(["mixed", "plastic", "construction", "organic", "water", "medical"]);
const MAX_TEXT_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

// Env values are trimmed because dashboard copy-paste often smuggles in a
// trailing newline, which breaks URL parsing and HTTP header values.
function env(name) {
  return (process.env[name] || "").trim();
}

let ratelimit = null;
function getRatelimit() {
  const url = env("UPSTASH_REDIS_REST_URL") || env("KV_REST_API_URL");
  const token = env("UPSTASH_REDIS_REST_TOKEN") || env("KV_REST_API_TOKEN");
  if (!url || !token) return null;
  if (!ratelimit) {
    ratelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW),
      prefix: "jabor:report-submit",
    });
  }
  return ratelimit;
}

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

async function verifyTurnstile(token, ip) {
  const secret = env("TURNSTILE_SECRET_KEY");
  if (!secret) {
    // Not configured yet - allow through so submissions keep working until the
    // Turnstile keys are added, but make the gap loud in the logs.
    console.warn("[jabor] TURNSTILE_SECRET_KEY is not set - skipping bot verification");
    return { ok: true };
  }
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, reason: "missing-token" };
  }
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) {
    return { ok: false, reason: (data?.["error-codes"] || []).join(",") || "verification-failed" };
  }
  return { ok: true };
}

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validatePayload(body) {
  const cloudName = env("VITE_CLOUDINARY_CLOUD_NAME");
  if (!cloudName) {
    return { error: "Report submissions are not configured on the server.", status: 500 };
  }

  const area = cleanText(body?.area);
  const district = cleanText(body?.district);
  const constituency = cleanText(body?.constituency);
  if (!area || !district || !constituency) {
    return { error: "Area, district, and constituency are required." };
  }

  const photoUrl = typeof body?.photo_url === "string" ? body.photo_url.trim() : "";
  const photoPattern = new RegExp(
    `^https://res\\.cloudinary\\.com/${cloudName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/image/upload/[\\w\\-./]+$`,
  );
  if (!photoPattern.test(photoUrl)) {
    return { error: "Photo URL is missing or not a valid upload for this app." };
  }

  const wasteType = cleanText(body?.waste_type);
  if (!WASTE_TYPES.has(wasteType)) {
    return { error: "Waste type is not recognised." };
  }

  return {
    report: {
      id: crypto.randomUUID(),
      district,
      constituency,
      lok_sabha_seat: cleanText(body?.lok_sabha_seat),
      mla: cleanText(body?.mla) || "Unknown",
      mla_party: cleanText(body?.mla_party) || "Unknown",
      mp: cleanText(body?.mp) || "Unknown",
      mp_party: cleanText(body?.mp_party) || "Unknown",
      area,
      landmark: cleanText(body?.landmark),
      waste_type: wasteType,
      description: cleanText(body?.description, MAX_DESCRIPTION_LENGTH),
      lat: null,
      lng: null,
      photo_url: photoUrl,
    },
  };
}

async function insertReport(report) {
  const supabaseUrl = env("SUPABASE_URL") || env("VITE_SUPABASE_URL");
  // Prefer the service role key so anon inserts can be revoked at the DB
  // (supabase/jabor-close-direct-report-inserts.sql), making this route the
  // only write path for reports. Falls back to the anon key so submissions
  // keep working until SUPABASE_SERVICE_ROLE_KEY is set in Vercel.
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseKey = serviceKey || env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseKey) {
    return { status: 500, error: "Report storage is not configured on the server." };
  }
  if (!serviceKey) {
    console.warn("[jabor] SUPABASE_SERVICE_ROLE_KEY is not set - inserting with the anon key; direct anon inserts must stay enabled until it is configured");
  }
  const res = await fetch(`${supabaseUrl}/rest/v1/reports`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(report),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 409 || text.includes("unique_photo_url")) {
      return { status: 409, error: "This photo has already been submitted." };
    }
    console.error(`[jabor] report insert failed: ${res.status} ${text}`);
    return { status: 502, error: "Could not save the report. Please try again." };
  }
  return { status: 200 };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const ip = getClientIp(req);

  // A misconfigured rate limiter must degrade to "no rate limit", never to
  // a crashed function that blocks every submission.
  let limiter = null;
  try {
    limiter = getRatelimit();
  } catch (error) {
    console.error("[jabor] rate limiter init failed:", error?.message || error);
  }
  if (limiter) {
    try {
      const { success, remaining } = await limiter.limit(ip);
      if (!success) {
        console.log(`[jabor] rate limit exceeded for report submission (ip=${ip}, remaining=${remaining})`);
        return res.status(429).json({
          error: "Too many reports from your connection. Please wait a few minutes and try again.",
        });
      }
    } catch (error) {
      // Redis being down should not take report submissions with it.
      console.error("[jabor] rate limiter unavailable:", error?.message || error);
    }
  } else {
    console.warn("[jabor] UPSTASH_REDIS_REST_URL/TOKEN not set - report rate limiting is disabled");
  }

  const turnstile = await verifyTurnstile(req.body?.turnstileToken, ip);
  if (!turnstile.ok) {
    console.log(`[jabor] turnstile rejected report submission (ip=${ip}, reason=${turnstile.reason})`);
    return res.status(400).json({ error: "Bot verification failed. Please refresh the page and try again." });
  }

  const validated = validatePayload(req.body || {});
  if (validated.error) {
    return res.status(validated.status || 400).json({ error: validated.error });
  }

  const insert = await insertReport(validated.report);
  if (insert.error) {
    return res.status(insert.status).json({ error: insert.error });
  }

  return res.status(200).json({ ok: true, id: validated.report.id });
}
