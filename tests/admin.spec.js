import fs from "node:fs/promises";
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
const BOM = String.fromCharCode(0xfeff);
const DESKTOP = { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false };
const PHONE = { viewport: { width: 360, height: 640 } };
const READ = new Set(["GET", "HEAD", "OPTIONS"]);
// The monthly report and the hotspot ranking are database functions called with POST, but they only read.
const READ_RPC = /^\/rest\/v1\/rpc\/(monthly_ward_report|ward_hotspots)$/;

async function signIn(page, account) {
  await page.goto("/admin");
  await page.getByPlaceholder("Admin email").fill(account.email);
  await page.getByPlaceholder("Enter password").fill(account.password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByRole("button", { name: "Account" })).toBeVisible();
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
    const exports = []; // CSV export requests: recorded and answered with a stub, so no audit row is written on the site under test
    const exportReply = { status: 200 };
    const account = testInfo.title.includes("[super]") ? SUPER : JMB;
    await addBypass(context, baseURL);
    // The guard: nothing but a GET, the sign-in and sign-out routes, and the proxy gets out.
    await context.route("**/*", route => (READ.has(route.request().method()) ? route.fallback() : route.abort()));
    await page.route("**/api/admin/*", async route => {
      const url = new URL(route.request().url());
      // continue() skips the context handler that adds the Vercel bypass header, so it is added here.
      const pass = () => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders } });
      if (READ.has(route.request().method()) || url.pathname === "/api/admin/login" || url.pathname === "/api/admin/logout") return pass();
      if (url.pathname === "/api/admin/export" && route.request().method() === "POST") {
        exports.push(JSON.parse(route.request().postData() || "{}"));
        if (exportReply.status === 413) return route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "12,345 reports match. An export holds at most 10,000. Narrow the filters (a date range or a ward) and try again." }) });
        return route.fulfill({ status: 200, contentType: "text/csv", headers: { "content-disposition": 'attachment; filename="jabor-reports-test.csv"', "x-row-count": "2" }, body: "id,date\r\nabc,2026-10-01\r\n" });
      }
      if (url.pathname !== "/api/admin/rest" || route.request().method() !== "POST") return route.abort();
      const envelope = JSON.parse(route.request().postData() || "{}");
      if (!envelope.method || envelope.method === "GET" || (envelope.method === "POST" && READ_RPC.test(envelope.path))) return pass(); // a read: let it through
      writes.push(envelope);
      const id = /id=eq\.([0-9a-f-]{36})/.exec(envelope.path)?.[1];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id, ...envelope.body }]) });
    });
    await context.addCookies(await sessionFor(browser, baseURL, account));
    await use({ account, writes, exports, exportReply });
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
  test.use(DESKTOP);

  test("sees only their own municipality", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Jabor - .+ admin$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Jorhat");
    await expect(page.getByLabel("Municipality")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("link")).toHaveText(["Dashboard", "Reports", "Hotspots", "Monthly report", "Audit log"]);
    await expect(page.getByRole("link", { name: "Cleanup Verification" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Moderation" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Hidden" })).toHaveCount(0); // Hidden is a tab of Reports now

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

  test("the dashboard tiles lead to the Reports page", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Dashboard");
    const tile = name => page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).locator(".adm-tile-value");
    const number = async name => Number(await tile(name).innerText());
    await expect(page.locator(".adm-tile")).toHaveCount(8);
    await expect(page.locator(".adm-tile .adm-tile-value").filter({ hasText: /^\d+$/ })).toHaveCount(8); // every tile has its number
    await expect(page.getByRole("table")).toHaveCount(0); // the table lives on the Reports page
    const total = await number("Total");
    expect(total).toBeGreaterThan(0);
    // the status tiles add up to the total, leaving out only what is not counted as cleaned by JMB
    const parts = (await number("Active")) + (await number("In progress")) + (await number("Cleaned")) + (await number("Invalid")) + (await number("Auto-cleaned"));
    expect(parts).toBeLessThanOrEqual(total);
    expect(parts).toBeGreaterThan(total * 0.9);

    // each tile opens Reports with its filter, and the table's total is the tile's number
    const statusCases = [["Invalid", "invalid", await number("Invalid")], ["Auto-cleaned", "auto_cleaned", await number("Auto-cleaned")]];
    const overdue = await number("Overdue");
    const pager = page.locator(".adm-pager span").first();
    const cases = [["Total", "all", total], ["Active", "active", await number("Active")], ["In progress", "in_progress", await number("In progress")], ["Cleaned", "cleaned", await number("Cleaned")],
      ["Unassigned wards", "unassigned", await number("Unassigned wards")]];
    for (const [name, tab, expected] of cases) {
      await page.goto("/admin#/dashboard");
      await page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).click();
      await expect(page.getByRole("heading", { level: 2 })).toHaveText("Reports");
      await expect(page).toHaveURL(new RegExp(tab === "all" ? "#/reports$" : `#/reports/${tab}$`));
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", `rt-${tab}`);
      if (expected === 0) await expect(page.getByText(/There are no reports|No reports match/)).toBeVisible();
      else await expect(pager).toContainText(`of ${expected}`);
    }
    for (const [name, status, expected] of statusCases) {
      await page.goto("/admin#/dashboard");
      await page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).click();
      await expect(page).toHaveURL(new RegExp(`status=${status}`));
      await expect(page.getByLabel("Status", { exact: true })).toHaveValue(status);
      if (expected === 0) await expect(page.getByText(/There are no reports|No reports match/)).toBeVisible();
      else await expect(pager).toContainText(`of ${expected}`);
    }
    await page.goto("/admin#/dashboard");
    await page.locator(".adm-tile").filter({ has: page.getByText("Overdue", { exact: true }) }).click();
    await expect(page.getByLabel("Overdue only")).toBeChecked();
    await expect(pager).toContainText(`of ${overdue}`);
  });

  test("Unassigned wards counts reports with no ward, leaving out invalid and hidden ones", async ({ page }) => {
    await page.goto("/admin");
    const tile = name => page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).locator(".adm-tile-value");
    await expect(page.locator(".adm-tile .adm-tile-value").filter({ hasText: /^\d+$/ })).toHaveCount(8);
    const unassigned = Number(await tile("Unassigned wards").innerText());
    // the same number from the data: all reports with no ward, minus the invalid or hidden ones among them
    const all = await proxy(page, { path: "/rest/v1/reports?select=id,status,is_deleted,ward_id&ward_id=is.null&limit=1000", method: "GET" });
    expect(all.status).toBe(200);
    const open = all.body.filter(r => !r.is_deleted && ["verified", "pending", "active", "reported", "open", "in_progress", "cleaned"].includes(r.status));
    expect(open.length).toBe(unassigned);
    expect(all.body.length).toBeGreaterThanOrEqual(unassigned);
    // the tab shows exactly those reports: unassigned, none invalid or hidden
    await page.locator(".adm-tile").filter({ has: page.getByText("Unassigned wards", { exact: true }) }).click();
    const pager = page.locator(".adm-pager span").first();
    if (unassigned > 0) await expect(pager).toContainText(`of ${unassigned}`);
    await expect(page.getByLabel("Ward", { exact: true })).toHaveCount(0); // the tab is the ward filter
    await expect(page.getByLabel("Status", { exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      const cells = await page.locator(".adm-table tbody tr td:last-child").allInnerTexts();
      return cells.length > 0 && cells.every(cell => cell.includes("Unassigned"));
    }).toBe(true);
    await expect(page.locator(".adm-badge-invalid")).toHaveCount(0);
  });

  test("the Reports page: tabs, filters, paging and sorting", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Reports");
    await expect(page.getByRole("tab")).toHaveText(["All reports", "Unassigned wards", "Active", "In progress", "Cleaned", "Hidden"]);
    const pager = page.locator(".adm-pager span").first();
    await expect(pager).toContainText("Showing 1 to");
    const total = Number(/of (\d+)/.exec(await pager.innerText())?.[1]);
    expect(total).toBeGreaterThan(0);

    // status filter lives on All reports; Invalid is reachable there
    await page.getByLabel("Status", { exact: true }).selectOption("active");
    await expect(page.locator(".adm-table tbody .adm-badge-active")).toHaveCount(await page.locator(".adm-table tbody tr").count());
    await page.getByLabel("Status", { exact: true }).selectOption("invalid");
    await expect(page.locator(".adm-table tbody .adm-badge-invalid").first()).toBeVisible();
    await page.getByLabel("Status", { exact: true }).selectOption("");

    // the Active tab and the Overdue filter
    await page.getByRole("tab", { name: "Active" }).click();
    await expect(page).toHaveURL(/#\/reports\/active$/);
    await expect(page.getByLabel("Status", { exact: true })).toHaveCount(0);
    await page.getByLabel("Overdue only").check();
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    await expect.poll(async () => (await page.locator(".adm-table tbody tr").count()) === (await page.locator(".adm-badge-overdue").count())).toBe(true);
    await page.getByRole("tab", { name: "Cleaned" }).click();
    await expect(page.getByLabel("Overdue only")).toHaveCount(0); // Active reports only
    await page.getByRole("tab", { name: "All reports" }).click();
    await page.getByRole("button", { name: "Clear filters" }).click();

    // ward filter, search, paging, sorting
    await page.getByLabel("Ward", { exact: true }).selectOption("unassigned");
    await expect.poll(async () => {
      const cells = await page.locator(".adm-table tbody tr td:last-child").allInnerTexts();
      return cells.length > 0 && cells.every(cell => cell.includes("Unassigned"));
    }).toBe(true);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Search").fill("zzzz-nothing-matches-this");
    await expect(page.getByText("No reports match these filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(pager).toContainText(`of ${total}`);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator(".adm-page-of")).toHaveText(/Page 2 of/);
    await page.getByRole("button", { name: "Previous" }).click();
    await page.getByRole("button", { name: /^Age/ }).click();
    await expect(page.locator("th[aria-sort]").nth(2)).toHaveAttribute("aria-sort", /ascending|descending/);
  });

  test("the Reports tabs add up to the dashboard", async ({ page }) => {
    await page.goto("/admin");
    const tile = name => page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).locator(".adm-tile-value");
    await expect(page.locator(".adm-tile .adm-tile-value").filter({ hasText: /^\d+$/ })).toHaveCount(8);
    const n = {};
    for (const name of ["Total", "Active", "In progress", "Cleaned", "Invalid"]) n[name] = Number(await tile(name).innerText());
    await page.goto("/admin#/reports");
    const pager = page.locator(".adm-pager span").first();
    for (const [tab, expected] of [["All reports", n.Total], ["Active", n.Active], ["In progress", n["In progress"]], ["Cleaned", n.Cleaned]]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await expect(pager).toContainText(`of ${expected}`);
    }
    // Hidden lists the reports that are off the public site (hidden or invalid): the Invalid tile
    await page.getByRole("tab", { name: "Hidden" }).click();
    await expect(page.getByRole("heading", { name: `Hidden (${n.Invalid})` })).toBeVisible();
  });

  test("Hidden keeps Restore working", async ({ page, staff }) => {
    await page.goto("/admin#/reports/hidden");
    await expect(page.getByRole("heading", { name: /^Hidden \(\d+\)$/ })).toBeVisible();
    const restore = page.getByRole("button", { name: "Restore", exact: true }).first();
    await expect(restore).toBeVisible();
    await restore.click();
    const dialog = page.getByRole("dialog", { name: "Restore this report?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(staff.writes).toHaveLength(0);
    await restore.click();
    await dialog.getByLabel("Note (optional)").fill("Checked again");
    await dialog.getByRole("button", { name: "Restore", exact: true }).click();
    await expect.poll(() => staff.writes.length).toBeGreaterThan(0);
    expect(staff.writes.every(w => w.method === "PATCH")).toBe(true); // never a delete
  });

  test("the user icon shows who is signed in", async ({ page }) => {
    await page.goto("/admin");
    // nothing about the person or Sign out sits in the header any more
    await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0);
    await expect(page.locator(".adm-bar")).not.toContainText("@");
    const icon = page.getByRole("button", { name: "Account" });
    await icon.click();
    const popover = page.getByRole("dialog", { name: "Account" });
    await expect(popover).toContainText(JMB.email);
    await expect(popover).toContainText("Municipality admin");
    await expect(popover.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(icon).toBeFocused();
    await icon.click();
    await page.mouse.click(600, 500);
    await expect(popover).toHaveCount(0);
    await icon.press("Enter");
    await expect(popover).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(popover).toHaveCount(0); // focus left it
  });

  test("the page is in the address, so a refresh stays on it; the menu button collapses the sidebar", async ({ page }) => {
    const side = page.getByRole("navigation", { name: "Admin sections" });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Dashboard");
    await expect(side).toBeVisible(); // open on a wide screen
    await side.getByRole("link", { name: "Hotspots" }).click();
    await expect(page).toHaveURL(/#\/hotspots$/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Hotspots");
    await expect(side.getByRole("link", { name: "Hotspots" })).toHaveAttribute("aria-current", "page");
    await side.getByRole("link", { name: "Reports" }).click();
    await page.getByRole("tab", { name: "In progress" }).click();
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", "rt-in_progress");
    await page.goBack();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Reports");
    // an address that is not a page is the dashboard
    await page.goto("/admin#/no-such-page");
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Dashboard");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await menu.click();
    await expect(side).toBeHidden();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(side).toBeVisible();
  });

  test("a status change sends one update through the status rules", async ({ page, staff }) => {
    const { writes } = staff;
    await page.goto("/admin#/reports/active");
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
    await page.goto("/admin#/reports/unassigned");
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
    await page.goto("/admin#/audit");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Audit log");
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
  test("the reports export sends only the filters and tells the person what happened", async ({ page, staff }) => {
    await page.goto("/admin#/reports");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    await page.getByLabel("Status", { exact: true }).selectOption("active");
    await page.getByLabel("Ward", { exact: true }).selectOption("unassigned");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    expect((await download).suggestedFilename()).toBe("jabor-reports-test.csv");
    await expect(page.getByRole("status").filter({ hasText: "Downloaded 2 reports." })).toBeVisible();
    expect(staff.exports).toHaveLength(1);
    // only the filter part of the query leaves the browser: no columns, no paging, no municipality
    expect(Object.keys(staff.exports[0])).toEqual(["path"]);
    const sent = new URL(staff.exports[0].path, "http://x");
    expect(sent.pathname).toBe("/rest/v1/reports");
    expect([...sent.searchParams.keys()]).toEqual(["and"]);
    expect(sent.searchParams.get("and")).toContain("ward_id.is.null");
    expect(sent.searchParams.get("and")).toContain("status.in.(verified,pending,active,reported,open)");

    // too many rows: the server's sentence is shown as it is
    staff.exportReply.status = 413;
    await page.getByRole("button", { name: "Export CSV" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "An export holds at most 10,000" })).toBeVisible();
  });

  test("the monthly ward report matches the dashboard and can be exported and printed", async ({ page }) => {
    await page.goto("/admin");
    const tile = name => page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).locator(".adm-tile-value");
    await expect(page.locator(".adm-tile .adm-tile-value").filter({ hasText: /^\d+$/ })).toHaveCount(8);
    const tiles = {};
    for (const name of ["Active", "In progress", "Invalid", "Overdue"]) tiles[name] = Number(await tile(name).innerText());

    await page.getByRole("link", { name: "Monthly report" }).click();
    const total = page.locator(".adm-row-total");
    await expect(total).toBeVisible();
    await expect(page.locator(".adm-print-title h2")).toContainText(/Monthly ward report: \w+ \d{4}/); // shown on paper only
    // the current month ends today, so its end-of-month columns are the dashboard's numbers
    const cells = await total.locator("td").allInnerTexts(); // received, cleaned, auto, active, in progress, invalid, overdue, median, average
    expect(cells.slice(3, 7).map(Number)).toEqual([tiles.Active, tiles["In progress"], tiles.Invalid, tiles.Overdue]);
    // every ward, then Unassigned, then Total
    const names = await page.locator(".adm-rtable tbody th").allInnerTexts();
    expect(names.slice(-2)).toEqual(["Unassigned", "Total"]);
    expect(names.length).toBeGreaterThan(3);
    // the ward rows add up to the total row
    const rows = await page.locator(".adm-rtable tbody tr:not(.adm-row-total)").evaluateAll(trs => trs.map(tr => [...tr.querySelectorAll("td")].slice(0, 7).map(td => Number(td.textContent))));
    const sums = rows[0].map((_, i) => rows.reduce((sum, row) => sum + row[i], 0));
    expect(sums).toEqual(cells.slice(0, 7).map(Number));

    // a month with nothing says so, then back to this month
    await page.getByLabel("Month", { exact: true }).fill("2024-01");
    await expect(page.getByText(/No reports were received in January 2024/)).toBeVisible();
    await page.getByLabel("Month", { exact: true }).fill(new Date().toISOString().slice(0, 7));
    await expect(total).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^jabor-monthly-ward-report-\d{4}-\d{2}\.csv$/);
    const text = (await fs.readFile(await file.path(), "utf8")).replace(BOM, "");
    expect(text.split("\r\n")[0]).toMatch(/^ward,received,cleaned,auto_cleaned,active_at_month_end/);
    expect(text).toContain("\r\nTotal,");

    // print layout: only the report shows
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".adm-side")).toBeHidden();
    await expect(page.locator(".adm-bar")).toBeHidden();
    await expect(page.locator(".adm-print-title")).toBeVisible();
    await expect(page.locator(".adm-print-title h2")).toContainText("Monthly ward report");
    await expect(total).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  });

  test("the hotspot ranking shows wards only, with its formula, and exports", async ({ page }) => {
    await page.goto("/admin#/hotspots");
    await expect(page.getByText("Staff only: this is never shown to the public")).toBeVisible();
    await expect(page.getByText("overdue × 3 + active × 1 + repeat locations × 2")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Score" })).toHaveAttribute("title", /overdue × 3/);
    const rows = page.locator(".adm-rtable tbody tr");
    await expect(rows.first()).toBeVisible();
    // the top 5 wards to begin with, and a toggle for all of them
    await expect(rows).toHaveCount(5);
    await expect(page.getByText(/Showing the top 5 of \d+ wards/)).toBeVisible();
    await page.getByRole("button", { name: "Show all wards" }).click();
    const everyone = await rows.count();
    expect(everyone).toBeGreaterThan(5);
    await expect(page.getByText(`Showing all ${everyone} wards`)).toBeVisible();
    await page.getByRole("button", { name: "Show top 5" }).click();
    await expect(rows).toHaveCount(5);
    // ranked: the first row has the highest score, and scores never go up as the rank goes down
    const scores = (await rows.locator("td:last-child").allInnerTexts()).map(Number);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // the score is the formula applied to the row (overdue, active, repeat places)
    const [rank, reports, active, overdue, repeat, , score] = await rows.first().locator("td").allInnerTexts();
    expect(rank).toBe("1");
    expect(Number(overdue) * 3 + Number(active) + Number(repeat) * 2).toBe(Number(score));
    expect(Number(reports)).toBeGreaterThanOrEqual(Number(active));
    // a chart, and no map or coordinates anywhere
    await expect(page.locator("svg.adm-chart")).toBeVisible();
    await expect(page.locator("canvas, .leaflet-container, iframe, [class*=map]")).toHaveCount(0);
    expect(await page.locator(".adm-main").innerText()).not.toMatch(/\b\d{2}\.\d{4,}\b/);

    // a wider window loads without error, and the export has the documented columns
    await page.getByLabel("Reports from the last").selectOption("90");
    await expect(rows.first()).toBeVisible();
    await expect(page.locator(".adm-state[role=alert]")).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("jabor-ward-hotspots-90-days.csv");
    expect((await fs.readFile(await file.path(), "utf8")).replace(BOM, "").split("\r\n")[0]).toBe("rank,ward,reports_in_window,active,overdue,repeat_locations,average_days_to_clean,score,small_sample");
  });

  test("the proxy refuses a municipality, a window or a month it does not allow", async ({ page }) => {
    await page.goto("/admin");
    const post = (path, body) => proxy(page, { path, method: "POST", body });
    expect((await post("/rest/v1/rpc/ward_hotspots", { p_days: 30, p_municipality: "00000000-0000-4000-8000-000000000000" })).status).toBe(403);
    expect((await post("/rest/v1/rpc/ward_hotspots", { p_days: 45 })).status).toBe(403);
    expect((await post("/rest/v1/rpc/monthly_ward_report", { p_month: "2026-08-15" })).status).toBe(403);
  });

});

test.describe("owner", () => {
  test.skip(needsSuper, "E2E_SUPER_EMAIL and E2E_SUPER_PASSWORD are not set");
  test.use(DESKTOP);

  test("[super] chooses a municipality and keeps the older screens", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Jabor - Super admin");
    const selector = page.getByLabel("Municipality");
    await expect(selector).toBeVisible();
    await expect(selector.locator("option:checked")).toContainText("Jorhat");
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("link")).toHaveText(["Dashboard", "Reports", "Hotspots", "Monthly report", "Audit log", "Cleanup Verification", "Moderation"]);
    await expect(page.locator(".adm-tile", { hasText: "Total" }).locator(".adm-tile-value")).not.toHaveText("0");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("dialog", { name: "Account" })).toContainText("Super admin");
    await page.keyboard.press("Escape");
    // the table, tabs and Hidden list work for the owner too
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveText(["All reports", "Unassigned wards", "Active", "In progress", "Cleaned", "Hidden"]);
    await expect(page.locator(".adm-pager span").first()).toContainText("of");
    await page.getByRole("tab", { name: "Hidden" }).click();
    await expect(page.getByRole("heading", { name: /^Hidden \(\d+\)$/ })).toBeVisible();
    await page.getByRole("link", { name: "Cleanup Verification" }).click();
    await expect(page.getByRole("heading", { name: /Cleanup Proofs/ })).toBeVisible();
  });
});

test.describe("municipality admin on a 360px phone", () => {
  test.skip(needsJmb, "E2E_JMB_EMAIL and E2E_JMB_PASSWORD are not set");
  test.use(PHONE);

  test("the menu is a drawer, closed to begin with, that closes when a page is chosen", async ({ page }) => {
    await page.goto("/admin");
    const side = page.getByRole("navigation", { name: "Admin sections" });
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(side).toBeHidden();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await menu.click();
    await expect(side).toBeVisible();
    const box = await side.boundingBox();
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThanOrEqual(360 * 0.86 + 1);
    expect(Math.round(box.y + box.height)).toBe(640); // a full-height drawer over the page
    for (const link of await side.getByRole("link").all()) expect((await link.boundingBox()).height).toBeGreaterThanOrEqual(44);
    // Esc closes it and gives focus back to the button
    await page.keyboard.press("Escape");
    await expect(side).toBeHidden();
    await expect(menu).toBeFocused();
    // choosing a page closes it
    await menu.click();
    await side.getByRole("link", { name: "Reports" }).click();
    await expect(side).toBeHidden();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Reports");
    // tapping the dimmed page closes it too
    await menu.click();
    await page.mouse.click(340, 600);
    await expect(side).toBeHidden();
  });

  test("the header, user icon and segmented tabs fit and work", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Jorhat");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Account" }).click();
    const popover = page.getByRole("dialog", { name: "Account" });
    const box = await popover.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await expect(popover.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Active" }).click();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", "rt-active");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    await page.locator(".adm-table tbody .adm-link").first().click();
    await expect(page.getByRole("dialog").getByRole("heading", { level: 3, name: "History" })).toBeVisible();
  });
});
