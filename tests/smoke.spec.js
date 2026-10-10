import { test as base, expect } from "@playwright/test";

// Smoke tests only read. Every non-GET request is aborted in the browser, so nothing
// can submit a report, a cleanup proof, a login, or trigger an authority email.
// The Vercel bypass secret is sent only to the target host, never to third parties.
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const host = new URL(baseURL).host;
    await context.route("**/*", route => {
      const request = route.request();
      if (!READ_METHODS.has(request.method())) return route.abort();
      if (BYPASS && new URL(request.url()).host === host) {
        return route.continue({ headers: { ...request.headers(), "x-vercel-protection-bypass": BYPASS } });
      }
      return route.continue();
    });
    await use(context);
  },
});

const bypassHeaders = BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};

test("write guard blocks POST requests", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(() =>
    fetch("/api/reports/submit", { method: "POST", body: "{}" }).then(() => "sent", () => "blocked"));
  expect(outcome).toBe("blocked");
});

test("home page loads", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.status()).toBeLessThan(400);
  await expect(page.getByRole("heading", { name: "Track. Report. Clean." })).toBeVisible();
});

test("report form renders", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Report Garbage Now" }).click();
  await expect(page.getByRole("heading", { name: /Report Garbage/ })).toBeVisible();
});

test("/admin shows the login gate", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin Access" })).toBeVisible();
  await expect(page.getByPlaceholder("Enter password")).toBeVisible();
});

test("health endpoint reports ok", async ({ request }) => {
  const response = await request.get("/api/health", { headers: bypassHeaders });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("staging is not indexable", async ({ request }) => {
  const page = await request.get("/", { headers: bypassHeaders });
  expect(page.headers()["x-robots-tag"]).toContain("noindex");
  const robots = await request.get("/robots.txt", { headers: bypassHeaders });
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Disallow: /");
});
