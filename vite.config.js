import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    define: {
      __CLOUDINARY_CLOUD_NAME__: JSON.stringify(env.CLOUDINARY_CLOUD_NAME || ""),
      __CLOUDINARY_UPLOAD_PRESET__: JSON.stringify(env.CLOUDINARY_UPLOAD_PRESET || ""),
    },
  };
});
