// A municipality admin sees report rows of the audit log and nothing else: `node api/_lib/audit-scope.check.js`
// Runs the real proxy (/api/admin/rest) and the real export (/api/admin/export) against a stubbed Supabase.
// The stub applies today's row level security (own municipality, any entity_type), so only the API layer
// can keep staff rows away from a municipality admin.
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon-key-for-tests";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";

const { default: restHandler } = await import("../admin/rest.js");
const { default: exportHandler, MAX_ROWS, AUDIT_COLUMNS } = await import("../admin/export.js");

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const U_SUPER = "aaaaaaaa-0000-4000-8000-000000000001";
const U_MUNI = "aaaaaaaa-0000-4000-8000-000000000002";
const accounts = {
  "t-muni": { user: { id: U_MUNI, email: "jmb@example.test", app_metadata: { role: "municipality_admin", municipality_id: M1 } }, profile: { user_id: U_MUNI, role: "municipality_admin", municipality_id: M1, is_active: true, municipalities: { name: "Jorhat", slug: "jorhat" } } },
  "t-super": { user: { id: U_SUPER, email: "owner@example.test", app_metadata: { role: "super_admin" } }, profile: { user_id: U_SUPER, role: "super_admin", municipality_id: null, is_active: true, municipalities: null } },
};

// ── the audit_log ────────────────────────────────────────────────────────────
const AUDIT = [];
const add = extra => AUDIT.push({ id: AUDIT.length + 1, municipality_id: M1, entity_type: "report", entity_id: `r${AUDIT.length + 1}`, actor_id: null, actor_email: "jmb@example.test", action: "status_change", from_value: { status: "active" }, to_value: { status: "cleaned" }, note: null, created_at: new Date(Date.UTC(2026, 9, 1) + AUDIT.length * 60_000).toISOString(), ...extra });
for (let n = 0; n < 6; n++) add(n % 3 === 0 ? { actor_email: "public", action: "report_created" } : n % 3 === 1 ? { action: "ward_change" } : {});
add({ actor_email: "system", action: "status_change" });        // a report row written by the system: still a report row
add({ actor_email: "owner@example.test", action: "assignment_change" }); // a report row a super admin wrote
for (let n = 0; n < 4; n++) add({ municipality_id: M2, actor_email: "other@example.test" });
const REPORTS_M1 = AUDIT.filter(r => r.municipality_id === M1).length;
// the five kinds of row from the bug report, all carrying the municipality's own id, plus a kind nobody has written yet
add({ entity_type: "staff_profile", entity_id: "u9", actor_email: "system", action: "staff_created", from_value: null, to_value: { role: "municipality_admin", designation: "Health Officer", municipality_id: M1 } });
add({ entity_type: "staff_profile", entity_id: "u8", actor_email: "owner@example.test", action: "staff_created", from_value: null, to_value: { role: "municipality_admin", municipality_id: M1 } });
add({ entity_type: "staff_profile", entity_id: "u9", actor_email: "system", action: "staff_changed", from_value: { designation: "Health Officer" }, to_value: { designation: "Sanitary Inspector" } });
add({ entity_type: "staff_profile", entity_id: "u8", actor_email: "system", action: "staff_deleted", from_value: { role: "municipality_admin" }, to_value: null });
add({ entity_type: "staff_member", entity_id: "u9", actor_email: "owner@example.test", action: "staff_account_deactivated", from_value: null, to_value: { email: "second.admin@example.test" } });
add({ entity_type: "staff_invite", entity_id: "u7", actor_email: "system", action: "staff_invited", from_value: null, to_value: { email: "third.admin@example.test" } });
add({ entity_type: "export", entity_id: "audit_log", actor_email: "owner@example.test", action: "export", from_value: null, to_value: { rows: 5 } });
const NOT_REPORTS_M1 = AUDIT.filter(r => r.municipality_id === M1).length - REPORTS_M1;
const LEAKS = /staff_|second\.admin|third\.admin|Health Officer|Sanitary Inspector/;

// One Postgrest filter value against one cell: eq, neq, in, ilike, with an optional not.
const matches = (cell, filter) => {
  const not = filter.startsWith("not.");
  const [, op, arg] = /^(eq|neq|in|ilike)\.(.*)$/s.exec(not ? filter.slice(4) : filter) || [];
  assert.ok(op, `the stub does not know the filter ${filter}`);
  const hit = op === "eq" ? String(cell) === arg : op === "neq" ? String(cell) !== arg : op === "in" ? arg.slice(1, -1).split(",").includes(String(cell))
    : new RegExp(`^${arg.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(String(cell));
  return hit !== not;
};
let bulk = 0; // set to pretend the municipality has this many more report rows
const auditList = (url, account) => {
  const q = url.searchParams;
  const rls = account.profile.role === "super_admin" ? null : account.profile.municipality_id;
  const extra = Array.from({ length: bulk }, (_, i) => ({ ...AUDIT[0], id: 1000 + i, created_at: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString() }));
  let rows = [...AUDIT, ...extra].filter(r => (!rls || r.municipality_id === rls) &&
    // the same column more than once is ANDed, as Postgrest does
    ["municipality_id", "entity_type", "entity_id", "action", "actor_email"].every(col => q.getAll(col).every(f => matches(r[col], f))));
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
  const offset = Number(q.get("offset") || 0), limit = Number(q.get("limit") || 1000);
  const page = rows.slice(offset, offset + limit);
  return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json", "content-range": `${offset}-${offset + page.length - 1}/${rows.length}` } });
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const realFetch = globalThis.fetch;
let reads = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const account = accounts[/^Bearer (.+)$/.exec(init.headers?.Authorization || "")?.[1]];
  if (url.endsWith("/auth/v1/user")) return account ? json(account.user) : json({}, 401);
  if (url.includes("/rest/v1/staff_profiles?")) return json(account ? [account.profile] : []);
  if (url.includes("/rest/v1/audit_log") && init.method === "POST") return new Response(null, { status: 201 });
  if (url.includes("/rest/v1/audit_log")) { reads++; return auditList(new URL(url), account); }
  return json({}, 404);
};
const call = async (handler, token, body) => {
  const req = { method: "POST", headers: { host: "jabor.in", origin: "https://jabor.in", "x-forwarded-for": "9.9.9.9", ...(token ? { cookie: `jabor_at=${token}` } : {}) }, socket: {}, body };
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  res.end = text => { res.body = text; return res; };
  reads = 0;
  await handler(req, res);
  return res;
};
const params = pairs => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
// The Audit log page: what src/admin/queryBuilders.ts sends through the proxy.
const list = async (token, filters = []) => {
  const res = await call(restHandler, token, { path: `/rest/v1/audit_log?${params([["select", AUDIT_COLUMNS], ...filters, ["order", "created_at.desc,id.desc"], ["limit", "50"], ["offset", "0"]])}`, method: "GET", prefer: "count=exact" });
  return { status: res.statusCode, rows: res.statusCode === 200 ? JSON.parse(res.body) : [], text: String(res.body), total: Number(/\/(\d+)$/.exec(res.headers["Content-Range"] || "/0")[1]) };
};
// Export CSV: with filters it is the filtered export, with none it is Export all.
const exported = async (token, filters = []) => {
  const res = await call(exportHandler, token, { type: "audit_log", path: `/rest/v1/audit_log${filters.length ? `?${params(filters)}` : ""}` });
  const lines = res.statusCode === 200 ? res.body.replace(String.fromCharCode(0xfeff), "").split("\r\n").filter(Boolean).slice(1) : [];
  return { status: res.statusCode, rows: lines.map(l => ({ entity_type: l.split(",")[4] })), text: String(res.body), total: Number(res.headers["X-Total-Rows"] ?? 0), headers: res.headers };
};
const origWarn = console.warn, origError = console.error;
console.warn = () => {};
console.error = () => {};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

for (const [path, fetchRows] of [["list", list], ["filtered export", exported], ["export all", exported]]) {
  const filters = path === "export all" ? [] : path === "filtered export" ? [["and", "(created_at.gte.2026-01-01T00:00:00.000Z)"]] : [];
  test(`municipality_admin gets no staff rows: ${path}`, async () => {
    const out = await fetchRows("t-muni", filters);
    assert.equal(out.status, 200);
    assert.deepEqual(out.rows.filter(r => r.entity_type !== "report"), [], "zero rows with an entity_type other than report");
    assert.doesNotMatch(out.text, LEAKS, "no staff action, email, role change or designation");
  });
  test(`municipality_admin still gets their own municipality's report rows, none from another: ${path}`, async () => {
    const out = await fetchRows("t-muni", filters);
    assert.equal(out.rows.length, REPORTS_M1);
    assert.equal(out.total, REPORTS_M1);
    assert.doesNotMatch(out.text, /other@example\.test/);
    if (path === "list") assert.ok(out.rows.every(r => r.municipality_id === M1));
  });
  test(`super_admin still gets staff rows: ${path}`, async () => {
    const out = await fetchRows("t-super", filters);
    assert.equal(out.total, AUDIT.length, "everything, as before");
    for (const action of ["staff_created", "staff_changed", "staff_deleted", "staff_account_deactivated"]) assert.match(out.text, new RegExp(action));
    assert.match(out.text, /second\.admin@example\.test/);
  });
  test(`anon gets 401: ${path}`, async () => assert.equal((await fetchRows(undefined, filters)).status, 401));
}

// Every way the page's filters (and a hand-made request) could ask for staff rows.
const REACH = {
  'Done by "system"': [["actor_email", "ilike.*system*"]],
  "Done by a super admin's email": [["actor_email", "ilike.*owner@example.test*"]],
  "Action staff_created": [["action", "eq.staff_created"]],
  "Action staff_account_deactivated": [["action", "eq.staff_account_deactivated"]],
  "Action in a list of staff actions": [["action", "in.(staff_created,staff_changed,staff_deleted,staff_account_deactivated)"]],
  "Action and Done by together": [["action", "eq.staff_changed"], ["actor_email", "ilike.*system*"]],
  "entity_type staff_profile": [["entity_type", "eq.staff_profile"]],
  "entity_type staff_member": [["entity_type", "eq.staff_member"]],
  "entity_type not report": [["entity_type", "neq.report"]],
  "entity_type in a list": [["entity_type", "in.(report,staff_profile,staff_member)"]],
  "an or over entity_type": [["or", "(entity_type.eq.staff_profile,entity_type.eq.staff_member,entity_type.eq.report)"]],
  "an and over entity_type": [["and", "(entity_type.eq.staff_member)"]],
  "a future staff event type": [["entity_type", "eq.staff_invite"]],
};
for (const [name, filters] of Object.entries(REACH)) {
  test(`municipality_admin cannot reach staff rows with ${name}`, async () => {
    for (const [path, fetchRows] of [["list", list], ["export", exported]]) {
      // or=, neq and in are not filters the export accepts at all (400); the proxy takes them and the scope still holds
      const out = await fetchRows("t-muni", filters);
      assert.ok(out.status === 200 || (path === "export" && out.status === 400), `${path}: ${out.status}`);
      if (out.status !== 200) continue;
      assert.deepEqual(out.rows.filter(r => r.entity_type !== "report"), [], `${path}: only report rows`);
      assert.doesNotMatch(out.text.replace(/^.*\r\n/, ""), LEAKS, path);
    }
  });
}
test('Done by "system" and Done by a super admin still return the report rows they wrote', async () => {
  assert.equal((await list("t-muni", REACH['Done by "system"'])).total, 1);
  assert.equal((await exported("t-muni", REACH['Done by "system"'])).total, 1);
  assert.equal((await list("t-muni", REACH["Done by a super admin's email"])).total, 1);
});
test("the request Supabase receives carries the server's own entity_type and municipality_id, last", async () => {
  const { authorize } = await import("./access.js");
  const MUNI = { role: "municipality_admin", userId: U_MUNI, municipalityId: M1 };
  const SUPER = { role: "super_admin", userId: U_SUPER, municipalityId: null };
  const q = new URLSearchParams(authorize(MUNI, { path: "/rest/v1/audit_log?select=id&entity_type=eq.staff_member", method: "GET" }).path.split("?")[1]);
  assert.deepEqual(q.getAll("entity_type"), ["eq.staff_member", "eq.report"]);
  assert.deepEqual(q.getAll("municipality_id"), [`eq.${M1}`]);
  assert.deepEqual(new URLSearchParams(authorize(SUPER, { path: "/rest/v1/audit_log?select=id", method: "GET" }).path.split("?")[1]).getAll("entity_type"), [], "a super admin is not narrowed");
  // the history of one report, as the report page asks for it, still works
  assert.deepEqual(new URLSearchParams(authorize(MUNI, { path: "/rest/v1/audit_log?select=id&entity_type=eq.report&entity_id=eq.r1", method: "GET" }).path.split("?")[1]).getAll("entity_type"), ["eq.report", "eq.report"]);
});
test("export all keeps the 10,000 row cap, and the capped file has no staff rows", async () => {
  bulk = MAX_ROWS + 5;
  const out = await exported("t-muni");
  bulk = 0;
  assert.equal(out.rows.length, MAX_ROWS);
  assert.equal(out.headers["X-Truncated"], "true");
  assert.equal(out.total, MAX_ROWS + 5 + REPORTS_M1, "the total counts report rows only");
  assert.deepEqual(out.rows.filter(r => r.entity_type !== "report"), []);
  assert.equal(reads, 10, "ten reads of a thousand");
});
test("the fixture holds the rows from the bug report", () => {
  assert.equal(NOT_REPORTS_M1, 7);
  assert.equal(AUDIT.filter(r => r.entity_type === "staff_profile").length, 4);
  assert.equal(AUDIT.filter(r => r.entity_type === "staff_member").length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok    ${name}`); } catch (error) { failed++; console.log(`  FAIL  ${name}\n        ${String(error.message).split("\n")[0]}`); }
}
console.warn = origWarn;
console.error = origError;
globalThis.fetch = realFetch;
if (failed) { console.log(`audit scope: ${failed} of ${tests.length} failed`); process.exit(1); }
console.log(`audit scope ok (${tests.length} tests)`);
