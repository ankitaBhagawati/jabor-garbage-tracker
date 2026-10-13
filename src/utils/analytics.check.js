// Google Analytics loads only on a Vercel production build: `node src/utils/analytics.check.js`
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gaEnabled } from "./analytics.js";

assert.equal(gaEnabled({ VERCEL_ENV: "production" }), true);
assert.equal(gaEnabled({ VERCEL_ENV: "production", APP_ENV: "production" }), true);
assert.equal(gaEnabled({ VERCEL_ENV: "preview" }), false, "Preview build");
assert.equal(gaEnabled({ VERCEL_ENV: "preview", APP_ENV: "production" }), false, "Preview build, even with APP_ENV=production");
assert.equal(gaEnabled({ VERCEL_ENV: "development" }), false, "vercel dev");
assert.equal(gaEnabled({ DEV: true, MODE: "development" }), false, "vite dev on localhost");
assert.equal(gaEnabled({ PROD: true, MODE: "production" }), false, "a production-mode build with no VERCEL_ENV stays off");
assert.equal(gaEnabled({}), false);
assert.equal(gaEnabled(undefined), false);
assert.equal(gaEnabled({ VERCEL_ENV: "production", APP_ENV: "staging" }), false, "staging never sends analytics");

// The wiring: GA is started in one place, behind gaEnabled, and the build exposes VERCEL_ENV to it.
const read = file => readFile(new URL(`../../${file}`, import.meta.url), "utf8");
const app = await read("Jabor.jsx");
assert.equal(app.match(/initGA\(/g).length, 1, "initGA is called once");
assert.ok(app.includes("if (gaEnabled(import.meta.env)) initGA("), "initGA is behind gaEnabled");
assert.match(await read("vite.config.js"), /envPrefix: \[[^\]]*"VERCEL_ENV"/, "vite exposes VERCEL_ENV to the client");
for (const file of ["index.html", "src/utils/analytics.js"]) {
  assert.ok(!/googletagmanager|gtag\(/.test(await read(file)), `${file}: no GA tag outside react-ga4`);
}

console.log("analytics gate ok");
