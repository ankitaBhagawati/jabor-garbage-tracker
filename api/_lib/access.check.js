// Tests for the admin proxy's access rules: `node api/_lib/access.check.js`
// Part 1 checks the rules directly (every role, table and operation, and filter smuggling).
// Part 2 runs the real handlers with a stubbed Supabase: role lookup, forged claims, deactivation, logging.
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon-key-for-tests";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";

const { Denied, authorize, summary } = await import("./access.js");
const { deriveStaff } = await import("./staff.js");

const M1 = "11111111-1111-4111-8111-111111111111"; // the municipality admin's own municipality
const M2 = "22222222-2222-4222-8222-222222222222"; // another municipality
const U_SUPER = "aaaaaaaa-0000-4000-8000-000000000001";
const U_MUNI = "aaaaaaaa-0000-4000-8000-000000000002";
const ID = "33333333-3333-4333-8333-333333333333";
const SUPER = { role: "super_admin", userId: U_SUPER, municipalityId: null };
const MUNI = { role: "municipality_admin", userId: U_MUNI, municipalityId: M1 };

const get = (staff, path, prefer) => authorize(staff, { path, method: "GET", prefer });
const patch = (staff, path, body, prefer) => authorize(staff, { path, method: "PATCH", prefer, body });
function refused(fn, reason) {
  try { fn(); } catch (error) {
    assert.ok(error instanceof Denied, `expected a denial, got ${error}`);
    if (reason) assert.equal(error.reason, reason);
    return;
  }
  assert.fail("expected the request to be denied");
}
const query = plan => new URLSearchParams(plan.path.split("?")[1]);

// ── Part 1a: role x table x operation ────────────────────────────────────────
const EXPECTED = {
  super_admin: { reports: "select,update", cleanup_proofs: "select", report_contacts: "select", audit_log: "select", wards: "select", ward_localities: "select", municipalities: "select", staff_profiles: "select" },
  municipality_admin: { reports: "select,update", cleanup_proofs: "select", audit_log: "select", wards: "select", municipalities: "select", staff_profiles: "select" },
};
const SELECT = {
  reports: "id,status,ward_id", cleanup_proofs: "*,reports!inner(id)", report_contacts: "report_id,name", audit_log: "action,created_at", wards: "id,number",
  ward_localities: "id,name", municipalities: "id,name", staff_profiles: "user_id,role",
};
const PATCH_BODY = { reports: { admin_note: "x" }, cleanup_proofs: { status: "approved" } };
const ALL_TABLES = [...Object.keys(SELECT), "authority_contacts", "escalation_guidelines", "recommendations_audit", "mla_list", "mp_list", "constituencies", "report_activity", "audit_logs", "users"];
let cells = 0;
for (const [role, staff] of [["super_admin", SUPER], ["municipality_admin", MUNI]]) {
  for (const table of ALL_TABLES) {
    const ops = (EXPECTED[role][table] || "").split(",").filter(Boolean);
    const cases = {
      select: () => get(staff, `/rest/v1/${table}?select=${SELECT[table] || "id"}&limit=5`),
      update: () => patch(staff, `/rest/v1/${table}?id=eq.${ID}`, PATCH_BODY[table] || { status: "approved" }),
      insert: () => authorize(staff, { path: `/rest/v1/${table}`, method: "POST", body: { id: ID } }),
      delete: () => authorize(staff, { path: `/rest/v1/${table}?id=eq.${ID}`, method: "DELETE" }),
    };
    for (const [op, run] of Object.entries(cases)) {
      cells++;
      if (ops.includes(op)) assert.doesNotThrow(run, `${role} ${op} ${table} should be allowed`);
      else refused(run); // a denial for the right reason is checked below
    }
  }
}
// Denied cells fail because of policy, not because the sample was malformed.
for (const [staff, table, op] of [[MUNI, "report_contacts", "select"], [SUPER, "cleanup_proofs", "update"], [MUNI, "cleanup_proofs", "update"], [MUNI, "ward_localities", "select"], [SUPER, "authority_contacts", "select"], [MUNI, "wards", "update"], [SUPER, "reports", "insert"], [SUPER, "reports", "delete"]]) {
  const request = op === "select" ? { path: `/rest/v1/${table}?select=id&limit=1`, method: "GET" } : { path: `/rest/v1/${table}?id=eq.${ID}`, method: op === "insert" ? "POST" : op === "delete" ? "DELETE" : "PATCH", body: { name: "x" } };
  try { authorize(staff, request); assert.fail("allowed"); } catch (e) { assert.ok(["table", "operation"].includes(e.reason), `${table} ${op}: ${e.reason}`); }
}
assert.equal(cells, 2 * ALL_TABLES.length * 4);
// The summary the docs quote.
for (const [role, tables] of Object.entries(EXPECTED)) {
  for (const [table, ops] of Object.entries(tables)) assert.deepEqual(summary(role)[table], ops.split(","));
  assert.deepEqual(Object.keys(summary(role)).filter(k => k !== "functions" && k !== "rpc").sort(), Object.keys(tables).sort());
}

// ── Part 1b: scope is added by the server ────────────────────────────────────
const scoped = (staff, table, select, key, value) => {
  const q = query(get(staff, `/rest/v1/${table}?select=${select}&limit=1`));
  assert.deepEqual(q.getAll(key), value ? [`eq.${value}`] : [], `${table}: ${key}`);
};
scoped(MUNI, "reports", "id", "municipality_id", M1);
scoped(MUNI, "audit_log", "action", "municipality_id", M1);
scoped(MUNI, "wards", "id", "municipality_id", M1);
scoped(MUNI, "municipalities", "id", "id", M1);
scoped(MUNI, "staff_profiles", "user_id", "user_id", U_MUNI);
scoped(SUPER, "reports", "id", "municipality_id", null);
scoped(SUPER, "audit_log", "action", "municipality_id", null);
assert.deepEqual(query(patch(MUNI, `/rest/v1/reports?id=eq.${ID}`, { status: "in_progress" })).getAll("municipality_id"), [`eq.${M1}`], "a municipality admin's update is scoped too");
assert.equal(get(MUNI, "/rest/v1/reports?select=id").path.includes("limit=1000"), true, "a default row cap is added");
assert.equal(query(get(SUPER, "/rest/v1/reports?select=id&municipality_id=eq." + M2)).get("municipality_id"), `eq.${M2}`, "a super admin may choose a municipality");

// ── Part 1c: smuggling ───────────────────────────────────────────────────────
const R = "/rest/v1/reports?select=id&";
// scope keys: the client may not send them, in any spelling
for (const key of ["municipality_id", "municipality%5Fid"]) refused(() => get(MUNI, `${R}${key}=eq.${M2}`), "scope-key");
refused(() => get(MUNI, `${R}municipality_id=eq.${M1}&municipality_id=eq.${M2}`), "scope-key");
refused(() => get(SUPER, `${R}municipality_id=eq.${M1}&municipality_id=eq.${M2}`), "duplicate-key");
refused(() => get(MUNI, `${R}municipality%255Fid=eq.${M2}`), "param-key");
refused(() => get(MUNI, `${R}Municipality_Id=eq.${M2}`), "param-key");
refused(() => get(MUNI, `/rest/v1/municipalities?select=id&id=eq.${M2}`), "scope-key");
refused(() => get(MUNI, `/rest/v1/staff_profiles?select=user_id&user_id=eq.${U_SUPER}`), "scope-key");
refused(() => get(MUNI, `/rest/v1/audit_log?select=id&municipality_id=eq.${M2}`), "scope-key");
refused(() => get(MUNI, `/rest/v1/wards?select=id&municipality_id=eq.${M2}`), "scope-key");
// duplicates and unknown keys
refused(() => get(MUNI, `${R}status=eq.active&status=eq.cleaned`), "duplicate-key");
refused(() => get(MUNI, `${R}select=id`), "duplicate-key");
for (const key of ["foo", "reports.status", "columns", "on_conflict", "Prefer", "apikey", "id.eq"]) refused(() => get(MUNI, `${R}${key}=x`), "param-key");
// or= and and=: a column the role may not filter by anywhere inside denies the whole thing
refused(() => get(MUNI, `${R}or=(municipality_id.eq.${M2},status.eq.active)`), "logic-column");
refused(() => get(MUNI, `${R}or=(status.eq.active,and(municipality_id.eq.${M2},status.eq.x))`), "logic-column");
refused(() => get(MUNI, `${R}and=(status.eq.active,or(status.eq.x,not.or(municipality_id.eq.${M2})))`), "logic-column");
refused(() => get(MUNI, `${R}or=(municipality_id.not.eq.${M1})`), "logic-column");
refused(() => get(MUNI, `${R}or=(embedding.eq.1)`), "logic-column");
refused(() => get(MUNI, `${R}or=status.eq.active`), "logic-syntax");
refused(() => get(MUNI, `${R}or=(status.eq.active`), "logic-syntax");
refused(() => get(MUNI, `${R}or=(status.eq.active))`), "filter-syntax");
refused(() => get(MUNI, `${R}or=(status)`), "logic-column");
refused(() => get(MUNI, `${R}or=(a.eq.1,a.eq.2,a.eq.3,a.eq.4,a.eq.5,a.eq.6,a.eq.7,a.eq.8,a.eq.9,a.eq.10,a.eq.11,a.eq.12,a.eq.13,a.eq.14,a.eq.15,a.eq.16,a.eq.17,a.eq.18,a.eq.19,a.eq.20,a.eq.21)`), "logic-size");
refused(() => get(MUNI, `${R}and=(or(or(or(or(status.eq.a)))))`), "logic-syntax");
refused(() => get(MUNI, `${R}status=eq.a,municipality_id.eq.${M2}&select=id`), "duplicate-key");
for (const value of ["active", "gt", "fts.word", "plfts.word", "cs.{a}", "eq", "wfts.x"]) refused(() => get(MUNI, `${R}status=${value}`), "filter-value");
// allowed filters still work
for (const q of ["status=eq.active", "status=in.(active,in_progress)", "status=not.eq.cleaned", "ward_id=is.null", `ward_id=eq.${ID}`, "area=ilike.*market*", `or=(area.ilike."*a,b*",landmark.ilike.*x*)`,
  "and=(created_at.gte.2026-01-01,created_at.lte.2026-02-01)", "or=(status.eq.active,and(status.eq.cleaned,ward_id.is.null))", "description=ilike.*a%20b*"]) {
  assert.doesNotThrow(() => get(MUNI, `${R}${q}`), q);
}
// select: explicit columns only; no embeds, no star, nothing outside the readable set
refused(() => get(MUNI, "/rest/v1/reports?select=*"), "select-star");
refused(() => get(MUNI, "/rest/v1/reports?select=*,report_contacts(*)"), "select-star");
refused(() => get(MUNI, "/rest/v1/reports?select=id,report_contacts(*)"), "select-embed");
refused(() => get(MUNI, "/rest/v1/reports?select=id,contacts:report_contacts(name,email)"), "select-embed");
refused(() => get(MUNI, "/rest/v1/reports?select=id,report_contacts!inner(email)"), "select-embed");
refused(() => get(MUNI, "/rest/v1/reports?select=id,wards(*)"), "select-embed");
refused(() => get(SUPER, "/rest/v1/reports?select=id,report_contacts(*)"), "select-embed");
refused(() => get(MUNI, "/rest/v1/reports?select=id,embedding"), "select-column");
refused(() => get(MUNI, "/rest/v1/reports?select=id,admin_note->x"), "select-embed");
refused(() => get(MUNI, "/rest/v1/reports?select=id::text"), "select-embed");
refused(() => get(MUNI, "/rest/v1/reports?select=id,((("), "filter-syntax");
refused(() => get(MUNI, "/rest/v1/reports?limit=5"), "select-required");
refused(() => get(SUPER, "/rest/v1/cleanup_proofs?select=*,report_contacts(*)"), "select-embed");
refused(() => get(SUPER, "/rest/v1/cleanup_proofs?select=*,reports(id,embedding)"), "select-embed-column");
refused(() => get(SUPER, "/rest/v1/cleanup_proofs?select=*,reports(*)"), "select-embed-column");
// order, limit, offset
refused(() => get(MUNI, `${R}order=embedding`), "order-column");
refused(() => get(MUNI, `${R}order=municipality_id.desc`), "order-column");
refused(() => get(MUNI, `${R}order=created_at,created_at.desc`), "order-column");
refused(() => get(MUNI, `${R}order=created_at;drop`), "order-column");
refused(() => get(MUNI, `${R}order=a,b,c,d`), "order-size");
assert.doesNotThrow(() => get(MUNI, `${R}order=created_at.desc.nullslast,id`));
for (const limit of ["0", "-1", "1001", "abc", "1e3", "", "10000"]) refused(() => get(MUNI, `${R}limit=${limit}`), "limit");
for (const offset of ["-1", "abc", "1.5", "9999999"]) refused(() => get(MUNI, `${R}offset=${offset}`), "offset");
assert.doesNotThrow(() => get(MUNI, `${R}limit=25&offset=50`));
// paths
for (const path of ["/rest/v1/reports/../report_contacts?select=id", "/rest/v1/rpc/auto_clean_old_reports", "/rest/v1/reports%2Freport_contacts?select=id", " /rest/v1/reports?select=id", "//rest/v1/reports?select=id",
  "/rest/v1/Reports?select=id", "/rest/v1/reports?select=id#x", "/rest/v1/reports/?select=id", "/rest/v1/?select=id", "/rest/v1", "/auth/v1/admin/users", "/storage/v1/object/list/x", "/rest/v1/reports\\?select=id", "rest/v1/reports?select=id", "http://evil.test/rest/v1/reports?select=id"]) {
  refused(() => get(SUPER, path));
}
refused(() => authorize(SUPER, { path: 5, method: "GET" }), "path");
refused(() => authorize(SUPER, { path: "/rest/v1/reports?select=id&limit=%E0%A4%A", method: "GET" }), "encoding");
// methods
for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS", "get", "TRACE", undefined]) {
  refused(() => authorize(SUPER, { path: "/rest/v1/reports?select=id", method }));
}
refused(() => authorize(SUPER, { path: "/rest/v1/reports?select=id", method: "GET", body: { a: 1 } }), "body-on-read");
// Prefer
for (const prefer of ["resolution=merge-duplicates", "tx=rollback", "missing=default", "handling=strict", "return=representation,count=exact", "return=headers-only", "params=multiple-objects", "x"]) {
  refused(() => get(SUPER, `${R}limit=1`, prefer), "prefer");
}
for (const prefer of [undefined, null, "return=minimal", "return=representation", "count=exact"]) assert.doesNotThrow(() => get(SUPER, `${R}limit=1`, prefer));
assert.equal(get(SUPER, `${R}limit=1`, null).prefer, null);

// PATCH: one row by id, and only the keys the role may send
const P = `/rest/v1/reports?id=eq.${ID}`;
refused(() => patch(MUNI, "/rest/v1/reports", { admin_note: "x" }), "update-id");
refused(() => patch(MUNI, `/rest/v1/reports?id=in.(${ID},${M2})`, { admin_note: "x" }), "update-id");
refused(() => patch(MUNI, `/rest/v1/reports?id=eq.not-a-uuid`, { admin_note: "x" }), "update-id");
refused(() => patch(MUNI, `/rest/v1/reports?id=neq.${ID}`, { admin_note: "x" }), "update-id");
refused(() => patch(MUNI, `${P}&status=eq.active`, { admin_note: "x" }), "update-filter");
refused(() => patch(MUNI, `${P}&or=(status.eq.active)`, { admin_note: "x" }), "update-filter");
refused(() => patch(MUNI, `${P}&municipality_id=eq.${M2}`, { admin_note: "x" }), "scope-key");
refused(() => patch(MUNI, `${P}&limit=1`, { admin_note: "x" }), "limit");
for (const key of ["municipality_id", "photo_url", "lat", "lng", "source", "cleaned_marked_by", "cleaned_marked_at", "assigned_to_text", "due_at", "updated_at", "created_at", "embedding", "id", "district", "description", "claimed_in_municipality", "in_municipality"]) {
  refused(() => patch(MUNI, P, { [key]: "x" }), "body-key");
}
refused(() => patch(MUNI, P, { admin_note: "x", municipality_id: M2 }), "body-key");
refused(() => patch(MUNI, P, {}), "body-key");
refused(() => patch(MUNI, P, [{ admin_note: "x" }]), "body-shape");
refused(() => patch(MUNI, P, "admin_note=x"), "body-shape");
refused(() => patch(MUNI, P, null), "body-shape");
refused(() => patch(MUNI, P, { admin_note: { a: 1 } }), "body-value");
refused(() => patch(MUNI, P, { admin_note: ["x"] }), "body-value");
refused(() => patch(MUNI, P, { admin_note: "x".repeat(2001) }), "body-value");
for (const status of ["rejected", "verified", "auto", "hidden", "", 5]) refused(() => patch(MUNI, P, { status }), "body-status");
refused(() => patch(MUNI, P, { status: "cleaned", cleaned_by_type: "auto" }), "body-cleaned-by");
refused(() => patch(MUNI, P, { ward_id: "7" }), "body-ward");
for (const body of [{ status: "in_progress" }, { status: "active", admin_note: "Restored" }, { ward_id: ID }, { ward_id: null }, { admin_note: "A note" },
  { status: "cleaned", cleaned_by_name: "JMB team", cleaned_by_type: "jmb", cleaned_at: "2026-10-10T00:00:00Z" }, { status: "invalid", invalid_reason: "spam", admin_note: "Spam" }]) {
  assert.doesNotThrow(() => patch(MUNI, P, body, "return=representation"), JSON.stringify(body));
}
// a municipality admin may hide and unhide (a soft hide), with a reason and a note, and nothing else rides along
assert.doesNotThrow(() => patch(MUNI, P, { is_deleted: true, invalid_reason: "spam", admin_note: "Not a real report" }, "return=representation"));
assert.doesNotThrow(() => patch(MUNI, P, { is_deleted: false, invalid_reason: null, admin_note: "Hidden by mistake" }, "return=representation"));
assert.doesNotThrow(() => patch(MUNI, P, { is_deleted: true }));
for (const value of ["true", 1, 0, null, "", [true], { a: 1 }]) refused(() => patch(MUNI, P, { is_deleted: value }));
for (const value of ["true", 1, null]) refused(() => patch(SUPER, P, { is_deleted: value }));
refused(() => patch(MUNI, P, { is_deleted: true, municipality_id: M2 }), "body-key");
refused(() => patch(MUNI, P, { is_deleted: true, updated_at: "2026-10-10T00:00:00Z" }), "body-key");
refused(() => patch(MUNI, `${P}&municipality_id=eq.${M2}`, { is_deleted: true }), "scope-key");
refused(() => authorize(MUNI, { path: P, method: "DELETE" }), "operation");
// a super admin may hide and restore, but not set the system stamps or another table's columns
assert.doesNotThrow(() => patch(SUPER, P, { is_deleted: true, updated_at: "2026-10-10T00:00:00Z" }, "return=minimal"));
for (const key of ["cleaned_marked_by", "cleaned_marked_at", "municipality_id", "photo_url", "embedding", "source"]) refused(() => patch(SUPER, P, { [key]: "x" }), "body-key");
// cleanup proofs: nobody PATCHes a proof any more; a review is the review_cleanup_proof RPC (below)
for (const staff of [SUPER, MUNI]) {
  refused(() => patch(staff, `/rest/v1/cleanup_proofs?id=eq.${ID}`, { status: "approved" }), "operation");
  refused(() => patch(staff, `/rest/v1/cleanup_proofs?id=eq.${ID}`, { image_url: "x" }), "operation");
}
// a municipality admin lists proofs of their own municipality only: the server filters on the embedded report
{
  const PROOFS = "/rest/v1/cleanup_proofs?select=*,reports!inner(id,municipality_id)&status=eq.pending&order=created_at.desc";
  const q = query(get(MUNI, PROOFS));
  assert.equal(q.get("reports.municipality_id"), `eq.${M1}`);
  assert.equal(q.get("status"), "eq.pending");
  // a super admin is not narrowed
  assert.equal(query(get(SUPER, PROOFS)).get("reports.municipality_id"), null);
  // without the inner join the filter would only blank the embed, not drop the row
  refused(() => get(MUNI, "/rest/v1/cleanup_proofs?select=*"), "scope-embed");
  refused(() => get(MUNI, "/rest/v1/cleanup_proofs?select=*,reports(id)"), "scope-embed");
  refused(() => get(MUNI, "/rest/v1/cleanup_proofs?select=*,r:reports!inner(id)"), "scope-embed");
  // choosing the municipality, or widening it with or=, is refused
  refused(() => get(MUNI, `${PROOFS}&reports.municipality_id=eq.${M2}`), "scope-key");
  refused(() => get(MUNI, `/rest/v1/cleanup_proofs?select=*,reports!inner(id)&or=(reports.municipality_id.eq.${M2})`), "logic-column");
  refused(() => get(MUNI, `/rest/v1/cleanup_proofs?select=*,reports!inner(id)&municipality_id=eq.${M2}`), "param-key");
}

// edge functions
for (const fn of ["jabor-recommendations", "jabor-execute", "jabor-embed"]) {
  assert.doesNotThrow(() => authorize(SUPER, { path: `/functions/v1/${fn}`, method: "POST", body: { reportId: ID } }), fn);
  refused(() => authorize(MUNI, { path: `/functions/v1/${fn}`, method: "POST", body: {} }), "function");
}
for (const path of ["/functions/v1/jabor-notify", "/functions/v1/other", "/functions/v1/jabor-execute?x=1", "/functions/v1/jabor-execute/extra", "/functions/v1/"]) refused(() => authorize(SUPER, { path, method: "POST", body: {} }));
refused(() => authorize(SUPER, { path: "/functions/v1/jabor-execute", method: "GET" }), "function");
refused(() => authorize(SUPER, { path: "/functions/v1/jabor-execute", method: "POST", body: [1] }), "function-body");
refused(() => authorize(SUPER, { path: "/functions/v1/jabor-execute", method: "POST", body: { a: "x".repeat(100001) } }), "function-body");
refused(() => authorize(SUPER, { path: "/functions/v1/jabor-execute", method: "POST", body: {}, prefer: "return=minimal" }), "prefer");

// database functions (T6/T7): the monthly report and the hotspot ranking
const rpc = (staff, name, body, extra = {}) => authorize(staff, { path: `/rest/v1/rpc/${name}`, method: "POST", body, ...extra });
const M2U = "22222222-2222-4222-8222-222222222222";
for (const [name, args] of [["monthly_ward_report", { p_month: "2026-08-01" }], ["ward_hotspots", { p_days: 30 }]]) {
  // a super admin names the municipality
  const own = rpc(SUPER, name, { ...args, p_municipality: M2U });
  assert.deepEqual([own.path, own.method], [`/rest/v1/rpc/${name}`, "POST"]);
  assert.deepEqual(JSON.parse(own.body), { p_municipality: M2U, ...args });
  // a municipality admin gets their own, added by the server
  const mine = rpc(MUNI, name, args);
  assert.deepEqual(JSON.parse(mine.body), { p_municipality: M1, ...args });
  // smuggling: choosing a municipality, extra keys, missing keys, wrong types, query strings, forged headers
  refused(() => rpc(MUNI, name, { ...args, p_municipality: M2U }), "scope-key");
  refused(() => rpc(MUNI, name, { ...args, p_municipality: M1 }), "scope-key");
  refused(() => rpc(MUNI, name, { ...args, extra: 1 }), "body-key");
  refused(() => rpc(SUPER, name, { ...args, p_municipality: M2U, extra: 1 }), "body-key");
  refused(() => rpc(SUPER, name, args), "body-key"); // a super admin must name the municipality
  refused(() => rpc(SUPER, name, { ...args, p_municipality: "not-a-uuid" }), "rpc-arg");
  refused(() => rpc(SUPER, name, { ...args, p_municipality: `${M2U}' or 1=1` }), "rpc-arg");
  refused(() => rpc(SUPER, name, { ...args, p_municipality: [M2U] }), "rpc-arg");
  refused(() => rpc(MUNI, name, {}), "body-key");
  refused(() => rpc(MUNI, name, [args]), "body-shape");
  refused(() => rpc(MUNI, name, null), "body-shape");
  refused(() => authorize(MUNI, { path: `/rest/v1/rpc/${name}?p_municipality=${M2U}`, method: "POST", body: args }), "rpc");
  refused(() => authorize(MUNI, { path: `/rest/v1/rpc/${name}?select=*`, method: "POST", body: args }), "rpc");
  refused(() => authorize(MUNI, { path: `/rest/v1/rpc/${name}`, method: "GET" }), "rpc");
  refused(() => authorize(MUNI, { path: `/rest/v1/rpc/${name}`, method: "PATCH", body: args }), "rpc");
  refused(() => authorize(MUNI, { path: `/rest/v1/rpc/${name}`, method: "DELETE" }), "rpc");
  refused(() => rpc(MUNI, name, args, { prefer: "return=representation" }), "prefer");
  refused(() => rpc(MUNI, name, args, { prefer: "count=exact" }), "prefer");
  refused(() => authorize({ ...MUNI, municipalityId: null }, { path: `/rest/v1/rpc/${name}`, method: "POST", body: args }), "scope-missing");
  refused(() => authorize({ ...MUNI, municipalityId: "x" }, { path: `/rest/v1/rpc/${name}`, method: "POST", body: args }), "scope-missing");
}
for (const bad of ["2026-08-02", "2026-8-01", "2026-13-01", "2026-00-01", "2019-08-01", "2026-08-01T00:00:00", "'2026-08-01", 202608, null, undefined, ["2026-08-01"]]) {
  refused(() => rpc(MUNI, "monthly_ward_report", { p_month: bad }), "rpc-arg");
}
for (const bad of [45, 0, -30, 31, "30", 30.5, null, undefined, [30], 3e1 + 0.1, 90000]) refused(() => rpc(MUNI, "ward_hotspots", { p_days: bad }), "rpc-arg");
for (const days of [30, 60, 90]) assert.doesNotThrow(() => rpc(MUNI, "ward_hotspots", { p_days: days }));
// only the two functions exist, and similar names, other schemas and the private helpers are not routes
for (const path of ["/rest/v1/rpc/auto_clean_old_reports", "/rest/v1/rpc/normalize_status", "/rest/v1/rpc/is_super_admin", "/rest/v1/rpc/monthly_ward_report2", "/rest/v1/rpc/",
  "/rest/v1/rpc/MONTHLY_WARD_REPORT", "/rest/v1/rpc/monthly_ward_report/x", "/rest/v1/rpc/..%2Frpc%2Fward_hotspots", "/rest/v1/rpc/ward_hotspots%00", "/rest/v1//rpc/ward_hotspots"]) {
  for (const staff of [SUPER, MUNI]) refused(() => authorize(staff, { path, method: "POST", body: { p_days: 30, p_municipality: M2U } }));
}
// the two roles' view of the allowlist
assert.deepEqual(summary("super_admin").rpc, ["review_cleanup_proof", "monthly_ward_report", "ward_hotspots"]);
assert.deepEqual(summary("municipality_admin").rpc, ["review_cleanup_proof", "monthly_ward_report", "ward_hotspots"]);

// cleanup proof review: a municipality admin's municipality is the server's; a super admin names the report's
{
  const review = { p_proof: ID, p_decision: "approved", p_note: null };
  assert.deepEqual(JSON.parse(rpc(MUNI, "review_cleanup_proof", review).body), { p_municipality: M1, ...review });
  assert.deepEqual(JSON.parse(rpc(MUNI, "review_cleanup_proof", { ...review, p_decision: "rejected", p_note: "blurry" }).body), { p_municipality: M1, ...review, p_decision: "rejected", p_note: "blurry" });
  refused(() => rpc(MUNI, "review_cleanup_proof", { ...review, p_municipality: M2 }), "scope-key");
  refused(() => rpc(MUNI, "review_cleanup_proof", { ...review, p_municipality: null }), "scope-key");
  refused(() => authorize({ ...MUNI, municipalityId: null }, { path: "/rest/v1/rpc/review_cleanup_proof", method: "POST", body: review }), "scope-missing");
  assert.deepEqual(JSON.parse(rpc(SUPER, "review_cleanup_proof", { ...review, p_municipality: M2 }).body), { p_municipality: M2, ...review });
  assert.deepEqual(JSON.parse(rpc(SUPER, "review_cleanup_proof", { ...review, p_municipality: null }).body), { p_municipality: null, ...review });
  refused(() => rpc(SUPER, "review_cleanup_proof", review), "body-key");
  for (const bad of ["cleaned", "active", "pending", "", null, ["approved"]]) refused(() => rpc(MUNI, "review_cleanup_proof", { ...review, p_decision: bad }), "rpc-arg");
  for (const bad of ["x", `${ID}'`, null, 1]) refused(() => rpc(MUNI, "review_cleanup_proof", { ...review, p_proof: bad }), "rpc-arg");
  for (const bad of ["x".repeat(2001), 1, { a: 1 }]) refused(() => rpc(MUNI, "review_cleanup_proof", { ...review, p_note: bad }), "rpc-arg");
  refused(() => rpc(MUNI, "review_cleanup_proof", { p_proof: ID, p_decision: "approved" }), "body-key");
  // the report functions still need a named municipality
  for (const name of ["monthly_ward_report", "ward_hotspots"]) refused(() => rpc(SUPER, name, { ...(name === "ward_hotspots" ? { p_days: 30 } : { p_month: "2026-08-01" }), p_municipality: null }), "rpc-arg");
}

// ── Part 1d: everything the current admin screens send is still allowed for a super admin ──
{
  const ids = Array.from({ length: 150 }, (_, i) => `${ID.slice(0, -3)}${String(i).padStart(3, "0")}`);
  const params = o => new URLSearchParams(o).toString();
  const REPORT_SELECT = "id,constituency,district,lok_sabha_seat,mla,mla_party,mp,mp_party,area,landmark,waste_type,description,photo_url,lat,lng,status,assigned_to,rejected_at,is_deleted,created_at,updated_at,tweeted_at,emailed_at";
  for (const path of [
    `/rest/v1/cleanup_proofs?${params({ select: "*,reports!inner(id,photo_url,area,landmark,district,constituency,description,waste_type,mla,mp,created_at,status,municipality_id)", status: "eq.pending", order: "created_at.desc" })}`,
    `/rest/v1/reports?${params({ select: REPORT_SELECT, is_deleted: "eq.false", status: "in.(verified,pending,active,reported,open)", order: "created_at.desc" })}`,
    `/rest/v1/reports?${params({ select: REPORT_SELECT, is_deleted: "eq.false", status: "eq.cleaned", order: "updated_at.desc" })}`,
    `/rest/v1/cleanup_proofs?${params({ select: "report_id,image_url,status,created_at,updated_at", report_id: `in.(${ids.join(",")})`, status: "in.(pending,approved)", order: "updated_at.desc" })}`,
    `/rest/v1/report_contacts?${params({ select: "report_id,name,email", report_id: `in.(${ids.join(",")})` })}`,
    `/rest/v1/reports?${params({ select: "id,photo_url,area,landmark,district,status,is_deleted,invalid_reason,admin_note,created_at,updated_at", or: "(is_deleted.eq.true,status.in.(invalid,rejected))", order: "updated_at.desc" })}`,
    `/rest/v1/audit_log?${params({ select: "entity_id,action,actor_email,to_value,note,created_at", entity_type: "eq.report", entity_id: `in.(${ids.join(",")})`, action: "in.(hidden,status_change)", order: "created_at.desc" })}`,
  ]) assert.doesNotThrow(() => get(SUPER, path), path.slice(0, 80));
  for (const [path, body, prefer] of [
    [`/rest/v1/reports?id=eq.${ID}`, { status: "cleaned", updated_at: "2026-10-10T00:00:00.000Z" }, "return=representation"],
    [`/rest/v1/reports?id=eq.${ID}`, { is_deleted: true, updated_at: "2026-10-10T00:00:00.000Z" }, "return=minimal"],
    [`/rest/v1/reports?id=eq.${ID}`, { is_deleted: false, invalid_reason: null, admin_note: "ok" }, "return=representation"],
    [`/rest/v1/reports?id=eq.${ID}`, { status: "active", admin_note: "Restored from the Hidden tab" }, "return=representation"],
  ]) assert.doesNotThrow(() => patch(SUPER, path, body, prefer));
}

// ── Part 1e: who is staff ────────────────────────────────────────────────────
const user = (role, extra = {}) => ({ id: U_MUNI, email: "a@example.test", app_metadata: { role, ...extra } });
const profile = (role, extra = {}) => ({ user_id: U_MUNI, role, municipality_id: null, is_active: true, municipalities: null, ...extra });
assert.equal(deriveStaff(user("admin"), profile("super_admin")).role, "super_admin", "the older admin role maps to super_admin");
assert.equal(deriveStaff(user("super_admin"), profile("super_admin")).role, "super_admin");
assert.equal(deriveStaff(user("municipality_admin", { municipality_id: M1 }), profile("municipality_admin", { municipality_id: M1, municipalities: { name: "Jorhat", slug: "jorhat" } })).municipalityId, M1);
for (const [u, p] of [
  [user("admin"), null], [user("admin"), profile("super_admin", { is_active: false })], [user("admin"), profile("municipality_admin", { municipality_id: M1 })],
  [user("super_admin"), profile("municipality_admin", { municipality_id: M1 })], [user("municipality_admin", { municipality_id: M1 }), profile("super_admin")],
  [user("municipality_admin", { municipality_id: M2 }), profile("municipality_admin", { municipality_id: M1 })], [user("municipality_admin"), profile("municipality_admin", { municipality_id: M1 })],
  [user("municipality_admin", { municipality_id: M1 }), profile("municipality_admin", { municipality_id: null })], [user("municipality_admin", { municipality_id: "x" }), profile("municipality_admin", { municipality_id: "x" })],
  [user("authenticated"), profile("super_admin")], [user(undefined), profile("super_admin")], [user("service_role"), profile("super_admin")],
  [user("admin"), profile("super_admin", { user_id: U_SUPER })], [{ id: U_MUNI }, profile("super_admin")], [null, profile("super_admin")],
  [user("admin"), profile("super_admin", { is_active: "true" })],
]) assert.equal(deriveStaff(u, p), null);

console.log("proxy rules ok");

// ── Part 2: the real handlers, with Supabase stubbed ─────────────────────────
const { default: restHandler } = await import("../admin/rest.js");
const { default: sessionHandler } = await import("../admin/session.js");
const { default: loginHandler } = await import("../admin/login.js");

const accounts = new Map(); // token -> { user, profile }
let profileLookups = 0, authLookups = 0, upstream = [];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const token = /^Bearer (.+)$/.exec(init.headers?.Authorization || "")?.[1];
  if (url.endsWith("/auth/v1/user")) { authLookups++; const a = accounts.get(token); return a ? json(a.user) : json({ msg: "bad" }, 401); }
  if (url.includes("/rest/v1/staff_profiles?select=user_id,role")) {
    profileLookups++;
    const a = accounts.get(token);
    // RLS: a user sees only their own active row, read with their own token.
    assert.ok(a && url.includes(`user_id=eq.${a.user.id}`), "the profile is read for the caller, with the caller's own token");
    return json(a.profile && a.profile.is_active ? [a.profile] : []);
  }
  if (url.includes("/auth/v1/token?grant_type=password")) {
    const { email, password } = JSON.parse(init.body);
    const found = [...accounts.entries()].find(([, a]) => a.user.email === email);
    if (!found || password !== "right-password") return json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
    return json({ access_token: found[0], refresh_token: "r-" + found[0], expires_in: 3600, user: found[1].user });
  }
  if (url.includes("/auth/v1/logout")) { upstream.push({ url, logout: true }); return json({}); }
  upstream.push({ url, method: init.method, headers: init.headers, body: init.body });
  return json(upstream.next ?? [{ id: ID }], upstream.nextStatus ?? 200, upstream.nextHeaders ?? {});
};
const reset = () => { upstream = []; profileLookups = 0; authLookups = 0; };

function account(token, role, extra = {}, prof = undefined) {
  const id = extra.id || U_MUNI;
  const user = { id, email: `${token}@example.test`, app_metadata: { role, ...(extra.meta || {}) } };
  const profile = prof === undefined ? { user_id: id, role: extra.profileRole || role, municipality_id: extra.municipality ?? null, is_active: true, municipalities: extra.municipality ? { name: "Jorhat Municipal Board", slug: "jorhat" } : null } : prof;
  accounts.set(token, { user, profile });
}
account("t-super", "admin", { id: U_SUPER, profileRole: "super_admin" });
account("t-muni", "municipality_admin", { id: U_MUNI, meta: { municipality_id: M1 }, municipality: M1 });
account("t-muni-forged", "municipality_admin", { id: "aaaaaaaa-0000-4000-8000-000000000003", meta: { municipality_id: M2 }, municipality: M1 });
account("t-inactive", "municipality_admin", { id: "aaaaaaaa-0000-4000-8000-000000000004", meta: { municipality_id: M1 }, municipality: M1 }, { user_id: "aaaaaaaa-0000-4000-8000-000000000004", role: "municipality_admin", municipality_id: M1, is_active: false });
account("t-noprofile", "admin", { id: "aaaaaaaa-0000-4000-8000-000000000005" }, null);
account("t-super-claim-muni-row", "super_admin", { id: "aaaaaaaa-0000-4000-8000-000000000006", profileRole: "municipality_admin", municipality: M1 });
account("t-muni-claim-super-row", "municipality_admin", { id: "aaaaaaaa-0000-4000-8000-000000000007", meta: { municipality_id: M1 }, profileRole: "super_admin" });
account("t-plain", "authenticated", { id: "aaaaaaaa-0000-4000-8000-000000000008", profileRole: "super_admin" });

const makeRes = () => {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  res.end = text => { res.body = text; return res; };
  return res;
};
const call = async (handler, { token, method = "POST", body = {}, headers = {}, ip = "9.9.9.9" } = {}) => {
  const req = { method, headers: { host: "jabor.in", origin: "https://jabor.in", "x-forwarded-for": ip, ...(token ? { cookie: `jabor_at=${token}` } : {}), ...headers }, socket: {}, body };
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() : res.body, headers: res.headers, raw: res.body };
};
const proxy = (token, envelope, extra = {}) => call(restHandler, { token, body: envelope, ...extra });
const dataCalls = () => upstream.filter(u => !u.logout);
const origError = console.error, origWarn = console.warn;
const logs = [];
console.warn = (...a) => logs.push(a.join(" "));
console.error = () => {};

// signed out, bad token
reset();
assert.equal((await proxy(undefined, { path: "/rest/v1/reports?select=id" })).status, 401);
assert.equal((await proxy("t-nobody", { path: "/rest/v1/reports?select=id" })).status, 401);
assert.equal(dataCalls().length, 0);

// a super admin with the older admin role works, with their own token and the anon key
reset();
let out = await proxy("t-super", { path: "/rest/v1/reports?select=id,status&limit=5", method: "GET" });
assert.equal(out.status, 200);
assert.equal(dataCalls().length, 1);
assert.equal(dataCalls()[0].headers.Authorization, "Bearer t-super");
assert.equal(dataCalls()[0].headers.apikey, "anon-key-for-tests");
assert.ok(!dataCalls()[0].url.includes("municipality_id"));

// a municipality admin is scoped by the profile, whatever the token says
reset();
out = await proxy("t-muni", { path: "/rest/v1/reports?select=id&status=eq.active", method: "GET" });
assert.equal(out.status, 200);
const sent = new URL(dataCalls()[0].url).searchParams;
assert.deepEqual(sent.getAll("municipality_id"), [`eq.${M1}`]);
reset();
out = await proxy("t-muni-forged", { path: "/rest/v1/reports?select=id", method: "GET" });
assert.equal(out.status, 403, "the token's municipality claim must match the profile");
assert.equal(dataCalls().length, 0);

// denied states: inactive, no profile, mismatched or unknown roles
for (const token of ["t-inactive", "t-noprofile", "t-super-claim-muni-row", "t-muni-claim-super-row", "t-plain"]) {
  reset();
  out = await proxy(token, { path: "/rest/v1/reports?select=id", method: "GET" });
  assert.equal(out.status, 403, token);
  assert.equal(dataCalls().length, 0, token);
  assert.match(String(out.headers["Set-Cookie"]), /Max-Age=0/, `${token}: the session cookies are cleared`);
}

// no caching: a deactivation applies to the next request
reset();
account("t-flip", "municipality_admin", { id: "aaaaaaaa-0000-4000-8000-000000000009", meta: { municipality_id: M1 }, municipality: M1 });
assert.equal((await proxy("t-flip", { path: "/rest/v1/reports?select=id", method: "GET" })).status, 200);
assert.equal((await proxy("t-flip", { path: "/rest/v1/reports?select=id", method: "GET" })).status, 200);
assert.equal(profileLookups, 2, "the profile is read on every request");
assert.equal(authLookups, 2, "the token is verified on every request");
accounts.get("t-flip").profile.is_active = false;
out = await proxy("t-flip", { path: "/rest/v1/reports?select=id", method: "GET" });
assert.equal(out.status, 403, "deactivated staff are refused on the very next request, with a still-valid token");
accounts.get("t-flip").profile.is_active = true;
assert.equal((await proxy("t-flip", { path: "/rest/v1/reports?select=id", method: "GET" })).status, 200, "and can be reactivated");

// forged inputs: an extra envelope key, Range and other headers, Prefer, and role claims in the body
for (const envelope of [
  { path: "/rest/v1/reports?select=id", role: "super_admin" }, { path: "/rest/v1/reports?select=id", municipality_id: M2 }, { path: "/rest/v1/reports?select=id", headers: { Range: "0-9" } },
  { path: "/rest/v1/reports?select=id", range: "0-999" }, [], "path", null, { path: "/rest/v1/reports?select=id", method: 5 }, { path: "/rest/v1/reports?select=id", prefer: ["return=minimal"] },
]) {
  reset();
  out = await proxy("t-muni", envelope);
  assert.equal(out.status, 400, JSON.stringify(envelope));
  assert.equal(dataCalls().length, 0);
}
reset();
out = await proxy("t-muni", { path: "/rest/v1/reports?select=id", method: "GET" }, { headers: { range: "0-99999", "range-unit": "items", prefer: "resolution=merge-duplicates", "x-role": "super_admin", "x-municipality-id": M2, "content-profile": "private" } });
assert.equal(out.status, 200);
assert.deepEqual(Object.keys(dataCalls()[0].headers).sort(), ["Authorization", "Content-Type", "apikey"], "no client header reaches Supabase");
reset();
out = await proxy("t-muni", { path: "/rest/v1/reports?select=id", method: "GET", prefer: "return=representation" });
assert.equal(dataCalls()[0].headers.Prefer, "return=representation");
reset();
out = await proxy("t-muni", { path: "/rest/v1/reports?select=id", method: "GET", prefer: "resolution=merge-duplicates" });
assert.equal(out.status, 403);

// the smuggling attempts, through the handler: nothing reaches Supabase
for (const envelope of [
  { path: `/rest/v1/reports?select=id&municipality_id=eq.${M2}`, method: "GET" },
  { path: `/rest/v1/reports?select=id&or=(municipality_id.eq.${M2},status.eq.active)`, method: "GET" },
  { path: "/rest/v1/reports?select=*,report_contacts(*)", method: "GET" },
  { path: "/rest/v1/report_contacts?select=email", method: "GET" },
  { path: "/rest/v1/authority_contacts?select=email", method: "GET" },
  { path: "/rest/v1/cleanup_proofs?select=*", method: "GET" },
  { path: "/rest/v1/ward_localities?select=name", method: "GET" },
  { path: `/rest/v1/reports?id=eq.${ID}`, method: "DELETE" },
  { path: `/rest/v1/reports?id=eq.${ID}`, method: "PATCH", body: { municipality_id: M2 } },
  { path: `/rest/v1/reports?id=eq.${ID}`, method: "PATCH", body: { is_deleted: "true" } },
  { path: `/functions/v1/jabor-execute`, method: "POST", body: { reportId: ID } },
  { path: `/functions/v1/jabor-notify`, method: "POST", body: {} },
]) {
  reset();
  out = await proxy("t-muni", envelope);
  assert.equal(out.status, 403, JSON.stringify(envelope));
  assert.deepEqual(out.body, { error: "Not allowed." });
  assert.equal(dataCalls().length, 0);
}

// a super admin can call the edge functions, with their own token
reset();
out = await proxy("t-super", { path: "/functions/v1/jabor-recommendations", method: "POST", body: { reportId: ID } });
assert.equal(out.status, 200);
assert.equal(dataCalls()[0].url, "http://supabase.test/functions/v1/jabor-recommendations");
assert.equal(dataCalls()[0].headers.Authorization, "Bearer t-super");

// denials are logged with who, role and route, never the query or the body
logs.length = 0;
await proxy("t-muni", { path: "/rest/v1/report_contacts?select=email&report_id=in.(SECRETQUERYMARKER)", method: "GET" });
await proxy("t-muni", { path: `/rest/v1/reports?id=eq.${ID}`, method: "PATCH", body: { photo_url: "SECRETBODYMARKER" } });
assert.equal(logs.length, 2);
assert.match(logs[0], new RegExp(`user=${U_MUNI} role=municipality_admin route="GET /rest/v1/report_contacts" reason=operation`));
assert.match(logs[1], /route="PATCH \/rest\/v1\/reports" reason=body-key/);
assert.ok(!logs.join("\n").match(/SECRET(QUERY|BODY)MARKER|report_id=in|photo_url/), "no payload in the log");

// Supabase errors keep code and message, drop details and hints; Content-Range is passed on
reset();
upstream.next = { code: "23514", message: "Marking a report cleaned needs who cleaned it, the type and the date.", details: "Failing row contains (secret)", hint: "internal hint" };
upstream.nextStatus = 400;
out = await proxy("t-muni", { path: `/rest/v1/reports?id=eq.${ID}`, method: "PATCH", body: { status: "cleaned" } });
assert.equal(out.status, 400);
assert.deepEqual(out.body, { code: "23514", message: "Marking a report cleaned needs who cleaned it, the type and the date." });
reset();
upstream.nextHeaders = { "Content-Range": "0-24/137" };
out = await proxy("t-muni", { path: "/rest/v1/reports?select=id&limit=25", method: "GET", prefer: "count=exact" });
assert.equal(out.headers["Content-Range"], "0-24/137");

// ── sign-in and session ──────────────────────────────────────────────────────
reset();
out = await call(loginHandler, { body: { email: "t-muni@example.test", password: "right-password" }, ip: "1.1.1.1" });
assert.equal(out.status, 200);
assert.deepEqual(out.body, { email: "t-muni@example.test", role: "municipality_admin", municipality: { name: "Jorhat Municipal Board", slug: "jorhat" } });
assert.match(out.headers["Set-Cookie"].join("\n"), /jabor_at=t-muni; Path=\/api\/admin; HttpOnly; SameSite=Strict/);
out = await call(loginHandler, { body: { email: "t-super@example.test", password: "right-password" }, ip: "1.1.1.2" });
assert.deepEqual(out.body, { email: "t-super@example.test", role: "super_admin", municipality: null });
// right password, but not active staff: no session, and the sign-in is revoked
for (const [email, ip] of [["t-inactive@example.test", "1.1.1.3"], ["t-noprofile@example.test", "1.1.1.4"], ["t-plain@example.test", "1.1.1.5"]]) {
  reset();
  out = await call(loginHandler, { body: { email, password: "right-password" }, ip });
  assert.equal(out.status, 403, email);
  assert.ok(!out.headers["Set-Cookie"], `${email}: no cookies are set`);
  assert.equal(upstream.filter(u => u.logout).length, 1, `${email}: the new sign-in is signed out again`);
}
out = await call(loginHandler, { body: { email: "t-muni@example.test", password: "wrong" }, ip: "1.1.1.6" });
assert.deepEqual([out.status, out.body.error], [401, "Invalid email or password."]);
out = await call(loginHandler, { body: { email: "nobody@example.test", password: "wrong" }, ip: "1.1.1.7" });
assert.deepEqual([out.status, out.body.error], [401, "Invalid email or password."], "unknown user and wrong password look the same");
reset();
out = await call(sessionHandler, { method: "GET", token: "t-muni" });
assert.deepEqual(out.body, { email: "t-muni@example.test", role: "municipality_admin", municipality: { name: "Jorhat Municipal Board", slug: "jorhat" } });
out = await call(sessionHandler, { method: "GET", token: "t-inactive" });
assert.equal(out.status, 403);
assert.match(String(out.headers["Set-Cookie"]), /Max-Age=0/);
out = await call(sessionHandler, { method: "GET" });
assert.equal(out.status, 401);

console.warn = origWarn;
console.error = origError;
globalThis.fetch = realFetch;
console.log("proxy handlers ok");
