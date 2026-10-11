// Builds the synthetic Jorhat demo data: reports, their history, cleanup proofs and contacts.
// Pure and deterministic (same inputs, same output), so it can be checked without a database.
//
// Nothing here is real. Place names are generic ("Demo Area 07") unless the ward_localities table
// already holds names supplied by JMB, in which case those are used. Ward names are never invented.
import crypto from "node:crypto";

export const DAY = 24 * 60 * 60 * 1000;
export const REPORT_COUNT = 150;
// Status mix: 55% active, 15% in progress, 25% cleaned, 5% invalid.
export const STATUS_COUNTS = { active: 83, in_progress: 22, cleaned: 38, invalid: 7 };
export const UNASSIGNED_COUNT = 15; // 10% have no ward
export const IMAGE_COUNT = { report: 4, after: 2 };

const WASTE = [["mixed", 40], ["plastic", 20], ["organic", 15], ["construction", 10], ["water", 10], ["medical", 5]];
const DESCRIPTIONS = {
  mixed: ["Mixed garbage piled up on the roadside.", "Overflowing community bin that has not been cleared for days.", "Loose garbage spread along the lane."],
  plastic: ["Plastic bags and bottles dumped near the drain.", "Plastic waste blocking the side of the road."],
  organic: ["Kitchen and market waste rotting near the junction.", "Organic waste attracting stray animals."],
  construction: ["Construction debris left on the footpath.", "Bricks and sand dumped beside the road."],
  water: ["Garbage floating in the drain next to the lane.", "Waste dumped in the pond edge."],
  medical: ["Medical waste found in an open bin.", "Discarded medical items near the road."],
};
const INVALID_REASONS = ["spam", "duplicate", "outside_jurisdiction", "other"];
// Some wards are heavy and some light, so a ward ranking looks believable.
const WARD_WEIGHTS = [14, 3, 9, 2, 12, 5, 16, 4, 7, 10, 3, 8, 11, 2, 6, 13, 4, 9, 5];

// ── small deterministic helpers ──────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A stable uuid per name, so every run produces the same ids.
export function demoUuid(name) {
  const h = crypto.createHash("sha1").update(`jabor-demo:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const pad = (n, width = 2) => String(n).padStart(width, "0");

// ── generator ────────────────────────────────────────────────────────────────
// input: { now: Date, municipalityId, wards: [{id, number}], localities: {wardNumber: [names]},
//          staff: [{id, email}], leader: {lok_sabha_seat, mla, mla_party, mp, mp_party}, overdueDays }
export function generateDemoData(input) {
  const { now, municipalityId, wards, localities = {}, leader = {}, overdueDays = 7 } = input;
  const staff = input.staff?.length ? input.staff : [{ id: null, email: "jmb-demo-staff@example.invalid" }];
  const rnd = mulberry32(20261011);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const between = (a, b) => a + rnd() * (b - a);
  const pick = list => list[Math.floor(rnd() * list.length)];
  const weighted = pairs => {
    let r = rnd() * pairs.reduce((s, p) => s + p[1], 0);
    for (const [value, weight] of pairs) if ((r -= weight) < 0) return value;
    return pairs[pairs.length - 1][0];
  };
  const wardPairs = wards.map(w => [w, WARD_WEIGHTS[(w.number - 1) % WARD_WEIGHTS.length]]);
  const at = ms => new Date(ms).toISOString();

  // Locations: a pool that many reports share (repeat spots) and one-offs for the rest.
  let locationCount = 0;
  const makeLocation = forcedWard => {
    const ward = forcedWard || weighted(wardPairs);
    const k = ++locationCount;
    const names = localities[ward.number] || [];
    return { ward, area: names.length ? names[k % names.length] : `Demo Area ${pad(k)}`, landmark: `Demo Landmark ${pad(k)}` };
  };
  // The shared pool has a spot in every ward plus extra spots in the heavy ones, in shuffled order.
  const pool = [...wards.map(w => makeLocation(w)), ...Array.from({ length: 15 }, () => makeLocation())].sort(() => rnd() - 0.5);
  const poolPairs = pool.map((loc, rank) => [loc, 1 / Math.pow(rank + 1, 0.9)]);
  const pooled = new Set(pool);

  // 1. Reports as they were first submitted.
  const drafts = [];
  for (let i = 0; i < REPORT_COUNT; i++) {
    const location = rnd() < 0.62 ? weighted(poolPairs) : makeLocation();
    // More reports in the recent weeks than in the oldest ones, like a live backlog.
    const ageDays = 0.3 + 59.7 * Math.pow(rnd(), 1.9);
    const createdMs = now.getTime() - ageDays * DAY - int(0, 6) * 60 * 60 * 1000;
    drafts.push({ i, location, ageDays: (now.getTime() - createdMs) / DAY, createdMs, waste: weighted(WASTE) });
  }

  // Every ward gets at least one report: a light ward that chance skipped takes one from a heavy ward.
  for (const ward of wards) {
    if (drafts.some(d => d.location.ward === ward)) continue;
    const counts = new Map();
    drafts.forEach(d => counts.set(d.location.ward, (counts.get(d.location.ward) || 0) + 1));
    const donor = drafts.find(d => !pooled.has(d.location) && counts.get(d.location.ward) > 4);
    donor.location = makeLocation(ward);
  }

  // 2. Final status: the oldest reports are the ones that got cleaned, with some noise so a few old
  //    ones are still open (those are the overdue ones).
  const byNoisyAge = [...drafts].sort((a, b) => (b.ageDays + between(-12, 12)) - (a.ageDays + between(-12, 12)));
  const taken = new Set();
  const take = (n, filter, source) => {
    const chosen = [];
    for (const d of source) {
      if (chosen.length === n) break;
      if (!taken.has(d.i) && filter(d)) { chosen.push(d); taken.add(d.i); }
    }
    return chosen;
  };
  const shuffled = [...drafts].sort(() => rnd() - 0.5);
  take(STATUS_COUNTS.cleaned, d => d.ageDays >= 4, byNoisyAge).forEach(d => (d.status = "cleaned"));
  take(STATUS_COUNTS.invalid, d => d.ageDays >= 1, shuffled).forEach(d => (d.status = "invalid"));
  take(STATUS_COUNTS.in_progress, d => d.ageDays >= 2.5, shuffled).forEach(d => (d.status = "in_progress"));
  drafts.forEach(d => { d.status ||= "active"; });

  // 3. Ward: most reporters picked it; some were assigned by staff later; some are still unassigned.
  const unassignable = drafts.filter(d => d.status === "active" || d.status === "invalid");
  [...unassignable].sort(() => rnd() - 0.5).slice(0, UNASSIGNED_COUNT).forEach(d => (d.unassigned = true));
  drafts.forEach(d => {
    d.finalWard = d.unassigned ? null : d.location.ward;
    d.staffAssigned = !d.unassigned && rnd() < 0.3;
    d.claimed = d.unassigned && rnd() < 0.3 ? "not_sure" : "yes";
  });

  // 4. History for each report, and the rows it leaves behind.
  const reports = [], audit = [], proofs = [], contacts = [];
  let staffTurn = 0;
  const nextStaff = () => staff[staffTurn++ % staff.length];
  const ceiling = now.getTime() - 0.1 * DAY; // nothing happens in the future
  const mla = {
    lok_sabha_seat: leader.lok_sabha_seat ?? "", mla: leader.mla ?? "Unknown", mla_party: leader.mla_party ?? "Unknown",
    mp: leader.mp ?? "Unknown", mp_party: leader.mp_party ?? "Unknown",
  };

  drafts.sort((a, b) => a.createdMs - b.createdMs).forEach((d, n) => {
    const id = demoUuid(`report-${d.i}`);
    const initialWard = d.staffAssigned ? null : d.finalWard;
    const report = {
      id, constituency: "Jorhat", district: "Jorhat", ...mla,
      area: d.location.area, landmark: d.location.landmark, waste_type: d.waste,
      description: `[Demo] ${pick(DESCRIPTIONS[d.waste])}`,
      photo_url: `/demo/placeholder-${1 + (d.i % IMAGE_COUNT.report)}.svg?demo=${pad(d.i + 1, 3)}`,
      status: d.status, is_deleted: false, created_at: at(d.createdMs), updated_at: at(d.createdMs),
      municipality_id: municipalityId, ward_id: d.finalWard?.id ?? null, claimed_in_municipality: d.claimed, source: "demo",
      invalid_reason: null, cleaned_by_name: null, cleaned_by_type: null, cleaned_at: null, cleaned_marked_at: null,
      cleaned_marked_by: null, assigned_to_text: null, due_at: null, admin_note: null,
    };
    const event = (ms, actor, action, from_value, to_value, note = null) => {
      audit.push({ municipality_id: municipalityId, entity_type: "report", entity_id: id, actor_id: actor?.id ?? null,
        actor_email: actor ? actor.email : "public", action, from_value, to_value, note, created_at: at(ms) });
      report.updated_at = at(Math.max(ms, Date.parse(report.updated_at)));
    };
    const strip = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

    event(d.createdMs, null, "report_created", null, strip({ source: "demo", status: "active", claimed_in_municipality: d.claimed, ward_id: initialWard?.id }));
    let t = d.createdMs;

    if (d.staffAssigned) {
      t = Math.min(ceiling, t + between(0.05, 1.2) * DAY);
      event(t, nextStaff(), "ward_change", { ward_id: null }, { ward_id: d.finalWard.id });
    }

    if (d.status === "in_progress" || d.status === "cleaned") {
      const viaProgress = d.status === "in_progress" || rnd() < 0.6;
      if (viaProgress) {
        t = Math.min(ceiling - DAY, Math.max(t + 0.2 * DAY, d.createdMs + between(0.5, 5) * DAY));
        const actor = nextStaff();
        event(t, actor, "status_change", { status: "active" }, { status: "in_progress" });
        report.assigned_to_text = `[Demo] ${d.finalWard ? `Ward ${d.finalWard.number}` : "JMB"} sanitation team`;
        report.due_at = at(t + between(3, 9) * DAY);
        event(t + 60 * 1000, actor, "assignment_change", { assigned_to_text: null, due_at: null }, { assigned_to_text: report.assigned_to_text, due_at: report.due_at });
        t += 60 * 1000;
      }
      if (d.status === "cleaned") {
        t = Math.min(ceiling, t + between(1, 12) * DAY);
        const type = rnd() < 0.7 ? "jmb" : "citizen";
        const actor = nextStaff();
        const cleanedMs = Math.max(d.createdMs, t - between(0, 1.5) * DAY);
        report.cleaned_by_type = type;
        report.cleaned_by_name = type === "jmb" ? `[Demo] JMB ${d.finalWard ? `ward ${d.finalWard.number} ` : ""}team` : "[Demo] Citizen volunteer";
        report.cleaned_at = at(cleanedMs);
        report.cleaned_marked_at = at(t);
        report.cleaned_marked_by = actor.id;
        event(t, actor, "status_change", { status: viaProgress ? "in_progress" : "active" },
          { status: "cleaned", cleaned_by_name: report.cleaned_by_name, cleaned_by_type: type, cleaned_at: report.cleaned_at });
        if (type === "citizen" || rnd() < 0.55) {
          proofs.push({
            report_id: id, image_url: `/demo/placeholder-after-${1 + (d.i % IMAGE_COUNT.after)}.svg?demo=${pad(d.i + 1, 3)}`,
            submitted_by: type === "citizen" ? "[Demo] Citizen volunteer" : null, cleaned_date_estimate: `[Demo] ${at(cleanedMs).slice(0, 10)}`,
            status: "approved", created_at: at(Math.max(d.createdMs, cleanedMs)), updated_at: at(t),
          });
        }
      }
    }

    if (d.status === "invalid") {
      t = Math.min(ceiling, d.createdMs + between(0.2, Math.min(6, d.ageDays - 0.1)) * DAY);
      report.invalid_reason = pick(INVALID_REASONS);
      event(t, nextStaff(), "status_change", { status: "active" }, { status: "invalid", invalid_reason: report.invalid_reason });
    }

    if (n % 4 === 0) {
      contacts.push({ report_id: id, name: `Demo Citizen ${pad(d.i + 1, 3)}`, email: `demo-citizen-${pad(d.i + 1, 3)}@example.invalid`, created_at: at(d.createdMs) });
    }
    reports.push(report);
  });

  audit.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { reports, audit, proofs, contacts, overdueDays, now: now.toISOString() };
}

// Plain numbers for the dry-run printout and the self-check.
export function summarize({ reports, audit, proofs, contacts, overdueDays, now }) {
  const tally = (list, key) => list.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {});
  const nowMs = Date.parse(now);
  return {
    reports: reports.length,
    byStatus: tally(reports, r => r.status),
    byWard: tally(reports, r => r.ward_id ?? "unassigned"),
    unassigned: reports.filter(r => !r.ward_id).length,
    cleanedByType: tally(reports.filter(r => r.status === "cleaned"), r => r.cleaned_by_type),
    overdueActive: reports.filter(r => r.status === "active" && nowMs - Date.parse(r.created_at) > overdueDays * DAY).length,
    repeatLocations: Object.values(tally(reports, r => `${r.area}|${r.landmark}`)).filter(c => c >= 2).length,
    reportsAtRepeatLocations: Object.values(tally(reports, r => `${r.area}|${r.landmark}`)).filter(c => c >= 2).reduce((s, c) => s + c, 0),
    oldestDays: Math.round((nowMs - Math.min(...reports.map(r => Date.parse(r.created_at)))) / DAY),
    audit: audit.length,
    auditByAction: tally(audit, a => a.action),
    proofs: proofs.length,
    contacts: contacts.length,
  };
}
