// Self-check for the demo data generator: `node scripts/lib/demo-data.check.mjs`
import assert from "node:assert/strict";
import { REPORT_COUNT, STATUS_COUNTS, UNASSIGNED_COUNT, demoUuid, generateDemoData, summarize } from "./demo-data.mjs";

const now = new Date("2026-10-11T12:00:00Z");
const wards = Array.from({ length: 19 }, (_, i) => ({ id: demoUuid(`ward-${i + 1}`), number: i + 1 }));
const staff = [{ id: demoUuid("staff-1"), email: "jmb-admin@example.invalid" }, { id: demoUuid("staff-2"), email: "super@example.invalid" }];
const input = { now, municipalityId: demoUuid("municipality"), wards, staff, overdueDays: 7, leader: { mla: "Test MLA" } };

const data = generateDemoData(input);
const summary = summarize(data);

// Same inputs, same output (so a re-run changes nothing).
assert.deepEqual(generateDemoData(input), data, "generation is deterministic");

// Size and status mix: 55% active, 15% in progress, 25% cleaned, 5% invalid.
assert.equal(data.reports.length, REPORT_COUNT);
assert.deepEqual(summary.byStatus, STATUS_COUNTS);
assert.equal(summary.unassigned, UNASSIGNED_COUNT);
assert.ok(new Set(data.reports.map(r => r.id)).size === REPORT_COUNT, "unique ids");
assert.ok(new Set(data.reports.map(r => r.photo_url)).size === REPORT_COUNT, "unique photo urls (reports.photo_url is unique)");

// Spread over about 60 days, nothing in the future.
assert.ok(summary.oldestDays >= 55 && summary.oldestDays <= 61, `oldest report is ${summary.oldestDays} days old`);
for (const r of data.reports) {
  assert.ok(Date.parse(r.created_at) <= now.getTime(), "created in the past");
  assert.ok(Date.parse(r.updated_at) <= now.getTime(), "updated in the past");
  assert.ok(Date.parse(r.updated_at) >= Date.parse(r.created_at));
}
for (const a of data.audit) assert.ok(Date.parse(a.created_at) <= now.getTime(), "audit rows are in the past");

// Wards: all 19 used, some heavy and some light, and the unassigned ones are in Jorhat with no ward.
const perWard = wards.map(w => data.reports.filter(r => r.ward_id === w.id).length);
assert.ok(perWard.every(n => n >= 1), "every ward has at least one report");
assert.ok(Math.max(...perWard) >= 3 * Math.min(...perWard), `ward counts vary (${perWard.join(",")})`);
assert.ok(data.reports.every(r => r.municipality_id === input.municipalityId && r.district === "Jorhat" && r.source === "demo"));
assert.ok(data.reports.filter(r => !r.ward_id).every(r => r.status === "active" || r.status === "invalid"), "only open or invalid reports are unassigned");

// Cleaned reports: JMB or citizen only (never auto), with who, when, and the system stamps.
const cleaned = data.reports.filter(r => r.status === "cleaned");
assert.ok(cleaned.every(r => ["jmb", "citizen"].includes(r.cleaned_by_type)), "no auto-cleaned rows");
assert.ok(cleaned.every(r => r.cleaned_by_name && r.cleaned_at && r.cleaned_marked_at && r.cleaned_marked_by));
assert.ok(cleaned.every(r => Date.parse(r.cleaned_marked_at) <= now.getTime() && Date.parse(r.cleaned_at) >= Date.parse(r.created_at)));
assert.ok(summary.cleanedByType.jmb > 0 && summary.cleanedByType.citizen > 0, "both cleaner types appear");
assert.ok(data.proofs.length >= 10 && data.proofs.length < cleaned.length + 1, "some, not all, cleaned reports have proof");
assert.ok(data.proofs.every(p => cleaned.some(r => r.id === p.report_id)) && new Set(data.proofs.map(p => p.report_id)).size === data.proofs.length, "one approved proof per cleaned report at most");
assert.ok(data.reports.filter(r => r.status !== "cleaned").every(r => !r.cleaned_by_type && !r.cleaned_at), "only cleaned reports have cleaned details");
assert.ok(data.reports.filter(r => r.status === "invalid").every(r => r.invalid_reason), "invalid reports have a reason");
assert.ok(data.reports.filter(r => r.status === "in_progress").every(r => r.assigned_to_text && r.due_at));

// Overdue: some active reports are older than the threshold, and some are not.
const active = data.reports.filter(r => r.status === "active");
assert.ok(summary.overdueActive >= 20 && summary.overdueActive < active.length, `overdue active: ${summary.overdueActive} of ${active.length}`);

// Repeat locations: several places have more than one report, and one place has a cleaned and a newer open report.
assert.ok(summary.repeatLocations >= 8 && summary.reportsAtRepeatLocations >= 40, `repeat locations: ${summary.repeatLocations}`);

// History replays: the audit trail of every report ends in its final status, in time order.
const byReport = new Map();
for (const a of data.audit) byReport.set(a.entity_id, [...(byReport.get(a.entity_id) || []), a]);
for (const r of data.reports) {
  const trail = byReport.get(r.id);
  assert.equal(trail[0].action, "report_created");
  assert.equal(trail[0].actor_email, "public");
  assert.equal(trail[0].to_value.source, "demo");
  const statuses = trail.filter(a => a.action === "status_change");
  let state = "active";
  for (const a of statuses) { assert.equal(a.from_value.status, state, `${r.id}: history is consistent`); state = a.to_value.status; }
  assert.equal(state, r.status, `${r.id}: history ends in the final status`);
  const wardEvents = trail.filter(a => a.action === "ward_change");
  assert.ok(wardEvents.length <= 1);
  const initialWard = trail[0].to_value.ward_id ?? null;
  assert.equal(wardEvents.length ? wardEvents[0].to_value.ward_id : initialWard, r.ward_id, `${r.id}: ward history ends in the final ward`);
  assert.deepEqual(trail.map(a => a.created_at), [...trail.map(a => a.created_at)].sort(), "events are in time order");
  assert.ok(trail.slice(1).every(a => staff.some(s => s.email === a.actor_email)), "staff actions are by staff");
}

// Nothing real: every contact uses the reserved domain, every description is marked.
assert.ok(data.contacts.every(c => c.email.endsWith("@example.invalid") && c.name.startsWith("Demo Citizen")));
assert.ok(data.contacts.length >= 30 && data.contacts.length <= 45);
assert.ok(data.reports.every(r => r.description.startsWith("[Demo] ")));
assert.ok(data.reports.every(r => /^Demo Area \d+$/.test(r.area) && /^Demo Landmark \d+$/.test(r.landmark)), "no invented place names");
const text = JSON.stringify(data);
assert.ok(!/@(?!example\.invalid)[\w.-]+\.[a-z]{2,}/i.test(text.replace(/"cleaned_date_estimate"[^,]*/g, "")), "no email outside example.invalid");
assert.ok(!/\b[6-9]\d{9}\b/.test(text), "no phone-like numbers");

// Real locality names from the database are used when they exist (and are not invented otherwise).
const named = generateDemoData({ ...input, localities: Object.fromEntries(wards.map(w => [w.number, [`Locality A${w.number}`, `Locality B${w.number}`]])) });
assert.ok(named.reports.every(r => /^Locality [AB]\d+$/.test(r.area)));

// Without staff accounts, history falls back to a fake staff identity.
const noStaff = generateDemoData({ ...input, staff: [] });
assert.ok(noStaff.audit.filter(a => a.action !== "report_created").every(a => a.actor_email === "jmb-demo-staff@example.invalid"));

console.log("demo data ok");
