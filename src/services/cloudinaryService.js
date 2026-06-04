const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || "";
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || "";

const MAX_WIDTH = 1000;
const TARGET_BYTES = 300 * 1024;

function assertCloudinaryConfig() {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error("Cloudinary is not configured. Add the required VITE_CLOUDINARY environment variables.");
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
  if (!file?.type?.startsWith("image/")) throw new Error("Please choose a valid image file.");

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
    return new File([blob], name, { type: "image/webp" });
  } catch {
    // Some browsers cannot decode HEIC/HEIF; Cloudinary can still process the original.
    return file;
  }
}

// Unsigned browser upload: only the cloud name and upload preset are exposed.
export async function uploadImageToCloudinary(file, folder) {
  assertCloudinaryConfig();
  const preparedFile = await prepareImageForUpload(file);
  const formData = new FormData();
  formData.append("file", preparedFile);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", folder);

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
