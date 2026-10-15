// Self-check for the API guards: `node api/_lib/check.js`
import assert from "node:assert/strict";

process.env.VITE_CLOUDINARY_CLOUD_NAME = "demo";
// Stubbed Supabase: the checks below never reach a real project.
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";
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
assert.throws(() => cloudinaryFolder("reports"), { status: 503, detail: /not a valid folder path/ });
delete process.env.CLOUDINARY_FOLDER_PREFIX;

// The signature route ignores any prefix the browser sends.
process.env.CLOUDINARY_API_KEY = "k";
process.env.CLOUDINARY_API_SECRET = "s";
const { default: sign } = await import("../cloudinary-signature.js");
const signReq = folder => ({ ...req("POST", { origin: "https://jabor.in", "x-forwarded-for": "9.9.9.9" }), body: { folder } });
for (const [sent, got] of [["reports", "jabor/reports"], ["jabor/reports", "jabor/reports"], ["someone-else/reports", "jabor/reports"]]) {
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
await submit({ method: "POST", headers: { host: "jabor.in", origin: "https://jabor.in" }, socket: {}, body: { area: "x" } }, res);
Object.assign(console, quiet);
assert.equal(res.statusCode, 400);
assert.equal(res.body.error, "The security check did not run. Please refresh the page and try again.");
assert.ok(!JSON.stringify(res.body).includes("missing-token"), "error codes must not reach the client");

// ── Public report placement: municipality and ward are decided on the server ──
const JORHAT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WARD_J1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const WARD_O1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const municipalityRows = [
  { id: JORHAT, name: "Jorhat Municipal Board", is_active: true, settings: { public_form: { district: "Jorhat", constituencies: ["Jorhat"] } } },
  { id: OTHER, name: "Other Town", is_active: true, settings: {} },
];
const wardOwner = { [WARD_J1]: JORHAT, [WARD_O1]: OTHER };

let inserted = [];
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
let mlaLookups = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("challenges.cloudflare.com")) return jsonResponse({ success: true });
  if (url.includes("/rest/v1/municipalities")) return jsonResponse(municipalityRows);
  if (url.includes("/rest/v1/wards")) {
    const id = /id=eq\.([^&]+)/.exec(url)?.[1];
    const municipality = /municipality_id=eq\.([^&]+)/.exec(url)?.[1];
    return jsonResponse(wardOwner[id] && wardOwner[id] === municipality ? [{ id }] : []);
  }
  if (url.includes("/rest/v1/mla_list")) mlaLookups++;
  if (url.includes("/rest/v1/mla_list")) return jsonResponse([{ name: "Test MLA", party: "T", lok_sabha_seat: "" }]);
  if (url.includes("/rest/v1/reports") && init.method === "POST") { inserted.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
  throw new Error(`unexpected request in test: ${url}`);
};

let photoCounter = 0;
async function submitReport(extra, place = { district: "Jorhat", constituency: "Jorhat" }) {
  inserted = [];
  const out = mockRes();
  await submit({
    method: "POST", headers: { host: "jabor.in", origin: "https://jabor.in" }, socket: {},
    body: {
      turnstileToken: "token", area: "Test area", waste_type: "mixed", ...place,
      photo_url: `https://res.cloudinary.com/demo/image/upload/v1/jabor/reports/t${++photoCounter}.webp`, ...extra,
    },
  }, out);
  return { status: out.statusCode, body: out.body, row: inserted[0] };
}
console.log = console.warn = () => {};
const cases = [
  ["yes with a valid ward", { municipality_answer: "yes", ward_id: WARD_J1 }, 200, { municipality_id: JORHAT, ward_id: WARD_J1, claimed_in_municipality: "yes" }],
  ["yes, ward not chosen (JMB will assign)", { municipality_answer: "yes", ward_id: null }, 200, { municipality_id: JORHAT, ward_id: null, claimed_in_municipality: "yes" }],
  ["yes with a ward from another municipality", { municipality_answer: "yes", ward_id: WARD_O1 }, 400],
  ["yes with a ward that does not exist", { municipality_answer: "yes", ward_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, 400],
  ["yes with a malformed ward id", { municipality_answer: "yes", ward_id: "7" }, 400],
  ["no", { municipality_answer: "no" }, 200, { municipality_id: null, ward_id: null, claimed_in_municipality: "no" }],
  ["no with a ward", { municipality_answer: "no", ward_id: WARD_J1 }, 400],
  ["not sure", { municipality_answer: "not_sure" }, 200, { municipality_id: JORHAT, ward_id: null, claimed_in_municipality: "not_sure" }],
  ["not sure with a ward", { municipality_answer: "not_sure", ward_id: WARD_J1 }, 400],
  ["answer missing for Jorhat", {}, 400],
  ["answer not one of yes, no, not_sure", { municipality_answer: "maybe" }, 400],
  ["forged municipality_id with no", { municipality_answer: "no", municipality_id: OTHER }, 200, { municipality_id: null, claimed_in_municipality: "no" }],
  ["forged municipality_id with yes", { municipality_answer: "yes", ward_id: WARD_J1, municipality_id: OTHER }, 200, { municipality_id: JORHAT, ward_id: WARD_J1 }],
  ["forged municipality_id with not sure", { municipality_answer: "not_sure", municipality_id: OTHER }, 200, { municipality_id: JORHAT }],
];
for (const [name, extra, status, expected] of cases) {
  const out = await submitReport(extra);
  assert.equal(out.status, status, `${name}: status ${out.status} ${JSON.stringify(out.body)}`);
  if (status === 200) {
    assert.equal(out.row.source, "public", `${name}: source is set by the server`);
    for (const [key, value] of Object.entries(expected)) assert.equal(out.row[key], value, `${name}: ${key}`);
  } else {
    assert.equal(out.row, undefined, `${name}: nothing is stored on a rejection`);
    assert.ok(out.body.error && !/supabase|sql|uuid/i.test(out.body.error), `${name}: plain error message`);
  }
}
// MLA and MP are looked up once per constituency per warm instance, not once per report.
assert.equal(mlaLookups, 1, "the representatives lookup is cached");
// Anything else a client sends is ignored: only the whitelisted fields reach the row.
const forged = await submitReport({ municipality_answer: "no", status: "cleaned", is_deleted: true, cleaned_by_type: "jmb", source: "demo", in_municipality: true, admin_note: "x" });
assert.equal(forged.status, 200);
for (const key of ["status", "is_deleted", "cleaned_by_type", "in_municipality", "admin_note"]) assert.equal(key in forged.row, false, `forged ${key} is dropped`);
assert.equal(forged.row.source, "public");
// Elsewhere (no municipality asks the question) nothing changes.
const kamrup = { district: "Kamrup", constituency: "Dispur" };
let out = await submitReport({}, kamrup);
assert.equal(out.status, 200);
assert.deepEqual([out.row.municipality_id, out.row.ward_id, out.row.claimed_in_municipality], [null, null, null]);
out = await submitReport({ municipality_answer: "yes" }, kamrup);
assert.equal(out.status, 200, "an answer sent for a location that is not asked is ignored");
assert.deepEqual([out.row.municipality_id, out.row.claimed_in_municipality], [null, null]);
out = await submitReport({ ward_id: WARD_J1 }, kamrup);
assert.equal(out.status, 400, "a ward outside a municipal area is rejected");
// A municipality that is switched off asks nothing.
municipalityRows[0].is_active = false;
out = await submitReport({});
assert.equal(out.status, 200);
assert.equal(out.row.municipality_id, null);
municipalityRows[0].is_active = true;
// Another municipality switches on by data alone.
municipalityRows[1].settings = { public_form: { district: "Kamrup", constituencies: ["Dispur"] } };
out = await submitReport({ municipality_answer: "yes", ward_id: WARD_O1 }, kamrup);
assert.deepEqual([out.status, out.row.municipality_id, out.row.ward_id], [200, OTHER, WARD_O1]);
out = await submitReport({ municipality_answer: "yes", ward_id: WARD_J1 }, kamrup);
assert.equal(out.status, 400, "a ward of another municipality is rejected there too");
municipalityRows[1].settings = {};

// The public form's config route lists wards without ids of municipalities or settings.
globalThis.fetch = async url => {
  url = String(url);
  if (url.includes("/rest/v1/municipalities")) return jsonResponse(municipalityRows);
  if (url.includes("/rest/v1/wards")) return jsonResponse([{ id: WARD_J1, municipality_id: JORHAT, number: 1, name: null }, { id: WARD_J1.replace(/1$/, "2"), municipality_id: JORHAT, number: 2, name: "Named" }]);
  if (url.includes("/rest/v1/ward_localities")) return jsonResponse([{ ward_id: WARD_J1, name: "L1" }, { ward_id: WARD_J1, name: "L2" }, { ward_id: WARD_J1, name: "L3" }, { ward_id: WARD_J1, name: "L4" }]);
  throw new Error(`unexpected request in test: ${url}`);
};
const { default: municipalitiesRoute } = await import("../municipalities.js");
res = mockRes();
await municipalitiesRoute({ ...req("GET"), headers: { host: "jabor.in", "x-forwarded-for": "7.7.7.7" } }, res);
assert.equal(res.statusCode, 200);
assert.equal(res.body.municipalities.length, 1, "only municipalities with public_form are listed");
const listed = res.body.municipalities[0];
assert.deepEqual(Object.keys(listed).sort(), ["constituencies", "district", "name", "wards"]);
assert.deepEqual(listed.wards[0].localities, ["L1", "L2", "L3"], "at most three localities per ward");
assert.ok(!JSON.stringify(res.body).includes(JORHAT), "the municipality id is not exposed");
Object.assign(console, quiet);
globalThis.fetch = realFetch;

// Client logic of the same question (plain TypeScript, run by node).
const placement = await import("../../src/report/placement.ts");
const jorhat = { name: "Jorhat Municipal Board", district: "Jorhat", constituencies: ["Jorhat"], wards: [] };
assert.equal(placement.findMunicipality([jorhat], "Jorhat", "Jorhat"), jorhat);
assert.equal(placement.findMunicipality([jorhat], "Jorhat", "Mariani"), null);
assert.equal(placement.findMunicipality([jorhat], "Kamrup", "Jorhat"), null);
assert.equal(placement.wardLabel({ id: "x", number: 7, name: null, localities: [] }), "Ward 7");
assert.equal(placement.wardLabel({ id: "x", number: 7, name: "Named", localities: ["A"] }), "Ward 7 · Named");
assert.equal(placement.wardLabel({ id: "x", number: 7, name: null, localities: ["A", "B"] }), "Ward 7 · A, B");
assert.equal(placement.placementError(null, "", ""), "");
assert.match(placement.placementError(jorhat, "", ""), /within the Jorhat Municipal Board area/);
assert.match(placement.placementError(jorhat, "yes", ""), /choose a ward/);
assert.equal(placement.placementError(jorhat, "yes", placement.WARD_NOT_SURE), "");
assert.equal(placement.placementError(jorhat, "no", ""), "");
assert.equal(placement.placementError(jorhat, "not_sure", ""), "");
assert.deepEqual(placement.placementFields(null, "yes", WARD_J1), {});
assert.deepEqual(placement.placementFields(jorhat, "yes", WARD_J1), { municipality_answer: "yes", ward_id: WARD_J1 });
assert.deepEqual(placement.placementFields(jorhat, "yes", placement.WARD_NOT_SURE), { municipality_answer: "yes", ward_id: null });
assert.deepEqual(placement.placementFields(jorhat, "no", WARD_J1), { municipality_answer: "no", ward_id: null }, "a ward is never sent with No");
assert.deepEqual(placement.placementFields(jorhat, "not_sure", WARD_J1), { municipality_answer: "not_sure", ward_id: null });

console.log("api guards ok");
