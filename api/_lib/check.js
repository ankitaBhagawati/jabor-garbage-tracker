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

console.log("api guards ok");
