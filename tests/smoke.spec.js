import { bypassHeaders, expect, test } from "./fixtures.js";

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
  await expect(page.getByText(/security check is not configured/i)).toHaveCount(0);
});

test("municipal area question and ward list", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Report Garbage Now" }).click();
  await page.locator("select").nth(0).selectOption("Jorhat");
  const question = page.getByRole("group", { name: /is this location within .* area/i });
  // Mariani is in district Jorhat but is not covered by the municipality settings: no question.
  await page.locator("select").nth(1).selectOption("Mariani");
  await expect(question).toHaveCount(0);
  await page.locator("select").nth(1).selectOption("Jorhat");
  await expect(question).toBeVisible();
  await expect(page.getByLabel("Ward")).toHaveCount(0);
  await question.getByRole("radio", { name: "Yes", exact: true }).check();
  const options = await page.getByLabel("Ward").locator("option").allTextContents();
  expect(options).toContain("Ward 1");
  expect(options).toContain("Ward 19");
  expect(options).toContain("Not sure, JMB will assign");
  await question.getByRole("radio", { name: "No", exact: true }).check();
  await expect(page.getByLabel("Ward")).toHaveCount(0);
  await question.getByRole("radio", { name: "Not sure" }).check();
  await expect(page.getByLabel("Ward")).toHaveCount(0);
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
