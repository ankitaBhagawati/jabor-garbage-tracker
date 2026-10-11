import { test as base, expect } from "@playwright/test";
import { addBypass, bypassHeaders } from "./fixtures.js";

// Admin dashboard smoke tests. They sign in with real staff accounts and READ real data, but they never
// change anything: every request the dashboard sends to the proxy is inspected, reads go through, and any
// update is recorded and answered with a mock, so it never reaches the server. Anything that is not an admin
// request (and is not a GET) is aborted, as in the other smoke tests.
//
// Needs staff accounts: E2E_JMB_EMAIL and E2E_JMB_PASSWORD (a Jorhat municipality admin), and optionally
// E2E_SUPER_EMAIL and E2E_SUPER_PASSWORD. Tests skip when they are not set. Create them with
// scripts/create-demo-staff.mjs and load the demo data first (docs/DEMO-DATA.md).
const JMB = { email: process.env.E2E_JMB_EMAIL, password: process.env.E2E_JMB_PASSWORD };
const SUPER = { email: process.env.E2E_SUPER_EMAIL, password: process.env.E2E_SUPER_PASSWORD };
const READ = new Set(["GET", "HEAD", "OPTIONS"]);

async function signIn(page, account) {
  await page.goto("/admin");
  await page.getByPlaceholder("Admin email").fill(account.email);
  await page.getByPlaceholder("Enter password").fill(account.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible();
}

// One sign-in per account for the whole run (the login route allows 5 attempts per 15 minutes per address).
const sessions = new Map();
async function sessionFor(browser, baseURL, account) {
  if (!sessions.has(account.email)) {
    const context = await browser.newContext({ baseURL });
    await addBypass(context, baseURL);
    const page = await context.newPage();
    await signIn(page, account);
    sessions.set(account.email, (await context.storageState()).cookies);
    await context.close();
  }
  return sessions.get(account.email);
}

const test = base.extend({
  // The signed-in person, and the updates the page tried to send (recorded, never delivered).
  staff: [async ({ browser, baseURL, context, page }, use, testInfo) => {
    const writes = [];
    const account = testInfo.title.includes("[super]") ? SUPER : JMB;
    await addBypass(context, baseURL);
    // The guard: nothing but a GET, the sign-in and sign-out routes, and the proxy gets out.
    await context.route("**/*", route => (READ.has(route.request().method()) ? route.fallback() : route.abort()));
    await page.route("**/api/admin/*", async route => {
      const url = new URL(route.request().url());
      // continue() skips the context handler that adds the Vercel bypass header, so it is added here.
      const pass = () => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders } });
      if (READ.has(route.request().method()) || url.pathname === "/api/admin/login" || url.pathname === "/api/admin/logout") return pass();
      if (url.pathname !== "/api/admin/rest" || route.request().method() !== "POST") return route.abort();
      const envelope = JSON.parse(route.request().postData() || "{}");
      if (!envelope.method || envelope.method === "GET") return pass(); // a read: let it through
      writes.push(envelope);
      const id = /id=eq\.([0-9a-f-]{36})/.exec(envelope.path)?.[1];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id, ...envelope.body }]) });
    });
    await context.addCookies(await sessionFor(browser, baseURL, account));
    await use({ account, writes });
  }, { auto: true }], // signed in for every test in this file
});

const needsJmb = !JMB.email || !JMB.password;
const needsSuper = !SUPER.email || !SUPER.password;

// A request the page sends to the proxy, as the signed-in person. Reads only.
const proxy = (page, envelope) => page.evaluate(async body => {
  const res = await fetch("/api/admin/rest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}, envelope);

test.describe("municipality admin", () => {
  test.skip(needsJmb, "E2E_JMB_EMAIL and E2E_JMB_PASSWORD are not set");

  test("sees only their own municipality", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Admin");
    await expect(page.getByLabel("Municipality")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("button")).toHaveText(["Dashboard", "Audit log", "Hidden"]);
    await expect(page.getByRole("button", { name: "Cleanup Verification" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Moderation" })).toHaveCount(0);

    // Everything they can read belongs to one municipality, and the contact tables are closed to them.
    const reports = await proxy(page, { path: "/rest/v1/reports?select=municipality_id&limit=1000", method: "GET" });
    expect(reports.status).toBe(200);
    expect(new Set(reports.body.map(r => r.municipality_id)).size).toBe(1);
    expect((await proxy(page, { path: "/rest/v1/report_contacts?select=email", method: "GET" })).status).toBe(403);
    expect((await proxy(page, { path: "/rest/v1/authority_contacts?select=email", method: "GET" })).status).toBe(403);
    expect((await proxy(page, { path: "/rest/v1/cleanup_proofs?select=*", method: "GET" })).status).toBe(403);
    expect((await proxy(page, { path: "/rest/v1/reports?select=id,report_contacts(*)", method: "GET" })).status).toBe(403);
    expect((await proxy(page, { path: "/rest/v1/reports?select=id&municipality_id=eq.00000000-0000-4000-8000-000000000000", method: "GET" })).status).toBe(403);
    expect((await proxy(page, { path: "/rest/v1/cleanup_proofs?select=id", method: "GET" })).status).toBe(403);
    expect((await proxy(page, { path: "/rest/v1/reports?select=id", method: "GET", role: "super_admin" })).status).toBe(400);
  });

  test("tiles and filters", async ({ page }) => {
    await page.goto("/admin");
    const tile = name => page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).locator(".adm-tile-value");
    const number = async name => Number(await tile(name).innerText());
    await expect(page.locator(".adm-tile")).toHaveCount(7);
    await expect(page.locator(".adm-tile .adm-tile-value").filter({ hasText: /^\d+$/ })).toHaveCount(7); // every tile has its number
    const total = await number("Total");
    expect(total).toBeGreaterThan(0);
    // the status tiles add up to the total, leaving out only what is not counted as cleaned by JMB
    const parts = (await number("Active")) + (await number("In progress")) + (await number("Cleaned")) + (await number("Invalid")) + (await number("Auto-cleaned"));
    expect(parts).toBeLessThanOrEqual(total);
    expect(parts).toBeGreaterThan(total * 0.9);

    const pager = page.locator(".adm-pager span").first();
    await expect(pager).toContainText(`of ${total}`);
    await page.getByLabel("Status", { exact: true }).selectOption("active");
    await expect(pager).toContainText(`of ${await number("Active")}`);
    await expect(page.locator(".adm-table tbody .adm-badge-active")).toHaveCount(await page.locator(".adm-table tbody tr").count());

    await page.getByLabel("Status", { exact: true }).selectOption("");
    await page.getByLabel("Ward", { exact: true }).selectOption("unassigned");
    await expect.poll(async () => {
      const cells = await page.locator(".adm-table tbody tr td:last-child").allInnerTexts();
      return cells.length > 0 && cells.every(cell => cell.includes("Unassigned"));
    }).toBe(true);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Overdue only").check();
    await expect(pager).toContainText(`of ${await number("Overdue")}`);
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    expect(await page.locator(".adm-table tbody tr").count()).toBe(await page.locator(".adm-badge-overdue").count());

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Search").fill("zzzz-nothing-matches-this");
    await expect(page.getByText("No reports match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(pager).toContainText(`of ${total}`);

    // pages and sorting
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator(".adm-page-of")).toHaveText(/Page 2 of/);
    await page.getByRole("button", { name: "Previous" }).click();
    // the column headers are only on wider screens (on a phone each row is a card), so sort at tablet width
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.getByRole("button", { name: /^Age/ }).click();
    await expect(page.locator("th[aria-sort]").nth(2)).toHaveAttribute("aria-sort", /ascending|descending/);
  });

  test("a status change sends one update through the status rules", async ({ page, staff }) => {
    const { writes } = staff;
    await page.goto("/admin");
    await page.getByLabel("Status", { exact: true }).selectOption("active");
    await page.locator(".adm-table tbody .adm-link").first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("heading", { level: 3, name: "History" })).toBeVisible();

    // in progress, in one click
    await drawer.getByRole("button", { name: "Start work" }).click();
    await expect(drawer.getByText("Marked In progress.")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PATCH", body: { status: "in_progress" } });
    expect(writes[0].path).toMatch(/^\/rest\/v1\/reports\?id=eq\.[0-9a-f-]{36}$/);
    expect(Object.keys(writes[0].body)).toEqual(["status"]);

    // cleaned needs who and when, and is recorded as JMB
    await drawer.getByRole("button", { name: "Mark cleaned" }).click();
    await drawer.getByLabel("Cleaned by").fill("");
    await drawer.getByRole("button", { name: "Confirm cleaned" }).click();
    await expect(drawer.getByText("Say who cleaned it.")).toBeVisible();
    expect(writes).toHaveLength(1);
    await drawer.getByLabel("Cleaned by").fill("JMB ward team");
    await drawer.getByRole("button", { name: "Confirm cleaned" }).click();
    await expect(drawer.getByText("Marked Cleaned.")).toBeVisible();
    expect(writes[1].body).toMatchObject({ status: "cleaned", cleaned_by_name: "JMB ward team", cleaned_by_type: "jmb" });
    expect(Object.keys(writes[1].body).sort()).toEqual(["cleaned_at", "cleaned_by_name", "cleaned_by_type", "status"]);

    // invalid needs a reason and a note
    await drawer.getByRole("button", { name: "Mark invalid" }).click();
    await drawer.getByRole("button", { name: "Confirm invalid" }).click();
    await expect(drawer.getByText("Choose a reason.")).toBeVisible();
    await drawer.getByLabel("Reason").selectOption("duplicate");
    await drawer.getByRole("button", { name: "Confirm invalid" }).click();
    await expect(drawer.getByText("Write a note saying why it is invalid.")).toBeVisible();
    await drawer.getByLabel("Note (required)").fill("Same as another report");
    await drawer.getByRole("button", { name: "Confirm invalid" }).click();
    await expect(drawer.getByText("Marked Invalid.")).toBeVisible();
    expect(writes[2].body).toEqual({ status: "invalid", invalid_reason: "duplicate", admin_note: "Same as another report" });
    expect(writes).toHaveLength(3);
    for (const write of writes) expect(write.method).toBe("PATCH"); // never a delete or an insert
  });

  test("a ward can be assigned, and only to this municipality's wards", async ({ page, staff }) => {
    const { writes } = staff;
    await page.goto("/admin");
    await page.getByLabel("Ward", { exact: true }).selectOption("unassigned");
    await page.locator(".adm-table tbody .adm-link").first().click();
    const drawer = page.getByRole("dialog");
    const select = drawer.locator("#d-ward");
    await expect(select).toHaveValue("");
    await expect(drawer.getByRole("button", { name: "Save ward" })).toBeDisabled();
    const options = await select.locator("option").allInnerTexts();
    expect(options[0]).toBe("Unassigned");
    expect(options.slice(1).every(text => /^Ward \d+/.test(text))).toBe(true);
    await select.selectOption({ index: 2 });
    await drawer.getByRole("button", { name: "Save ward" }).click();
    await expect(drawer.getByText("Ward saved.")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ ward_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(writes[0].path).toMatch(/^\/rest\/v1\/reports\?id=eq\./);

    // an internal note is its own update
    await drawer.locator("#d-note").fill("Checked with the ward office");
    await drawer.getByRole("button", { name: "Save note" }).click();
    await expect(drawer.getByText("Note saved.")).toBeVisible();
    expect(writes[1].body).toEqual({ admin_note: "Checked with the ward office" });
  });

  test("the audit log filters, pages and opens reports", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("button", { name: "Audit log" }).click();
    const rows = page.locator(".adm-table tbody tr");
    await expect(rows.first()).toBeVisible();
    const pager = page.locator(".adm-pager span").first();
    await expect(pager).toContainText("Showing 1 to");
    const total = Number(/of (\d+)/.exec(await pager.innerText())?.[1]);

    await page.getByLabel("Action").selectOption("status_change");
    await expect(pager).not.toContainText(`of ${total}`);
    for (const cell of await rows.locator("strong").allInnerTexts()) expect(cell).toBe("Status changed");

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Done by").fill("public");
    await expect.poll(async () => {
      const cells = await rows.locator("td:nth-child(2)").allInnerTexts();
      return cells.length > 0 && cells.every(cell => cell === "Public (citizen)");
    }).toBe(true);
    await page.getByRole("button", { name: "Clear filters" }).click();

    await expect(pager).toContainText(`of ${total}`);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator(".adm-page-of")).toHaveText(/Page 2 of/);
    await rows.first().getByRole("button", { name: "Open report" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { level: 3, name: "History" })).toBeVisible();
  });
});

test.describe("owner", () => {
  test.skip(needsSuper, "E2E_SUPER_EMAIL and E2E_SUPER_PASSWORD are not set");

  test("[super] chooses a municipality and keeps the older screens", async ({ page }) => {
    await page.goto("/admin");
    const selector = page.getByLabel("Municipality");
    await expect(selector).toBeVisible();
    await expect(selector.locator("option:checked")).toContainText("Jorhat");
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("button")).toHaveText(["Dashboard", "Audit log", "Hidden", "Cleanup Verification", "Moderation"]);
    await expect(page.locator(".adm-tile", { hasText: "Total" }).locator(".adm-tile-value")).not.toHaveText("0");
    await page.getByRole("button", { name: "Cleanup Verification" }).click();
    await expect(page.getByRole("heading", { name: /Cleanup Proofs/ })).toBeVisible();
  });
});
