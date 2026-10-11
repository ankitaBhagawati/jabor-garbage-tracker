// Self-check for the API guards: `node api/_lib/check.js`
import assert from "node:assert/strict";

process.env.VITE_CLOUDINARY_CLOUD_NAME = "demo";
const { assertCloudinaryUrl, cloudinaryFolder, cookie, rateLimit, readCookies, route } = await import("./server.js");

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

// Upload folders: default prefix is production's; the env var moves an environment elsewhere.
assert.equal(cloudinaryFolder("reports"), "jabor/reports");
assert.equal(cloudinaryFolder("cleanup-proofs"), "jabor/cleanup-proofs");
assert.throws(() => cloudinaryFolder("anything-else"), { status: 400 });
process.env.CLOUDINARY_FOLDER_PREFIX = "jabor-staging";
assert.equal(cloudinaryFolder("reports"), "jabor-staging/reports");
process.env.CLOUDINARY_FOLDER_PREFIX = "../escape";
assert.throws(() => cloudinaryFolder("reports"), /not a valid folder path/);
delete process.env.CLOUDINARY_FOLDER_PREFIX;

// The signature route ignores any prefix the browser sends.
process.env.CLOUDINARY_API_KEY = "k";
process.env.CLOUDINARY_API_SECRET = "s";
const { default: sign } = await import("../cloudinary-signature.js");
const signReq = folder => ({ ...req("POST", { origin: "https://jabor.in", "x-forwarded-for": "9.9.9.9" }), body: { folder } });
for (const [sent, got] of [["reports", "jabor/reports"], ["jabor/reports", "jabor/reports"], ["someone-else/cleanup-proofs", "jabor/cleanup-proofs"]]) {
  res = mockRes();
  await sign(signReq(sent), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.folder, got);
}
process.env.CLOUDINARY_FOLDER_PREFIX = "jabor-staging";
res = mockRes();
await sign(signReq("jabor/reports"), res);
assert.equal(res.body.folder, "jabor-staging/reports", "an old client asking for jabor/reports still lands in the staging folder");
res = mockRes();
await sign(signReq("jabor/secrets"), res);
assert.equal(res.statusCode, 400);
delete process.env.CLOUDINARY_FOLDER_PREFIX;

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

// Report submit: a request with no Turnstile token gets a plain message and no Cloudflare codes.
process.env.TURNSTILE_SECRET_KEY = "test-secret";
const { default: submit } = await import("../reports/submit.js");
const quiet = { log: console.log, warn: console.warn };
console.log = console.warn = () => {};
res = mockRes();
await submit({ method: "POST", headers: { host: "jabor.in" }, socket: {}, body: { area: "x" } }, res);
Object.assign(console, quiet);
assert.equal(res.statusCode, 400);
assert.equal(res.body.error, "The security check did not run. Please refresh the page and try again.");
assert.ok(!JSON.stringify(res.body).includes("missing-token"), "error codes must not reach the client");

console.log("api guards ok");
