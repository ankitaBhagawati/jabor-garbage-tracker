// Shared helpers for the Vercel functions in api/. Files under api/_lib are not routes.
import crypto from "node:crypto";
import { captureError } from "./sentry.js";

export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Server misconfiguration (a missing secret, a bad env value): the caller gets a generic 503, the detail
// goes to the log and Sentry only.
export function configError(detail) {
  const error = new HttpError(503, "Temporarily unavailable. Please try again later.");
  error.detail = detail;
  return error;
}

// Wraps a handler: enforces the method, same-origin requests, and turns HttpError into JSON.
export function route(method, handler) {
  return async (req, res) => {
    try {
      if (req.method !== method) {
        res.setHeader("Allow", method);
        throw new HttpError(405, "Method not allowed.");
      }
      if (method !== "GET") {
        assertSameOrigin(req);
        // Vercel parses the body lazily and throws on malformed JSON; that is the caller's mistake, not ours.
        try { void req.body; } catch { throw new HttpError(400, "Invalid request body."); }
      }
      res.setHeader("Cache-Control", "no-store");
      return await handler(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500 || e.detail) {
        const reported = e.detail ? new Error(e.detail) : e;
        console.error(reported);
        await captureError(reported);
      }
      return res.status(status).json({ error: status === 500 ? "Server error." : e.message });
    }
  };
}

// CSRF guard: browsers always send Origin on cross-site POSTs, so a mismatch means another site.
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  let originHost = "";
  try { originHost = new URL(origin).host; } catch { /* "null" or garbage: blocked below */ }
  if (!origin || !host || originHost !== host) {
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
      // SET NX EX creates the counter with its TTL once; INCR keeps that TTL. Works on any Redis version.
      body: JSON.stringify([["SET", key, "0", "EX", String(windowSec), "NX"], ["INCR", key]]),
    });
    if (!res.ok) return null;
    const [, incr] = await res.json();
    return Number(incr?.result) || null;
  } catch {
    return null;
  }
}

export async function rateLimit(req, name, max, windowSec) {
  const key = `jabor:rl2:${name}:${getClientIp(req)}`;
  const count = (await redisIncr(key, windowSec)) ?? memoryIncr(key, windowSec);
  if (count > max) throw new HttpError(429, "Too many requests. Please try again later.");
}

// A limiter that fails closed, for routes that create or change accounts. The counter is per actor (not per
// address), kept in Upstash. If Redis is not configured or does not answer, the request is refused (503), never
// let through. The in-memory fallback exists only off Vercel (local development and tests, where VERCEL_ENV is unset).
export async function strictRateLimit(actorId, name, max, windowSec) {
  const key = `jabor:rl2:${name}:actor:${actorId}`;
  let count = await redisIncr(key, windowSec);
  if (count === null && !process.env.VERCEL_ENV) count = memoryIncr(key, windowSec);
  if (count === null) throw new HttpError(503, "Temporarily unavailable. Please try again later.");
  if (count > max) throw new HttpError(429, "Too many requests. Please try again later.");
}

// True unless this is positively a Preview or development run. VERCEL_ENV is set by Vercel itself. A deployed
// function that somehow has no VERCEL_ENV still counts as production (Vercel runs every function with
// NODE_ENV=production), so the checks that ask this fail closed. Off Vercel (vite dev, tests) it is false.
export function isProduction() {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv) return vercelEnv !== "preview" && vercelEnv !== "development";
  return process.env.NODE_ENV === "production";
}

// ── Cloudflare Turnstile ─────────────────────────────────────────────────────
export async function verifyTurnstile(req, token) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) throw configError("TURNSTILE_SECRET_KEY is not configured.");
  if (typeof token !== "string" || !token) throw new HttpError(400, "Please complete the human check.");
  let res;
  try {
    res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response: token, remoteip: getClientIp(req) }),
    });
  } catch (error) {
    console.error("[jabor] Turnstile verification call failed:", error?.message || error);
    throw new HttpError(503, "The security check is unavailable right now. Please try again later.");
  }
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new HttpError(400, "Human check failed. Please try again.");
}

// A public cleanup proof passes Turnstile once, when its upload is signed. Turnstile tokens are single-use,
// so the signature route hands back this ticket and /api/cleanup-proofs accepts it in place of a second token.
// ponytail: replayable from the same address until it expires; the 5 per 10 minutes limit on
// /api/cleanup-proofs bounds that. Bind it to the uploaded public_id if that ever matters.
const PROOF_TICKET_TTL = 10 * 60;

function proofTicketMac(expires, req) {
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!secret) throw configError("CLOUDINARY_API_SECRET is not configured.");
  return crypto.createHmac("sha256", secret).update(`cleanup-proof:${expires}:${getClientIp(req)}`).digest("base64url");
}

export function issueProofTicket(req) {
  const expires = Math.floor(Date.now() / 1000) + PROOF_TICKET_TTL;
  return `${expires}.${proofTicketMac(expires, req)}`;
}

export function assertProofTicket(req, ticket) {
  const [expires, mac] = typeof ticket === "string" ? ticket.split(".") : [];
  const expected = /^\d+$/.test(expires || "") ? Buffer.from(proofTicketMac(expires, req)) : null;
  const given = Buffer.from(mac || "");
  if (!expected || Number(expires) < Date.now() / 1000 || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new HttpError(400, "The security check expired. Please refresh the page and try again.");
  }
}

// ── Supabase ─────────────────────────────────────────────────────────────────
// Service-role REST call: bypasses RLS, so callers must validate everything first.
export async function serviceRest(path, options = {}) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw configError("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured.");
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

// Uploads go to <prefix>/reports and <prefix>/cleanup-proofs. The prefix comes from the server's
// env so each environment writes to its own folders; the browser never chooses it.
// Default "jabor" (production). Staging sets CLOUDINARY_FOLDER_PREFIX=jabor-staging.
const UPLOAD_KINDS = new Set(["reports", "cleanup-proofs"]);

export function cloudinaryFolder(kind) {
  const prefix = (process.env.CLOUDINARY_FOLDER_PREFIX || "jabor").trim();
  if (!/^[\w-]+(\/[\w-]+)*$/.test(prefix)) throw configError("CLOUDINARY_FOLDER_PREFIX is not a valid folder path.");
  if (!UPLOAD_KINDS.has(kind)) throw new HttpError(400, "Upload folder is not allowed.");
  return `${prefix}/${kind}`;
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
