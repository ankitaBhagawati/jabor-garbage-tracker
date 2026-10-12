import { expect, test } from "./fixtures.js";

// The public form's dropdowns and the feed filters. Nothing here submits anything (the guard in
// fixtures.js blocks every write), and it only needs the public data the site already loads.

const DESKTOP = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };
const PHONE = { viewport: { width: 360, height: 640 } };

const openForm = async page => {
  await page.goto("/");
  await page.getByRole("button", { name: "Report Garbage Now" }).click();
  await expect(page.getByRole("combobox", { name: /district/i })).toBeVisible();
};
const district = page => page.getByRole("combobox", { name: /district/i });
const constituency = page => page.getByRole("combobox", { name: /constituency/i });

test.describe("report form dropdowns, desktop", () => {
  test.use(DESKTOP);

  test("opens a bounded panel, filters as you type, and picks with the keyboard", async ({ page }) => {
    await openForm(page);
    await expect(district(page)).toContainText("Select district");
    await district(page).click();
    const panel = page.locator(".jsel-panel");
    await expect(panel).toBeVisible();
    await expect(district(page)).toHaveAttribute("aria-expanded", "true");
    const box = await panel.boundingBox();
    expect(box.height).toBeLessThanOrEqual(280);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    // a long list is searchable, and focus is in the search box
    const search = page.getByRole("searchbox", { name: /search district/i });
    await expect(search).toBeFocused();
    const all = await page.getByRole("option").count();
    expect(all).toBeGreaterThan(8);
    await search.fill("jor");
    const shown = await page.getByRole("option").allInnerTexts();
    expect(shown.length).toBeLessThan(all);
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) expect(text.toLowerCase()).toContain("jor");
    await search.fill("zzzzz");
    await expect(page.getByText("No matches")).toBeVisible();
    await search.fill("jorhat");
    // options are tall enough to tap
    const option = page.getByRole("option", { name: "Jorhat", exact: true });
    expect((await option.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await search.press("ArrowDown");
    await expect(search).toHaveAttribute("aria-activedescendant", /.+/);
    await search.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(district(page)).toContainText("Jorhat");
    await expect(district(page)).toBeFocused();
    // the chosen item has a check
    await district(page).click();
    await expect(page.getByRole("option", { selected: true })).toHaveText("Jorhat");
    await expect(page.getByRole("option", { selected: true }).locator("svg")).toBeVisible();
  });

  test("Escape and a click outside close it; arrows, Home and End move; Enter chooses", async ({ page }) => {
    await openForm(page);
    await district(page).press("ArrowDown"); // opens from the keyboard
    await expect(page.locator(".jsel-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".jsel-panel")).toHaveCount(0);
    await expect(district(page)).toBeFocused();
    await district(page).click();
    await expect(page.locator(".jsel-panel")).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.locator(".jsel-panel")).toHaveCount(0);

    await district(page).click();
    const search = page.getByRole("searchbox", { name: /search district/i });
    const options = page.getByRole("option");
    const count = await options.count();
    await search.press("End");
    await expect(search).toHaveAttribute("aria-activedescendant", await options.nth(count - 1).getAttribute("id"));
    await search.press("Home");
    await expect(search).toHaveAttribute("aria-activedescendant", await options.nth(0).getAttribute("id"));
    await search.press("ArrowDown");
    await search.press("ArrowDown");
    const second = await options.nth(2).innerText();
    await search.press("Enter");
    await expect(district(page)).toContainText(second);
  });

  test("changing the district resets the constituency, as before", async ({ page }) => {
    await openForm(page);
    await district(page).click();
    await page.getByRole("option", { name: "Jorhat", exact: true }).click();
    await expect(constituency(page)).toBeVisible();
    await expect(constituency(page)).toContainText("Select constituency");
    await constituency(page).click();
    await page.getByRole("option", { name: "Mariani", exact: true }).click();
    await expect(constituency(page)).toContainText("Mariani");
    await page.getByPlaceholder("e.g. Fancy Bazar").fill("Somewhere");
    // another district: the constituency and the area are cleared
    await district(page).click();
    await page.getByRole("option").last().click();
    await expect(district(page)).not.toContainText("Jorhat");
    await expect(constituency(page)).toContainText("Select constituency");
    await expect(page.getByPlaceholder("e.g. Fancy Bazar")).toHaveCount(0);
  });

  test("the municipal question and ward list use the same control", async ({ page }) => {
    await openForm(page);
    await district(page).click();
    await page.getByRole("option", { name: "Jorhat", exact: true }).click();
    await constituency(page).click();
    await page.getByRole("option", { name: "Mariani", exact: true }).click();
    const question = page.getByRole("group", { name: /is this location within .* area/i });
    await expect(question).toHaveCount(0); // Mariani is not covered by the municipality
    await constituency(page).click();
    await page.getByRole("option", { name: "Jorhat", exact: true }).click();
    await expect(question).toBeVisible();
    await question.getByRole("radio", { name: "Yes", exact: true }).check();
    const ward = page.getByRole("combobox", { name: /ward/i });
    await ward.click();
    const labels = await page.getByRole("option").allInnerTexts();
    expect(labels).toContain("Ward 1");
    expect(labels).toContain("Ward 19");
    expect(labels).toContain("Not sure, JMB will assign");
    await page.getByRole("searchbox", { name: /search ward/i }).fill("ward 7");
    await page.getByRole("option", { name: "Ward 7", exact: true }).click();
    await expect(ward).toContainText("Ward 7");
    // answering No clears the ward question and its answer
    await question.getByRole("radio", { name: "No", exact: true }).check();
    await expect(page.getByRole("combobox", { name: /ward/i })).toHaveCount(0);
    await question.getByRole("radio", { name: "Yes", exact: true }).check();
    await expect(page.getByRole("combobox", { name: /ward/i })).toContainText("Select ward");
  });
});

test.describe("report form dropdowns, 360px phone", () => {
  test.use(PHONE);

  test("the panel is a bottom sheet no taller than half the screen, and the page does not scroll sideways", async ({ page }) => {
    await openForm(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await district(page).click();
    const sheet = page.locator(".jsel-sheet");
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(box.x).toBe(0);
    expect(box.width).toBe(360);
    expect(box.height).toBeLessThanOrEqual(640 * 0.5 + 1);
    expect(Math.round(box.y + box.height)).toBe(640); // sits on the bottom edge
    // the list scrolls inside the sheet; the page behind does not move to make room
    expect(await page.locator(".jsel-list").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect((await page.getByRole("option").first().boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
    // choose by tapping, then close from the backdrop
    await page.getByRole("option", { name: "Jorhat", exact: true }).first().tap();
    await expect(sheet).toHaveCount(0);
    await expect(district(page)).toContainText("Jorhat");
    await district(page).tap();
    await expect(sheet).toBeVisible();
    await page.mouse.click(180, 40); // the dimmed page above the sheet
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("feed filters", () => {
  test.use(DESKTOP);

  test("each filter has a cross that appears only with a value and clears just that filter", async ({ page }) => {
    await page.goto("/");
    const waste = page.getByRole("combobox", { name: /waste type/i }).first();
    const range = page.getByRole("combobox", { name: /date range/i }).first();
    await waste.scrollIntoViewIfNeeded();
    await expect(waste).toContainText("All waste types");
    await expect(range).toContainText("Any time");
    await expect(page.getByRole("button", { name: /clear waste type/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /clear date range/i })).toHaveCount(0);

    await waste.click();
    await page.getByRole("option").nth(1).click();
    const chosenWaste = (await waste.innerText()).trim();
    expect(chosenWaste).not.toBe("All waste types");
    await range.click();
    await page.getByRole("option", { name: "Last month", exact: true }).click();
    await expect(range).toContainText("Last month");
    await expect(page.getByRole("button", { name: /clear waste type/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /clear date range/i }).first()).toBeVisible();

    // clearing one leaves the other alone
    await page.getByRole("button", { name: /clear waste type/i }).first().click();
    await expect(waste).toContainText("All waste types");
    await expect(range).toContainText("Last month");
    await expect(page.getByRole("button", { name: /clear waste type/i })).toHaveCount(0);
    await page.getByRole("button", { name: /clear date range/i }).first().click();
    await expect(range).toContainText("Any time");
  });

  test("report cards and the report view show the status but no dates or ages", async ({ page }) => {
    await page.goto("/");
    const card = page.locator(".rcard").first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    await expect(card.locator(".status-pill")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\b(\d+d|\d+h|now) ago\b/);
    await card.click();
    const view = page.locator("text=REPORT DETAILS").locator("..").locator("..");
    await expect(view).toBeVisible();
    await expect(page.getByText(/Status:/)).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/\bReported\b.*\bago\b|\bago\b/);
  });
});
