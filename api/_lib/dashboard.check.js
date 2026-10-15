// Tests for the dashboard's logic and its requests: `node api/_lib/dashboard.check.js`
// Every request the dashboard can build is run against the admin proxy's rules for both roles, so a screen
// that starts asking for something the allowlist does not permit fails here, not in front of a user.
import assert from "node:assert/strict";

const { authorize } = await import("./access.js");
const F = await import("../../src/admin/format.ts");
const Q = await import("../../src/admin/queryBuilders.ts");
const { EMPTY_FILTERS } = await import("../../src/admin/types.ts");

const M1 = "11111111-1111-4111-8111-111111111111";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-11T12:00:00Z");
const SUPER = { role: "super_admin", userId: "aaaaaaaa-0000-4000-8000-000000000001", municipalityId: null };
const MUNI = { role: "municipality_admin", userId: "aaaaaaaa-0000-4000-8000-000000000002", municipalityId: M1 };
const SCOPE_SUPER = { municipalityId: M1 }; // a super admin chooses a municipality
const SCOPE_MUNI = { municipalityId: null }; // a municipality admin never sends one

// ── Status rules ─────────────────────────────────────────────────────────────
// The same table is checked against private.normalize_status in supabase/tests/database/090_status_mapping.test.sql.
const MAPPING = [["verified", false, "active"], ["pending", false, "active"], ["active", false, "active"], ["reported", false, "active"], ["open", false, "active"],
  ["in_progress", false, "in_progress"], ["cleaned", false, "cleaned"], ["invalid", false, "invalid"], ["rejected", false, "invalid"], [null, false, "invalid"], ["whatever", false, "invalid"],
  ["verified", true, "invalid"], ["cleaned", true, "invalid"], ["in_progress", true, "invalid"], ["active", true, "invalid"], ["verified", null, "active"]];
for (const [status, is_deleted, expected] of MAPPING) assert.equal(F.statusOf({ status, is_deleted }), expected, `${status}/${is_deleted}`);

// Overdue: Active for longer than the threshold; never in progress, cleaned or invalid.
const created = days => new Date(NOW.getTime() - days * F.DAY).toISOString();
assert.equal(F.isOverdue({ status: "verified", is_deleted: false, created_at: created(8) }, 7, NOW), true);
assert.equal(F.isOverdue({ status: "verified", is_deleted: false, created_at: created(7) }, 7, NOW), false, "exactly on the threshold is not overdue");
assert.equal(F.isOverdue({ status: "active", is_deleted: false, created_at: created(30) }, 7, NOW), true);
for (const status of ["in_progress", "cleaned", "invalid"]) assert.equal(F.isOverdue({ status, is_deleted: false, created_at: created(60) }, 7, NOW), false, status);
assert.equal(F.isOverdue({ status: "active", is_deleted: true, created_at: created(60) }, 7, NOW), false, "hidden reports are not overdue");
assert.equal(F.ageDays(created(12), NOW), 12);
assert.equal(F.ageDays(created(0.2), NOW), 0);
assert.equal(F.ageDays(new Date(NOW.getTime() + F.DAY).toISOString(), NOW), 0, "a clock a little ahead never gives a negative age");
assert.equal(F.ageLabel(0), "Today");
assert.equal(F.ageLabel(1), "1 day");
assert.equal(F.ageLabel(9), "9 days");
assert.equal(F.wardLabel({ id: W1, number: 7, name: null }), "Ward 7");
assert.equal(F.wardLabel({ id: W1, number: 7, name: "  " }), "Ward 7");
assert.equal(F.wardLabel({ id: W1, number: 7, name: "Named" }), "Ward 7 · Named");

// Allowed moves are exactly the ones in docs/STATUS-MODEL.md.
assert.deepEqual(F.actionsFor("active"), ["start", "clean", "invalid"]);
assert.deepEqual(F.actionsFor("in_progress"), ["back_to_active", "clean", "invalid"]);
assert.deepEqual(F.actionsFor("cleaned"), ["reopen"]);
assert.deepEqual(F.actionsFor("invalid"), ["reopen"]);

const input = (extra = {}) => ({ name: "", date: "", reason: "", note: "", currentNote: null, ...extra });
const err = (action, extra) => { const r = F.buildStatusPatch(action, input(extra), NOW); assert.ok("error" in r, `${action} should be refused`); return r.error; };
const body = (action, extra) => { const r = F.buildStatusPatch(action, input(extra), NOW); assert.ok("body" in r, `${action} should be allowed: ${r.error}`); return r.body; };
assert.deepEqual(body("start"), { status: "in_progress" });
assert.deepEqual(body("start", { note: " On it " }), { status: "in_progress", admin_note: "On it" });
assert.deepEqual(body("back_to_active"), { status: "active" });
// cleaned needs who and when, and is always JMB
assert.match(err("clean", { date: "2026-10-10" }), /who cleaned/);
assert.match(err("clean", { name: "Team" }), /date/);
assert.match(err("clean", { name: "Team", date: "2026-10-12" }), /future/);
assert.match(err("clean", { name: "x".repeat(121), date: "2026-10-10" }), /120/);
const cleaned = body("clean", { name: " JMB ward 7 team ", date: "2026-10-10", note: "Done" });
assert.deepEqual([cleaned.status, cleaned.cleaned_by_name, cleaned.cleaned_by_type, cleaned.admin_note], ["cleaned", "JMB ward 7 team", "jmb", "Done"]);
assert.ok(Date.parse(cleaned.cleaned_at) <= NOW.getTime(), "the cleaned date is not in the future");
assert.equal(body("clean", { name: "Team", date: "2026-10-11" }).cleaned_by_type, "jmb", "today is allowed");
for (const type of ["citizen", "auto", "other"]) assert.notEqual(body("clean", { name: "Team", date: "2026-10-10", reason: type }).cleaned_by_type, type, "the type never comes from the form");
// invalid needs a reason and a note
assert.match(err("invalid", { note: "Spam" }), /reason/);
assert.match(err("invalid", { reason: "hacker", note: "x" }), /reason/);
assert.match(err("invalid", { reason: "spam" }), /note/);
assert.match(err("invalid", { reason: "spam", note: "   " }), /note/);
assert.deepEqual(body("invalid", { reason: "duplicate", note: "Same as another" }), { status: "invalid", invalid_reason: "duplicate", admin_note: "Same as another" });
// reopening needs a new note
assert.match(err("reopen", {}), /note/);
assert.match(err("reopen", { note: "Same", currentNote: "Same" }), /new note/);
assert.deepEqual(body("reopen", { note: "Garbage returned", currentNote: "Old" }), { status: "active", admin_note: "Garbage returned" });
assert.match(err("start", { note: "x".repeat(1001) }), /1000/);
assert.deepEqual(F.buildNotePatch(" New ", "Old"), { body: { admin_note: "New" } });
assert.deepEqual(F.buildNotePatch("", "Old"), { body: { admin_note: null } }, "clearing the note");
assert.ok("error" in F.buildNotePatch("Old", " Old "), "an unchanged note is not saved");
assert.ok("error" in F.buildNotePatch("x".repeat(1001), null));
assert.equal(F.todayISO(new Date(2026, 9, 5)), "2026-10-05");

// ── Audit text ───────────────────────────────────────────────────────────────
const wards = new Map([[W1, { id: W1, number: 7, name: null }]]);
const d = (action, from_value, to_value, note = null) => F.describeAudit({ action, from_value, to_value, note }, wards);
assert.equal(d("status_change", { status: "verified" }, { status: "in_progress" }), "Status: Active to In progress.");
assert.equal(d("status_change", { status: "in_progress" }, { status: "cleaned", cleaned_by_name: "JMB team", cleaned_by_type: "jmb" }), "Status: In progress to Cleaned, cleaned by JMB team (JMB).");
assert.equal(d("status_change", { status: "active" }, { status: "invalid", invalid_reason: "outside_jurisdiction" }), "Status: Active to Invalid, reason: Outside jurisdiction.");
assert.equal(d("ward_change", { ward_id: null }, { ward_id: W1 }), "Ward: Unassigned to Ward 7.");
assert.equal(d("ward_change", { ward_id: W1 }, { ward_id: "other-ward-id" }), "Ward: Ward 7 to a ward.");
assert.equal(d("note_change", { admin_note: null }, { admin_note: "x" }), "Internal note updated.");
assert.equal(d("note_change", { admin_note: "x" }, { admin_note: null }), "Internal note cleared.");
assert.equal(d("proof_approved", { status: "pending" }, { status: "approved" }), "Citizen cleanup proof approved.");
assert.equal(d("proof_rejected", { status: "pending" }, { status: "rejected" }), "Citizen cleanup proof rejected.");
assert.match(d("report_created", null, { claimed_in_municipality: "yes" }), /inside the municipal area/);
assert.match(d("report_created", null, {}), /^Report received\.$/);
assert.equal(d("hidden", null, null), "Hidden from the public site.");
assert.equal(d("something_new", null, null), "something_new");
assert.equal(F.actorLabel("public"), "Public (citizen)");
assert.equal(F.actorLabel("system"), "System");
assert.equal(F.actorLabel("a@b.test"), "a@b.test");

// ── Every request the dashboard builds is allowed for each role, and scoped ──
const allowed = (staff, envelope, label) => {
  try { return authorize(staff, { path: envelope.path, method: envelope.method, prefer: envelope.prefer, body: envelope.body }); }
  catch (error) { assert.fail(`${staff.role} ${label}: refused (${error.reason}) for ${envelope.path.slice(0, 120)}`); }
};
const params = plan => new URLSearchParams(plan.path.split("?")[1]);
const bothRoles = (build, label, check) => {
  const asSuper = allowed(SUPER, build(SCOPE_SUPER), label);
  const asMuni = allowed(MUNI, build(SCOPE_MUNI), label);
  assert.deepEqual(params(asSuper).getAll("municipality_id"), [`eq.${M1}`], `${label}: a super admin's chosen municipality is sent`);
  assert.deepEqual(params(asMuni).getAll("municipality_id"), [`eq.${M1}`], `${label}: the server scopes a municipality admin`);
  check?.(asSuper, asMuni);
  return [asSuper, asMuni];
};
let built = 0;

// tiles
for (const key of Q.TILE_KEYS) {
  const [, plan] = bothRoles(scope => Q.tileEnvelope(key, scope, NOW, 7), `tile ${key}`);
  assert.equal(params(plan).get("limit"), "1");
  assert.equal(plan.prefer, "count=exact");
  built++;
}
const tileAnd = key => params(allowed(MUNI, Q.tileEnvelope(key, SCOPE_MUNI, NOW, 7), key)).get("and");
assert.equal(tileAnd("total"), null, "total has no status condition");
assert.match(tileAnd("cleaned"), /cleaned_by_type\.neq\.auto/, "the Cleaned tile leaves out auto-cleaned");
assert.match(tileAnd("auto_cleaned"), /cleaned_by_type\.eq\.auto/);
assert.match(tileAnd("overdue"), new RegExp(`created_at\\.lt\\.${created(7).slice(0, 10)}`), "overdue cuts at now minus the threshold");
assert.match(tileAnd("overdue"), /status\.in\.\(verified,pending,active,reported,open\)/);
assert.match(tileAnd("invalid"), /is_deleted\.is\.true/, "hidden reports count as invalid");
assert.equal(params(allowed(MUNI, Q.tileEnvelope("overdue", SCOPE_MUNI, NOW, 14), "x")).get("and").includes(created(14).slice(0, 10)), true, "the threshold comes from the municipality's setting");

// the reports table: every status, ward, date range, overdue, search and sort
const statuses = ["", "active", "in_progress", "cleaned", "auto_cleaned", "invalid"];
const wardsToTry = ["", "unassigned", W1];
const sorts = ["created_at", "updated_at", "status", "area"].flatMap(key => [{ key, dir: "asc" }, { key, dir: "desc" }]);
const searches = ["", "market", "  Fancy Bazar  ", `a"b\\c`, "x,y(z)", "*%_", `quote"),municipality_id.eq.${"22222222-2222-4222-8222-222222222222"},("`, "অসমীয়া", "x".repeat(500), "\u0000\u001f tabs\tand\nnewlines"];
for (const status of statuses) for (const ward of wardsToTry) for (const q of searches) {
  const filters = { ...EMPTY_FILTERS, status, ward, q, from: "2026-09-01", to: "2026-10-11", overdueOnly: false };
  bothRoles(scope => Q.reportsPageEnvelope(scope, filters, sorts[0], 1, NOW, 7), `reports ${status}/${ward}/${q.slice(0, 10)}`);
  built++;
}
for (const sort of sorts) for (const page of [1, 2, 40]) {
  const [, plan] = bothRoles(scope => Q.reportsPageEnvelope(scope, { ...EMPTY_FILTERS, overdueOnly: true }, sort, page, NOW, 7), `sort ${sort.key} ${sort.dir}`);
  assert.equal(params(plan).get("offset"), String((page - 1) * Q.PAGE_SIZE));
  assert.equal(params(plan).get("limit"), String(Q.PAGE_SIZE));
  built++;
}
bothRoles(scope => Q.reportsPageEnvelope(scope, { ...EMPTY_FILTERS, from: "2026-10-01" }, sorts[0], 1, NOW, 7), "from only");
bothRoles(scope => Q.reportsPageEnvelope(scope, { ...EMPTY_FILTERS, to: "2026-10-01" }, sorts[0], 1, NOW, 7), "to only");
bothRoles(scope => Q.reportsPageEnvelope(scope, EMPTY_FILTERS, sorts[0], 0, NOW, 7), "page 0 is page 1");
assert.equal(params(allowed(MUNI, Q.reportsPageEnvelope(SCOPE_MUNI, EMPTY_FILTERS, sorts[0], 0, NOW, 7), "p")).get("offset"), "0");
// a search can never reach another column or break out of its quotes
{
  const nasty = Q.reportsPageEnvelope(SCOPE_MUNI, { ...EMPTY_FILTERS, q: `x"),municipality_id.eq.22222222-2222-4222-8222-222222222222,("` }, sorts[0], 1, NOW, 7);
  const and = decodeURIComponent(nasty.path.split("and=")[1].split("&")[0]);
  assert.equal((and.match(/"/g) || []).length % 2, 0, "quotes stay balanced");
  assert.equal((and.match(/"/g) || []).length, 6, "exactly the three patterns are quoted");
  assert.equal(Q.cleanSearch(`a"b\\c`), "abc");
  assert.equal(Q.cleanSearch("x".repeat(500)).length, 80);
}
// overdue-only is Active and overdue, whatever status was chosen
assert.match(params(allowed(MUNI, Q.reportsPageEnvelope(SCOPE_MUNI, { ...EMPTY_FILTERS, overdueOnly: true }, sorts[0], 1, NOW, 7), "o")).get("and"), new RegExp(`created_at\\.lt\\.${created(7).slice(0, 16)}`), "overdue-only cuts at the threshold");
assert.match(params(allowed(MUNI, Q.reportsPageEnvelope(SCOPE_MUNI, { ...EMPTY_FILTERS, status: "cleaned", overdueOnly: true }, sorts[0], 1, NOW, 7), "o")).get("and"), /status\.in\.\(verified/);
assert.ok(!/status\.eq\.cleaned/.test(params(allowed(MUNI, Q.reportsPageEnvelope(SCOPE_MUNI, { ...EMPTY_FILTERS, status: "cleaned", overdueOnly: true }, sorts[0], 1, NOW, 7), "o")).get("and")));

// one report and its history
for (const [label, build] of [["report", () => Q.reportEnvelope(ID)], ["history", () => Q.historyEnvelope(ID)]]) {
  const plan = allowed(MUNI, build(), label);
  assert.deepEqual(params(plan).getAll("id").concat(params(plan).getAll("entity_id")).length, 1);
  assert.deepEqual(params(plan).getAll("municipality_id"), [`eq.${M1}`], `${label} is scoped for a municipality admin`);
  assert.deepEqual(params(allowed(SUPER, build(), label)).getAll("municipality_id"), [], `${label}: a super admin may open any municipality's report`);
  built++;
}

// reference data
bothRoles(Q.wardsEnvelope, "wards");
assert.deepEqual(params(allowed(MUNI, Q.municipalitiesEnvelope(), "m")).getAll("id"), [`eq.${M1}`], "a municipality admin sees only their municipality");
assert.deepEqual(params(allowed(SUPER, Q.municipalitiesEnvelope(), "m")).getAll("id"), [], "a super admin sees them all");

// the audit log: every filter, both roles
for (const action of ["", "status_change", "ward_change", "note_change", "report_created", "hidden", "staff_changed"]) for (const actor of ["", "demo-jmb@example.test", "public", `x"y%_*`]) {
  bothRoles(scope => Q.auditPageEnvelope(scope, { from: "2026-09-01", to: "2026-10-11", actor, action }, 2), `audit ${action}/${actor}`);
  built++;
}
bothRoles(scope => Q.auditPageEnvelope(scope, Q.EMPTY_AUDIT_FILTERS, 1), "audit no filters");
assert.ok(!params(allowed(MUNI, Q.auditPageEnvelope(SCOPE_MUNI, { ...Q.EMPTY_AUDIT_FILTERS, actor: "a*%b" }, 1), "a")).get("actor_email").includes("%"), "wildcards typed by the person are removed");

// hidden tab
bothRoles(Q.hiddenEnvelope, "hidden list");
for (const staff of [SUPER, MUNI]) allowed(staff, Q.hiddenHistoryEnvelope([ID, W1]), "hidden history");
assert.deepEqual(params(allowed(MUNI, Q.hiddenHistoryEnvelope([ID]), "h")).getAll("municipality_id"), [`eq.${M1}`]);

// updates: every body the status buttons and the note box can produce is allowed for a municipality admin
const bodies = [];
for (const action of ["start", "back_to_active", "clean", "invalid", "reopen"]) {
  const r = F.buildStatusPatch(action, input({ name: "JMB team", date: "2026-10-10", reason: "spam", note: "A note", currentNote: "Old" }), NOW);
  assert.ok("body" in r, action);
  bodies.push(r.body);
}
bodies.push({ ward_id: W1 }, { ward_id: null }, { admin_note: "Just a note" }, { admin_note: null });
for (const b of bodies) {
  const envelope = Q.patchReportEnvelope(ID, b);
  for (const staff of [SUPER, MUNI]) {
    const plan = allowed(staff, envelope, `patch ${JSON.stringify(Object.keys(b))}`);
    assert.deepEqual(params(plan).getAll("id"), [`eq.${ID}`]);
    assert.deepEqual(params(plan).getAll("municipality_id"), staff.role === "municipality_admin" ? [`eq.${M1}`] : []);
    assert.equal(plan.method, "PATCH");
    assert.ok(!["DELETE", "POST"].includes(plan.method), "nothing deletes or inserts");
  }
  built++;
}

// T6/T7: the CSV export, the monthly report and the hotspot ranking
const EXPORT_COLUMNS = "id,created_at,ward_id,status,is_deleted,cleaned_by_type,cleaned_at,cleaned_marked_at,description"; // the server's fixed list (api/admin/export.js)
for (const status of ["", "active", "in_progress", "cleaned", "invalid", "auto_cleaned"]) for (const ward of ["", "unassigned", W1]) for (const overdueOnly of [false, true]) {
  for (const q of ["", `bad"quote\\ *`]) {
    const filters = { ...EMPTY_FILTERS, status, ward, overdueOnly, q, from: "2026-09-01", to: "2026-10-11" };
    for (const [staff, scope] of [[SUPER, SCOPE_SUPER], [MUNI, SCOPE_MUNI]]) {
      const envelope = Q.exportEnvelope(scope, filters, NOW, 7);
      const keys = [...new URLSearchParams(envelope.path.split("?")[1]).keys()];
      assert.ok(keys.every(k => k === "and" || k === "municipality_id"), `the export sends only filters: ${keys}`);
      assert.deepEqual(keys.includes("municipality_id"), staff.role === "super_admin", "only a super admin names the municipality");
      // what the server does with it: fixed columns, order and paging, then the same allowlist
      const plan = authorize(staff, { path: `${envelope.path}${envelope.path.includes("?") ? "&" : "?"}select=${EXPORT_COLUMNS}&order=created_at.asc,id.asc&limit=1000&offset=0`, method: "GET", prefer: "count=exact" });
      assert.deepEqual(params(plan).getAll("municipality_id"), [`eq.${M1}`], "the export is scoped");
      built++;
    }
  }
}
assert.equal(Q.exportEnvelope(SCOPE_MUNI, EMPTY_FILTERS, NOW, 7).path, "/rest/v1/reports?", "with no filters the export is the whole municipality");
for (const [name, build] of [["monthly", scope => Q.monthlyEnvelope(scope, "2026-08")], ["hotspots 30", scope => Q.hotspotsEnvelope(scope, 30)], ["hotspots 60", scope => Q.hotspotsEnvelope(scope, 60)], ["hotspots 90", scope => Q.hotspotsEnvelope(scope, 90)]]) {
  const asSuper = allowed(SUPER, build(SCOPE_SUPER), name);
  const asMuni = allowed(MUNI, build(SCOPE_MUNI), name);
  assert.equal(JSON.parse(asSuper.body).p_municipality, M1, `${name}: a super admin's chosen municipality`);
  assert.equal(JSON.parse(asMuni.body).p_municipality, M1, `${name}: the server scopes a municipality admin`);
  assert.equal("p_municipality" in (build(SCOPE_MUNI).body ?? {}), false, `${name}: a municipality admin never sends one`);
  assert.equal(asMuni.method, "POST");
  built++;
}

console.log(`dashboard logic ok (${built} request shapes checked for both roles)`);
