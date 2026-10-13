import { expect, test } from "./fixtures.js";

// The public site's look: content is there at once (no splash, no scroll-in), no emoji, SVG icons in their place.
const EMOJI = /[\u{1F000}-\u{1FAFF}☀-➿⭐✅❌⏳ℹ]/u;

test("the home page is readable at once: no splash screen, no headline fading in, no sections hidden until scrolled to", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".startup-loader")).toHaveCount(0);
  const heading = page.getByRole("heading", { name: "Track. Report. Clean." });
  await expect(heading).toBeVisible();
  // every word of the headline is fully opaque straight away (it used to fade in over about three seconds)
  const opacity = await page.locator(".hero-word").evaluateAll(words => words.map(w => getComputedStyle(w).opacity));
  expect(opacity).toEqual(["1", "1", "1"]);
  // sections far down the page are not waiting for a scroll to appear
  const hidden = await page.locator(".page-section, .section-band").evaluateAll(sections => sections.filter(s => getComputedStyle(s).opacity !== "1").length);
  expect(hidden).toBe(0);
  // only a spinner and the short fades remain
  expect(await page.evaluate(() => document.getAnimations().filter(a => a.animationName && !["spin", "slideIn", "fadeIn", "popIn", "drawerIn"].includes(a.animationName)).map(a => a.animationName))).toEqual([]);
});

test("no emoji on the home page or the report form; waste types and places use SVG icons", async ({ page }) => {
  await page.goto("/");
  expect(await page.locator("body").innerText()).not.toMatch(EMOJI);
  await page.getByRole("button", { name: "Report Garbage Now" }).click();
  await expect(page.getByRole("heading", { name: "Report Garbage" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(EMOJI);
  const chips = page.locator(".chip");
  expect(await chips.count()).toBe(6);
  for (const chip of await chips.all()) await expect(chip.locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Back to dashboard" }).locator("svg")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("buttons and navigation have square corners with a small radius, not a pill", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  const radii = await page.evaluate(() => [...document.querySelectorAll("button, .btn-p, .btn-s, .icon-action, .drawer-link, .quote-nav, .status-pill")]
    .filter(el => el.getBoundingClientRect().width > 0)
    .map(el => ({ name: el.className || el.tagName, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), height: el.getBoundingClientRect().height }))
    .filter(item => item.radius >= item.height / 2 && item.height > 12 && item.radius > 12));
  expect(radii).toEqual([]);
  await page.setViewportSize({ width: 360, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the feed cards and the report view carry no emoji", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(".rcard").first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  expect(await card.innerText()).not.toMatch(EMOJI);
  await card.click();
  await expect(page.getByText("REPORT DETAILS")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(EMOJI);
});
