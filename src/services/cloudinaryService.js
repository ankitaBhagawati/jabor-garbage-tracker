const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || "";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MAX_WIDTH = 1000;
const TARGET_BYTES = 300 * 1024;

function assertCloudinaryConfig() {
  if (!CLOUDINARY_CLOUD_NAME) {
    throw new Error("Cloudinary is not configured. Add VITE_CLOUDINARY_CLOUD_NAME.");
  }
}

export function validateUploadImage(file, label = "Image") {
  if (!file) throw new Error(`${label} is required.`);
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${label} must be a JPG, PNG, or WEBP image.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${label} must be smaller than 10 MB.`);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function loadImage(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// Resize and compress before upload to reduce bandwidth on mobile networks.
export async function prepareImageForUpload(file) {
  validateUploadImage(file);

  try {
    const image = await loadImage(file);
    const scale = Math.min(1, MAX_WIDTH / image.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let quality = 0.82;
    let blob = await canvasToBlob(canvas, "image/webp", quality);
    while (blob && blob.size > TARGET_BYTES && quality > 0.42) {
      quality -= 0.08;
      blob = await canvasToBlob(canvas, "image/webp", quality);
    }

    if (!blob) return file;
    const name = `${file.name?.replace(/\.[^.]+$/, "") || "jabor-image"}.webp`;
    const preparedFile = new File([blob], name, { type: "image/webp" });
    validateUploadImage(preparedFile);
    return preparedFile;
  } catch {
    return file;
  }
}

async function getUploadSignature(folder) {
  const res = await fetch("/api/cloudinary-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Could not authorize image upload.");
  }
  return data;
}

export async function uploadImageToCloudinary(file, folder) {
  assertCloudinaryConfig();
  const preparedFile = await prepareImageForUpload(file);
  const signatureData = await getUploadSignature(folder);
  const formData = new FormData();
  formData.append("file", preparedFile);
  formData.append("api_key", signatureData.apiKey);
  formData.append("timestamp", String(signatureData.timestamp));
  formData.append("folder", signatureData.folder);
  formData.append("allowed_formats", signatureData.allowedFormats);
  formData.append("overwrite", "false");
  formData.append("signature", signatureData.signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok || !data.secure_url) {
    throw new Error(data?.error?.message || "Cloudinary image upload failed.");
  }
  return data.secure_url;
}
