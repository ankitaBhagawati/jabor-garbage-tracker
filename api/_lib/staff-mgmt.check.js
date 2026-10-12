// Tests for the staff management routes: `node api/_lib/staff-mgmt.check.js`
// Who may call them, validation, the order of writes and rollback, duplicates, the rules for switching an account,
// the rate limit, and that no password or key ever leaves the server. Supabase and Upstash are stubbed.
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon-key-for-tests";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-secret-for-tests";
process.env.UPSTASH_REDIS_REST_URL = "http://upstash.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "upstash-token-secret";
process.env.VERCEL_ENV = "preview"; // on Vercel the limiter must be Redis and must fail closed

const V = await import("./staffAdmin.js");
const { default: collection } = await import("../admin/staff.js");
const { default: statusRoute } = await import("../admin/staff/status.js");

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222"; // does not exist
const U_SUPER = "aaaaaaaa-0000-4000-8000-000000000001";
const U_SUPER2 = "aaaaaaaa-0000-4000-8000-000000000009";
const U_MUNI = "aaaaaaaa-0000-4000-8000-000000000002";
const U_MUNI2 = "aaaaaaaa-0000-4000-8000-000000000003";
const U_NEW = "bbbbbbbb-0000-4000-8000-000000000001";
const PASSWORD = "correct horse battery 42";

// ── pure rules ───────────────────────────────────────────────────────────────
const bad = (fn, status, pattern) => { try { fn(); } catch (e) { assert.equal(e.status, status, `${e.message}`); if (pattern) assert.match(e.message, pattern); return; } assert.fail("expected an error"); };
const good = { email: "  New.Admin@Example.TEST ", password: PASSWORD, municipality_id: M1 };
assert.deepEqual(V.validateCreate(good), { email: "new.admin@example.test", password: PASSWORD, municipalityId: M1 }, "email trimmed and lowercased");
for (const email of ["", "nobody", "a@b", "a b@example.com", "a@@example.com", "<x>@example.com", "a@example..com", "@example.com", "a@.com", `${"x".repeat(250)}@example.com`, 5, null, ["a@example.com"], { a: 1 }]) bad(() => V.validateCreate({ ...good, email }), 400, /valid email/);
for (const password of ["", "short", "elevenchars", "x".repeat(11), 123456789012, null, ["a".repeat(12)]]) bad(() => V.validateCreate({ ...good, password }), 400, /password/);
assert.doesNotThrow(() => V.validateCreate({ ...good, password: "x".repeat(12) }), "12 characters is enough");
bad(() => V.validateCreate({ ...good, password: "x".repeat(73) }), 400, /at most 72/);
for (const municipality_id of ["", "jorhat", "not-a-uuid", 7, null, `${M1}'--`, [M1]]) bad(() => V.validateCreate({ ...good, municipality_id }), 400, /municipality/i);
// unknown fields are refused: a role, a municipality name, anything
for (const extra of [{ role: "super_admin" }, { role: "municipality_admin" }, { is_active: true }, { app_metadata: { role: "super_admin" } }, { user_id: U_NEW }, { __proto__x: 1 }]) bad(() => V.validateCreate({ ...good, ...extra }), 400, /Unknown field/);
for (const body of [null, undefined, [], "x", 5, {}, { email: good.email }, { email: good.email, password: PASSWORD }]) bad(() => V.validateCreate(body), 400);
assert.deepEqual(V.validateStatus({ user_id: U_MUNI.toUpperCase(), is_active: false }), { userId: U_MUNI, isActive: false });
for (const body of [{ user_id: U_MUNI }, { is_active: true }, { user_id: "x", is_active: true }, { user_id: U_MUNI, is_active: "false" }, { user_id: U_MUNI, is_active: 0 }, { user_id: U_MUNI, is_active: true, role: "super_admin" }, { user_id: U_MUNI, is_active: true, email: "a@b.co" }, null, []]) bad(() => V.validateStatus(body), 400);

// rules for switching an account
const muniProfile = { user_id: U_MUNI, role: "municipality_admin", is_active: true };
assert.equal(V.statusChangeError({ actorId: U_SUPER, target: muniProfile, isActive: false, activeSuperAdmins: 0 }), null);
assert.equal(V.statusChangeError({ actorId: U_SUPER, target: { ...muniProfile, is_active: false }, isActive: true, activeSuperAdmins: 0 }), null);
assert.equal(V.statusChangeError({ actorId: U_SUPER, target: null, isActive: false, activeSuperAdmins: 0 }).status, 404);
assert.equal(V.statusChangeError({ actorId: U_MUNI, target: muniProfile, isActive: false, activeSuperAdmins: 2 }).status, 403, "never yourself");
assert.equal(V.statusChangeError({ actorId: U_SUPER, target: { user_id: U_SUPER2, role: "super_admin", is_active: true }, isActive: false, activeSuperAdmins: 2 }).status, 403, "never a super admin here");
assert.equal(V.statusChangeError({ actorId: U_SUPER, target: { user_id: U_SUPER, role: "super_admin", is_active: true }, isActive: false, activeSuperAdmins: 1 }).status, 403, "never yourself, even as the last one");

// ── the stub ─────────────────────────────────────────────────────────────────
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const accounts = new Map();
const account = (token, role, id, profile) => accounts.set(token, { user: { id, email: `${token}@example.test`, app_metadata: { role, ...(role === "municipality_admin" ? { municipality_id: M1 } : {}) } }, profile });
const prof = (id, role, extra = {}) => ({ user_id: id, role, municipality_id: role === "municipality_admin" ? M1 : null, is_active: true, municipalities: role === "municipality_admin" ? { name: "Jorhat Municipal Board", slug: "jorhat" } : null, ...extra });
account("t-super", "super_admin", U_SUPER, prof(U_SUPER, "super_admin"));
account("t-legacy", "admin", U_SUPER2, prof(U_SUPER2, "super_admin")); // the older token role, with a super_admin profile
account("t-muni", "municipality_admin", U_MUNI, prof(U_MUNI, "municipality_admin"));
account("t-inactive-super", "super_admin", "aaaaaaaa-0000-4000-8000-0000000000a1", prof("aaaaaaaa-0000-4000-8000-0000000000a1", "super_admin", { is_active: false }));
account("t-noprofile", "super_admin", "aaaaaaaa-0000-4000-8000-0000000000a2", null);
account("t-plain", "authenticated", "aaaaaaaa-0000-4000-8000-0000000000a3", prof("aaaaaaaa-0000-4000-8000-0000000000a3", "super_admin")); // not a staff role in the token
account("t-claims-super-row-muni", "super_admin", "aaaaaaaa-0000-4000-8000-0000000000a4", prof("aaaaaaaa-0000-4000-8000-0000000000a4", "municipality_admin")); // token and profile disagree
account("t-claims-muni-row-super", "municipality_admin", "aaaaaaaa-0000-4000-8000-0000000000a5", prof("aaaaaaaa-0000-4000-8000-0000000000a5", "super_admin"));

let calls, authUsers, profiles, auditRows, counters, failures, logs;
const reset = () => {
  calls = []; auditRows = []; counters = new Map(); failures = new Set(); logs = [];
  authUsers = new Map([["taken@example.test", "cccccccc-0000-4000-8000-000000000001"]]);
  profiles = new Map([
    [U_SUPER, { user_id: U_SUPER, email: "owner@example.test", role: "super_admin", municipality_id: null, is_active: true, created_at: "2026-10-01T00:00:00Z" }],
    [U_SUPER2, { user_id: U_SUPER2, email: "legacy@example.test", role: "super_admin", municipality_id: null, is_active: true, created_at: "2026-10-02T00:00:00Z" }],
    [U_MUNI, { user_id: U_MUNI, email: "jmb@example.test", role: "municipality_admin", municipality_id: M1, is_active: true, created_at: "2026-10-03T00:00:00Z" }],
    [U_MUNI2, { user_id: U_MUNI2, email: "jmb2@example.test", role: "municipality_admin", municipality_id: M1, is_active: false, created_at: "2026-10-04T00:00:00Z" }],
  ]);
};
reset();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const auth = init.headers?.Authorization || "";
  const token = /^Bearer (.+)$/.exec(auth)?.[1];
  const service = token === process.env.SUPABASE_SERVICE_ROLE_KEY;
  const method = init.method || "GET";
  if (url.startsWith("http://upstash.test")) {
    if (failures.has("limiter")) throw new Error("connect ECONNREFUSED");
    const [, [, key]] = JSON.parse(init.body);
    counters.set(key, (counters.get(key) || 0) + 1);
    return json([{ result: "OK" }, { result: counters.get(key) }]);
  }
  if (url.endsWith("/auth/v1/user")) { const a = accounts.get(token); return a ? json(a.user) : json({}, 401); }
  if (url.includes("/rest/v1/staff_profiles?select=user_id,role,municipality_id,is_active,municipalities(name,slug)")) {
    const a = accounts.get(token);
    return json(a?.profile && a.profile.is_active ? [a.profile] : []);
  }
  calls.push({ url, method, service, token, body: init.body });
  if (url.endsWith("/auth/v1/admin/users") && method === "POST") {
    assert.ok(service, "the Auth admin API is called with the service key only");
    const { email } = JSON.parse(init.body);
    if (failures.has("auth")) return json({ msg: "boom" }, 500);
    if (authUsers.has(email)) return json({ error_code: "email_exists", msg: "A user with this email address has already been registered" }, 422);
    authUsers.set(email, U_NEW);
    return json({ id: U_NEW, email });
  }
  if (/\/auth\/v1\/admin\/users\/[0-9a-f-]{36}$/.test(url) && method === "DELETE") {
    assert.ok(service);
    if (failures.has("delete")) return json({ msg: "boom" }, 500);
    const id = url.split("/").pop();
    for (const [email, uid] of authUsers) if (uid === id) authUsers.delete(email);
    profiles.delete(id); // on delete cascade
    return json({});
  }
  if (url.includes("/rest/v1/municipalities?id=eq.")) return json(url.includes(M1) ? [{ id: M1, name: "Jorhat Municipal Board" }] : []);
  if (url.includes("/rest/v1/staff_profiles?select=user_id,email,role,municipality_id,is_active,created_at,municipalities(name)")) {
    assert.equal(token, "t-super", "the list is read with the caller's own token, so row level security applies");
    return json([...profiles.values()].map(p => ({ ...p, municipalities: p.municipality_id ? { name: "Jorhat Municipal Board" } : null })));
  }
  if (url.includes("/rest/v1/staff_profiles") && method === "POST") {
    assert.ok(service);
    if (failures.has("profile")) return json({ message: "violates something", details: `Key (email)=(x) ${JSON.parse(init.body).email}` }, 409);
    const row = JSON.parse(init.body);
    profiles.set(row.user_id, { ...row, created_at: "2026-10-11T00:00:00Z" });
    return new Response(null, { status: 201 });
  }
  if (url.includes("/rest/v1/staff_profiles?role=eq.super_admin&is_active=eq.true")) return json([...profiles.values()].filter(p => p.role === "super_admin" && p.is_active).map(p => ({ user_id: p.user_id })));
  if (url.includes("/rest/v1/staff_profiles?user_id=eq.") && method === "GET") { const p = profiles.get(/user_id=eq\.([0-9a-f-]{36})/.exec(url)[1]); return json(p ? [p] : []); }
  if (url.includes("/rest/v1/staff_profiles?user_id=eq.") && method === "PATCH") {
    assert.ok(service);
    assert.match(url, /role=eq\.municipality_admin/, "only a municipality admin's row can be changed");
    const p = profiles.get(/user_id=eq\.([0-9a-f-]{36})/.exec(url)[1]);
    if (!p || p.role !== "municipality_admin") return json([]);
    p.is_active = JSON.parse(init.body).is_active;
    return json([p]);
  }
  if (url.includes("/rest/v1/audit_log") && method === "POST") {
    assert.ok(service);
    if (failures.has("audit")) return json({ message: "boom" }, 500);
    auditRows.push(JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  return json({ message: "unexpected request" }, 404);
};
const makeRes = () => {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  res.end = text => { res.body = text; return res; };
  return res;
};
const call = async (handler, { token, method = "POST", body = {}, origin = "https://jabor.in" } = {}) => {
  const req = { method, headers: { host: "jabor.in", origin, "x-forwarded-for": "9.9.9.9", ...(token ? { cookie: `jabor_at=${token}` } : {}) }, socket: {}, body };
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
};
const origError = console.error, origWarn = console.warn;
console.error = (...a) => logs.push(a.join(" "));
console.warn = (...a) => logs.push(a.join(" "));
const create = (token, body = { email: "new.admin@example.test", password: PASSWORD, municipality_id: M1 }, extra) => call(collection, { token, body, ...extra });
const setStatus = (token, body) => call(statusRoute, { token, body });
const mutations = () => calls.filter(c => c.method !== "GET" && !c.url.startsWith("http://upstash"));

// ── who may call ─────────────────────────────────────────────────────────────
let out = await create("t-super");
assert.equal(out.status, 201);
out = await create("t-legacy", { email: "second@example.test", password: PASSWORD, municipality_id: M1 });
assert.equal(out.status, 201, "the older admin token role with an active super_admin profile works");
for (const [token, status] of [["t-muni", 403], [undefined, 401], ["t-nobody", 401], ["t-inactive-super", 403], ["t-noprofile", 403], ["t-plain", 403], ["t-claims-super-row-muni", 403], ["t-claims-muni-row-super", 403]]) {
  reset();
  for (const [name, run] of [["create", () => create(token)], ["status", () => setStatus(token, { user_id: U_MUNI, is_active: false })], ["list", () => call(collection, { token, method: "GET" })]]) {
    out = await run();
    assert.equal(out.status, status, `${token ?? "anon"} ${name}`);
    assert.equal(mutations().length, 0, `${token ?? "anon"} ${name}: nothing was written`);
    assert.equal(calls.filter(c => c.service).length, 0, `${token ?? "anon"} ${name}: the service key was not used`);
  }
  assert.equal(auditRows.length, 0);
}
// wrong method, and a request from another site
out = await call(collection, { token: "t-super", method: "DELETE" });
assert.equal(out.status, 405);
out = await call(collection, { token: "t-super", method: "PUT" });
assert.equal(out.status, 405);
out = await call(statusRoute, { token: "t-super", method: "GET" });
assert.equal(out.status, 405);
reset();
out = await create("t-super", undefined, { origin: "https://evil.example" });
assert.equal(out.status, 403);
assert.equal(mutations().length, 0);

// ── create: what is sent and stored ──────────────────────────────────────────
reset();
out = await create("t-super", { email: " New.Admin@Example.TEST", password: PASSWORD, municipality_id: M1 });
assert.equal(out.status, 201);
assert.deepEqual(out.body, { user_id: U_NEW, email: "new.admin@example.test", role: "municipality_admin", municipality_id: M1, municipality_name: "Jorhat Municipal Board", is_active: true });
const order = mutations().map(c => `${c.method} ${new URL(c.url).pathname}`);
assert.deepEqual(order, ["POST /auth/v1/admin/users", "POST /rest/v1/staff_profiles", "POST /rest/v1/audit_log"], "login, then profile, then the audit row");
const authCall = JSON.parse(calls.find(c => c.url.endsWith("/auth/v1/admin/users")).body);
assert.deepEqual(authCall, { email: "new.admin@example.test", password: PASSWORD, email_confirm: true, app_metadata: { role: "municipality_admin", municipality_id: M1 } });
const profileBody = JSON.parse(calls.find(c => c.url.includes("/staff_profiles") && c.method === "POST").body);
assert.deepEqual(profileBody, { user_id: U_NEW, municipality_id: M1, role: "municipality_admin", email: "new.admin@example.test", is_active: true });
assert.equal(auditRows.length, 1);
const audit = auditRows[0];
assert.deepEqual([audit.entity_type, audit.entity_id, audit.action, audit.actor_id, audit.actor_email, audit.municipality_id], ["staff_member", U_NEW, "staff_account_created", U_SUPER, "t-super@example.test", M1]);
assert.equal(audit.to_value.email, "new.admin@example.test");
assert.ok(!JSON.stringify(audit).includes(PASSWORD), "the password is not in the audit row");
assert.ok(!JSON.stringify(out.body).includes(PASSWORD));
// the request cannot choose a role, not even the one it would get anyway
for (const role of ["super_admin", "municipality_admin", "admin"]) {
  reset();
  out = await create("t-super", { email: "x@example.test", password: PASSWORD, municipality_id: M1, role });
  assert.equal(out.status, 400, role);
  assert.equal(mutations().length, 0);
}
// bad input changes nothing; a municipality that does not exist is refused before any login is made
reset();
out = await create("t-super", { email: "x@example.test", password: "short", municipality_id: M1 });
assert.equal(out.status, 400);
out = await create("t-super", { email: "x@example.test", password: PASSWORD, municipality_id: M2 });
assert.equal(out.status, 400);
assert.match(out.body.error, /municipality/);
assert.equal(mutations().length, 0);

// ── duplicates ───────────────────────────────────────────────────────────────
reset();
out = await create("t-super", { email: "Taken@Example.test", password: PASSWORD, municipality_id: M1 });
assert.equal(out.status, 409);
assert.match(out.body.error, /already exists\. Nothing was changed\./);
assert.deepEqual(mutations().map(c => c.method), ["POST"], "only the refused create was attempted: no profile, no audit row, no delete");
assert.equal(authUsers.get("taken@example.test"), "cccccccc-0000-4000-8000-000000000001", "the existing user was not touched");
assert.equal(auditRows.length, 0);

// ── rollback ─────────────────────────────────────────────────────────────────
reset(); failures.add("profile");
out = await create("t-super");
assert.equal(out.status, 500);
assert.deepEqual(mutations().map(c => `${c.method} ${new URL(c.url).pathname.replace(U_NEW, ":id")}`), ["POST /auth/v1/admin/users", "POST /rest/v1/staff_profiles", "DELETE /auth/v1/admin/users/:id"]);
assert.equal(authUsers.has("new.admin@example.test"), false, "no orphan login");
assert.equal(auditRows.length, 0, "and no audit row for something that did not happen");
reset(); failures.add("audit");
out = await create("t-super");
assert.equal(out.status, 500);
assert.equal(authUsers.has("new.admin@example.test"), false, "no staff account without its audit row: the login is removed");
assert.equal(profiles.has(U_NEW), false, "and so is the profile");
reset(); failures.add("auth");
out = await create("t-super");
assert.equal(out.status, 500);
assert.deepEqual(mutations().map(c => c.method), ["POST"], "nothing else was written");
reset(); failures.add("profile"); failures.add("delete");
out = await create("t-super");
assert.equal(out.status, 500);
assert.ok(logs.some(l => l.includes(`${U_NEW} could not be removed`)), "a login that could not be removed is reported by id for a manual clean up");

// ── the list ─────────────────────────────────────────────────────────────────
reset();
out = await call(collection, { token: "t-super", method: "GET" });
assert.equal(out.status, 200);
assert.equal(out.body.length, 4);
assert.deepEqual(Object.keys(out.body[0]).sort(), ["created_at", "email", "is_active", "municipality_id", "municipality_name", "role", "user_id"]);
assert.deepEqual(out.body.find(r => r.user_id === U_MUNI2), { user_id: U_MUNI2, email: "jmb2@example.test", role: "municipality_admin", municipality_id: M1, municipality_name: "Jorhat Municipal Board", is_active: false, created_at: "2026-10-04T00:00:00Z" });
assert.equal(out.body.find(r => r.user_id === U_SUPER).municipality_name, null);
assert.ok(!/password|token|secret|encrypted/i.test(JSON.stringify(out.body)));
assert.equal(calls.filter(c => c.service).length, 0, "the list does not use the service key");

// ── switching an account ─────────────────────────────────────────────────────
reset();
out = await setStatus("t-super", { user_id: U_MUNI, is_active: false });
assert.deepEqual([out.status, out.body], [200, { user_id: U_MUNI, is_active: false, changed: true }]);
assert.equal(profiles.get(U_MUNI).is_active, false);
assert.deepEqual([auditRows[0].action, auditRows[0].entity_id, auditRows[0].actor_id, auditRows[0].municipality_id, auditRows[0].from_value, auditRows[0].to_value.email], ["staff_account_deactivated", U_MUNI, U_SUPER, M1, { is_active: true }, "jmb@example.test"]);
out = await setStatus("t-super", { user_id: U_MUNI, is_active: false });
assert.deepEqual(out.body, { user_id: U_MUNI, is_active: false, changed: false }, "setting it again changes nothing");
assert.equal(auditRows.length, 1, "and logs nothing");
out = await setStatus("t-super", { user_id: U_MUNI, is_active: true });
assert.equal(out.body.changed, true);
assert.equal(auditRows[1].action, "staff_account_activated");
out = await setStatus("t-legacy", { user_id: U_MUNI2, is_active: true });
assert.equal(out.status, 200, "the older admin token role works here too");
// not yourself, not a super admin, not an unknown account
for (const [token, user_id, status] of [["t-super", U_SUPER, 403], ["t-legacy", U_SUPER2, 403], ["t-super", U_SUPER2, 403], ["t-super", "dddddddd-0000-4000-8000-000000000001", 404]]) {
  reset();
  out = await setStatus(token, { user_id, is_active: false });
  assert.equal(out.status, status, `${token} -> ${user_id}`);
  assert.equal(mutations().length, 0);
  assert.equal(auditRows.length, 0);
  assert.equal([...profiles.values()].filter(p => p.role === "super_admin" && p.is_active).length, 2, "both super admins are still active");
}
// the audit row is part of the change: if it cannot be written, the change is undone
reset(); failures.add("audit");
out = await setStatus("t-super", { user_id: U_MUNI, is_active: false });
assert.equal(out.status, 500);
assert.equal(profiles.get(U_MUNI).is_active, true, "reverted");
// a profile that is not a municipality admin is never changed, even if the check were skipped (the PATCH filters on the role)
assert.match(calls.find(c => c.method === "PATCH").url, /role=eq\.municipality_admin/);

// ── deactivation takes effect on the very next request ───────────────────────
reset();
const proxy = (await import("../admin/rest.js")).default;
const asProxy = async token => call(proxy, { token, body: { path: "/rest/v1/reports?select=id&limit=1", method: "GET" } });
globalThis.fetchBeforeProxy = globalThis.fetch;
const innerFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("/rest/v1/reports")) return json([]);
  return innerFetch(url, init);
};
assert.equal((await asProxy("t-muni")).status, 200, "a municipality admin works");
out = await setStatus("t-super", { user_id: U_MUNI, is_active: false });
assert.equal(out.status, 200);
// the stub's account profile follows the database row, as row level security does
accounts.get("t-muni").profile.is_active = profiles.get(U_MUNI).is_active;
assert.equal((await asProxy("t-muni")).status, 403, "the very next request, with the same valid token, is refused");
globalThis.fetch = innerFetch;
accounts.get("t-muni").profile.is_active = true;

// ── rate limit: per actor, fails closed ──────────────────────────────────────
reset();
for (let i = 1; i <= 10; i++) {
  out = await create("t-super", { email: `n${i}@example.test`, password: PASSWORD, municipality_id: M1 });
  assert.equal(out.status, 201, `create ${i}`);
  authUsers.delete(`n${i}@example.test`);
}
const before = mutations().length;
out = await create("t-super", { email: "n11@example.test", password: PASSWORD, municipality_id: M1 });
assert.equal(out.status, 429, "the 11th in the hour is refused");
assert.equal(mutations().length, before, "and writes nothing");
out = await create("t-legacy", { email: "other.actor@example.test", password: PASSWORD, municipality_id: M1 });
assert.equal(out.status, 201, "the limit is per actor");
for (let i = 1; i <= 10; i++) assert.equal((await setStatus("t-super", { user_id: i % 2 ? U_MUNI : U_MUNI2, is_active: i % 2 === 0 })).status, 200);
assert.equal((await setStatus("t-super", { user_id: U_MUNI, is_active: true })).status, 429, "status changes have their own counter of 10");
assert.ok([...counters.keys()].every(k => k.includes(":actor:")), "counters are keyed by actor");
// a refused (invalid) request still counts, so guessing is limited too
reset();
for (let i = 0; i < 10; i++) assert.equal((await create("t-super", { email: "bad", password: PASSWORD, municipality_id: M1 })).status, 400);
assert.equal((await create("t-super", { email: "bad", password: PASSWORD, municipality_id: M1 })).status, 429);
// Redis unreachable: refused, nothing written
reset(); failures.add("limiter");
out = await create("t-super");
assert.equal(out.status, 503);
assert.equal(mutations().length, 0);
out = await setStatus("t-super", { user_id: U_MUNI, is_active: false });
assert.equal(out.status, 503);
assert.equal(mutations().length, 0);
// Redis not configured on Vercel: refused too. Off Vercel (local development) the in-memory counter is used.
reset();
const url = process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_URL;
assert.equal((await create("t-super")).status, 503);
delete process.env.VERCEL_ENV;
assert.equal((await create("t-super")).status, 201, "local development works without Redis");
process.env.VERCEL_ENV = "preview"; process.env.UPSTASH_REDIS_REST_URL = url;

// ── nothing secret leaves the server ─────────────────────────────────────────
reset(); failures.add("profile");
out = await create("t-super");
const everything = `${JSON.stringify(out)}\n${logs.join("\n")}`;
for (const secret of [PASSWORD, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.UPSTASH_REDIS_REST_TOKEN, "t-super"]) assert.ok(!everything.includes(secret), `a secret did not leak: ${secret.slice(0, 6)}...`);
reset();
out = await create("t-super");
const ok = `${JSON.stringify(out)}\n${logs.join("\n")}${JSON.stringify(auditRows)}`;
for (const secret of [PASSWORD, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.UPSTASH_REDIS_REST_TOKEN]) assert.ok(!ok.includes(secret));
// denials are logged by user, role and route only
reset();
await create("t-muni");
assert.ok(logs.some(l => /staff route denied: user=aaaaaaaa-0000-4000-8000-000000000002 role=municipality_admin route="POST \/api\/admin\/staff"/.test(l)));
assert.ok(!logs.join("\n").includes(PASSWORD));

console.warn = origWarn;
console.error = origError;
globalThis.fetch = realFetch;
console.log("staff management ok");
