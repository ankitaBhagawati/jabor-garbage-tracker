import { defineConfig, devices } from "@playwright/test";

// Read-only smoke tests. Default target is staging; never production.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "https://staging.jabor.in";
if (/^(www\.)?jabor\.in$/.test(new URL(baseURL).host)) {
  throw new Error("Smoke tests must not run against production.");
}

export default defineConfig({
  testDir: "tests",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL,
    // The app registers a service worker; blocking it keeps every request visible to the write guard.
    serviceWorkers: "block",
    // Traces record request headers, which would include the Vercel bypass secret.
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Pixel 7"] } }],
});
