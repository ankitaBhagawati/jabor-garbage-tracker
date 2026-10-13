// Tests for the CSV export route and the CSV rules: `node api/_lib/export.check.js`
import assert from "node:assert/strict";

const BOM = String.fromCharCode(0xfeff);

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon-key-for-tests";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";

const { csvCell, toCsv, plainDescription } = await import("../../src/admin/csv.js");
const { default: exportHandler, MAX_ROWS, HEADER, AUDIT_HEADER } = await import("../admin/export.js");

// ── CSV rules ────────────────────────────────────────────────────────────────
for (const lead of ["=", "+", "-", "@", "\t", "\r"]) assert.equal(csvCell(`${lead}1+1`).replace(/^"|"$/g, "").startsWith("'" + lead), true, `a cell starting with ${JSON.stringify(lead)} is prefixed`);
assert.equal(csvCell("=HYPERLINK(\"http://evil\")"), `"'=HYPERLINK(""http://evil"")"`);
assert.equal(csvCell("-2+3"), "'-2+3");
assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
assert.equal(csvCell(" =1"), " =1", "only a leading character counts");
assert.equal(csvCell("a=b"), "a=b");
assert.equal(csvCell(7), "7");
assert.equal(csvCell(0), "0");
assert.equal(csvCell(null), "");
assert.equal(csvCell(undefined), "");
assert.equal(csvCell(NaN), "");
assert.equal(csvCell("a,b"), '"a,b"');
assert.equal(csvCell('say "hi"'), '"say ""hi"""');
assert.equal(csvCell("two\nlines"), '"two\nlines"');
assert.equal(toCsv(["a", "b"], [[1, "=x"], ["y,z", null]]), BOM + "a,b\r\n1,'=x\r\n\"y,z\",\r\n");
assert.equal(plainDescription("Call me on 98765 43210 or mail ravi.k+x@example.com now\nthanks"), "Call me on [phone removed] or mail [email removed] now thanks");
assert.equal(plainDescription("Garbage near ward 7, 3 bags"), "Garbage near ward 7, 3 bags", "ordinary numbers stay");
assert.equal(plainDescription("+91-98765-43210"), "[phone removed]");
assert.equal(plainDescription(null), "");

// ── The route, with Supabase stubbed ─────────────────────────────────────────
const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const U_SUPER = "aaaaaaaa-0000-4000-8000-000000000001";
const U_MUNI = "aaaaaaaa-0000-4000-8000-000000000002";
const accounts = {
  "t-muni": { user: { id: U_MUNI, email: "jmb@example.test", app_metadata: { role: "municipality_admin", municipality_id: M1 } }, profile: { user_id: U_MUNI, role: "municipality_admin", municipality_id: M1, is_active: true, municipalities: { name: "Jorhat", slug: "jorhat" } } },
  "t-super": { user: { id: U_SUPER, email: "owner@example.test", app_metadata: { role: "super_admin" } }, profile: { user_id: U_SUPER, role: "super_admin", municipality_id: null, is_active: true, municipalities: null } },
};
let calls = [];
let total = 3;
let auditFails = false;
const report = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, created_at: "2026-10-01T10:00:00Z", ward_id: W1, status: "verified", is_deleted: false, cleaned_by_type: null, cleaned_at: null, cleaned_marked_at: null, description: `report ${n}`, ...extra });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const token = /^Bearer (.+)$/.exec(init.headers?.Authorization || "")?.[1];
  const account = accounts[token];
  if (url.endsWith("/auth/v1/user")) return account ? json(account.user) : json({}, 401);
  if (url.includes("/rest/v1/staff_profiles?")) return json(account ? [account.profile] : []);
  calls.push({ url, init, token });
  if (url.includes("/rest/v1/audit_log") && init.method === "POST") return auditFails ? json({ message: "boom" }, 500) : new Response(null, { status: 201 });
  if (url.includes("/rest/v1/audit_log")) return auditList(new URL(url));
  if (url.includes("/rest/v1/wards")) return json([{ id: W1, number: 7, name: null }]);
  if (url.includes("/rest/v1/municipalities")) return json([{ id: M1, settings: { overdue_after_days: 7 } }]);
  if (url.includes("/rest/v1/reports")) {
    const offset = Number(new URL(url).searchParams.get("offset"));
    const rows = Array.from({ length: Math.max(0, Math.min(1000, total - offset)) }, (_, i) => report(offset + i + 1));
    if (offset === 0 && rows[0] && total === 3) {
      rows[0] = report(1, { description: "=HYPERLINK(\"http://evil\") call 98765 43210", created_at: "2026-09-01T10:00:00Z" });
      rows[1] = report(2, { status: "cleaned", cleaned_by_type: "citizen", cleaned_at: "2026-10-03T08:00:00Z" });
      rows[2] = report(3, { ward_id: null, status: "cleaned", cleaned_by_type: "auto", cleaned_at: "2026-10-05T08:00:00Z", is_deleted: false });
    }
    return json(rows, 200, { "content-range": `${offset}-${offset + rows.length - 1}/${total}` });
  }
  return json({}, 404);
};

// ── a small audit_log: the stub applies the same filters Postgrest would ─────
const AUDIT = [];
const addAudit = (n, extra) => AUDIT.push({ id: n, municipality_id: M1, entity_type: "report", entity_id: `r${n}`, actor_email: "jmb@example.test", action: "status_change", from_value: { status: "verified" }, to_value: { status: "cleaned" }, note: null, created_at: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + n * 3600_000).toISOString(), ...extra });
for (let n = 1; n <= 40; n++) addAudit(n, n % 4 === 0 ? { action: "ward_change" } : n % 7 === 0 ? { actor_email: "public", action: "report_created", to_value: { source: "public" } } : {});
for (let n = 41; n <= 50; n++) addAudit(n, { municipality_id: M2, actor_email: "other@example.test" });
addAudit(51, { note: "=HYPERLINK(\"http://evil\") ring 98765 43210", to_value: { status: "cleaned", cleaned_by_name: "Ravi Kumar", phone: "9876543210", lat: 26.75, lng: 94.2, admin_note: "mail me at a.b@example.com" } });
addAudit(52, { entity_type: "staff_member", entity_id: "u1", actor_email: "owner@example.test", action: "staff_account_created", from_value: null, to_value: { email: "new.admin@example.test", role: "municipality_admin" } });
let auditBulk = null; // set to a number to pretend the log is that long
const auditList = url => {
  const q = url.searchParams;
  const gte = /created_at\.gte\.([^,)]+)/.exec(q.get("and") || "")?.[1], lte = /created_at\.lte\.([^,)]+)/.exec(q.get("and") || "")?.[1];
  const actor = /^ilike\.\*(.*)\*$/.exec(q.get("actor_email") || "")?.[1];
  let rows = auditBulk ? Array.from({ length: auditBulk }, (_, i) => ({ ...AUDIT[0], id: auditBulk - i, created_at: new Date(Date.UTC(2026, 9, 1) + (auditBulk - i) * 1000).toISOString() })) : AUDIT.filter(r =>
    (!q.get("municipality_id") || q.get("municipality_id") === `eq.${r.municipality_id}`) &&
    (!q.get("action") || q.get("action") === `eq.${r.action}`) && q.getAll("entity_type").every(f => f === `eq.${r.entity_type}`) &&
    (!actor || r.actor_email.toLowerCase().includes(actor.toLowerCase())) && (!gte || r.created_at >= gte) && (!lte || r.created_at <= lte));
  rows = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
  const offset = Number(q.get("offset") || 0), limit = Number(q.get("limit") || 1000);
  const page = rows.slice(offset, offset + limit);
  return json(page, 200, { "content-range": `${offset}-${offset + page.length - 1}/${rows.length}` });
};
const makeRes = () => {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  res.end = text => { res.body = text; return res; };
  return res;
};
const run = async (token, body) => {
  calls = [];
  const req = { method: "POST", headers: { host: "jabor.in", origin: "https://jabor.in", "x-forwarded-for": "9.9.9.9", ...(token ? { cookie: `jabor_at=${token}` } : {}) }, socket: {}, body };
  const res = makeRes();
  await exportHandler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body, calls };
};
const origError = console.error, origWarn = console.warn;
console.error = () => {};
console.warn = () => {};
const AND = "and=(status.in.(verified,pending),created_at.gte.2026-09-01T00:00:00.000Z)";
const auditOf = out => out.calls.filter(c => c.url.includes("/audit_log") && c.init.method === "POST");

// a municipality admin: scope added by the server, fixed columns, the audit row, the file
let out = await run("t-muni", { path: `/rest/v1/reports?${AND}` });
assert.equal(out.status, 200);
assert.equal(out.headers["Content-Type"], "text/csv; charset=utf-8");
assert.match(out.headers["Content-Disposition"], /^attachment; filename="jabor-reports-\d{4}-\d{2}-\d{2}\.csv"$/);
const reportReads = out.calls.filter(c => c.url.includes("/rest/v1/reports"));
assert.equal(reportReads.length, 1);
const readUrl = new URL(reportReads[0].url);
assert.equal(readUrl.searchParams.get("municipality_id"), `eq.${M1}`, "the server adds the municipality");
assert.equal(readUrl.searchParams.get("select"), "id,created_at,ward_id,status,is_deleted,cleaned_by_type,cleaned_at,cleaned_marked_at,description");
assert.equal(readUrl.searchParams.get("and"), AND.slice(4), "the dashboard's filters are applied");
assert.equal(readUrl.searchParams.get("order"), "created_at.asc,id.asc");
assert.equal(reportReads[0].token, "t-muni", "reads use the caller's own token, so RLS applies");
assert.doesNotMatch(readUrl.search, /lat|lng|gps|embedding|contact|email/i, "no coordinates, contact details or embeddings are ever requested");
const lines = out.body.replace(/^\uFEFF/, "").split("\r\n");
assert.deepEqual(lines[0].split(","), HEADER);
assert.deepEqual(HEADER, ["id", "date", "ward", "status", "age_days", "overdue", "cleaned_date", "cleaned_by_type", "description"]);
assert.match(lines[1], /^00000000-0000-4000-8000-000000000001,2026-09-01,Ward 7,active,\d+,yes,,,"'=HYPERLINK\(""http:\/\/evil""\) call \[phone removed\]"$/, "formula neutralised, phone removed, old active report is overdue");
assert.match(lines[2], /^00000000-0000-4000-8000-000000000002,2026-10-01,Ward 7,cleaned,\d+,no,2026-10-03,citizen,report 2$/);
assert.match(lines[3], /,Unassigned,cleaned,\d+,no,2026-10-05,auto,report 3$/, "auto-cleaned stays marked auto");
const audit = auditOf(out);
assert.equal(audit.length, 1);
assert.equal(audit[0].init.headers.Authorization, "Bearer service-key-for-tests");
const row = JSON.parse(audit[0].init.body);
assert.deepEqual([row.entity_type, row.entity_id, row.action, row.actor_id, row.actor_email, row.municipality_id, row.to_value.rows], ["export", "reports", "export", U_MUNI, "jmb@example.test", M1, 3]);
assert.ok(row.to_value.filters.includes("and="), "the filters are logged");
assert.ok(out.calls.indexOf(audit[0]) < Infinity && out.body, "audited, then sent");

// a municipality admin cannot choose another municipality; nothing is read or logged beyond the denial
out = await run("t-muni", { path: `/rest/v1/reports?municipality_id=eq.${M2}` });
assert.equal(out.status, 403);
assert.equal(auditOf(out).length, 0);
assert.ok(!out.calls.some(c => c.url.includes("/rest/v1/reports")), "nothing was read");

// a super admin names the municipality
out = await run("t-super", { path: `/rest/v1/reports?${AND}&municipality_id=eq.${M1}` });
assert.equal(out.status, 200);
assert.equal(new URL(out.calls.find(c => c.url.includes("/rest/v1/reports")).url).searchParams.get("municipality_id"), `eq.${M1}`);
assert.equal(JSON.parse(auditOf(out)[0].init.body).municipality_id, M1);

// only the filter part is accepted: no other columns, no paging, no other tables, no other keys
for (const body of [
  { path: "/rest/v1/reports?select=*" }, { path: "/rest/v1/reports?select=lat,lng" }, { path: "/rest/v1/reports?limit=100000" }, { path: "/rest/v1/reports?offset=5" },
  { path: "/rest/v1/reports?order=lat" }, { path: `/rest/v1/reports?${AND}&${AND}` }, { path: "/rest/v1/report_contacts?select=email" }, { path: "/rest/v1/reports/../report_contacts" },
  { path: "/rest/v1/reports?status=eq.active" }, { path: "/rest/v1/reports?or=(status.eq.active)" }, { path: 5 }, { path: "/rest/v1/reports", extra: 1 }, { path: "/rest/v1/reports", role: "super_admin" }, {}, [], null,
]) {
  out = await run("t-muni", body);
  assert.ok(out.status === 400, `${JSON.stringify(body)} -> ${out.status}`);
  assert.equal(auditOf(out).length, 0);
}
// a filter on a column nobody may filter by is refused by the allowlist
out = await run("t-muni", { path: "/rest/v1/reports?and=(embedding.eq.1)" });
assert.equal(out.status, 403);

// signed out
out = await run(undefined, { path: "/rest/v1/reports" });
assert.equal(out.status, 401);
assert.equal(out.calls.length, 0);

// paging: 2,500 rows come in three reads
total = 2500;
out = await run("t-muni", { path: "/rest/v1/reports" });
assert.equal(out.status, 200);
assert.deepEqual(out.calls.filter(c => c.url.includes("/rest/v1/reports")).map(c => new URL(c.url).searchParams.get("offset")), ["0", "1000", "2000"]);
assert.equal(out.body.split("\r\n").length, 2500 + 2, "header, 2,500 rows and the closing newline");
assert.equal(out.headers["X-Row-Count"], "2500");
assert.equal(JSON.parse(auditOf(out)[0].init.body).to_value.rows, 2500);

// the cap: a clear message, nothing exported, nothing logged
total = MAX_ROWS;
out = await run("t-muni", { path: "/rest/v1/reports" });
assert.equal(out.status, 200, "exactly the cap is allowed");
total = MAX_ROWS + 1;
out = await run("t-muni", { path: "/rest/v1/reports" });
assert.equal(out.status, 413);
assert.match(out.body.error, /10,001 reports match\. An export holds at most 10,000\. Narrow the filters/);
assert.equal(auditOf(out).length, 0);
assert.equal(out.calls.filter(c => c.url.includes("/rest/v1/reports")).length, 1, "stops after the first read");

// if the export cannot be logged, it is not delivered
total = 3;
auditFails = true;
out = await run("t-muni", { path: "/rest/v1/reports" });
assert.equal(out.status, 500);
assert.equal(typeof out.body, "object");
assert.ok(!out.headers["Content-Disposition"], "no file is sent");
auditFails = false;


// ═══ The audit log export ════════════════════════════════════════════════════
const AUDIT_PATH = filters => `/rest/v1/audit_log${filters ? `?${filters}` : ""}`;
const csvLines = out => out.body.replace(BOM, "").split("\r\n").filter(Boolean);
const listCount = async (token, filters) => { // what the Audit log tab's list says: the same request with count=exact
  const { authorize } = await import("./access.js");
  const staff = token === "t-muni" ? { role: "municipality_admin", userId: U_MUNI, municipalityId: M1 } : { role: "super_admin", userId: U_SUPER, municipalityId: null };
  const plan = authorize(staff, { path: `/rest/v1/audit_log?select=id&${filters}${filters ? "&" : ""}limit=1`, method: "GET", prefer: "count=exact" });
  const res = await globalThis.fetch(`http://supabase.test${plan.path}`, { headers: { Authorization: `Bearer ${token}` } });
  return Number(/\/(\d+)$/.exec(res.headers.get("content-range"))[1]);
};

// every filter the Audit log tab sends, alone and together: the file has exactly as many rows as the list
const FILTERS = [
  "", "action=eq.ward_change", "actor_email=ilike.*public*", "actor_email=ilike.*JMB*", "entity_type=eq.staff_member",
  `and=${encodeURIComponent("(created_at.gte.2026-10-01T20:00:00.000Z,created_at.lte.2026-10-02T10:00:00.000Z)")}`,
  `and=${encodeURIComponent("(created_at.gte.2026-10-02T00:00:00.000Z)")}`,
  `and=${encodeURIComponent("(created_at.lte.2026-10-01T15:00:00.000Z)")}&action=eq.status_change`,
  "action=eq.status_change&actor_email=ilike.*jmb*", "action=eq.nothing_like_this",
];
for (const token of ["t-muni", "t-super"]) {
  for (const filters of FILTERS) {
    const expected = await listCount(token, filters);
    out = await run(token, { type: "audit_log", path: AUDIT_PATH(filters) });
    assert.equal(out.status, 200, `${token} ${filters}`);
    assert.equal(csvLines(out).length - 1, expected, `${token} [${filters}]: the file has the list's row count`);
    assert.equal(out.headers["X-Row-Count"], String(expected));
    assert.equal(out.headers["X-Truncated"], "false");
    assert.deepEqual(csvLines(out)[0].split(","), AUDIT_HEADER);
  }
}
assert.deepEqual(AUDIT_HEADER, ["id", "date", "actor", "action", "entity_type", "entity_id", "details", "note"]);

// no filters: everything the caller may see. A municipality admin: only their municipality. A super admin: all of it.
out = await run("t-muni", { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(csvLines(out).length - 1, AUDIT.filter(r => r.municipality_id === M1 && r.entity_type === "report").length, "report rows of their municipality, and no staff rows");
assert.ok(!csvLines(out).some(l => /staff_|new\.admin@example\.test/.test(l)), "no staff management row");
assert.equal(new URL(out.calls.find(c => c.url.includes("/audit_log") && c.init.method !== "POST").url).searchParams.get("municipality_id"), `eq.${M1}`, "the server adds the scope");
assert.ok(!csvLines(out).some(l => l.includes("other@example.test")), "nothing from another municipality");
out = await run("t-super", { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(csvLines(out).length - 1, AUDIT.length);
out = await run("t-super", { type: "audit_log", path: AUDIT_PATH(`municipality_id=eq.${M2}`) });
assert.equal(csvLines(out).length - 1, 10, "a super admin may narrow to one municipality");
// a municipality admin cannot name one, and the read goes out with their own token (row level security applies)
out = await run("t-muni", { type: "audit_log", path: AUDIT_PATH(`municipality_id=eq.${M2}`) });
assert.equal(out.status, 403);
assert.equal(auditOf(out).length, 0);
out = await run("t-muni", { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(out.calls.find(c => c.url.includes("/audit_log") && c.init.method !== "POST").token, "t-muni");

// only the filters: no columns, paging, ordering, other tables or other keys
for (const body of [
  { type: "audit_log", path: "/rest/v1/audit_log?select=*" }, { type: "audit_log", path: "/rest/v1/audit_log?select=actor_id" }, { type: "audit_log", path: "/rest/v1/audit_log?limit=99999" },
  { type: "audit_log", path: "/rest/v1/audit_log?offset=1" }, { type: "audit_log", path: "/rest/v1/audit_log?order=id" }, { type: "audit_log", path: "/rest/v1/audit_log?entity_id=eq.x" },
  { type: "audit_log", path: "/rest/v1/audit_log?action=eq.a&action=eq.b" }, { type: "audit_log", path: "/rest/v1/reports" }, { type: "reports", path: "/rest/v1/audit_log" },
  { type: "audit_log", path: "/rest/v1/audit_log_x" }, { type: "audit_log", path: "/rest/v1/audit_log/x" }, { type: "audit", path: "/rest/v1/audit_log" }, { type: "constructor", path: "/rest/v1/audit_log" },
  { type: ["audit_log"], path: "/rest/v1/audit_log" }, { type: "audit_log", path: "/rest/v1/audit_log", role: "super_admin" }, { type: null, path: "/rest/v1/audit_log" },
]) {
  out = await run("t-super", body);
  assert.equal(out.status, 400, JSON.stringify(body));
  assert.equal(auditOf(out).length, 0);
}
out = await run("t-muni", { type: "audit_log", path: AUDIT_PATH("and=(embedding.eq.1)") });
assert.equal(out.status, 403, "a filter on a column nobody may filter by is refused");
out = await run(undefined, { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(out.status, 401);

// what is in the file: staff emails stay, citizens' details and coordinates never do, formulas are neutralised
out = await run("t-super", { type: "audit_log", path: AUDIT_PATH("") });
const text = out.body;
assert.doesNotMatch(text, /Ravi Kumar|9876543210|98765 43210|a\.b@example\.com|26\.75|94\.2|"lat"|"lng"|actor_id|ip_address/, "no citizen details, coordinates or ids of people");
assert.match(text, /owner@example\.test/, "the staff actor's email is kept");
assert.match(text, /new\.admin@example\.test/, "a staff account's own email is kept");
assert.match(text, /'=HYPERLINK/, "a note that starts with = is neutralised");
assert.match(text, /\[phone removed\]/);
assert.ok(!text.split("\r\n").some(line => /^[=+\-@]/.test(line.split(",")[6] ?? "")), "no cell starts with a formula character");

// the export itself is logged with its filters; a municipality admin's row carries their municipality
out = await run("t-muni", { type: "audit_log", path: AUDIT_PATH("action=eq.ward_change&actor_email=ilike.*jmb*") });
let logged = JSON.parse(auditOf(out)[0].init.body);
assert.deepEqual([logged.entity_type, logged.entity_id, logged.action, logged.actor_id, logged.actor_email, logged.municipality_id], ["export", "audit_log", "export", U_MUNI, "jmb@example.test", M1]);
assert.equal(logged.to_value.type, "audit_log");
assert.equal(logged.to_value.rows, csvLines(out).length - 1);
assert.equal(logged.to_value.truncated, false);
assert.match(logged.to_value.filters, /action=eq\.ward_change/);
assert.match(logged.to_value.filters, /actor_email=ilike/);
assert.equal(auditOf(out).length, 1);

// the cap: the newest 10,000 rows, and the file name and headers say it was cut
auditBulk = MAX_ROWS + 5;
out = await run("t-super", { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(out.status, 200);
assert.equal(csvLines(out).length - 1, MAX_ROWS);
assert.equal(out.headers["X-Truncated"], "true");
assert.equal(out.headers["X-Total-Rows"], String(MAX_ROWS + 5));
assert.match(out.headers["Content-Disposition"], /-first-10000\.csv"$/);
assert.equal(csvLines(out)[1].split(",")[0], String(MAX_ROWS + 5), "the newest row comes first");
assert.equal(out.calls.filter(c => c.url.includes("/audit_log") && c.init.method !== "POST").length, 10, "ten reads of a thousand");
logged = JSON.parse(auditOf(out)[0].init.body);
assert.deepEqual([logged.to_value.rows, logged.to_value.total, logged.to_value.truncated], [MAX_ROWS, MAX_ROWS + 5, true]);
auditBulk = MAX_ROWS;
out = await run("t-super", { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(out.headers["X-Truncated"], "false", "exactly the cap is not truncated");
auditBulk = null;

// not logged, not delivered
auditFails = true;
out = await run("t-super", { type: "audit_log", path: AUDIT_PATH("") });
assert.equal(out.status, 500);
assert.ok(!out.headers["Content-Disposition"]);
auditFails = false;

// the reports export still works with no type
out = await run("t-muni", { path: "/rest/v1/reports" });
assert.equal(out.status, 200);
assert.deepEqual(csvLines(out)[0].split(","), HEADER);

console.warn = origWarn;
console.error = origError;
globalThis.fetch = realFetch;
console.log("export ok");
