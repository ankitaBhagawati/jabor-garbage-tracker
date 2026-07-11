import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Serves the Vercel serverless routes in api/ during `vite dev`, so photo
// uploads (which need /api/cloudinary-signature) work locally without
// `vercel dev`. Loads .env* into process.env so the handlers see their secrets.
function devApiRoutes(mode) {
  return {
    name: "dev-api-routes",
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), "");
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      server.middlewares.use("/api/cloudinary-signature", async (req, res) => {
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString("utf8");
          req.body = raw ? JSON.parse(raw) : {};
          res.status = (code) => { res.statusCode = code; return res; };
          res.json = (obj) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(obj));
            return res;
          };
          const mod = await server.ssrLoadModule("/api/cloudinary-signature.js");
          await mod.default(req, res);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: e?.message || "Dev API route failed." }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), devApiRoutes(mode)],
}));
