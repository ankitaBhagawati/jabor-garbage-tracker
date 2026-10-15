// Tests for the staff page and the audit export on the browser side: `node src/admin/staffui.check.js`
// The export path comes from the same builder as the list, the password helpers, and the plain-words errors.
import assert from "node:assert/strict";

const { authorize } = await import("../../api/_lib/access.js"); // read only: the same rules the server applies
const Q = await import("./queryBuilders.ts");
const P = await import("./password.ts");
const A = await import("./adminApi.ts");
const R = await import("./route.ts");
const N = await import("./nav.ts");

const M1 = "11111111-1111-4111-8111-111111111111";
const SUPER = { role: "super_admin", userId: "aaaaaaaa-0000-4000-8000-000000000001", municipalityId: null };
const MUNI = { role: "municipality_admin", userId: "aaaaaaaa-0000-4000-8000-000000000002", municipalityId: M1 };
const params = path => new URLSearchParams(path.split("?")[1]);
const LIST_ONLY = new Set(["select", "order", "limit", "offset"]);
const filtersOf = path => [...params(path).entries()].filter(([key]) => !LIST_ONLY.has(key)).sort();

// ── the export is built from the list's own filters ──────────────────────────
const { EMPTY_AUDIT_FILTERS } = Q;
let checked = 0;
for (const from of ["", "2026-09-01"]) for (const to of ["", "2026-10-11"]) for (const actor of ["", "demo-jmb@example.test", "public", `a*%"b`, "x".repeat(200)]) for (const action of ["", "status_change", "export", "staff_account_created"]) {
  const filters = { from, to, actor, action };
  for (const scope of [{ municipalityId: null }, { municipalityId: M1 }]) {
    const list = Q.auditPageEnvelope(scope, filters, 3);
    const exp = Q.auditExportEnvelope(scope, filters);
    assert.deepEqual(filtersOf(exp.path), filtersOf(list.path), `the export has exactly the list's filters: ${JSON.stringify(filters)}`);
    assert.equal(exp.type, "audit_log");
    assert.deepEqual(Object.keys(exp).sort(), ["path", "type"]);
    assert.ok(exp.path.startsWith("/rest/v1/audit_log"));
    for (const key of LIST_ONLY) assert.ok(!params(exp.path).has(key), `no ${key} in the export`);
    assert.equal(Q.auditFiltersActive(filters), filtersOf(list.path).filter(([k]) => k !== "municipality_id").length > 0, "the button label follows the real filters");
    // the server accepts it (api/admin/export.js adds the columns, order and paging, then asks the same allowlist)
    for (const staff of [SUPER, MUNI]) {
      if (staff.role === "municipality_admin" && scope.municipalityId) continue; // a municipality admin never sends one
      if (staff.role === "super_admin" && !scope.municipalityId) { /* all municipalities: allowed */ }
      const sent = new URLSearchParams(exp.path.split("?")[1]);
      const asServer = new URLSearchParams([["select", "id,municipality_id,entity_type,entity_id,actor_email,action,from_value,to_value,note,created_at"], ...sent, ["order", "created_at.desc,id.desc"], ["limit", "1000"], ["offset", "0"]]);
      const plan = authorize(staff, { path: `/rest/v1/audit_log?${asServer}`, method: "GET", prefer: "count=exact" });
      assert.ok(plan.path.startsWith("/rest/v1/audit_log?"));
      checked++;
    }
  }
}
// no filters: the export says so, and the label is "all"
assert.equal(Q.auditExportEnvelope({ municipalityId: null }, EMPTY_AUDIT_FILTERS).path, "/rest/v1/audit_log?");
assert.equal(Q.auditFiltersActive(EMPTY_AUDIT_FILTERS), false);
assert.equal(Q.auditFiltersActive({ ...EMPTY_AUDIT_FILTERS, action: "ward_change" }), true);
assert.equal(Q.auditFiltersActive({ ...EMPTY_AUDIT_FILTERS, from: "2026-09-01" }), true);
assert.equal(Q.auditFiltersActive({ ...EMPTY_AUDIT_FILTERS, actor: "   " }), false, "blank spaces are not a filter, as the list treats them");
// the date range is one `and=` with both ends, as in the list
const both = params(Q.auditExportEnvelope({ municipalityId: null }, { ...EMPTY_AUDIT_FILTERS, from: "2026-09-01", to: "2026-10-11" }).path).get("and");
assert.match(both, /^\(created_at\.gte\..*,created_at\.lte\..*\)$/);

// ── Add admins is for super admins, and the address of it is not a page for anyone else ──
const superPages = N.navFor("super_admin").map(i => i.id), muniPages = N.navFor("municipality_admin").map(i => i.id);
assert.ok(superPages.includes("admins"));
assert.ok(!muniPages.includes("admins"));
assert.equal(N.navFor("super_admin").find(i => i.id === "admins").label, "Add admins");
assert.equal(R.parseRoute("#/admins", superPages).page, "admins");
assert.equal(R.parseRoute("#/admins", muniPages).page, "dashboard", "a municipality admin typing the address gets the Dashboard");
assert.equal(R.parseRoute("#/admins/x?y=1", muniPages).page, "dashboard");

// ── passwords ────────────────────────────────────────────────────────────────
const seen = new Set();
for (let i = 0; i < 300; i++) {
  const password = P.generatePassword();
  assert.ok(password.length >= 16 && password.length <= P.PASSWORD_MAX, `length ${password.length}`);
  assert.equal(P.passwordProblem(password), "");
  assert.match(password, /[a-z]/); assert.match(password, /[A-Z]/); assert.match(password, /[2-9]/); assert.match(password, /[-_!@#$%*+=?]/);
  assert.doesNotMatch(password, /[\s"'<>\\`&]/, "nothing that is awkward to copy or paste");
  seen.add(password);
}
assert.equal(seen.size, 300, "no repeats");
assert.equal(P.generatePassword(5).length, 16, "never shorter than 16");
assert.equal(P.generatePassword(500).length, P.PASSWORD_MAX, "never longer than the server accepts");
// the characters are spread evenly (no modulo bias): every character of the alphabet appears
const counts = new Map();
for (let i = 0; i < 4000; i++) for (const c of P.generatePassword(20)) counts.set(c, (counts.get(c) || 0) + 1);
assert.equal(counts.size, 25 + 24 + 8 + 11, "every character of the alphabet is used");
const mean = [...counts.values()].reduce((a, b) => a + b, 0) / counts.size;
for (const [c, n] of counts) assert.ok(n > mean * 0.7 && n < mean * 1.3, `${c} appears ${n} times, mean ${Math.round(mean)}`);
// it asks the crypto source for its random numbers (a counting wrapper around the real one)
let asked = 0;
const counting = { getRandomValues(buffer) { asked++; return globalThis.crypto.getRandomValues(buffer); } };
assert.ok(P.generatePassword(16, counting).length >= 16);
assert.ok(asked >= 16, "random numbers come from getRandomValues");
assert.ok(!/Math\.random/.test(await (await import("node:fs/promises")).readFile(new URL("./password.ts", import.meta.url), "utf8")), "never Math.random");
for (const [password, fine] of [["", false], ["short", false], ["elevenchars", false], ["x".repeat(11), false], ["x".repeat(12), true], ["x".repeat(72), true], ["x".repeat(73), false]]) assert.equal(P.passwordProblem(password) === "", fine, `"${password.slice(0, 12)}" (${password.length})`);

// ── errors, in plain words ───────────────────────────────────────────────────
const say = A.staffErrorMessage;
assert.equal(say(409), "An account with this email already exists. Nothing was changed.");
assert.equal(say(403), "You do not have permission to do that.");
assert.equal(say(429), "Too many attempts. Please wait a while and try again.");
assert.equal(say(0), "Could not reach the server. Check your connection and try again.");
assert.equal(say(401), "Your session has ended. Please sign in again.");
assert.equal(say(503), "This is temporarily unavailable. Please try again in a few minutes.");
assert.equal(say(400, "Enter a valid email address."), "Enter a valid email address.", "the server's own validation sentence is shown");
assert.equal(say(400, "The password must be at least 12 characters."), "The password must be at least 12 characters.");
// anything else, however it is worded, is not shown
for (const raw of ["duplicate key value violates unique constraint", "<html>Bad gateway</html>", "{\"code\":\"23505\"}", "x".repeat(400), "", null, undefined, 5, "lowercase start.", "No full stop"]) assert.equal(say(400, raw), "Check the details and try again.", String(raw).slice(0, 30));
for (const status of [500, 502, 504, 418, 422]) assert.equal(say(status, "duplicate key value violates unique constraint"), "Something went wrong. Please try again.");
assert.equal(say(404), "That account was not found. Refresh the list and try again.");
for (const status of [0, 400, 401, 403, 404, 409, 429, 500, 503]) assert.ok(!say(status, "boom").includes("—"), "no em dashes in UI text");

// the new audit actions have names and sentences
const F = await import("./format.ts");
for (const action of ["staff_account_created", "staff_account_activated", "staff_account_deactivated"]) {
  assert.ok(F.ACTION_LABEL[action], `${action} has a label`);
  const line = F.describeAudit({ action, from_value: null, to_value: { email: "a@example.test" }, note: null }, new Map());
  assert.match(line, /^a@example\.test was /);
  assert.ok(!line.includes("\u2014"));
}

// ── the Audit log page's Action filter, by role ──────────────────────────────
const optionsFor = role => F.auditActionOptions(role).map(o => o.value);
assert.deepEqual(optionsFor("super_admin"), Object.keys(F.ACTION_LABEL), "a super admin is offered every action, as before");
for (const action of ["export", "staff_created", "staff_changed", "staff_deleted", "staff_account_created", "staff_account_activated", "staff_account_deactivated"]) {
  assert.ok(optionsFor("super_admin").includes(action), `super_admin: ${action}`);
  assert.ok(!optionsFor("municipality_admin").includes(action), `municipality_admin is not offered ${action}`);
}
assert.deepEqual(optionsFor("municipality_admin"), ["report_created", "status_change", "ward_change", "assignment_change", "cleaned_details_change", "note_change", "hidden", "unhidden", "proof_approved", "proof_rejected"]);
assert.ok(!optionsFor("municipality_admin").some(a => /staff|export/.test(a)), "no staff or export action by any name");
for (const option of F.auditActionOptions("municipality_admin")) assert.equal(option.label, F.ACTION_LABEL[option.value], "the same labels as the rows show");
// an unknown role is treated as the narrow one
assert.deepEqual(optionsFor("admin"), optionsFor("municipality_admin"));
// every action a municipality admin is offered passes the proxy and comes back scoped to report rows
for (const action of optionsFor("municipality_admin")) {
  const plan = authorize(MUNI, Q.auditPageEnvelope({ municipalityId: null }, { ...EMPTY_AUDIT_FILTERS, action }, 1));
  assert.deepEqual(params(plan.path).getAll("entity_type"), ["eq.report"]);
}

console.log(`staff page logic ok (${checked} export requests checked)`);
