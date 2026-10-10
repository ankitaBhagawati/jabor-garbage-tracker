// Self-check for the API guards: `node api/_lib/check.js`
import assert from "node:assert/strict";

process.env.VITE_CLOUDINARY_CLOUD_NAME = "demo";
const { assertCloudinaryUrl, cookie, rateLimit, readCookies, route } = await import("./server.js");

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  return res;
}
const req = (method, headers = {}) => ({ method, headers: { host: "jabor.in", ...headers }, socket: {} });
const ok = route("POST", (_req, res) => res.status(200).json({ ok: true }));

let res = mockRes();
await ok(req("GET"), res);
assert.equal(res.statusCode, 405);

res = mockRes();
await ok(req("POST", { origin: "https://evil.example" }), res);
assert.equal(res.statusCode, 403, "cross-origin POST must be blocked");

res = mockRes();
await ok(req("POST"), res);
assert.equal(res.statusCode, 403, "POST without Origin must be blocked");

res = mockRes();
await ok(req("POST", { origin: "https://jabor.in" }), res);
assert.equal(res.statusCode, 200);

const ipReq = req("POST", { "x-forwarded-for": "1.2.3.4" });
for (let i = 0; i < 3; i++) await rateLimit(ipReq, "check", 3, 60);
await assert.rejects(rateLimit(ipReq, "check", 3, 60), { status: 429 });

assert.ok(assertCloudinaryUrl("https://res.cloudinary.com/demo/image/upload/v1/jabor/reports/a.webp", "jabor/reports"));
assert.throws(() => assertCloudinaryUrl("https://res.cloudinary.com/other/image/upload/v1/jabor/reports/a.webp", "jabor/reports"));
assert.throws(() => assertCloudinaryUrl("https://res.cloudinary.com/demo/image/upload/v1/jabor/cleanup-proofs/a.webp", "jabor/reports"));

assert.deepEqual(readCookies({ headers: { cookie: "a=1; jabor_at=x%3Dy" } }), { a: "1", jabor_at: "x=y" });
assert.match(cookie(req("GET"), "jabor_at", "t", 60), /HttpOnly; SameSite=Strict; Max-Age=60; Secure$/);
assert.doesNotMatch(cookie(req("GET", { host: "localhost:5173" }), "jabor_at", "t", 60), /Secure/);

// Health: 200 when Supabase answers, 503 with no details on an error status or network failure.
const { default: health } = await import("../health.js");
const realFetch = globalThis.fetch;
const realError = console.error;
console.error = () => {};
for (const [stub, status] of [
  [async () => new Response("[]", { status: 200 }), 200],
  [async () => new Response("boom", { status: 500 }), 503],
  [async () => { throw new Error("unreachable"); }, 503],
]) {
  globalThis.fetch = stub;
  res = mockRes();
  await health(req("GET"), res);
  assert.equal(res.statusCode, status);
  assert.deepEqual(Object.keys(res.body), ["status"]);
}
globalThis.fetch = realFetch;
console.error = realError;

// Sentry scrubbing: no emails, tokens, keys, user, cookies or headers leave the machine.
const { scrubEvent } = await import("../../src/utils/sentryScrub.js");
const scrubbed = JSON.stringify(scrubEvent({
  message: "login failed for a.b+c@gmail.com with eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl and sb_secret_abc123", // gitleaks:allow (fake values)
  user: { email: "a@b.in", ip_address: "1.2.3.4" },
  request: { url: "https://jabor.in/api/admin/login", cookies: { jabor_at: "x" }, headers: { authorization: "Bearer y" }, data: { password: "p" } },
  breadcrumbs: [{ message: "fetch ?apikey=eyJa.eyJb.c" }],
}));
for (const leak of ["@gmail.com", "eyJ", "sb_secret_", "a@b.in", "1.2.3.4", "jabor_at", "Bearer", "password"]) {
  assert.ok(!scrubbed.includes(leak), `Sentry event leaks ${leak}`);
}
assert.ok(scrubbed.includes("https://jabor.in/api/admin/login"), "scrubbing keeps the non-sensitive URL");

console.log("api guards ok");
