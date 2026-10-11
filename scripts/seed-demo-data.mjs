#!/usr/bin/env node
// Fills the STAGING database with about 150 synthetic Jorhat reports for demos. See docs/DEMO-DATA.md.
//
//   node --env-file=.env.local scripts/seed-demo-data.mjs              dry run: prints the plan, changes nothing
//   node --env-file=.env.local scripts/seed-demo-data.mjs --execute     asks you to type the staging project ref
//   ... --replace                                                       clears existing demo rows first, then seeds again
//   node --env-file=.local/local-app.env scripts/seed-demo-data.mjs --local [--execute]   the local Supabase stack
//
// What it creates (all marked reports.source = 'demo', all in the Jorhat municipality):
//   reports        status mix 55% active, 15% in progress, 25% cleaned, 5% invalid; spread over the 19 wards
//                  (some heavy, some light) and the last 60 days; 10% with no ward; repeat locations
//   cleanup_proofs approved proof photos for some cleaned reports
//   report_contacts fake contacts on example.invalid for about a quarter of the reports
//   audit_log      each report's history: created, ward assigned, in progress, cleaned or invalid, with
//                  the right times and actors
//
// It follows the real status model: cleaned reports are cleaned by JMB or a citizen (never "auto"),
// invalid reports have a reason, and the history replays to each report's final status. The audit
// rows are written by this script, so the insert and update audit triggers are switched off inside
// the one transaction and back on before it commits.
//
// Images are the placeholder SVGs in public/demo (served by the site itself). Nothing is uploaded and
// Cloudinary is never called. No real names, phones or addresses: contacts use example.invalid, and
// places are "Demo Area NN" unless JMB's own locality names are already in ward_localities. Ward names
// are never invented.
//
// Re-running is safe: if demo rows exist the script stops and says so. Use --replace to start over.
// It refuses to run against production or any other project (see scripts/lib/target.mjs).
import { PRODUCTION_REF, STAGING_REF, confirmTyped, count, printTable, resolveTarget, runSql } from "./lib/target.mjs";
import { generateDemoData, summarize } from "./lib/demo-data.mjs";

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const replace = args.has("--replace");
const unknownArgs = [...args].filter(a => !["--execute", "--replace", "--local"].includes(a));

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}
if (unknownArgs.length) fail(`Unknown option: ${unknownArgs.join(" ")}`);

let target;
try {
  target = resolveTarget({ local: args.has("--local") });
} catch (error) {
  fail(error.message);
}

console.log(`${execute ? "EXECUTE" : "DRY RUN"} on ${target.label}`);
console.log(`(production ${PRODUCTION_REF} is refused; staging is ${STAGING_REF})\n`);

// Columns of each table the script writes, with the JSON type used to read them back.
const COLUMNS = {
  reports: {
    id: "uuid", constituency: "text", district: "text", lok_sabha_seat: "text", mla: "text", mla_party: "text", mp: "text", mp_party: "text",
    area: "text", landmark: "text", waste_type: "text", description: "text", photo_url: "text", status: "text", is_deleted: "boolean",
    created_at: "timestamptz", updated_at: "timestamptz", municipality_id: "uuid", ward_id: "uuid", claimed_in_municipality: "text", source: "text",
    invalid_reason: "text", cleaned_by_name: "text", cleaned_by_type: "text", cleaned_at: "timestamptz", cleaned_marked_at: "timestamptz",
    cleaned_marked_by: "uuid", assigned_to_text: "text", due_at: "timestamptz", admin_note: "text",
  },
  cleanup_proofs: { report_id: "uuid", image_url: "text", submitted_by: "text", cleaned_date_estimate: "text", status: "text", created_at: "timestamptz", updated_at: "timestamptz" },
  report_contacts: { report_id: "uuid", name: "text", email: "text", created_at: "timestamptz" },
  audit_log: {
    municipality_id: "uuid", entity_type: "text", entity_id: "text", actor_id: "uuid", actor_email: "text", action: "text",
    from_value: "jsonb", to_value: "jsonb", note: "text", created_at: "timestamptz",
  },
};

function insertFrom(table, rows) {
  const columns = COLUMNS[table];
  const names = Object.keys(columns);
  const json = JSON.stringify(rows);
  if (json.includes("$demo$")) throw new Error("demo data contains the SQL quote marker");
  return `insert into public.${table} (${names.join(", ")})
select ${names.map(n => `x.${n}`).join(", ")}
from jsonb_to_recordset($demo$${json}$demo$::jsonb) as x(${names.map(n => `${n} ${columns[n]}`).join(", ")});`;
}

try {
  // ── What the database already has ──────────────────────────────────────────
  const hasSource = count(target, "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reports' and column_name = 'source'");
  const triggers = count(target, `select count(*) from pg_trigger where not tgisinternal and tgname in ('reports_audit', 'reports_audit_insert', 'reports_before_insert', 'audit_log_no_update_delete')`);
  if (!hasSource || triggers < 4) fail("The T4-lite migration is not applied on this database (reports.source or its triggers are missing). Apply it first.");

  const [municipality] = runSql(target, "select id, coalesce(settings ->> 'overdue_after_days', '7') from public.municipalities where slug = 'jorhat'");
  if (!municipality) fail("There is no Jorhat municipality in this database.");
  const [municipalityId, overdueDays] = [municipality[0], Number(municipality[1])];

  const wards = runSql(target, `select id, number from public.wards where municipality_id = '${municipalityId}' order by number`).map(([id, number]) => ({ id, number: Number(number) }));
  if (wards.length !== 19) fail(`Expected 19 Jorhat wards, found ${wards.length}.`);

  // JMB's own locality names, if they have been loaded. Otherwise places stay generic.
  const localities = {};
  for (const [number, name] of runSql(target, `select w.number, l.name from public.ward_localities l join public.wards w on w.id = l.ward_id where w.municipality_id = '${municipalityId}' order by w.number, l.name`)) {
    (localities[Number(number)] ||= []).push(name);
  }

  const [leaderRow] = runSql(target, `select m.name, m.party, m.lok_sabha_seat, coalesce(p.name, ''), coalesce(p.party, '')
    from public.mla_list m left join public.mp_list p on p.lok_sabha_seat = m.lok_sabha_seat where m.constituency = 'Jorhat' limit 1`);
  const leader = leaderRow ? { mla: leaderRow[0], mla_party: leaderRow[1], lok_sabha_seat: leaderRow[2], mp: leaderRow[3] || "Unknown", mp_party: leaderRow[4] || "Unknown" } : {};

  // The staff who "did" the demo history. Their emails are not printed.
  const staff = runSql(target, `select user_id, email from public.staff_profiles where is_active and (municipality_id = '${municipalityId}' or role = 'super_admin') order by (role = 'municipality_admin') desc, created_at`)
    .map(([id, email]) => ({ id, email }));

  const existing = count(target, "select count(*) from public.reports where source = 'demo'");
  if (existing > 0 && !replace) {
    console.log(`Demo data is already present (${existing} reports). Nothing to do.`);
    console.log("Use --replace to clear it and seed again.");
    process.exit(0);
  }

  // ── The plan ───────────────────────────────────────────────────────────────
  const data = generateDemoData({ now: new Date(), municipalityId, wards, localities, staff, leader, overdueDays });
  const s = summarize(data);
  const pct = n => `${Math.round((100 * n) / s.reports)}%`;
  console.log(`Would create ${s.reports} reports${replace && existing ? ` (after clearing ${existing} existing demo reports)` : ""}:`);
  printTable([
    ["active", s.byStatus.active, pct(s.byStatus.active)], ["in_progress", s.byStatus.in_progress, pct(s.byStatus.in_progress)],
    ["cleaned", s.byStatus.cleaned, pct(s.byStatus.cleaned)], ["invalid", s.byStatus.invalid, pct(s.byStatus.invalid)],
  ], ["status", "reports", "share"]);
  console.log("\nReports per ward:");
  printTable([
    ...wards.map(w => [`Ward ${w.number}`, s.byWard[w.id] || 0]),
    ["No ward (unassigned)", s.unassigned],
  ], ["ward", "reports"]);
  console.log(`\nCleaned by: jmb ${s.cleanedByType.jmb || 0}, citizen ${s.cleanedByType.citizen || 0}, auto 0`);
  console.log(`Active reports older than ${overdueDays} days (overdue): ${s.overdueActive} of ${s.byStatus.active}`);
  console.log(`Repeat locations: ${s.repeatLocations} places with 2 or more reports (${s.reportsAtRepeatLocations} reports)`);
  console.log(`Oldest report: ${s.oldestDays} days ago`);
  console.log(`Also: ${s.proofs} approved cleanup proofs, ${s.contacts} fake contacts, ${s.audit} audit rows ${JSON.stringify(s.auditByAction)}`);
  console.log(`History is written for ${staff.length ? `${staff.length} existing staff account(s)` : "a fake staff identity (no staff accounts found)"}.`);
  console.log(`Place names: ${Object.keys(localities).length ? "JMB locality names from ward_localities where loaded, otherwise generic" : "generic (Demo Area NN); no ward_localities loaded"}`);
  console.log("Images: /demo/placeholder-*.svg served by the site. Cloudinary is not touched.");

  if (!execute) {
    console.log("\nDry run only. Nothing was changed. Add --execute to seed.");
    process.exit(0);
  }

  await confirmTyped(target);

  runSql(target, `
begin;
alter table public.reports disable trigger reports_audit_insert;
alter table public.reports disable trigger reports_audit;
${replace ? `alter table public.audit_log disable trigger audit_log_no_update_delete;
delete from public.audit_log where entity_type = 'report' and entity_id in (select id::text from public.reports where source = 'demo');
alter table public.audit_log enable trigger audit_log_no_update_delete;
delete from public.reports where source = 'demo';` : ""}
${insertFrom("reports", data.reports)}
${insertFrom("report_contacts", data.contacts)}
${insertFrom("cleanup_proofs", data.proofs)}
${insertFrom("audit_log", data.audit)}
alter table public.reports enable trigger reports_audit_insert;
alter table public.reports enable trigger reports_audit;
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid in ('public.reports'::regclass, 'public.audit_log'::regclass) and not tgisinternal and tgenabled <> 'O') then
    raise exception 'a trigger is still disabled';
  end if;
  if (select count(*) from public.reports where source = 'demo') <> ${s.reports} then raise exception 'unexpected number of demo reports'; end if;
end $$;
commit;
`);

  // ── Check what is there now ────────────────────────────────────────────────
  console.log("\nSeeded. Checking:");
  const check = sql => runSql(target, sql);
  printTable(check("select status, count(*) from public.reports where source = 'demo' group by status order by status"), ["status", "reports"]);
  console.log(`\nunassigned (Jorhat, no ward): ${count(target, "select count(*) from public.reports where source = 'demo' and ward_id is null")}`);
  console.log(`cleaned_by_type: ${check("select coalesce(cleaned_by_type, '-'), count(*) from public.reports where source = 'demo' and status = 'cleaned' group by 1 order by 1").map(r => `${r[0]} ${r[1]}`).join(", ")}`);
  console.log(`auto-cleaned demo rows: ${count(target, "select count(*) from public.reports where source = 'demo' and cleaned_by_type = 'auto'")} (must be 0)`);
  console.log(`audit rows for demo reports: ${count(target, "select count(*) from public.audit_log a join public.reports r on a.entity_id = r.id::text where r.source = 'demo' and a.entity_type = 'report'")}`);
  console.log(`reports whose audit history does not end in their status: ${count(target, `select count(*) from public.reports r where r.source = 'demo' and coalesce((select a.to_value ->> 'status' from public.audit_log a where a.entity_type = 'report' and a.entity_id = r.id::text and a.action = 'status_change' order by a.created_at desc, a.id desc limit 1), 'active') <> r.status`)} (must be 0)`);
  console.log(`visible on the public site (public_reports): ${count(target, "select count(*) from public.public_reports pr join public.reports r on r.id = pr.id where r.source = 'demo'")}`);
  console.log(`audit and report triggers disabled: ${count(target, "select count(*) from pg_trigger where tgrelid in ('public.reports'::regclass, 'public.audit_log'::regclass) and not tgisinternal and tgenabled <> 'O'")} (must be 0)`);
} catch (error) {
  fail(error.message);
}
