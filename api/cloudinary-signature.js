import crypto from "node:crypto";

const ALLOWED_FOLDERS = new Set(["jabor/reports", "jabor/cleanup-proofs"]);
const ALLOWED_FORMATS = "jpg,jpeg,png,webp";
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const signatureAttempts = new Map();

function getClientIp(req) {
  const forwardedFor = req.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const attempt = signatureAttempts.get(ip);
  if (!attempt || now - attempt.startedAt > RATE_LIMIT_WINDOW_MS) {
    signatureAttempts.set(ip, { count: 1, startedAt: now });
    return false;
  }
  attempt.count += 1;
  return attempt.count > RATE_LIMIT_MAX;
}

function signParams(params, apiSecret) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: "Too many upload attempts. Please try again later." });
  }

  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const cloudName = process.env.VITE_CLOUDINARY_CLOUD_NAME;
  if (!apiKey || !apiSecret || !cloudName) {
    return res.status(500).json({ error: "Cloudinary signed uploads are not configured." });
  }

  const folder = typeof req.body?.folder === "string" ? req.body.folder : "";
  if (!ALLOWED_FOLDERS.has(folder)) {
    return res.status(400).json({ error: "Upload folder is not allowed." });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signedParams = {
    allowed_formats: ALLOWED_FORMATS,
    folder,
    overwrite: "false",
    timestamp,
  };

  return res.status(200).json({
    apiKey,
    cloudName,
    folder,
    timestamp,
    allowedFormats: ALLOWED_FORMATS,
    signature: signParams(signedParams, apiSecret),
  });
}
