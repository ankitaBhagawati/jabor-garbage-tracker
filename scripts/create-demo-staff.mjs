#!/usr/bin/env node
// Creates (or updates) two demo staff accounts on STAGING: a super admin and a municipality admin
// for Jorhat (JMB). Uses the Supabase admin API and writes the matching staff_profiles rows.
//
//   node --env-file=.env.local scripts/create-demo-staff.mjs                dry run: says what it would do, changes nothing
//   node --env-file=.env.local scripts/create-demo-staff.mjs --execute      creates or updates the accounts
//   node --env-file=.local/local-app.env scripts/create-demo-staff.mjs --local [--execute]   the local Supabase stack
//
// Settings (from the environment; the same names can be passed as options, but the environment is
// better because command lines end up in shell history):
//   DEMO_SUPER_EMAIL     DEMO_SUPER_PASSWORD     (option: --super-email)
//   DEMO_JMB_EMAIL       DEMO_JMB_PASSWORD       (option: --jmb-email)
//   SUPABASE_URL or VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: the staging project
// Passwords are never printed or logged; only the emails are.
//
// It refuses to run unless the Supabase URL is the staging project (uefijiwklnelmwcipwku), and refuses the
// production project (wukftoblpeybortcnkuw) outright, including through the key (see scripts/lib/target.mjs).
// Safe to run again: an existing account gets the password, role and profile set again.
import { PRODUCTION_REF, STAGING_REF, resolveApiTarget } from "./lib/target.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => !a.includes("=") && !["--super-email", "--jmb-email", "--super-password", "--jmb-password"].includes(a)));
const option = name => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const execute = flags.has("--execute");
const unknown = [...flags].filter(a => !["--execute", "--local"].includes(a) && a.startsWith("--"));

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}
if (unknown.length) fail(`Unknown option: ${unknown.join(" ")}`);

let target;
try {
  target = resolveApiTarget({ local: flags.has("--local") });
} catch (error) {
  fail(error.message);
}

const accounts = [
  {
    label: "super admin", email: option("--super-email") || process.env.DEMO_SUPER_EMAIL, password: option("--super-password") || process.env.DEMO_SUPER_PASSWORD,
    role: "super_admin", fullName: "Demo Super Admin", designation: "Owner (demo)",
  },
  {
    label: "Jorhat municipality admin", email: option("--jmb-email") || process.env.DEMO_JMB_EMAIL, password: option("--jmb-password") || process.env.DEMO_JMB_PASSWORD,
    role: "municipality_admin", fullName: "Demo JMB Admin", designation: "Municipality admin (demo)",
  },
];
for (const a of accounts) {
  a.email = (a.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) fail(`The ${a.label} email is missing or not valid (set ${a.role === "super_admin" ? "DEMO_SUPER_EMAIL" : "DEMO_JMB_EMAIL"}).`);
  if (!a.password || a.password.length < 12) fail(`The ${a.label} password is missing or shorter than 12 characters (set ${a.role === "super_admin" ? "DEMO_SUPER_PASSWORD" : "DEMO_JMB_PASSWORD"}).`);
}
if (accounts[0].email === accounts[1].email) fail("The two accounts need different emails.");

console.log(`${execute ? "EXECUTE" : "DRY RUN"} on ${target.label}`);
console.log(`(production ${PRODUCTION_REF} is refused; staging is ${STAGING_REF})\n`);

// Only the status and Supabase's error code are shown on failure: response bodies can echo emails.
async function call(path, { method = "GET", body, prefer } = {}) {
  const res = await fetch(`${target.url}${path}`, {
    method,
    headers: {
      apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} failed: HTTP ${res.status}${data?.error_code ? ` (${data.error_code})` : ""}`);
  return data;
}

// The admin API has no lookup by email, so list the users page by page.
async function findUser(email) {
  for (let page = 1; page <= 50; page++) {
    const { users = [] } = await call(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const found = users.find(u => (u.email || "").toLowerCase() === email);
    if (found) return found;
    if (users.length < 200) return null;
  }
  throw new Error("More than 10,000 users: stopping the lookup.");
}

try {
  const [municipality] = await call("/rest/v1/municipalities?slug=eq.jorhat&select=id,name&limit=1");
  if (!municipality) fail("There is no Jorhat municipality in this database. Apply the migrations first.");

  for (const account of accounts) {
    const existing = await findUser(account.email);
    const appMetadata = account.role === "municipality_admin" ? { role: account.role, municipality_id: municipality.id } : { role: account.role };
    if (!execute) {
      console.log(`${existing ? "would update" : "would create"} ${account.label}: ${account.email}`);
      continue;
    }

    const attributes = { email: account.email, password: account.password, email_confirm: true, app_metadata: appMetadata };
    const user = existing
      ? await call(`/auth/v1/admin/users/${existing.id}`, { method: "PUT", body: attributes })
      : await call("/auth/v1/admin/users", { method: "POST", body: attributes });
    await call("/rest/v1/staff_profiles?on_conflict=user_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [{
        user_id: user.id, municipality_id: account.role === "municipality_admin" ? municipality.id : null, role: account.role,
        email: account.email, full_name: account.fullName, designation: account.designation, is_active: true,
      }],
    });
    console.log(`${existing ? "updated" : "created"} ${account.label}: ${account.email}`);
  }

  if (!execute) console.log("\nDry run only. Nothing was changed. Add --execute to create or update the accounts.");
} catch (error) {
  fail(error.message);
}
