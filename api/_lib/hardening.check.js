// Public routes fail with a 4xx and a plain { error } body on bad input, and 503 on missing config:
// `node api/_lib/hardening.check.js`
import assert from "node:assert/strict";

process.env.VITE_CLOUDINARY_CLOUD_NAME = "demo";
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon-for-tests";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";
process.env.CLOUDINARY_API_KEY = "k";
process.env.CLOUDINARY_API_SECRET = "s";
process.env.TURNSTILE_SECRET_KEY = "t";
delete process.env.SENTRY_DSN;
const { issueProofTicket } = await import("./server.js");
const routes = {
  login: (await import("../admin/login.js")).default,
  sign: (await import("../cloudinary-signature.js")).default,
  proofs: (await import("../cleanup-proofs.js")).default,
  submit: (await import("../reports/submit.js")).default,
};

const REPORT = "11111111-1111-4111-8111-111111111111";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
let turnstileOk = true;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("challenges.cloudflare.com")) return json({ success: turnstileOk });
  if (url.includes("/auth/v1/token")) {
    const { password } = JSON.parse(init.body);
    return password === "right" ? json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) : json({ error_code: "invalid_credentials" }, 400);
  }
  if (url.includes("/auth/v1/user")) return json({ id: "22222222-2222-4222-8222-222222222222", app_metadata: {} });
  if (url.includes("/auth/v1/logout")) return json({});
  if (url.includes("/rest/v1/staff_profiles")) return json([]);
  if (url.includes("/rest/v1/reports?id=eq.")) return json([{ id: REPORT }]);
  if (url.includes("/rest/v1/cleanup_proofs")) return new Response(null, { status: 201 });
  throw new Error(`unexpected request in test: ${url}`);
};

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  return res;
}
let ipCounter = 0;
const nextIp = () => `10.1.0.${++ipCounter}`;
async function call(route, { body = {}, origin = "https://jabor.in", ip = nextIp(), badJson = false } = {}) {
  const req = { method: "POST", headers: { host: "jabor.in", "x-forwarded-for": ip, ...(origin !== null && { origin }) }, socket: {} };
  // Vercel's lazy body parser throws on malformed JSON; mimic it.
  Object.defineProperty(req, "body", { get: () => { if (badJson) throw new Error("Invalid JSON"); return body; } });
  const res = mockRes();
  await route(req, res);
  return res;
}
function expectError(res, status, label) {
  assert.equal(res.statusCode, status, `${label}: ${res.statusCode} ${JSON.stringify(res.body)}`);
  assert.deepEqual(Object.keys(res.body), ["error"], `${label}: only { error }`);
  assert.equal(typeof res.body.error, "string");
  assert.doesNotMatch(res.body.error, /\bat \w|Error:|supabase|TURNSTILE|CLOUDINARY|stack/i, `${label}: no internals`);
}
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};

// Every route: missing, "null" and garbage Origin are 403; malformed JSON is 400; null and string bodies are 400.
for (const [name, route] of Object.entries(routes)) {
  expectError(await call(route, { origin: null }), 403, `${name} without Origin`);
  expectError(await call(route, { origin: "null" }), 403, `${name} with Origin: null`);
  expectError(await call(route, { origin: "not a url" }), 403, `${name} with a garbage Origin`);
  expectError(await call(route, { origin: "https://evil.example" }), 403, `${name} cross-origin`);
  expectError(await call(route, { badJson: true }), 400, `${name} with malformed JSON`);
  expectError(await call(route, { body: null }), 400, `${name} with a null body`);
  expectError(await call(route, { body: "hello" }), 400, `${name} with a text/plain body`);
  expectError(await call(route, { body: { turnstileToken: "" } }), 400, `${name} with an empty token`);
}

// Login: 401 on a wrong password, 403 for a valid account that is not active staff, 429 past 5 tries.
expectError(await call(routes.login, { body: { email: "a@b.in", password: "wrong" } }), 401, "login wrong password");
expectError(await call(routes.login, { body: { email: "a@b.in", password: "right" } }), 403, "login not staff");
let ip = nextIp();
for (let i = 0; i < 5; i++) await call(routes.login, { ip, body: { email: "a@b.in", password: "wrong" } });
expectError(await call(routes.login, { ip, body: { email: "a@b.in", password: "wrong" } }), 429, "login rate limit");

// Signature: reports stays anonymous; cleanup proofs need Turnstile; unknown folders are refused; 20 per 10 minutes.
let res = await call(routes.sign, { body: { folder: "reports" } });
assert.equal(res.statusCode, 200);
assert.equal(res.body.proofTicket, undefined, "a report signature carries no proof ticket");
assert.equal(res.body.allowedFormats, "jpg,jpeg,png,webp");
expectError(await call(routes.sign, { body: { folder: "cleanup-proofs" } }), 400, "proof signature without a token");
turnstileOk = false;
expectError(await call(routes.sign, { body: { folder: "cleanup-proofs", turnstileToken: "x" } }), 400, "proof signature, failed token");
turnstileOk = true;
res = await call(routes.sign, { body: { folder: "cleanup-proofs", turnstileToken: "x" } });
assert.equal(res.statusCode, 200);
assert.ok(res.body.proofTicket);
for (const folder of ["secrets", "jabor/secrets", "", "../reports/x"]) {
  expectError(await call(routes.sign, { body: { folder } }), 400, `signature for folder "${folder}"`);
}
ip = nextIp();
for (let i = 0; i < 20; i++) assert.equal((await call(routes.sign, { ip, body: { folder: "reports" } })).statusCode, 200);
expectError(await call(routes.sign, { ip, body: { folder: "reports" } }), 429, "signature rate limit");
delete process.env.CLOUDINARY_API_KEY;
expectError(await call(routes.sign, { body: { folder: "reports" } }), 503, "signature without Cloudinary config");
process.env.CLOUDINARY_API_KEY = "k";

// Cleanup proofs: the ticket must be present, unexpired, untampered and from the same address.
const proof = { report_id: REPORT, image_url: "https://res.cloudinary.com/demo/image/upload/v1/jabor/cleanup-proofs/a.webp", cleaned_date_estimate: "today" };
const ticketFor = addr => issueProofTicket({ headers: { "x-forwarded-for": addr }, socket: {} });
ip = nextIp();
expectError(await call(routes.proofs, { ip, body: proof }), 400, "proof without a ticket");
expectError(await call(routes.proofs, { ip, body: { ...proof, turnstileToken: "x" } }), 400, "proof with only a Turnstile token");
expectError(await call(routes.proofs, { ip, body: { ...proof, proofTicket: ticketFor("10.9.9.9") } }), 400, "proof ticket from another address");
expectError(await call(routes.proofs, { ip, body: { ...proof, proofTicket: ticketFor(ip).replace(/.$/, c => (c === "A" ? "B" : "A")) } }), 400, "tampered proof ticket");
expectError(await call(routes.proofs, { ip, body: { ...proof, proofTicket: `1.${ticketFor(ip).split(".")[1]}` } }), 400, "expired proof ticket");
ip = nextIp();
res = await call(routes.proofs, { ip, body: { ...proof, proofTicket: ticketFor(ip) } });
assert.equal(res.statusCode, 201, `valid proof ticket: ${JSON.stringify(res.body)}`);
ip = nextIp();
for (let i = 0; i < 5; i++) await call(routes.proofs, { ip, body: proof });
expectError(await call(routes.proofs, { ip, body: { ...proof, proofTicket: ticketFor(ip) } }), 429, "proof rate limit");

// Report submit: missing config is a 503 with a generic message.
delete process.env.VITE_CLOUDINARY_CLOUD_NAME;
expectError(await call(routes.submit, { body: { turnstileToken: "x", area: "a", district: "d", constituency: "c" } }), 503, "submit without Cloudinary config");
process.env.VITE_CLOUDINARY_CLOUD_NAME = "demo";

Object.assign(console, quiet);
console.log("route hardening ok");
