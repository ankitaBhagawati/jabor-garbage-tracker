// Tests for the admin shell: `node src/admin/shell.check.js`
// The address (hash) of each page, the sidebar per role, the header text, and every request the Reports page
// and the tiles can now send, run against the proxy's allowlist for both roles. api/ is only read.
import assert from "node:assert/strict";

const { authorize } = await import("../../api/_lib/access.js");
const R = await import("./route.ts");
const N = await import("./nav.ts");
const Q = await import("./queryBuilders.ts");
const { EMPTY_FILTERS } = await import("./types.ts");

const M1 = "11111111-1111-4111-8111-111111111111";
const SUPER = { role: "super_admin", userId: "aaaaaaaa-0000-4000-8000-000000000001", municipalityId: null };
const MUNI = { role: "municipality_admin", userId: "aaaaaaaa-0000-4000-8000-000000000002", municipalityId: M1 };
const NOW = new Date("2026-10-11T12:00:00Z");

// ── The sidebar ──────────────────────────────────────────────────────────────
const order = ["dashboard", "reports", "hotspots", "monthly", "audit"]; // the pages every role has
assert.deepEqual(N.navFor("municipality_admin").map(i => i.id), order, "a municipality admin: the pages, in order");
assert.deepEqual(N.navFor("super_admin").map(i => i.id), [...order, "admins"], "a super admin also has Add admins, last");
assert.deepEqual(N.navFor("super_admin").map(i => i.label), ["Dashboard", "Reports", "Hotspots", "Monthly report", "Audit log", "Add admins"]);
assert.ok(!N.navFor("municipality_admin").some(i => /add admins/i.test(i.label)), "Add admins is for super admins only");
const extra = [{ id: "cleanup", label: "Cleanup Verification" }];
assert.deepEqual(N.navFor("super_admin", extra).map(i => i.id), [...order, "admins", "cleanup"], "the owner's older screens follow the pages");
// a role-limited item shows only to that role
N.NAV.push({ id: "only-municipality", label: "X", icon: "audit", roles: ["municipality_admin"] });
assert.ok(N.navFor("municipality_admin").some(i => i.id === "only-municipality"));
assert.ok(!N.navFor("super_admin").some(i => i.id === "only-municipality"));
N.NAV.pop();

// ── The header shows the page the person is on ──────────────────────────────
for (const role of ["super_admin", "municipality_admin"]) {
  const labels = N.navFor(role).map(i => i.label);
  assert.ok(labels.every(l => l && !/[\u2013\u2014]/.test(l)), "page names are plain text");
  assert.equal(N.navFor(role).find(i => i.id === "dashboard").label, "Dashboard");
  assert.equal(N.navFor(role).find(i => i.id === "reports").label, "Reports");
}
assert.equal(N.headerTitle, undefined, "the municipality name is no longer in the title");

// ── The label under the profile icon ─────────────────────────────────────────
assert.equal(N.roleBadge("super_admin"), "Super Admin");
assert.equal(N.roleBadge("super_admin", { name: "Jorhat Municipal Board", slug: "jorhat" }), "Super Admin", "the owner's label does not depend on the municipality chosen");
assert.equal(N.roleBadge("municipality_admin", { name: "Jorhat Municipal Board", slug: "jorhat" }), "JMB Admin");
assert.equal(N.roleBadge("municipality_admin", { name: "Jorhat Municipal Board", slug: null }), "JMB Admin", "by name when there is no slug");
assert.equal(N.roleBadge("municipality_admin", { name: "Somewhere Else", slug: "somewhere", settings: { short_name: " SEB " } }), "SEB Admin", "a short_name in the settings wins");
assert.equal(N.roleBadge("municipality_admin", { name: "Somewhere Else", slug: "somewhere", settings: { short_name: 7 } }), "Municipal Admin", "an unknown municipality falls back");
assert.equal(N.roleBadge("municipality_admin", null), "Municipal Admin");
assert.equal(N.roleBadge("municipality_admin"), "Municipal Admin");
for (const text of ["Super Admin", N.roleBadge("municipality_admin", { name: "Jorhat Municipal Board" }), "Municipal Admin"]) assert.ok(!/[\u2013\u2014]/.test(text), "no dashes in UI text");

// ── Addresses ────────────────────────────────────────────────────────────────
const D = R.DEFAULT_ROUTE;
assert.deepEqual(R.parseRoute("", order), D, "no hash: the dashboard");
assert.deepEqual(R.parseRoute("#/", order), D);
assert.deepEqual(R.parseRoute("#/nonsense", order), D);
assert.deepEqual(R.parseRoute("#/cleanup", order), D, "a page this role does not have is the dashboard");
assert.deepEqual(R.parseRoute("#/cleanup", [...order, "cleanup"]), { ...D, page: "cleanup" });
for (const page of ["dashboard", "hotspots", "monthly", "audit"]) assert.deepEqual(R.parseRoute(`#/${page}`, order), { ...D, page });
assert.deepEqual(R.parseRoute("#/reports", order), { page: "reports", tab: "all", status: "", overdue: false });
for (const t of ["all", "unassigned", "active", "in_progress", "cleaned", "hidden"]) assert.equal(R.parseRoute(`#/reports/${t}`, order).tab, t);
assert.equal(R.parseRoute("#/reports/bogus", order).tab, "all");
assert.equal(R.parseRoute("#/reports/all?status=invalid", order).status, "invalid");
assert.equal(R.parseRoute("#/reports/all?status=evil", order).status, "", "an unknown status is ignored");
assert.equal(R.parseRoute("#/reports/active?status=invalid", order).status, "", "a status only applies on All reports");
assert.equal(R.parseRoute("#/reports/all?overdue=1", order).overdue, true);
assert.equal(R.parseRoute("#/reports/cleaned?overdue=1", order).overdue, false, "overdue only applies where Active reports can be");
assert.equal(R.parseRoute("#/reports/unassigned?overdue=1", order).overdue, true);
// format and parse agree for every page and tab
for (const page of order) {
  for (const tab of R.REPORT_TABS.map(t => t.id)) for (const status of ["", "invalid", "auto_cleaned"]) for (const overdue of [false, true]) {
    const route = { page, tab: page === "reports" ? tab : "all", status: page === "reports" && tab === "all" ? status : "", overdue: page === "reports" && ["all", "active", "unassigned"].includes(tab) ? overdue : false };
    assert.deepEqual(R.parseRoute(R.formatRoute(route), order), route, R.formatRoute(route));
  }
}
assert.equal(R.formatRoute({ page: "reports" }), "#/reports");
assert.equal(R.formatRoute({ page: "reports", tab: "unassigned" }), "#/reports/unassigned");
assert.equal(R.formatRoute({ page: "hotspots" }), "#/hotspots");

// ── Tab conditions ───────────────────────────────────────────────────────────
// Unassigned wards: no ward, and neither hidden nor invalid. The same list as the tile.
assert.deepEqual(Q.tabConditions("unassigned"), ["ward_id.is.null", "is_deleted.not.is.true", "status.in.(verified,pending,active,reported,open,in_progress,cleaned)"]);
assert.deepEqual(Q.tabConditions("all"), []);
assert.deepEqual(Q.tabConditions("active"), Q.statusConditions("active"));
assert.deepEqual(Q.tabConditions("cleaned"), Q.statusConditions("cleaned"), "Cleaned leaves out auto-cleaned, as the tile does");
assert.ok(!Q.tabConditions("unassigned").some(c => /invalid|rejected/.test(c)), "invalid is excluded by listing what is allowed");
// the tile and the tab share one definition
const tile = Q.tileEnvelope("unassigned", { municipalityId: null }, NOW, 7);
assert.equal(new URLSearchParams(tile.path.split("?")[1]).get("and"), `(${Q.tabConditions("unassigned").join(",")})`);
assert.equal(tile.prefer, "count=exact");
const list = Q.reportsPageEnvelope({ municipalityId: null }, EMPTY_FILTERS, { key: "created_at", dir: "desc" }, 1, NOW, 7, "unassigned");
assert.equal(new URLSearchParams(list.path.split("?")[1]).get("and"), `(${Q.tabConditions("unassigned").join(",")})`, "the table shows exactly what the tile counts");
// a status filter does not leak into other tabs; the ward filter does not apply to Unassigned
assert.ok(!Q.reportConditions({ ...EMPTY_FILTERS, status: "invalid" }, NOW, 7, "active").join().includes("invalid"));
assert.ok(Q.reportConditions({ ...EMPTY_FILTERS, status: "invalid" }, NOW, 7, "all").join().includes("invalid"));
assert.ok(!Q.reportConditions({ ...EMPTY_FILTERS, ward: "w1" }, NOW, 7, "unassigned").join().includes("ward_id.eq"));
assert.ok(Q.reportConditions({ ...EMPTY_FILTERS, ward: "w1" }, NOW, 7, "cleaned").join().includes("ward_id.eq.w1"));
assert.equal(Q.TILE_KEYS.length, 8);
assert.ok(Q.TILE_KEYS.includes("unassigned"));

// ── Tiles lead to the Reports page with the matching filter ──────────────────
{
  const { TILE_ROUTE } = R;
  for (const key of Q.TILE_KEYS) assert.deepEqual(R.parseRoute(R.formatRoute(TILE_ROUTE[key]), order), TILE_ROUTE[key], `${key}: the route survives the address`);
  assert.equal(TILE_ROUTE.unassigned.tab, "unassigned");
  assert.deepEqual([TILE_ROUTE.invalid.tab, TILE_ROUTE.invalid.status], ["all", "invalid"]);
  assert.equal(TILE_ROUTE.overdue.overdue, true);
}

// ── Every request is allowed, for both roles, and scoped ─────────────────────
const params = plan => new URLSearchParams(plan.path.split("?")[1]);
let checked = 0;
for (const tab of ["all", "unassigned", "active", "in_progress", "cleaned"]) {
  for (const status of ["", "active", "in_progress", "cleaned", "invalid", "auto_cleaned"]) for (const ward of ["", "unassigned", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"]) for (const overdueOnly of [false, true]) {
    const filters = { ...EMPTY_FILTERS, status, ward, overdueOnly, q: `x"y`, from: "2026-09-01", to: "2026-10-11" };
    for (const [staff, scope] of [[SUPER, { municipalityId: M1 }], [MUNI, { municipalityId: null }], [SUPER, { municipalityId: null }]]) {
      for (const envelope of [Q.reportsPageEnvelope(scope, filters, { key: "created_at", dir: "desc" }, 2, NOW, 7, tab)]) {
        const plan = authorize(staff, { path: envelope.path, method: envelope.method, prefer: envelope.prefer });
        assert.deepEqual(params(plan).getAll("municipality_id"), staff === SUPER && !scope.municipalityId ? [] : [`eq.${M1}`], "View all sends no municipality");
        checked++;
      }
      const exp = Q.exportEnvelope(scope, filters, NOW, 7, tab);
      authorize(staff, { path: `${exp.path}${exp.path.includes("?") ? "&" : "?"}select=id,created_at,ward_id,status,is_deleted,cleaned_by_type,cleaned_at,cleaned_marked_at,description&order=created_at.asc,id.asc&limit=1000&offset=0`, method: "GET", prefer: "count=exact" });
      checked++;
    }
  }
}
for (const [staff, scope] of [[SUPER, { municipalityId: M1 }], [MUNI, { municipalityId: null }]]) {
  const envelope = Q.tileEnvelope("unassigned", scope, NOW, 7);
  const plan = authorize(staff, { path: envelope.path, method: envelope.method, prefer: envelope.prefer });
  assert.deepEqual(params(plan).getAll("municipality_id"), [`eq.${M1}`]);
  checked++;
}
// ── Hide and restore: the bodies the drawer sends are ones both roles may send ──
const F = await import("./format.ts");
const ID = "33333333-3333-4333-8333-333333333333";
for (const [reason, note] of [["spam", ""], ["duplicate", "  Same as another  "], ["outside_jurisdiction", "x".repeat(1000)], ["other", "Not a real report"]]) {
  const result = F.buildHidePatch(reason, note);
  assert.ok("body" in result, reason);
  assert.deepEqual(Object.keys(result.body).sort(), note.trim() ? ["admin_note", "invalid_reason", "is_deleted"] : ["invalid_reason", "is_deleted"]);
  assert.equal(result.body.is_deleted, true);
  assert.equal(result.body.invalid_reason, reason);
  for (const staff of [SUPER, MUNI]) authorize(staff, { path: `/rest/v1/reports?id=eq.${ID}`, method: "PATCH", prefer: "return=representation", body: result.body });
}
for (const reason of ["", "hacker", "Spam", undefined]) assert.match(F.buildHidePatch(reason, "").error, /reason/);
assert.match(F.buildHidePatch("spam", "x".repeat(1001)).error, /1000/);
// restoring: a report that is only hidden loses the hide's reason; one still marked Invalid keeps its reason
assert.deepEqual(F.buildUnhidePatch({ status: "verified" }, "").body, { is_deleted: false, invalid_reason: null });
assert.deepEqual(F.buildUnhidePatch({ status: "cleaned" }, " Checked ").body, { is_deleted: false, invalid_reason: null, admin_note: "Checked" });
assert.deepEqual(F.buildUnhidePatch({ status: "invalid" }, "").body, { is_deleted: false });
assert.deepEqual(F.buildUnhidePatch({ status: "rejected" }, "").body, { is_deleted: false });
assert.match(F.buildUnhidePatch({ status: "verified" }, "x".repeat(1001)).error, /1000/);
for (const staff of [SUPER, MUNI]) for (const body of [F.buildUnhidePatch({ status: "verified" }, "ok").body, F.buildUnhidePatch({ status: "invalid" }, "").body]) authorize(staff, { path: `/rest/v1/reports?id=eq.${ID}`, method: "PATCH", body });

console.log(`admin shell ok (${checked} requests checked for both roles)`);
