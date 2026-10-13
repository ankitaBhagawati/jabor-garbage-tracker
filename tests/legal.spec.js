import { expect, test } from "./fixtures.js";

// The Privacy Policy and Terms pages (public, reads only).
for (const [path, title, other] of [["/privacy", "Privacy Policy", "Terms and Conditions"], ["/terms", "Terms and Conditions", "Privacy Policy"]]) {
  for (const [name, viewport] of [["360px", { width: 360, height: 700 }], ["desktop", { width: 1280, height: 800 }]]) {
    test(`${path} opens on its own address and reads well (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const response = await page.goto(path);
      expect(response.status()).toBeLessThan(400);
      await expect(page).toHaveTitle(`${title} | Jabor`);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByText(/^Last updated: \d{1,2} \w+ 20\d\d$/)).toBeVisible();
      // the page is the reading page, not the app: no app header, and the way back is there
      await expect(page.locator("header.top-appbar")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Back to Jabor" })).toBeVisible();
      const sections = page.locator(".legal-main section");
      expect(await sections.count()).toBeGreaterThanOrEqual(10);
      // nothing runs off the side, links and targets are tap-sized, and the text is plain
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const back = await page.getByRole("link", { name: "Back to Jabor" }).boundingBox();
      expect(back.height).toBeGreaterThanOrEqual(44);
      const text = await page.locator(".legal").innerText();
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}☀-➿]/u);
      // the contents list jumps to a section, and the other page is one click away
      await page.getByRole("navigation", { name: "On this page" }).getByRole("link").nth(2).click();
      await expect(page).toHaveURL(new RegExp(`${path}#s3$`));
      await expect(page.getByRole("link", { name: other }).last()).toHaveAttribute("href", other === "Privacy Policy" ? "/privacy" : "/terms");
      await expect(page.getByRole("link", { name: "Contact us" })).toHaveAttribute("href", /^mailto:jaborassam@gmail\.com/);
    });
  }
}

test("the footer and the report form link to both pages", async ({ page, context }) => {
  await page.goto("/");
  const footer = page.locator("footer").last();
  await expect(footer.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  await expect(footer.getByRole("link", { name: "Terms and Conditions" })).toHaveAttribute("href", "/terms");
  await page.getByRole("button", { name: "Report Garbage Now" }).click();
  const agree = page.getByText(/By sending a report you agree to the/);
  await agree.scrollIntoViewIfNeeded();
  // they open in a new tab, so a half-filled form is not lost
  await expect(agree.getByRole("link", { name: "Terms and Conditions" })).toHaveAttribute("target", "_blank");
  await expect(agree.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("target", "_blank");
  const opened = context.waitForEvent("page");
  await agree.getByRole("link", { name: "Privacy Policy" }).click();
  const tab = await opened;
  await tab.waitForLoadState();
  await expect(tab.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await tab.close();
});

test("a trailing slash and the app's own routes still work", async ({ page }) => {
  await page.goto("/privacy/");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Track. Report. Clean." })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Admin Access" })).toBeVisible();
});
