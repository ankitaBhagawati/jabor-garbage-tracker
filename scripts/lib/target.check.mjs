// Self-check for the staging guard: `node scripts/lib/target.check.mjs`
import assert from "node:assert/strict";
import { PRODUCTION_REF, STAGING_REF, resolveApiTarget, resolveTarget } from "./target.mjs";

const pooler = ref => `postgresql://postgres.${ref}:secret@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`;
const direct = ref => `postgresql://postgres:secret@db.${ref}.supabase.co:5432/postgres`;
const refuse = (env, pattern, opts = {}) => assert.throws(() => resolveTarget({ env, ...opts }), pattern);

// Staging is the only remote target.
for (const url of [pooler(STAGING_REF), direct(STAGING_REF)]) {
  const target = resolveTarget({ env: { STAGING_DB_URL: url } });
  assert.equal(target.kind, "staging");
  assert.equal(target.confirm, STAGING_REF);
  assert.equal(target.pg.PGPASSWORD, "secret");
}
assert.equal(resolveTarget({ env: { STAGING_DB_URL: pooler(STAGING_REF), STAGING_PROJECT_REF: STAGING_REF, VITE_SUPABASE_URL: `https://${STAGING_REF}.supabase.co` } }).kind, "staging");

// Production is refused in every place it can appear.
refuse({ STAGING_DB_URL: pooler(PRODUCTION_REF) }, /production/);
refuse({ STAGING_DB_URL: direct(PRODUCTION_REF) }, /production/);
refuse({ STAGING_DB_URL: pooler(STAGING_REF), VITE_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }, /production/);
refuse({ STAGING_DB_URL: pooler(STAGING_REF), SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }, /production/);
refuse({ STAGING_DB_URL: pooler(STAGING_REF), STAGING_PROJECT_REF: PRODUCTION_REF }, /production/);
refuse({ STAGING_DB_URL: pooler(STAGING_REF), LOCAL_DB_URL: pooler(PRODUCTION_REF) }, /production/);
refuse({ STAGING_DB_URL: pooler(PRODUCTION_REF) }, /production/, { local: true });
// Any other project, a missing URL, and a mixed-up environment are refused too.
refuse({ STAGING_DB_URL: pooler("aaaaaaaaaaaaaaaaaaaa") }, /not the staging project/);
refuse({ STAGING_DB_URL: "postgresql://postgres:secret@db.example.com:5432/postgres" }, /not the staging project/);
refuse({}, /STAGING_DB_URL is not set/);
refuse({ STAGING_DB_URL: pooler(STAGING_REF), VITE_SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" }, /not the staging project/);
refuse({ STAGING_DB_URL: pooler(STAGING_REF), STAGING_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa" }, /not the staging project/);
// A URL naming both projects is not accepted as staging.
refuse({ STAGING_DB_URL: `postgresql://postgres.${STAGING_REF}:secret@db.${PRODUCTION_REF}.supabase.co:5432/postgres` }, /production/);

// --local: this machine only, never a hosted database.
assert.equal(resolveTarget({ env: {}, local: true }).kind, "local");
// --local ignores the staging URL entirely: it never connects there.
const local = resolveTarget({ env: { STAGING_DB_URL: pooler(STAGING_REF) }, local: true });
assert.equal(local.confirm, "local");
assert.equal(local.pg.PGHOST, "127.0.0.1");
refuse({ LOCAL_DB_URL: "postgresql://postgres:x@db.example.com:5432/postgres" }, /on this machine/, { local: true });
refuse({ LOCAL_DB_URL: pooler(STAGING_REF) }, /on this machine|staging database/, { local: true });

// ── The API target (create-demo-staff) ───────────────────────────────────────
const jwtKey = ref => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role", ref })).toString("base64url")}.c2ln`;
const api = (env, opts = {}) => resolveApiTarget({ env, ...opts });
const stagingUrl = `https://${STAGING_REF}.supabase.co`;
assert.equal(api({ SUPABASE_URL: stagingUrl, SUPABASE_SERVICE_ROLE_KEY: jwtKey(STAGING_REF) }).kind, "staging");
assert.equal(api({ VITE_SUPABASE_URL: stagingUrl, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc" }).kind, "staging", "a key with no ref is accepted for the staging URL");
assert.equal(api({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "k" }, { local: true }).confirm, "local");
const refuseApi = (env, pattern, opts) => assert.throws(() => api(env, opts), pattern);
refuseApi({ SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwtKey(PRODUCTION_REF) }, /production/);
refuseApi({ SUPABASE_URL: stagingUrl, SUPABASE_SERVICE_ROLE_KEY: jwtKey(PRODUCTION_REF) }, /production/);
refuseApi({ SUPABASE_URL: stagingUrl, SUPABASE_SERVICE_ROLE_KEY: jwtKey("aaaaaaaaaaaaaaaaaaaa") }, /different project/);
refuseApi({ SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, /not the staging project/);
refuseApi({ SUPABASE_URL: "https://example.com", SUPABASE_SERVICE_ROLE_KEY: "k" }, /not the staging project/);
refuseApi({ SUPABASE_URL: stagingUrl, VITE_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "k" }, /production/);
refuseApi({ SUPABASE_URL: stagingUrl, SUPABASE_SERVICE_ROLE_KEY: "k", STAGING_PROJECT_REF: PRODUCTION_REF }, /production/);
refuseApi({ SUPABASE_URL: stagingUrl }, /must be set/);
refuseApi({ SUPABASE_SERVICE_ROLE_KEY: "k" }, /must be set/);
refuseApi({ SUPABASE_URL: stagingUrl, SUPABASE_SERVICE_ROLE_KEY: "k" }, /on this machine/, { local: true });
refuseApi({ SUPABASE_URL: "https://db.example.com", SUPABASE_SERVICE_ROLE_KEY: "k" }, /on this machine/, { local: true });
refuseApi({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: jwtKey(PRODUCTION_REF) }, /production/, { local: true });

console.log("target guard ok");
