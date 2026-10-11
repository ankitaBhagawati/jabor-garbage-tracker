// Tests for the edge functions' access rules: `node api/_lib/edge.check.js`
// The decision code is plain TypeScript in supabase/functions/_shared, run here by node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { isActiveSuperAdmin } = await import("../../supabase/functions/_shared/roles.ts");
const { authorizeNotify, secretsMatch } = await import("../../supabase/functions/_shared/notify-auth.ts");

// ── super admin only ─────────────────────────────────────────────────────────
const active = { role: "super_admin", is_active: true };
assert.equal(isActiveSuperAdmin("admin", active), true, "the older admin role maps to super admin");
assert.equal(isActiveSuperAdmin("super_admin", active), true);
for (const [role, profile] of [
  ["municipality_admin", { role: "municipality_admin", is_active: true }], ["municipality_admin", active], ["admin", { role: "municipality_admin", is_active: true }],
  ["super_admin", { role: "municipality_admin", is_active: true }], ["admin", { ...active, is_active: false }], ["admin", { ...active, is_active: null }],
  ["admin", { role: "super_admin" }], ["admin", null], ["admin", undefined], ["authenticated", active], ["service_role", active], [undefined, active], [null, active], ["", active], ["Admin", active],
]) assert.equal(isActiveSuperAdmin(role, profile), false, JSON.stringify([role, profile]));

// ── jabor-notify: the shared secret is the only credential ───────────────────
const SECRET = "s3cret-value-for-tests";
const jwt = role => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "authenticated", app_metadata: { role } })).toString("base64url")}.c2lnbmF0dXJl`;
const request = headers => new Request("https://project.supabase.co/functions/v1/jabor-notify", { method: "POST", headers, body: "{}" });
const status = async (headers, secret = SECRET) => (await authorizeNotify(request(headers), secret))?.status ?? "allowed";

assert.equal(await status({ "x-jabor-notify-secret": SECRET }), "allowed");
assert.equal(await status({ "x-jabor-notify-secret": SECRET, Authorization: `Bearer ${jwt("anon")}` }), "allowed", "the server calls it with the anon key and the secret");
for (const role of ["municipality_admin", "super_admin", "admin"]) {
  assert.equal(await status({ Authorization: `Bearer ${jwt(role)}`, apikey: jwt(role) }), 403, `a ${role} JWT without the secret is refused`);
  assert.equal(await status({ Authorization: `Bearer ${jwt(role)}`, "x-jabor-notify-secret": "wrong" }), 403, `a ${role} JWT with a wrong secret is refused`);
}
for (const given of ["", "wrong", SECRET.slice(0, -1), SECRET + "x", SECRET.toUpperCase(), SECRET.slice(1), "a".repeat(10000)]) assert.equal(await status({ "x-jabor-notify-secret": given }), 403, given.slice(0, 20));
assert.equal(await status({}), 403, "no credential at all");
for (const secret of [undefined, ""]) {
  assert.equal(await status({ "x-jabor-notify-secret": "" }, secret), 403, "an unset secret never matches an empty header");
  assert.equal(await status({ "x-jabor-notify-secret": "anything" }, secret), 403, "fails closed when the secret is not configured");
  assert.equal(await status({}, secret), 403);
}
const denied = await authorizeNotify(request({}), SECRET);
assert.deepEqual(await denied.json(), { error: "Forbidden." });
assert.equal(denied.headers.get("content-type"), "application/json");
assert.equal(await secretsMatch("a", "a"), true);
assert.equal(await secretsMatch("a", "b"), false);
assert.equal(await secretsMatch("", ""), true);
assert.equal(await secretsMatch(" a", "a"), false, "whitespace counts");
assert.equal(await secretsMatch("a", "a".repeat(5000)), false, "different lengths compare the same way");

// ── the functions really call their guard before touching data ───────────────
const read = name => readFileSync(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url), "utf8");
for (const name of ["jabor-recommendations", "jabor-execute", "jabor-embed"]) {
  const code = read(name);
  assert.ok(code.includes("requireSuperAdmin(req)"), `${name} checks for a super admin`);
  assert.ok(!code.includes("requireAdmin"), `${name} no longer uses the old check`);
  assert.ok(code.indexOf("requireSuperAdmin(req)") < code.search(/\.from\(|\.rpc\(|fetch\(/), `${name} checks before any data access or outbound call`);
}
const notify = read("jabor-notify");
assert.ok(notify.includes("authorizeNotify(req, Deno.env.get(\"NOTIFY_SHARED_SECRET\"))"));
assert.ok(notify.indexOf("authorizeNotify(") < notify.indexOf("req.json()") && notify.indexOf("authorizeNotify(") < notify.indexOf("createClient("), "notify checks the secret before reading the body or using the service role");
assert.ok(!notify.includes("!== secret"), "no plain string comparison of the secret");
const shared = readFileSync(new URL("../../supabase/functions/_shared/auth.ts", import.meta.url), "utf8");
assert.ok(shared.includes("isActiveSuperAdmin(role, profile)") && shared.includes('.from("staff_profiles")'), "the shared check reads the staff profile");
assert.ok(shared.indexOf("isActiveSuperAdmin(") > shared.indexOf("getUser(token)"), "the token is verified before the profile is judged");

console.log("edge function access ok");
