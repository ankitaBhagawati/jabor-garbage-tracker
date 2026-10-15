import crypto from "node:crypto";
import { cloudinaryFolder, configError, issueProofTicket, rateLimit, route, verifyTurnstile } from "./_lib/server.js";

const ALLOWED_FORMATS = "jpg,jpeg,png,webp";

function signParams(params, apiSecret) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

// Anyone may ask: citizens upload report photos and cleanup proofs without an account. Limits: 20 signatures per
// address per 10 minutes, two allowlisted folders, image formats only, no overwrites, and Cloudinary rejects a
// signature after one hour. A cleanup proof also needs a Turnstile token here (see docs/SECURITY-NOTES.md).
export default route("POST", async (req, res) => {
  await rateLimit(req, "cloudinary-signature", 20, 10 * 60);

  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const cloudName = process.env.VITE_CLOUDINARY_CLOUD_NAME;
  if (!apiKey || !apiSecret || !cloudName) {
    throw configError("Cloudinary signed uploads are not configured.");
  }

  // The client names the kind of upload ("reports" or "cleanup-proofs"). Older cached clients send
  // "jabor/reports"; only the last segment is used, so the folder prefix always comes from the server.
  const requested = typeof req.body?.folder === "string" ? req.body.folder : "";
  const kind = requested.split("/").pop();
  const folder = cloudinaryFolder(kind);
  let proofTicket;
  if (kind === "cleanup-proofs") {
    await verifyTurnstile(req, req.body?.turnstileToken);
    proofTicket = issueProofTicket(req);
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
    ...(proofTicket && { proofTicket }),
  });
});
