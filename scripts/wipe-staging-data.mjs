#!/usr/bin/env node
// Empties report data from the STAGING database and replaces real authority contacts with fakes,
// so staging can be filled with demo data. See docs/DEMO-DATA.md for the run order.
//
//   node --env-file=.env.local scripts/wipe-staging-data.mjs              dry run: counts only, changes nothing
//   node --env-file=.env.local scripts/wipe-staging-data.mjs --execute     asks you to type the staging project ref
//   node --env-file=.local/local-app.env scripts/wipe-staging-data.mjs --local [--execute]   the local Supabase stack
//
// DELETES (everything made from reports):
//   reports                 and, through foreign keys, cleanup_proofs and report_contacts
//   recommendations_audit   AI suggestions per report, including suggested authority emails
//   report_activity         hourly report counts per constituency
//   audit_log               only rows with entity_type = 'report' (the log is append-only, so the
//                           script switches off its no-delete trigger inside the same transaction)
// REPLACES:
//   authority_contacts      name, email and phone of every row become fake values
//                           (Demo Authority NN, authority-NN@example.invalid, 0000000000)
// KEEPS (printed with counts when the script runs):
//   staff_profiles, municipalities, wards, ward_localities, mla_list, mp_list, constituencies,
//   escalation_guidelines, audit_log rows about staff, and every auth user.
//
// Cloudinary: this script NEVER calls Cloudinary and does not delete or change any image.
// Photos stay where they are; only the database rows that point at them are removed.
//
// It refuses to run against production or any other project (see scripts/lib/target.mjs), reads
// credentials from the environment only, and never prints them or any row values.
import { PRODUCTION_REF, STAGING_REF, confirmTyped, count, printTable, resolveTarget, runSql } from "./lib/target.mjs";

const DELETE_TABLES = ["reports", "cleanup_proofs", "report_contacts", "recommendations_audit", "report_activity"];
const KEEP_TABLES = ["staff_profiles", "municipalities", "wards", "ward_localities", "mla_list", "mp_list", "constituencies", "escalation_guidelines"];
const REPLACE_TABLES = ["authority_contacts"];
// audit_log is handled on its own (only report rows go).
const KNOWN = new Set([...DELETE_TABLES, ...KEEP_TABLES, ...REPLACE_TABLES, "audit_log"]);

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const unknownArgs = [...args].filter(a => !["--execute", "--local"].includes(a));
if (unknownArgs.length) fail(`Unknown option: ${unknownArgs.join(" ")}`);

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

let target;
try {
  target = resolveTarget({ local: args.has("--local") });
} catch (error) {
  fail(error.message);
}

console.log(`${execute ? "EXECUTE" : "DRY RUN"} on ${target.label}`);
console.log(`(production ${PRODUCTION_REF} is refused; staging is ${STAGING_REF})\n`);

try {
  // A table nobody classified would silently keep report data, so stop and ask for it to be classified.
  const tables = runSql(target, "select tablename from pg_tables where schemaname = 'public' order by 1").map(r => r[0]);
  const unknown = tables.filter(t => !KNOWN.has(t));
  if (unknown.length) {
    fail(`These tables are not in the wipe or keep list: ${unknown.join(", ")}.\nAdd each one to DELETE_TABLES or KEEP_TABLES in this script first.`);
  }
  const present = name => tables.includes(name);

  console.log("Would delete:");
  const deleteRows = DELETE_TABLES.filter(present).map(t => [t, count(target, `select count(*) from public.${t}`)]);
  deleteRows.push(["audit_log (entity_type = report)", count(target, "select count(*) from public.audit_log where entity_type = 'report'")]);
  printTable(deleteRows, ["table", "rows"]);

  console.log("\nWould replace with fake values:");
  printTable(REPLACE_TABLES.filter(present).map(t => [t, count(target, `select count(*) from public.${t}`)]), ["table", "rows"]);

  console.log("\nKept as they are:");
  const keepRows = KEEP_TABLES.filter(present).map(t => [t, count(target, `select count(*) from public.${t}`)]);
  keepRows.push(["audit_log (everything else)", count(target, "select count(*) from public.audit_log where entity_type <> 'report'")]);
  keepRows.push(["auth.users", count(target, "select count(*) from auth.users")]);
  printTable(keepRows, ["table", "rows"]);
  console.log("\nCloudinary is not touched.");
  console.log("Review escalation_guidelines yourself: it is kept, and its guidance text may name real people.");

  if (!execute) {
    console.log("\nDry run only. Nothing was changed. Add --execute to wipe.");
    process.exit(0);
  }

  await confirmTyped(target);

  // One transaction: all of it happens, or none of it. The audit trigger is switched back on before commit.
  runSql(target, `
begin;
alter table public.audit_log disable trigger audit_log_no_update_delete;
delete from public.audit_log where entity_type = 'report';
alter table public.audit_log enable trigger audit_log_no_update_delete;
${present("recommendations_audit") ? "delete from public.recommendations_audit;" : ""}
${present("report_contacts") ? "delete from public.report_contacts;" : ""}
${present("cleanup_proofs") ? "delete from public.cleanup_proofs;" : ""}
${present("report_activity") ? "delete from public.report_activity;" : ""}
delete from public.reports;
with numbered as (
  select id, row_number() over (order by created_at, id) as n from public.authority_contacts
)
update public.authority_contacts a
set name = 'Demo Authority ' || to_char(n.n, 'FM000'),
    email = 'authority-' || to_char(n.n, 'FM000') || '@example.invalid',
    phone = '0000000000'
from numbered n where a.id = n.id;
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.audit_log'::regclass and tgname = 'audit_log_no_update_delete' and tgenabled <> 'O') then
    raise exception 'the audit_log trigger is still disabled';
  end if;
  if (select count(*) from public.reports) <> 0 then raise exception 'reports are not empty'; end if;
  if exists (select 1 from public.authority_contacts where email not like '%@example.invalid' or phone <> '0000000000') then
    raise exception 'an authority contact still has real values';
  end if;
end $$;
commit;
`);

  console.log("\nDone. Counts now:");
  const after = DELETE_TABLES.filter(present).map(t => [t, count(target, `select count(*) from public.${t}`)]);
  after.push(["audit_log (entity_type = report)", count(target, "select count(*) from public.audit_log where entity_type = 'report'")]);
  printTable(after, ["table", "rows"]);
  console.log(`authority_contacts with real values: ${count(target, "select count(*) from public.authority_contacts where email not like '%@example.invalid' or phone <> '0000000000'")}`);
} catch (error) {
  fail(error.message);
}
