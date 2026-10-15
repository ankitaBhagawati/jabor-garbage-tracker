// Turnstile must fail closed in production: `node api/_lib/turnstile.check.js`
import assert from "node:assert/strict";

process.env.VITE_CLOUDINARY_CLOUD_NAME = "demo";
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";
const { isProduction } = await import("./server.js");
const { default: submit } = await import("../reports/submit.js");

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  return res;
}
const SECURITY = /security check|verification/i;
let siteverify; // what Cloudflare answers in this case
let verifyCalls = 0;
let requests = 0; // a new address per request, so the rate limiter stays out of the way
globalThis.fetch = async url => {
  assert.ok(String(url).includes("challenges.cloudflare.com"), `unexpected request in test: ${url}`);
  verifyCalls++;
  return siteverify();
};
const cloudflare = body => () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function post(handler, { vercelEnv, nodeEnv, secret, token = "token", folder }) {
  for (const [name, value] of [["VERCEL_ENV", vercelEnv], ["NODE_ENV", nodeEnv], ["TURNSTILE_SECRET_KEY", secret]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  verifyCalls = 0;
  const res = mockRes();
  await handler({ method: "POST", headers: { host: "jabor.in", origin: "https://jabor.in", "x-forwarded-for": `10.0.0.${++requests}` }, socket: {}, body: { turnstileToken: token, folder } }, res);
  return res;
}
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};

siteverify = cloudflare({ success: true });
assert.equal(isProduction(), false, "plain node (tests, local) is not production");

// Missing secret in production: refused, and Cloudflare is never asked.
let res = await post(submit, { vercelEnv: "production" });
assert.equal(res.statusCode, 503, "missing secret in production must be refused");
assert.equal(verifyCalls, 0);

// VERCEL_ENV unexpectedly missing on a deployed function (NODE_ENV=production) or holding an unknown value: still refused.
res = await post(submit, { nodeEnv: "production" });
assert.equal(res.statusCode, 503, "no VERCEL_ENV on a deployed function must fail closed");
res = await post(submit, { vercelEnv: "something-else" });
assert.equal(res.statusCode, 503, "an unknown VERCEL_ENV must fail closed");

// Missing secret in Preview and locally: the bot check is skipped, as before (the request goes on to validation).
for (const env of [{ vercelEnv: "preview", nodeEnv: "production" }, { vercelEnv: "development" }, {}, { nodeEnv: "development" }]) {
  res = await post(submit, env);
  assert.equal(res.statusCode, 400, `missing secret, ${JSON.stringify(env)}: reaches validation`);
  assert.ok(!SECURITY.test(res.body.error), `missing secret, ${JSON.stringify(env)}: not a bot-check refusal`);
}

// Verification service down: refused everywhere.
siteverify = () => { throw new TypeError("fetch failed"); };
for (const vercelEnv of ["production", "preview", undefined]) {
  res = await post(submit, { vercelEnv, secret: "s" });
  assert.equal(res.statusCode, 503, `Cloudflare down (${vercelEnv}): refused`);
}
siteverify = () => new Response("bad gateway", { status: 502 });
res = await post(submit, { vercelEnv: "production", secret: "s" });
assert.equal(res.statusCode, 400, "a non-JSON answer from Cloudflare is refused");

// Invalid token: refused, with no Cloudflare codes in the answer.
siteverify = cloudflare({ success: false, "error-codes": ["invalid-input-response"] });
res = await post(submit, { vercelEnv: "production", secret: "s" });
assert.equal(res.statusCode, 400);
assert.equal(res.body.error, "Bot verification failed. Please refresh the page and try again.");

// No token at all: refused without asking Cloudflare.
res = await post(submit, { vercelEnv: "production", secret: "s", token: "" });
assert.equal(res.statusCode, 400);
assert.equal(verifyCalls, 0);

// Valid token: passes the bot check and reaches payload validation.
siteverify = cloudflare({ success: true });
res = await post(submit, { vercelEnv: "production", secret: "s" });
assert.equal(verifyCalls, 1);
assert.equal(res.statusCode, 400);
assert.ok(!SECURITY.test(res.body.error), "a valid token is not refused by the bot check");

// Cleanup proofs: Turnstile is checked when the upload is signed (shared verifyTurnstile) and never skipped,
// in any environment. /api/cleanup-proofs itself takes the ticket from that step (see hardening.check.js).
process.env.CLOUDINARY_API_KEY = "k";
process.env.CLOUDINARY_API_SECRET = "s";
const { default: sign } = await import("../cloudinary-signature.js");
for (const vercelEnv of ["production", "preview", undefined]) {
  siteverify = cloudflare({ success: true });
  res = await post(sign, { vercelEnv, folder: "cleanup-proofs" });
  assert.equal(res.statusCode, 503, `cleanup proof signature, missing secret (${vercelEnv}): refused`);
  siteverify = () => { throw new TypeError("fetch failed"); };
  res = await post(sign, { vercelEnv, secret: "s", folder: "cleanup-proofs" });
  assert.equal(res.statusCode, 503, `cleanup proof signature, Cloudflare down (${vercelEnv}): refused`);
  siteverify = cloudflare({ success: false });
  res = await post(sign, { vercelEnv, secret: "s", folder: "cleanup-proofs" });
  assert.equal(res.statusCode, 400, `cleanup proof signature, invalid token (${vercelEnv}): refused`);
  siteverify = cloudflare({ success: true });
  res = await post(sign, { vercelEnv, secret: "s", folder: "cleanup-proofs" });
  assert.equal(res.statusCode, 200, `cleanup proof signature, valid token (${vercelEnv}): signed`);
  assert.match(res.body.proofTicket, /^\d+\.[\w-]+$/);
}

Object.assign(console, quiet);
console.log("turnstile fail-closed ok");
