// Shared helpers for the Vercel functions in api/. Files under api/_lib are not routes.

export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps a handler: enforces the method, same-origin requests, and turns HttpError into JSON.
export function route(method, handler) {
  return async (req, res) => {
    try {
      if (req.method !== method) {
        res.setHeader("Allow", method);
        throw new HttpError(405, "Method not allowed.");
      }
      if (method !== "GET") assertSameOrigin(req);
      res.setHeader("Cache-Control", "no-store");
      return await handler(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return res.status(status).json({ error: status === 500 ? "Server error." : e.message });
    }
  };
}

// CSRF guard: browsers always send Origin on cross-site POSTs, so a mismatch means another site.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!origin || !host || new URL(origin).host !== host) {
    throw new HttpError(403, "Cross-origin request blocked.");
  }
}

export function getClientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) return forwardedFor.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Fixed window counter in Upstash Redis, shared by every serverless instance.
// ponytail: in-memory fallback when Upstash isn't configured (dev, or Redis down);
// it resets per instance, so production should always set the Upstash env vars.
const memoryHits = new Map();

function memoryIncr(key, windowSec) {
  const now = Date.now();
  const hit = memoryHits.get(key);
  if (!hit || now > hit.resetAt) {
    memoryHits.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return 1;
  }
  return ++hit.count;
}

async function redisIncr(key, windowSec) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec), "NX"]]),
    });
    if (!res.ok) return null;
    const [incr] = await res.json();
    return Number(incr?.result) || null;
  } catch {
    return null;
  }
}

export async function rateLimit(req, name, max, windowSec) {
  const key = `jabor:rl:${name}:${getClientIp(req)}`;
  const count = (await redisIncr(key, windowSec)) ?? memoryIncr(key, windowSec);
  if (count > max) throw new HttpError(429, "Too many requests. Please try again later.");
}

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────
export async function verifyTurnstile(req, token) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw new Error("TURNSTILE_SECRET_KEY is not configured.");
  if (typeof token !== "string" || !token) throw new HttpError(400, "Please complete the human check.");
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: getClientIp(req) }),
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new HttpError(400, "Human check failed. Please try again.");
}

// ── Supabase ─────────────────────────────────────────────────────────────────
// Service-role REST call: bypasses RLS, so callers must validate everything first.
export async function serviceRest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path.split("?")[0]} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Input validation ─────────────────────────────────────────────────────────
export function cleanText(value, max, { required = false, label = "Field" } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new HttpError(400, `${label} is required.`);
  if (text.length > max) throw new HttpError(400, `${label} is too long.`);
  return text;
}

// Only accept images uploaded to our own Cloudinary account and folder.
export function assertCloudinaryUrl(url, folder) {
  const cloudName = process.env.VITE_CLOUDINARY_CLOUD_NAME || process.env.CLOUDINARY_CLOUD_NAME;
  const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;
  if (typeof url !== "string" || !cloudName || !url.startsWith(prefix) || !url.includes(`/${folder}/`) || url.length > 500) {
    throw new HttpError(400, "Invalid image URL.");
  }
  return url;
}

// ── Cookies ──────────────────────────────────────────────────────────────────
export function readCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map(part => part.trim().split("="))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
  );
}

export function cookie(req, name, value, maxAgeSec) {
  const host = req.headers.host || "";
  // Secure cookies don't stick on plain-http localhost in every browser.
  const secure = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "" : "; Secure";
  return `${name}=${encodeURIComponent(value)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}
