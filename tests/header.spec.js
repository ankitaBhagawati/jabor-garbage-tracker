import { expect, test } from "./fixtures.js";

// The Jabor logo bar is on every page, admin included. Its own menu button is only for the public site: the admin
// area has its own menu button. Reads only, no sign-in needed: /admin shows the sign-in gate, which counts as admin.
test("the public header is on public pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header.top-appbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to dashboard" })).toBeVisible();
});

for (const [name, viewport] of [["360px", { width: 360, height: 700 }], ["desktop", { width: 1280, height: 800 }]]) {
  test(`the logo bar stays on /admin without its menu button (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin Access" })).toBeVisible();
    await expect(page.locator("header.top-appbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("leaving /admin for a public page brings the logo bar's menu button back", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
});
