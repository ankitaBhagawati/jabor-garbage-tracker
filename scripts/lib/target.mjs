// Shared by the staging data scripts: decides which database a script may touch, and runs SQL on it
// with psql. The only targets are the staging project and, with --local, the local Supabase stack.
// Production is refused outright, whatever the environment says.
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";

export const STAGING_REF = "uefijiwklnelmwcipwku";
export const PRODUCTION_REF = "wukftoblpeybortcnkuw";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Project refs named by a database URL: the pooler user (postgres.<ref>) or the direct host (db.<ref>.supabase.co).
function refsInDbUrl(url) {
  const refs = new Set();
  const user = decodeURIComponent(url.username || "");
  if (user.startsWith("postgres.")) refs.add(user.slice("postgres.".length));
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  if (direct) refs.add(direct[1]);
  return refs;
}

// env is process.env (or a test object). Returns the target, or throws with a plain message.
export function resolveTarget({ local = false, env = process.env } = {}) {
  // Any mention of the production ref in the database or API settings stops the script,
  // so a mixed-up .env.local cannot slip through.
  const watched = ["STAGING_DB_URL", "LOCAL_DB_URL", "SUPABASE_URL", "VITE_SUPABASE_URL", "STAGING_PROJECT_REF"];
  for (const name of watched) {
    if ((env[name] || "").includes(PRODUCTION_REF)) {
      throw new Error(`${name} points at the production project. These scripts never run against production.`);
    }
  }

  if (local) {
    const raw = env.LOCAL_DB_URL || LOCAL_DB_URL;
    const url = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("--local only works with a database on this machine.");
    if (raw.includes(STAGING_REF)) throw new Error("--local was given a staging database URL.");
    return { kind: "local", label: "the LOCAL Supabase stack", confirm: "local", pg: pgEnv(url) };
  }

  const raw = env.STAGING_DB_URL;
  if (!raw) throw new Error("STAGING_DB_URL is not set (the session pooler connection string of the staging project).");
  const url = new URL(raw);
  const refs = refsInDbUrl(url);
  if (!refs.has(STAGING_REF) || refs.size !== 1) {
    throw new Error(`STAGING_DB_URL is not the staging project (${STAGING_REF}). Refusing to run.`);
  }
  if (env.STAGING_PROJECT_REF && env.STAGING_PROJECT_REF !== STAGING_REF) {
    throw new Error("STAGING_PROJECT_REF is not the staging project. Refusing to run.");
  }
  for (const name of ["SUPABASE_URL", "VITE_SUPABASE_URL"]) {
    if (env[name] && new URL(env[name]).hostname.split(".")[0] !== STAGING_REF) {
      throw new Error(`${name} is not the staging project. Refusing to run.`);
    }
  }
  return { kind: "staging", label: `the STAGING project (${STAGING_REF})`, confirm: STAGING_REF, pg: pgEnv(url) };
}

// psql takes the connection from PG* variables, so the password never appears in a command line.
function pgEnv(url) {
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || "postgres",
    PGCONNECT_TIMEOUT: "15",
  };
}

// Runs SQL and returns the rows as arrays of strings. Only the ERROR line of a failure is shown,
// because the rest of psql's message can quote row values.
export function runSql(target, sql) {
  const result = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\u001f", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    env: { ...process.env, ...target.pg },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run psql: ${result.error.message}`);
  if (result.status !== 0) {
    const line = (result.stderr || "").split("\n").find(l => l.includes("ERROR:")) || "psql failed.";
    throw new Error(line.replace(/^.*ERROR:\s*/, "SQL error: ").slice(0, 300));
  }
  return result.stdout.split("\n").filter(Boolean).map(line => line.split("\u001f"));
}

export const count = (target, sql) => Number(runSql(target, sql)[0]?.[0] ?? 0);

// The extra step before anything is changed: type the project ref (or "local").
export async function confirmTyped(target) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type ${target.confirm} to continue: `)).trim();
  rl.close();
  if (answer !== target.confirm) throw new Error("Confirmation did not match. Nothing was changed.");
}

export function printTable(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map(w => "-".repeat(w)).join("  "));
  rows.forEach(r => console.log(line(r)));
}

// ── The Supabase API (admin users and REST with the service role key) ─────────
// The project ref inside a legacy service role key (a JWT) is checked too, so a production key cannot be
// paired with a staging URL by mistake. Newer sb_secret_ keys carry no ref and cannot be checked this way.
function keyRef(key) {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString()).ref ?? null; } catch { return null; }
}

// Returns { kind, url, serviceKey, confirm } for the staging project or, with local, this machine's stack.
export function resolveApiTarget({ local = false, env = process.env } = {}) {
  const watched = ["SUPABASE_URL", "VITE_SUPABASE_URL", "STAGING_PROJECT_REF", "STAGING_DB_URL"];
  for (const name of watched) {
    if ((env[name] || "").includes(PRODUCTION_REF)) throw new Error(`${name} points at the production project. These scripts never run against production.`);
  }
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const urlText = env.SUPABASE_URL || env.VITE_SUPABASE_URL || "";
  if (!urlText || !serviceKey) throw new Error("SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY must be set for the project you are targeting.");
  const url = new URL(urlText);
  const ref = keyRef(serviceKey);
  if (ref === PRODUCTION_REF) throw new Error("SUPABASE_SERVICE_ROLE_KEY belongs to the production project. These scripts never run against production.");

  if (local) {
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("--local only works with a Supabase stack on this machine.");
    return { kind: "local", label: "the LOCAL Supabase stack", url: url.origin, serviceKey, confirm: "local" };
  }
  if (!url.hostname.endsWith(".supabase.co") || url.hostname.split(".")[0] !== STAGING_REF) {
    throw new Error(`The Supabase URL is not the staging project (${STAGING_REF}). Refusing to run.`);
  }
  if (ref && ref !== STAGING_REF) throw new Error("SUPABASE_SERVICE_ROLE_KEY belongs to a different project than the staging URL. Refusing to run.");
  if (env.STAGING_PROJECT_REF && env.STAGING_PROJECT_REF !== STAGING_REF) throw new Error("STAGING_PROJECT_REF is not the staging project. Refusing to run.");
  return { kind: "staging", label: `the STAGING project (${STAGING_REF})`, url: url.origin, serviceKey, confirm: STAGING_REF };
}
