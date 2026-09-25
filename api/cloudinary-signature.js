import crypto from "node:crypto";
import { HttpError, rateLimit, route } from "./_lib/server.js";

const ALLOWED_FOLDERS = new Set(["jabor/reports", "jabor/cleanup-proofs"]);
const ALLOWED_FORMATS = "jpg,jpeg,png,webp";

function signParams(params, apiSecret) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export default route("POST", async (req, res) => {
  await rateLimit(req, "cloudinary-signature", 20, 10 * 60);

  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const cloudName = process.env.VITE_CLOUDINARY_CLOUD_NAME;
  if (!apiKey || !apiSecret || !cloudName) {
    throw new Error("Cloudinary signed uploads are not configured.");
  }

  const folder = typeof req.body?.folder === "string" ? req.body.folder : "";
  if (!ALLOWED_FOLDERS.has(folder)) {
    throw new HttpError(400, "Upload folder is not allowed.");
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
});
