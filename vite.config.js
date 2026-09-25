import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Serves the Vercel serverless routes in api/ during `vite dev`, so uploads,
// report submission and admin login work locally without `vercel dev`.
// Loads .env* into process.env so the handlers see their secrets.
function devApiRoutes(mode) {
  return {
    name: "dev-api-routes",
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), "");
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      server.middlewares.use("/api", async (req, res, next) => {
        // Mirrors Vercel's file routing: /api/admin/login -> api/admin/login.js.
        const route = req.url.split("?")[0].replace(/\/$/, "");
        if (!/^(\/[a-z-]+)+$/.test(route)) return next(); // also keeps api/_lib unroutable
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
          const mod = await server.ssrLoadModule(`/api${route}.js`);
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

// VITE_* values ship to every visitor; refuse to build if one looks like a secret.
function assertNoPublicSecrets(mode) {
  const leaked = Object.keys(loadEnv(mode, process.cwd(), "VITE_"))
    .filter(name => /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|TOKEN/.test(name));
  if (leaked.length) throw new Error(`Secrets must not use the VITE_ prefix: ${leaked.join(", ")}`);
}

export default defineConfig(({ mode }) => {
  assertNoPublicSecrets(mode);
  return { plugins: [react(), devApiRoutes(mode)] };
});
