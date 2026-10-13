import { expect, test } from "./fixtures.js";

// The feed is mocked, so this never reads or changes real reports.
const PHOTO = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#7a9"/></svg>');
const report = { id: "r1", constituency: "Jorhat", district: "Jorhat", waste_type: "plastic", description: "Plastic near the road", photo_url: PHOTO, cleanup_photo_url: null, status: "active", area: null, landmark: null, created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z" };

test.beforeEach(async ({ page }) => {
  await page.route("**/rest/v1/public_reports*", route => route.fulfill({ json: /status=in\.\(cleaned\)/.test(route.request().url()) ? [] : [report] }));
  await page.route("**/rest/v1/cleanup_proofs*", route => route.fulfill({ json: [] }));
  await page.goto("/");
});

const dialog = page => page.getByRole("dialog", { name: "Photo" });

test("clicking a feed photo enlarges it and the cross closes it", async ({ page }) => {
  await page.getByRole("button", { name: "Enlarge photo: Garbage report" }).first().click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("img", { name: "Report photo, enlarged" })).toBeVisible();
  // The report window behind it was not opened by the click.
  await expect(page.getByText("District", { exact: true })).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Close photo" }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test("Escape and a click outside also close it, and it fits the screen", async ({ page }) => {
  const open = () => page.getByRole("button", { name: "Enlarge photo: Garbage report" }).first().click();
  await open();
  const box = await dialog(page).getByRole("img").boundingBox();
  const view = page.viewportSize();
  expect(box.width).toBeLessThanOrEqual(view.width);
  expect(box.height).toBeLessThanOrEqual(view.height);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await open();
  await page.mouse.click(5, view.height - 5);
  await expect(dialog(page)).toHaveCount(0);
});

test("the photo in the report window enlarges too", async ({ page }) => {
  await page.getByText("Plastic near the road").first().click();
  await page.getByRole("button", { name: "Enlarge photo: garbage", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});
