import { expect, test } from "./fixtures.js";

// The public site has its own header (logo bar and menu); the admin area has its own, and only one of them shows.
// Reads only, no sign-in needed: /admin shows the sign-in gate, which is in the admin area too.
test("the public header is on public pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header.top-appbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to dashboard" })).toBeVisible();
});

for (const [name, viewport] of [["360px", { width: 360, height: 700 }], ["desktop", { width: 1280, height: 800 }]]) {
  test(`the public header is not on /admin (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin Access" })).toBeVisible();
    await expect(page.locator("header.top-appbar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Go to dashboard" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("leaving /admin for a public page brings the public header back", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.locator("header.top-appbar")).toHaveCount(0);
  await page.goto("/");
  await expect(page.locator("header.top-appbar")).toBeVisible();
});
