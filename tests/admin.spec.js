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
// The filter selects are the shared Select (a button that opens a list), not a native select.
const combo = (page, label) => page.getByRole("combobox", { name: new RegExp(`^${label}\\b`) });
const choose = async (page, label, option) => { await combo(page, label).click(); await page.getByRole("option", { name: option, exact: true }).click(); };
const clearField = (page, label) => page.getByRole("button", { name: `Clear ${label.toLowerCase()}` });
const STATUS_TEXT = { active: "Active", in_progress: "In progress", cleaned: "Cleaned", invalid: "Invalid", auto_cleaned: "Auto-cleaned" };
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
    const exportReply = { status: 200, truncated: false, delay: 0 };
    // The staff routes are answered here (reads too), so these tests do not need the staff API deployed and never create an account.
    const staffApi = {
      mode: "ok", calls: [],
      list: [
        { user_id: "aaaaaaaa-0000-4000-8000-000000000001", email: "owner@example.test", role: "super_admin", municipality_id: null, municipality_name: null, is_active: true, created_at: "2026-09-01T00:00:00Z" },
        { user_id: "aaaaaaaa-0000-4000-8000-000000000002", email: "jmb@example.test", role: "municipality_admin", municipality_id: "m1", municipality_name: "Jorhat Municipal Board", is_active: true, created_at: "2026-10-03T00:00:00Z" },
        { user_id: "aaaaaaaa-0000-4000-8000-000000000003", email: "former@example.test", role: "municipality_admin", municipality_id: "m1", municipality_name: "Jorhat Municipal Board", is_active: false, created_at: "2026-10-04T00:00:00Z" },
      ],
    };
    const account = testInfo.title.includes("[super]") ? SUPER : JMB;
    await addBypass(context, baseURL);
    // The guard: nothing but a GET, the sign-in and sign-out routes, and the proxy gets out.
    await context.route("**/*", route => (READ.has(route.request().method()) ? route.fallback() : route.abort()));
    await page.route("**/api/admin/**", async route => {
      const url = new URL(route.request().url());
      // continue() skips the context handler that adds the Vercel bypass header, so it is added here.
      const pass = () => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders } });
      const reply = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.pathname === "/api/admin/staff" && route.request().method() === "GET") return reply(200, staffApi.list);
      if (url.pathname === "/api/admin/staff" && route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        staffApi.calls.push({ path: url.pathname, body });
        if (staffApi.mode === "network") return route.abort();
        const failures = { conflict: [409, { error: "An account with this email already exists. Nothing was changed." }], bad: [400, { error: "Enter a valid email address." }], limit: [429, { error: "Too many requests. Please try again later." }], forbidden: [403, { error: "Not allowed." }], raw: [500, { error: "duplicate key value violates unique constraint staff_profiles_pkey" }] };
        if (failures[staffApi.mode]) return reply(...failures[staffApi.mode]);
        const row = { user_id: "bbbbbbbb-0000-4000-8000-000000000001", email: body.email, role: "municipality_admin", municipality_id: body.municipality_id, municipality_name: "Jorhat Municipal Board", is_active: true, created_at: "2026-10-12T00:00:00Z" };
        staffApi.list = [row, ...staffApi.list];
        return reply(201, { user_id: row.user_id, email: row.email, role: row.role, municipality_id: row.municipality_id, municipality_name: row.municipality_name, is_active: true });
      }
      if (url.pathname === "/api/admin/staff/status" && route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        staffApi.calls.push({ path: url.pathname, body });
        staffApi.list = staffApi.list.map(r => (r.user_id === body.user_id ? { ...r, is_active: body.is_active } : r));
        return reply(200, { user_id: body.user_id, is_active: body.is_active, changed: true });
      }
      if (READ.has(route.request().method()) || url.pathname === "/api/admin/login" || url.pathname === "/api/admin/logout") return pass();
      if (url.pathname === "/api/admin/export" && route.request().method() === "POST") {
        exports.push(JSON.parse(route.request().postData() || "{}"));
        if (exportReply.delay) await new Promise(resolve => setTimeout(resolve, exportReply.delay));
        if (exportReply.status !== 200 && exportReply.status !== 413) return reply(exportReply.status, { error: "Server error." });
        if (exportReply.status === 413) return route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "12,345 reports match. An export holds at most 10,000. Narrow the filters (a date range or a ward) and try again." }) });
        const audit = exports[exports.length - 1].type === "audit_log";
        return route.fulfill({
          status: 200, contentType: "text/csv",
          headers: audit
            ? { "content-disposition": 'attachment; filename="jabor-audit-log-test.csv"', "x-row-count": exportReply.truncated ? "10000" : "2", "x-total-rows": exportReply.truncated ? "12345" : "2", "x-truncated": String(exportReply.truncated) }
            : { "content-disposition": 'attachment; filename="jabor-reports-test.csv"', "x-row-count": "2" },
          body: "id,date\r\nabc,2026-10-01\r\n",
        });
      }
      if (url.pathname !== "/api/admin/rest" || route.request().method() !== "POST") return route.abort();
      const envelope = JSON.parse(route.request().postData() || "{}");
      if (!envelope.method || envelope.method === "GET" || (envelope.method === "POST" && READ_RPC.test(envelope.path))) return pass(); // a read: let it through
      writes.push(envelope);
      const id = /id=eq\.([0-9a-f-]{36})/.exec(envelope.path)?.[1];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id, ...envelope.body }]) });
    });
    await context.addCookies(await sessionFor(browser, baseURL, account));
    await use({ account, writes, exports, exportReply, staffApi });
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
    // the header shows the page the person is on, and the label under the profile icon says who they are
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    await expect(page.locator(".adm-role-label")).toHaveText("JMB Admin");
    await expect(page.getByLabel("Municipality")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("link")).toHaveText(["Dashboard", "Reports", "Hotspots", "Monthly report", "Audit log", "Cleanup Verification"]);
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
    // cleanup proofs: only with the report joined, and then only their own municipality's
    const proofs = await proxy(page, { path: "/rest/v1/cleanup_proofs?select=id,reports!inner(municipality_id)", method: "GET" });
    expect(proofs.status).toBe(200);
    expect(new Set(proofs.body.map(p => p.reports.municipality_id)).size).toBeLessThanOrEqual(1);
    expect((await proxy(page, { path: `/rest/v1/cleanup_proofs?id=eq.${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`, method: "PATCH", body: { status: "approved" } })).status).toBe(403);
    await page.getByRole("link", { name: "Cleanup Verification" }).click();
    await expect(page.getByRole("heading", { name: /Cleanup Proofs/ })).toBeVisible();
    expect((await proxy(page, { path: "/rest/v1/reports?select=id", method: "GET", role: "super_admin" })).status).toBe(400);
  });

  test("the dashboard tiles lead to the Reports page", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
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
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
      await expect(page).toHaveURL(new RegExp(tab === "all" ? "#/reports$" : `#/reports/${tab}$`));
      await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", `rt-${tab}`);
      if (expected === 0) await expect(page.getByText(/There are no reports|No reports match/)).toBeVisible();
      else await expect(pager).toContainText(`of ${expected}`);
    }
    for (const [name, status, expected] of statusCases) {
      await page.goto("/admin#/dashboard");
      await page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).click();
      await expect(page).toHaveURL(new RegExp(`status=${status}`));
      await expect(combo(page, "Status")).toContainText(STATUS_TEXT[status]);
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
    await expect(combo(page, "Ward")).toHaveCount(0); // the tab is the ward filter
    await expect(combo(page, "Status")).toHaveCount(0);
    await expect.poll(async () => {
      const cells = await page.locator(".adm-table tbody tr td:last-child").allInnerTexts();
      return cells.length > 0 && cells.every(cell => cell.includes("Unassigned"));
    }).toBe(true);
    await expect(page.locator(".adm-badge-invalid")).toHaveCount(0);
  });

  test("the Reports page: tabs, filters, paging and sorting", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
    await expect(page.getByRole("tab")).toHaveText([/^All reports \d+$/, /^Unassigned wards \d+$/, /^Active \d+$/, /^In progress \d+$/, /^Cleaned \d+$/, /^Hidden \d+$/]);
    const pager = page.locator(".adm-pager span").first();
    await expect(pager).toContainText("Showing 1 to");
    const total = Number(/of (\d+)/.exec(await pager.innerText())?.[1]);
    expect(total).toBeGreaterThan(0);

    // status filter lives on All reports; Invalid is reachable there
    await choose(page, "Status", "Active");
    await expect(page.locator(".adm-table tbody .adm-badge-active").first()).toBeVisible();
    await expect.poll(async () => (await page.locator(".adm-table tbody .adm-badge-active").count()) === (await page.locator(".adm-table tbody tr").count())).toBe(true);
    await choose(page, "Status", "Invalid");
    await expect(page.locator(".adm-table tbody .adm-badge-invalid").first()).toBeVisible();
    await clearField(page, "Status").click();
    await expect(combo(page, "Status")).toContainText("All statuses");
    await expect(clearField(page, "Status")).toHaveCount(0);

    // the Active tab and the Overdue filter
    await page.getByRole("tab", { name: "Active" }).click();
    await expect(page).toHaveURL(/#\/reports\/active$/);
    await expect(combo(page, "Status")).toHaveCount(0);
    await page.getByLabel("Overdue only").check();
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    await expect.poll(async () => (await page.locator(".adm-table tbody tr").count()) === (await page.locator(".adm-badge-overdue").count())).toBe(true);
    await page.getByRole("tab", { name: "Cleaned" }).click();
    await expect(page.getByLabel("Overdue only")).toHaveCount(0); // Active reports only
    await page.getByRole("tab", { name: "All reports" }).click();
    await page.getByRole("button", { name: "Clear filters" }).click();

    // ward filter, search, paging, sorting
    await choose(page, "Ward", "Unassigned");
    await expect.poll(async () => {
      const cells = await page.locator(".adm-table tbody tr td:last-child").allInnerTexts();
      return cells.length > 0 && cells.every(cell => cell.includes("Unassigned"));
    }).toBe(true);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Search", { exact: true }).fill("zzzz-nothing-matches-this");
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
      await page.getByRole("tab", { name: new RegExp(`^${tab}\\b`) }).click();
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
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    await expect(side).toBeVisible(); // open on a wide screen
    await side.getByRole("link", { name: "Hotspots" }).click();
    await expect(page).toHaveURL(/#\/hotspots$/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hotspots");
    await expect(side.getByRole("link", { name: "Hotspots" })).toHaveAttribute("aria-current", "page");
    await side.getByRole("link", { name: "Reports" }).click();
    await page.getByRole("tab", { name: "In progress" }).click();
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", "rt-in_progress");
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
    // an address that is not a page is the dashboard
    await page.goto("/admin#/no-such-page");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    // on a wide screen the toggle is the sidebar's own, at its top; collapsing leaves a narrow rail of icons
    expect((await menu.boundingBox()).y - (await side.boundingBox()).y).toBeLessThan(16);
    const wide = (await side.boundingBox()).width;
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(side).toBeVisible();
    expect((await side.boundingBox()).width).toBeLessThan(wide / 2);
    await expect(side.getByRole("link", { name: "Dashboard" })).toBeVisible(); // still reachable, by its icon
    await side.getByRole("link", { name: "Reports" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    expect((await side.boundingBox()).width).toBeGreaterThan(wide - 4);
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
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audit log");
    const rows = page.locator(".adm-table tbody tr");
    await expect(rows.first()).toBeVisible();
    const pager = page.locator(".adm-pager span").first();
    await expect(pager).toContainText("Showing 1 to");
    const total = Number(/of (\d+)/.exec(await pager.innerText())?.[1]);

    await choose(page, "Action", "Status changed");
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
    // only report rows can be opened (the log also holds exports and staff changes)
    await rows.getByRole("button", { name: "Open report" }).first().click();
    await expect(page.getByRole("dialog").getByRole("heading", { level: 3, name: "History" })).toBeVisible();
  });
  test("the reports export sends only the filters and tells the person what happened", async ({ page, staff }) => {
    await page.goto("/admin#/reports");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    await choose(page, "Status", "Active");
    await choose(page, "Ward", "Unassigned");
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
    await choose(page, "Reports from the last", "90 days");
    await expect(rows.first()).toBeVisible();
    await expect(page.locator(".adm-state[role=alert]")).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("jabor-ward-hotspots-90-days.csv");
    expect((await fs.readFile(await file.path(), "utf8")).replace(BOM, "").split("\r\n")[0]).toBe("rank,ward,reports_in_window,active,overdue,repeat_locations,average_days_to_clean,score,small_sample");
  });



  test("one header, no public header; the profile icon and its role label are at the top right", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    // the Jabor logo bar stays, without its own menu button; the admin menu button is the only one
    await expect(page.locator("header.top-appbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    await expect(page.locator("header.adm-bar")).toHaveCount(1);
    // exactly one menu button: the sidebar's, at the top of the sidebar
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(1);
    // the role label sits under the profile icon, at the right edge of the header
    const icon = await page.getByRole("button", { name: "Account" }).boundingBox();
    const label = page.locator(".adm-role-label");
    await expect(label).toHaveText("JMB Admin");
    const labelBox = await label.boundingBox();
    expect(labelBox.y).toBeGreaterThanOrEqual(icon.y + icon.height - 6);
    expect(Math.abs(labelBox.x + labelBox.width / 2 - (icon.x + icon.width / 2))).toBeLessThan(30);
    expect(icon.x + icon.width).toBeGreaterThan(1280 - 220);
    // a plain header: no card around it, a thin line under it
    const style = await page.locator(".adm-bar").evaluate(el => { const c = getComputedStyle(el); return { top: c.borderTopWidth, bottom: c.borderBottomWidth, radius: c.borderTopLeftRadius, background: c.backgroundColor }; });
    expect(style).toMatchObject({ top: "0px", bottom: "1px", radius: "0px" });
  });

  test("does not see Add admins, and is sent to the Dashboard from its address", async ({ page, staff }) => {
    const asked = [];
    page.on("request", request => { if (request.url().includes("/api/admin/staff")) asked.push(request.url()); });
    await page.goto("/admin#/admins");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    await expect(page).toHaveURL(/#\/dashboard$/);
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: /municipal admins/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /add municipal admin/i })).toHaveCount(0);
    expect(asked).toEqual([]); // the page never asked for the staff list
    expect(staff.staffApi.calls).toEqual([]);
    // typing it while the app is open changes the address back too
    await page.evaluate(() => { window.location.hash = "#/admins"; });
    await expect(page).toHaveURL(/#\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    // the same from a deeper address, and after a refresh
    await page.goto("/admin#/admins/anything?x=1");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    await expect(page).toHaveURL(/#\/dashboard$/);
    expect(asked).toEqual([]);
  });

  test("the audit export is the list's filters, labelled for what it does", async ({ page, staff }) => {
    await page.goto("/admin#/audit");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    const button = page.getByRole("button", { name: /^Export/ });
    await expect(button).toHaveText("Export all CSV");
    await expect(page.getByText("Exports only the rows matching your filters")).toHaveCount(0);

    // a date range and an action: the list asks, then the export carries the same filters
    const listRequest = page.waitForRequest(request => request.url().endsWith("/api/admin/rest") && /audit_log/.test(request.postData() || "") && /action=eq\.status_change/.test(request.postData() || "") && /created_at\.lte/.test(request.postData() || ""));
    await page.getByLabel("From", { exact: true }).fill("2026-09-01");
    await page.getByLabel("To", { exact: true }).fill("2026-10-11");
    await choose(page, "Action", "Status changed");
    const listEnvelope = JSON.parse((await listRequest).postData());
    await expect(button).toHaveText("Export filtered CSV");
    await expect(page.getByText("Exports only the rows matching your filters")).toBeVisible();

    const download = page.waitForEvent("download");
    await button.click();
    expect((await download).suggestedFilename()).toBe("jabor-audit-log-test.csv");
    expect(staff.exports).toHaveLength(1);
    const exported = staff.exports[0];
    expect(Object.keys(exported).sort()).toEqual(["path", "type"]);
    expect(exported.type).toBe("audit_log");
    const listUrl = new URL(listEnvelope.path, "http://x");
    const exportUrl = new URL(exported.path, "http://x");
    expect(exportUrl.pathname).toBe("/rest/v1/audit_log");
    // everything the list filters by is in the export; the columns, order and paging are the list's own and stay out
    const filtersOf = url => [...url.searchParams.entries()].filter(([key]) => !["select", "order", "limit", "offset"].includes(key)).sort();
    expect(filtersOf(exportUrl)).toEqual(filtersOf(listUrl));
    expect(filtersOf(exportUrl).map(([key]) => key).sort()).toEqual(["action", "and"]);
    expect(exportUrl.searchParams.get("and")).toMatch(/created_at\.gte\.2026-.*created_at\.lte\.2026-/);
    for (const key of ["select", "order", "limit", "offset", "municipality_id"]) expect(exportUrl.searchParams.has(key)).toBe(false);
    await expect(page.getByRole("status").filter({ hasText: "Downloaded 2 rows." })).toBeVisible();

    // clearing the filters puts the label back, and the export carries none
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(button).toHaveText("Export all CSV");
    const second = page.waitForEvent("download");
    await button.click();
    await second;
    expect(staff.exports[1].path).toBe("/rest/v1/audit_log?");
  });

  test("the audit export is disabled while it runs, and says when the file was cut or failed", async ({ page, staff }) => {
    await page.goto("/admin#/audit");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    const button = page.getByRole("button", { name: /^Export/ });
    staff.exportReply.delay = 600;
    const download = page.waitForEvent("download");
    await button.click();
    await expect(page.getByRole("button", { name: "Preparing…" })).toBeDisabled();
    await download;
    await expect(button).toBeEnabled();
    staff.exportReply.delay = 0;

    staff.exportReply.truncated = true;
    const cut = page.waitForEvent("download");
    await button.click();
    await cut;
    await expect(page.getByRole("status").filter({ hasText: /newest 10,000 rows.*12,345 rows match.*Narrow the filters/ })).toBeVisible();
    staff.exportReply.truncated = false;

    staff.exportReply.status = 500;
    await button.click();
    await expect(page.getByRole("alert").filter({ hasText: "The server had a problem. Please try again." })).toBeVisible();
    await expect(button).toBeEnabled();
    expect(staff.exports).toHaveLength(3);
  });

  test("a municipality admin can hide a report and restore it, through the status rules' own audit", async ({ page, staff }) => {
    const { writes } = staff;
    await page.goto("/admin#/reports/active");
    await page.locator(".adm-table tbody .adm-link").first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("heading", { level: 3, name: "History" })).toBeVisible();
    await expect(drawer.getByRole("heading", { level: 3, name: "Public site" })).toBeVisible();
    await drawer.getByRole("button", { name: "Hide from public site" }).click();
    // a reason is needed
    await drawer.getByRole("button", { name: "Confirm hide" }).click();
    await expect(drawer.getByText("Choose a reason.")).toBeVisible();
    expect(writes).toHaveLength(0);
    await drawer.getByLabel("Reason").selectOption("spam");
    await drawer.getByLabel("Note (optional)").fill("Not a real report");
    await drawer.getByRole("button", { name: "Confirm hide" }).click();
    await expect(drawer.getByText("Hidden from the public site.")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PATCH", body: { is_deleted: true, invalid_reason: "spam", admin_note: "Not a real report" } });
    expect(Object.keys(writes[0].body).sort()).toEqual(["admin_note", "invalid_reason", "is_deleted"]);
    expect(writes[0].path).toMatch(/^\/rest\/v1\/reports\?id=eq\.[0-9a-f-]{36}$/);
  });

  test("a hidden report shows Restore in the drawer, for a municipality admin too", async ({ page, staff }) => {
    const { writes } = staff;
    // the same report, as the server would answer if it were hidden
    await page.route("**/api/admin/rest", async route => {
      const envelope = JSON.parse(route.request().postData() || "{}");
      if (envelope.method === "GET" && /select=[^&]*description/.test(envelope.path) && /[?&]id=eq\./.test(envelope.path) && /reports\?/.test(envelope.path)) {
        try {
          const response = await route.fetch();
          const rows = await response.json();
          if (rows[0]) rows[0] = { ...rows[0], is_deleted: true, status: "verified", invalid_reason: "spam" };
          return await route.fulfill({ response, json: rows });
        } catch {
          return; // the test ended while this was in flight
        }
      }
      return route.fallback();
    });
    await page.goto("/admin#/reports/active");
    await page.locator(".adm-table tbody .adm-link").first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("This report is hidden from the public site. Nothing is deleted: restoring puts it back.")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Hide from public site" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Mark cleaned" })).toHaveCount(0); // nothing else to do while hidden
    await drawer.getByRole("button", { name: "Restore to public site" }).click();
    await drawer.getByLabel("Note (optional)").fill("Hidden by mistake");
    await drawer.getByRole("button", { name: "Confirm restore" }).click();
    await expect(drawer.getByText("Restored to the public site.")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ is_deleted: false, invalid_reason: null, admin_note: "Hidden by mistake" });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("every filter has a cross that clears just that filter, and Clear filters clears them all", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    const pager = page.locator(".adm-pager span").first();
    const total = Number(/of (\d+)/.exec(await pager.innerText())?.[1]);
    // nothing is set, so there is nothing to clear
    for (const label of ["Search", "Status", "Ward", "From", "To"]) await expect(clearField(page, label)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);

    await page.getByLabel("Search", { exact: true }).fill("Demo");
    await choose(page, "Status", "Active");
    await choose(page, "Ward", "Unassigned");
    await page.getByLabel("From", { exact: true }).fill("2026-09-01");
    await page.getByLabel("To", { exact: true }).fill("2026-10-30");
    for (const label of ["Search", "Status", "Ward", "From", "To"]) await expect(clearField(page, label)).toBeVisible();

    // each cross removes its own filter and leaves the others
    await clearField(page, "Search").click();
    await expect(page.getByLabel("Search", { exact: true })).toHaveValue("");
    await expect(combo(page, "Status")).toContainText("Active");
    await clearField(page, "From").click();
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("2026-10-30");
    await clearField(page, "Ward").click();
    await expect(combo(page, "Ward")).toContainText("All wards");
    await expect(combo(page, "Status")).toContainText("Active");
    await clearField(page, "To").click();
    await expect(clearField(page, "To")).toHaveCount(0);
    await clearField(page, "Status").click();
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0); // all clear again
    await expect(pager).toContainText(`of ${total}`);

    // the same, all at once
    await page.getByLabel("Search", { exact: true }).fill("Demo");
    await choose(page, "Ward", "Unassigned");
    await page.getByLabel("From", { exact: true }).fill("2026-09-01");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByLabel("Search", { exact: true })).toHaveValue("");
    await expect(combo(page, "Ward")).toContainText("All wards");
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
    await expect(pager).toContainText(`of ${total}`);
  });

  test("the sort choice changes the order the list asks for", async ({ page }) => {
    const asked = [];
    page.on("request", request => { const body = request.postData() || ""; if (request.url().endsWith("/api/admin/rest") && /reports\?/.test(body) && /count=exact/.test(body) && /limit=25/.test(body)) asked.push(JSON.parse(body).path); });
    await page.goto("/admin#/reports");
    await expect(combo(page, "Sort")).toContainText("Newest first");
    await expect(clearField(page, "Sort")).toHaveCount(0); // sorting is not a filter
    await choose(page, "Sort", "Oldest first");
    await expect.poll(() => asked.some(path => decodeURIComponent(path).includes("order=created_at.asc"))).toBe(true);
    await choose(page, "Sort", "Report name, A to Z");
    await expect.poll(() => asked.some(path => decodeURIComponent(path).includes("order=area.asc"))).toBe(true);
    await expect(page.locator("th[aria-sort=ascending]")).toHaveCount(1);
    // a column header changes the same setting
    await choose(page, "Sort", "Newest first");
    await expect(combo(page, "Sort")).toContainText("Newest first");
  });

  test("the numbers on the tabs are the dashboard's numbers", async ({ page }) => {
    await page.goto("/admin");
    const tile = name => page.locator(".adm-tile").filter({ has: page.getByText(name, { exact: true }) }).locator(".adm-tile-value");
    await expect(page.locator(".adm-tile .adm-tile-value").filter({ hasText: /^\d+$/ })).toHaveCount(8);
    const n = {};
    for (const name of ["Total", "Unassigned wards", "Active", "In progress", "Cleaned", "Invalid"]) n[name] = (await tile(name).innerText()).trim();
    await page.goto("/admin#/reports");
    await expect(page.getByTestId("count-all")).toHaveText(n.Total);
    await expect(page.getByTestId("count-unassigned")).toHaveText(n["Unassigned wards"]);
    await expect(page.getByTestId("count-active")).toHaveText(n.Active);
    await expect(page.getByTestId("count-in_progress")).toHaveText(n["In progress"]);
    await expect(page.getByTestId("count-cleaned")).toHaveText(n.Cleaned);
    await expect(page.getByTestId("count-hidden")).toHaveText(n.Invalid);
  });

  test("clicking a photo enlarges it, with a cross to close it", async ({ page }) => {
    await page.goto("/admin#/reports");
    const thumb = page.locator(".adm-thumbbtn").first();
    await expect(thumb).toBeVisible();
    await thumb.click();
    const viewer = page.getByRole("dialog", { name: "Photo" });
    await expect(viewer).toBeVisible();
    await expect(page.getByRole("dialog", { name: /.+/ }).filter({ has: page.locator("h3") })).toHaveCount(0); // the report drawer did not open
    const image = viewer.getByRole("img", { name: "Report photo, enlarged" });
    await expect(image).toBeVisible();
    await expect.poll(async () => (await image.boundingBox()).width).toBeGreaterThan(56 * 3); // bigger than the thumbnail
    const close = viewer.getByRole("button", { name: "Close photo" });
    expect((await close.boundingBox()).width).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(viewer).toHaveCount(0);
    // Esc closes it too, and a click on the dark area
    await thumb.click();
    await expect(viewer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await thumb.click();
    await page.mouse.click(5, 5);
    await expect(viewer).toHaveCount(0);
    // from the report drawer: the photo opens above the drawer, and closing it leaves the drawer open
    await page.locator(".adm-table tbody .adm-link").first().click();
    const drawer = page.getByRole("dialog").filter({ has: page.getByRole("heading", { level: 3, name: "History" }) });
    await expect(drawer).toBeVisible();
    await drawer.locator(".adm-photo").first().click();
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "Close photo" }).click();
    await expect(viewer).toHaveCount(0);
    await expect(drawer).toBeVisible();
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

  test("[super] Add admins lists staff and gives super admins no actions", async ({ page }) => {
    await page.goto("/admin");
    const side = page.getByRole("navigation", { name: "Admin sections" });
    await expect(side.getByRole("link")).toHaveText(["Dashboard", "Reports", "Hotspots", "Monthly report", "Audit log", "Add admins", "Cleanup Verification", "Moderation"]);
    await side.getByRole("link", { name: "Add admins" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add admins");
    await expect(page).toHaveURL(/#\/admins$/);
    await expect(page.getByRole("columnheader")).toHaveText(["Email", "Municipality", "Status", "Created", "Actions"]);
    const rows = page.locator(".adm-table tbody tr");
    await expect(rows).toHaveCount(3);
    const owner = rows.filter({ hasText: "owner@example.test" });
    await expect(owner).toContainText("Super admin");
    await expect(owner.getByRole("button")).toHaveCount(0);
    await expect(rows.filter({ hasText: "jmb@example.test" })).toContainText("Active");
    await expect(rows.filter({ hasText: "jmb@example.test" })).toContainText("Jorhat Municipal Board");
    await expect(rows.filter({ hasText: "jmb@example.test" }).getByRole("button", { name: "Deactivate" })).toBeVisible();
    await expect(rows.filter({ hasText: "former@example.test" })).toContainText("Inactive");
    await expect(rows.filter({ hasText: "former@example.test" }).getByRole("button", { name: "Reactivate" })).toBeVisible();
    // a refresh stays on the page
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add admins");
  });

  test("[super] adds a municipal admin: one-time panel, copy, and the password is cleared on dismiss", async ({ page, context, staff }) => {
    const logs = [];
    page.on("console", message => logs.push(message.text()));
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/admin#/admins");
    await page.getByRole("button", { name: "Add municipal admin" }).click();
    const form = page.getByRole("form", { name: "Add municipal admin" });
    await expect(form.getByLabel("Municipality")).toHaveValue(/.+/);
    await expect(form.getByLabel("Municipality").locator("option:checked")).toContainText("Jorhat");
    await expect(form.getByLabel(/role/i)).toHaveCount(0); // there is no role field

    // a short password is caught before anything is sent
    await form.getByLabel("Email").fill("  New.Admin@Example.TEST ");
    const password = form.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("type", "password");
    await password.fill("short");
    await expect(form.getByText("At least 12 characters.")).toBeVisible();
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(form.getByRole("alert")).toHaveText("Use at least 12 characters.");
    expect(staff.staffApi.calls).toEqual([]);
    // show and hide
    await form.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await form.getByRole("button", { name: "Hide password" }).click();
    await expect(password).toHaveAttribute("type", "password");
    // generate: 16 or more random characters, shown so they can be read, different each time
    await form.getByRole("button", { name: "Generate strong password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    const first = await password.inputValue();
    expect(first.length).toBeGreaterThanOrEqual(16);
    expect(first).toMatch(/[a-z]/); expect(first).toMatch(/[A-Z]/); expect(first).toMatch(/[0-9]/); expect(first).toMatch(/[-_!@#$%*+=?]/);
    await form.getByRole("button", { name: "Generate strong password" }).click();
    expect(await password.inputValue()).not.toBe(first);
    await expect(form.getByText("Long enough.")).toBeVisible();
    const chosen = await password.inputValue();

    await form.getByRole("button", { name: "Create account" }).click();
    const panel = page.getByRole("status", { name: "New account details" });
    await expect(panel).toBeVisible();
    // what was sent: the email trimmed and lowercased, the password, a municipality, and no role
    expect(staff.staffApi.calls).toHaveLength(1);
    expect(Object.keys(staff.staffApi.calls[0].body).sort()).toEqual(["email", "municipality_id", "password"]);
    expect(staff.staffApi.calls[0].body.email).toBe("new.admin@example.test");
    expect(staff.staffApi.calls[0].body.password).toBe(chosen);
    // the panel shows both, with the warning, and the form is gone
    await expect(panel).toContainText("new.admin@example.test");
    await expect(panel.locator("code")).toHaveText(chosen);
    await expect(panel).toContainText("Send this to the admin through a secure channel. It will not be shown again.");
    await expect(page.getByRole("form", { name: "Add municipal admin" })).toHaveCount(0);
    await expect(page.locator(".adm-table tbody tr").filter({ hasText: "new.admin@example.test" })).toBeVisible(); // the table refreshed
    // copy
    await panel.getByRole("button", { name: /Copy email and password/ }).click();
    await expect(panel.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Email: new.admin@example.test\nPassword: ${chosen}`);
    // the password is nowhere else: not the address, storage, cookies or the console
    expect(page.url()).not.toContain(chosen);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(chosen);
    expect((await context.cookies()).map(c => c.value).join()).not.toContain(chosen);
    expect(logs.join("\n")).not.toContain(chosen);
    // dismissing removes it from the page
    await panel.getByRole("button", { name: "Done" }).click();
    await expect(panel).toHaveCount(0);
    expect(await page.content()).not.toContain(chosen);
    await page.getByRole("button", { name: "Add municipal admin" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(""); // a new form starts empty
    expect(staff.staffApi.calls).toHaveLength(1);
  });

  test("[super] says in plain words what went wrong when adding fails", async ({ page, staff }) => {
    await page.goto("/admin#/admins");
    await page.getByRole("button", { name: "Add municipal admin" }).click();
    const form = page.getByRole("form", { name: "Add municipal admin" });
    await form.getByLabel("Email").fill("taken@example.test");
    await form.getByLabel("Password", { exact: true }).fill("a-long-test-password-1");
    const expectations = [
      ["conflict", "An account with this email already exists. Nothing was changed."],
      ["bad", "Enter a valid email address."],
      ["forbidden", "You do not have permission to do that."],
      ["limit", "Too many attempts. Please wait a while and try again."],
      ["network", "Could not reach the server. Check your connection and try again."],
      ["raw", "Something went wrong. Please try again."],
    ];
    for (const [mode, text] of expectations) {
      staff.staffApi.mode = mode;
      await form.getByRole("button", { name: "Create account" }).click();
      await expect(form.getByRole("alert")).toHaveText(text);
      await expect(page.getByRole("status", { name: "New account details" })).toHaveCount(0);
      await expect(form.getByLabel("Password", { exact: true })).toHaveValue("a-long-test-password-1"); // kept, so it can be tried again
    }
    expect(await page.locator("body").innerText()).not.toMatch(/duplicate key|staff_profiles_pkey/);
    // client side checks for the email
    staff.staffApi.mode = "ok";
    const before = staff.staffApi.calls.length;
    await form.getByLabel("Email").fill("not-an-email");
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(form.getByRole("alert")).toHaveText("Enter a valid email address.");
    expect(staff.staffApi.calls.length).toBe(before);
  });

  test("[super] deactivating asks first and says it takes effect immediately", async ({ page, staff }) => {
    await page.goto("/admin#/admins");
    const row = page.locator(".adm-table tbody tr").filter({ hasText: "jmb@example.test" });
    await row.getByRole("button", { name: "Deactivate" }).click();
    const dialog = page.getByRole("dialog", { name: "Deactivate this account?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("jmb@example.test");
    await expect(dialog).toContainText("immediately");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(staff.staffApi.calls).toEqual([]);
    await expect(row).toContainText("Active");

    await row.getByRole("button", { name: "Deactivate" }).click();
    await dialog.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByRole("status").filter({ hasText: "jmb@example.test is now inactive." })).toBeVisible();
    expect(staff.staffApi.calls).toEqual([{ path: "/api/admin/staff/status", body: { user_id: "aaaaaaaa-0000-4000-8000-000000000002", is_active: false } }]);
    await expect(row).toContainText("Inactive");
    await expect(row.getByRole("button", { name: "Reactivate" })).toBeVisible();

    await row.getByRole("button", { name: "Reactivate" }).click();
    const again = page.getByRole("dialog", { name: "Reactivate this account?" });
    await expect(again).toContainText("sign in again");
    await again.getByRole("button", { name: "Reactivate" }).click();
    await expect(row).toContainText("Active");
    expect(staff.staffApi.calls[1].body).toEqual({ user_id: "aaaaaaaa-0000-4000-8000-000000000002", is_active: true });
  });


  test("[super] the header says Super admin, with Super Admin under the profile icon", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    await expect(page.locator(".adm-role-label")).toHaveText("Super Admin");
    await expect(page.locator("header.top-appbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("dialog", { name: "Account" })).toContainText("Super admin");
  });

  test("[super] chooses a municipality and keeps the older screens", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    const selector = page.getByLabel("Municipality");
    await expect(selector).toBeVisible();
    await expect(selector.locator("option:checked")).toHaveText("View all");
    await expect(selector.locator("option")).toContainText(["View all", "Jorhat Municipal Board"]);
    await expect(page.getByRole("navigation", { name: "Admin sections" }).getByRole("link")).toHaveText(["Dashboard", "Reports", "Hotspots", "Monthly report", "Audit log", "Add admins", "Cleanup Verification", "Moderation"]);
    await expect(page.locator(".adm-tile", { hasText: "Total" }).locator(".adm-tile-value")).not.toHaveText("0");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("dialog", { name: "Account" })).toContainText("Super admin");
    await page.keyboard.press("Escape");
    // the table, tabs and Hidden list work for the owner too
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveText([/^All reports \d+$/, /^Active \d+$/, /^In progress \d+$/, /^Cleaned \d+$/, /^Hidden \d+$/]);
    await expect(page.locator(".adm-pager span").first()).toContainText("of");
    await page.getByRole("tab", { name: "Hidden" }).click();
    await expect(page.getByRole("heading", { name: /^Hidden \(\d+\)$/ })).toBeVisible();
    await page.getByRole("link", { name: "Cleanup Verification" }).click();
    await expect(page.getByRole("heading", { name: /Cleanup Proofs/ })).toBeVisible();
  });

  test("[super] View all has a District filter and no ward tab, filter or column", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.getByRole("tab", { name: /Unassigned wards/ })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Ward" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "District" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Ward" })).toHaveCount(0);
    const district = page.getByRole("combobox", { name: "District" });
    await district.click();
    await page.getByRole("listbox").getByRole("option").first().click();
    await expect(page.getByRole("button", { name: "Clear filters" }).first()).toBeVisible();
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.locator(".adm-tile", { hasText: "Unassigned wards" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Districts" }).getByRole("heading")).toContainText(/Districts \(\d+\)/);
    await expect(page.locator(".adm-districts li").first()).toBeVisible();
    await page.getByLabel("Municipality").first().selectOption({ label: "Jorhat Municipal Board" });
    await expect(page.locator(".adm-tile", { hasText: "Unassigned wards" })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Districts" })).toHaveCount(0);
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await expect(page.getByRole("tab", { name: /Unassigned wards/ })).toHaveCount(1);
    await expect(page.getByRole("combobox", { name: "District" })).toHaveCount(0);
  });

  test("[super] Add admins stays in the menu for every choice, and Hotspots needs a municipality", async ({ page }) => {
    await page.goto("/admin");
    const side = page.getByRole("navigation", { name: "Admin sections" });
    await page.getByRole("link", { name: "Hotspots" }).click();
    await expect(page.getByText(/Choose a municipality above/)).toBeVisible();
    await side.getByRole("link", { name: "Add admins" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add admins");
    await page.getByLabel("Municipality").first().selectOption({ label: "Jorhat Municipal Board" });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add admins");
    await expect(side.getByRole("link", { name: "Add admins" })).toHaveCount(1);
    await page.getByRole("link", { name: "Hotspots" }).click();
    await expect(page.getByText(/Choose a municipality above/)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hotspots");
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
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
    // tapping the dimmed page closes it too
    await menu.click();
    await page.mouse.click(340, 600);
    await expect(side).toBeHidden();
  });


  test("one header with one menu button; the title is the page; the role label is under the profile icon", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    // the Jabor logo bar is there without its hamburger, so there is one hamburger, closed and open
    await expect(page.locator("header.top-appbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    await expect(page.locator("header.adm-bar")).toHaveCount(1);
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toHaveCount(1);
    await menu.click();
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(1);
    await page.keyboard.press("Escape");
    // a simple three-line icon button with a 44px target: no border, no card
    const box = await menu.boundingBox();
    expect([box.width, box.height]).toEqual([44, 44]);
    expect(await menu.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe("0px");
    const bar = await page.locator(".adm-bar").evaluate(el => { const c = getComputedStyle(el); return { top: c.borderTopWidth, bottom: c.borderBottomWidth, radius: c.borderTopLeftRadius }; });
    expect(bar).toEqual({ top: "0px", bottom: "1px", radius: "0px" });
    // the title is whole, never cut with an ellipsis
    const title = page.getByRole("heading", { level: 1 });
    const fit = await title.evaluate(el => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth + 1, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }));
    expect(fit.overflow).not.toBe("ellipsis");
    expect(fit.clipped).toBe(false);
    // the menu button is at the left, before the title; the profile icon is at the right with its label under it
    const titleBox = await title.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(titleBox.x + 1);
    expect(box.x).toBeLessThan(titleBox.x);
    const account = await page.getByRole("button", { name: "Account" }).boundingBox();
    expect(account.x).toBeGreaterThan(titleBox.x + titleBox.width - 1);
    expect(account.x + account.width).toBeLessThanOrEqual(360);
    await expect(page.locator(".adm-role-label")).toHaveText("JMB Admin");
    expect((await page.locator(".adm-role-label").boundingBox()).y).toBeGreaterThanOrEqual(account.y + account.height - 6);
    // the popover still shows the email and role, and sign out
    await page.getByRole("button", { name: "Account" }).click();
    const popover = page.getByRole("dialog", { name: "Account" });
    await expect(popover).toContainText(JMB.email);
    await expect(popover).toContainText("Municipality admin");
    await expect(popover.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  });

  test("no page runs off the side at 360px", async ({ page }) => {
    for (const hash of ["dashboard", "reports", "reports/unassigned", "reports/hidden", "hotspots", "monthly", "audit"]) {
      await page.goto(`/admin#/${hash}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForTimeout(400); // let the page's data arrive
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `#/${hash}`).toBe(true);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    await page.goto("/admin#/reports");
    await page.locator(".adm-table tbody .adm-link").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the report drawer").toBe(true);
  });

  test("the filter panel is one column, every control is tap-sized, and the photo viewer fits", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noSideways()).toBe(true);
    const panel = page.getByRole("region", { name: "Search, sort and filter" });
    await expect(panel.getByRole("button", { name: "Export CSV" })).toBeVisible();
    // one column: the fields sit one under the other and fill the width
    const search = await page.getByLabel("Search", { exact: true }).boundingBox();
    const sort = await combo(page, "Sort").boundingBox();
    const status = await combo(page, "Status").boundingBox();
    expect(sort.y).toBeGreaterThan(search.y + search.height - 1);
    expect(status.y).toBeGreaterThan(sort.y + sort.height - 1);
    for (const box of [search, sort, status]) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(360); expect(box.height).toBeGreaterThanOrEqual(44); }
    // a value brings a cross, and the cross is a tap-sized target inside the field
    await page.getByLabel("Search", { exact: true }).fill("Demo");
    const cross = await clearField(page, "Search").boundingBox();
    expect(cross.width).toBeGreaterThanOrEqual(44);
    expect(cross.height).toBeGreaterThanOrEqual(44);
    expect(cross.x + cross.width).toBeLessThanOrEqual(search.x + search.width + 1);
    await choose(page, "Ward", "Unassigned");
    await page.getByLabel("From", { exact: true }).fill("2026-09-01");
    expect(await noSideways()).toBe(true);
    for (const label of ["Search", "Ward", "From"]) { const box = await clearField(page, label).boundingBox(); expect(box.width).toBeGreaterThanOrEqual(44); }
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
    // the photo viewer fits the screen
    await page.locator(".adm-thumbbtn").first().click();
    const viewer = page.getByRole("dialog", { name: "Photo" });
    await expect(viewer).toBeVisible();
    const image = await viewer.getByRole("img").boundingBox();
    expect(image.x).toBeGreaterThanOrEqual(0);
    expect(image.x + image.width).toBeLessThanOrEqual(360);
    expect(image.y + image.height).toBeLessThanOrEqual(640);
    expect((await viewer.getByRole("button", { name: "Close photo" }).boundingBox()).x + 44).toBeLessThanOrEqual(360 + 1);
    await viewer.getByRole("button", { name: "Close photo" }).click();
    await expect(viewer).toHaveCount(0);
  });

  test("the header, user icon and segmented tabs fit and work", async ({ page }) => {
    await page.goto("/admin#/reports");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
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

test.describe("owner on a 360px phone", () => {
  test.skip(needsSuper, "E2E_SUPER_EMAIL and E2E_SUPER_PASSWORD are not set");
  test.use(PHONE);

  test("[super] one hamburger, a wrapped title, the Super Admin label, and no page runs off the side", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
    await expect(page.locator(".adm-role-label")).toHaveText("Super Admin");
    await expect(page.locator("header.top-appbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(1);
    for (const hash of ["dashboard", "reports", "hotspots", "monthly", "audit", "admins", "reports/hidden"]) {
      await page.goto(`/admin#/${hash}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `#/${hash}`).toBe(true);
    }
  });

  test("[super] Add admins fits and works on a phone", async ({ page, staff }) => {
    await page.goto("/admin");
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Add admins" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add admins");
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noSideways()).toBe(true);
    await expect(page.locator(".adm-table tbody tr").first()).toBeVisible();
    for (const button of await page.locator(".adm-table tbody").getByRole("button").all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);

    await page.getByRole("button", { name: "Add municipal admin" }).click();
    const form = page.getByRole("form", { name: "Add municipal admin" });
    expect(await noSideways()).toBe(true);
    for (const control of [form.getByLabel("Email"), form.getByLabel("Municipality"), form.getByLabel("Password", { exact: true }), form.getByRole("button", { name: "Show password" }), form.getByRole("button", { name: "Generate strong password" }), form.getByRole("button", { name: "Create account" })]) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await form.getByLabel("Email").fill("phone.admin@example.test");
    await form.getByRole("button", { name: "Generate strong password" }).click();
    await form.getByRole("button", { name: "Create account" }).click();
    const panel = page.getByRole("status", { name: "New account details" });
    await expect(panel).toBeVisible();
    expect(await noSideways()).toBe(true);
    const box = await panel.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    await panel.getByRole("button", { name: "Done" }).click();
    // the confirmation dialog fits too
    await page.locator(".adm-table tbody tr").filter({ hasText: "jmb@example.test" }).getByRole("button", { name: "Deactivate" }).click();
    const dialog = page.getByRole("dialog", { name: "Deactivate this account?" });
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(360);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(staff.staffApi.calls).toHaveLength(1);
  });
});
