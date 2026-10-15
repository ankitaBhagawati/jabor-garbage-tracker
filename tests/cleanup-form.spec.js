import { expect, test } from "./fixtures.js";

// The cleanup proof form on a phone: every field, the security check and the button sit inside the form, nothing
// scrolls sideways, and the button is a comfortable tap target. Read-only: the form is opened, never submitted.
test("the cleanup proof form fits a 390px phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const open = page.getByRole("button", { name: "Reply: Report Cleaned Up" }).first();
  await open.scrollIntoViewIfNeeded();
  await open.click();
  const form = page.locator(".cleanup-form").first();
  await expect(form).toBeVisible();
  await expect(form.getByText("Choose photo")).toBeVisible();
  await expect(form.getByLabel("When was it cleaned?")).toBeVisible();
  // the security check, once it has rendered, is inside the form too
  await page.waitForFunction(() => document.querySelector(".cleanup-form iframe") || document.querySelector(".cleanup-form [role=alert]"), null, { timeout: 15_000 }).catch(() => {});
  const outside = await form.evaluate(f => {
    const box = f.getBoundingClientRect();
    return [...f.querySelectorAll(":scope > *, iframe")]
      .map(el => ({ el: el.tagName + "." + el.className, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5))
      .map(({ el }) => el);
  });
  expect(outside).toEqual([]);
  expect((await form.locator("button[type=submit]").boundingBox()).height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
