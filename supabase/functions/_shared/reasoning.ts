// Pure agent-reasoning helpers (no IO). Given a report, similar reports, and
// the civic knowledge base, decide patterns, escalations, authorities, timing
// and which actions to suggest.

export interface ReportRow {
  id: string;
  constituency?: string | null;
  district?: string | null;
  area?: string | null;
  landmark?: string | null;
  waste_type?: string | null;
  description?: string | null;
  status?: string | null;
  created_at?: string | null;
}

export interface SimilarReport extends ReportRow {
  similarity: number;
}

export interface Guideline {
  match_type: "location_keyword" | "waste_type" | "pattern";
  match_value: string;
  severity: "low" | "medium" | "high";
  authority_type: string | null;
  guidance: string;
}

export interface AuthorityContact {
  id: string;
  name: string;
  authority_type: string;
  email: string | null;
  district?: string | null;
  waste_types?: string[] | null;
}

export interface PatternAlert {
  detected: boolean;
  count: number;
  message: string;
}

export interface EscalationFlag {
  reason: string;
  severity: "low" | "medium" | "high";
  authority_type: string | null;
  guidance: string;
}

export interface SuggestedAction {
  action: "post_to_x" | "email_authority" | "create_followup_task" | "flag_for_escalation";
  label: string;
  enabled: boolean;
}

const PATTERN_THRESHOLD = 3;
const SIMILARITY_FLOOR = 0.6;

export function detectPattern(similar: SimilarReport[]): PatternAlert {
  const relevant = similar.filter((s) => s.similarity >= SIMILARITY_FLOOR);
  const count = relevant.length;
  const detected = count >= PATTERN_THRESHOLD;
  return {
    detected,
    count,
    message: detected
      ? `${count} similar reports nearby in the recent window — this looks like a recurring issue.`
      : count > 0
      ? `${count} loosely similar report(s) found nearby.`
      : "No closely similar reports found.",
  };
}

export function determineEscalations(
  report: ReportRow,
  guidelines: Guideline[],
  pattern: PatternAlert,
): EscalationFlag[] {
  const haystack = `${report.area ?? ""} ${report.landmark ?? ""} ${report.description ?? ""}`
    .toLowerCase();
  const flags: EscalationFlag[] = [];

  for (const g of guidelines) {
    if (g.match_type === "location_keyword") {
      if (haystack.includes(g.match_value.toLowerCase())) {
        flags.push({
          reason: `near ${g.match_value}`,
          severity: g.severity,
          authority_type: g.authority_type,
          guidance: g.guidance,
        });
      }
    } else if (g.match_type === "waste_type") {
      if ((report.waste_type ?? "").toLowerCase() === g.match_value.toLowerCase()) {
        flags.push({
          reason: `${g.match_value} waste`,
          severity: g.severity,
          authority_type: g.authority_type,
          guidance: g.guidance,
        });
      }
    } else if (g.match_type === "pattern" && pattern.detected) {
      flags.push({
        reason: "recurring reports in this area",
        severity: g.severity,
        authority_type: g.authority_type,
        guidance: g.guidance,
      });
    }
  }
  return flags;
}

export function selectAuthorities(
  report: ReportRow,
  escalations: EscalationFlag[],
  contacts: AuthorityContact[],
): AuthorityContact[] {
  const wantedTypes = new Set(
    escalations.map((e) => e.authority_type).filter(Boolean) as string[],
  );
  if (wantedTypes.size === 0) return [];

  const chosen: AuthorityContact[] = [];
  const seen = new Set<string>();
  for (const type of wantedTypes) {
    const matches = contacts
      .filter((c) => c.authority_type === type && c.is_active !== false)
      .sort((a, b) => scopeScore(b, report) - scopeScore(a, report));
    const best = matches[0];
    if (best && !seen.has(best.id)) {
      chosen.push(best);
      seen.add(best.id);
    }
  }
  return chosen;
}

// Prefer a contact scoped to the report's district over a statewide one.
function scopeScore(c: AuthorityContact & { is_active?: boolean }, report: ReportRow): number {
  let score = 0;
  if (c.district && report.district && c.district === report.district) score += 2;
  if (!c.district) score += 1; // statewide fallback
  return score;
}

export function suggestPostTiming(): string {
  // MVP: static peak-engagement window. Replace with engagement ML in v2.
  return "9:00 AM IST (peak engagement window)";
}

export function severityRank(escalations: EscalationFlag[]): "low" | "medium" | "high" {
  if (escalations.some((e) => e.severity === "high")) return "high";
  if (escalations.some((e) => e.severity === "medium")) return "medium";
  return "low";
}

export function buildActions(
  pattern: PatternAlert,
  escalations: EscalationFlag[],
  authorities: AuthorityContact[],
): SuggestedAction[] {
  const actions: SuggestedAction[] = [
    { action: "post_to_x", label: "Post caption to X", enabled: true },
  ];
  if (escalations.length > 0 && authorities.length > 0) {
    actions.push({
      action: "email_authority",
      label: `Email ${authorities.length} authorit${authorities.length === 1 ? "y" : "ies"}`,
      enabled: true,
    });
    actions.push({
      action: "flag_for_escalation",
      label: `Flag for ${severityRank(escalations)} escalation`,
      enabled: true,
    });
  }
  if (pattern.detected) {
    actions.push({
      action: "create_followup_task",
      label: "Create follow-up task (recurring issue)",
      enabled: true,
    });
  }
  return actions;
}

export function reportToText(report: ReportRow): string {
  return [
    report.waste_type ? `Waste type: ${report.waste_type}` : "",
    report.constituency ? `Constituency: ${report.constituency}` : "",
    report.district ? `District: ${report.district}` : "",
    report.area ? `Area: ${report.area}` : "",
    report.landmark ? `Landmark: ${report.landmark}` : "",
    report.description ? `Details: ${report.description}` : "",
  ].filter(Boolean).join(". ");
}

// Appends "@handle" mentions and an optional "More: <link>" to a caption within
// X's 280-char limit. `repHandles` (the report's MLA/MP) are added only while they
// fit; `mandatory` (dept minister, CMO, Swachh Bharat) plus the link always appear,
// so the caption is trimmed if needed to make room. X wraps every URL to 23 chars
// (t.co), so the link is budgeted at 23 regardless of its real length. Handles must
// already be de-duplicated by the caller.
export function assembleCaption(
  caption: string,
  repHandles: string[],
  mandatory: string[],
  link = "",
): string {
  const linkPart = link ? ` More: ${link}` : "";
  const tail = mandatory.map((h) => ` @${h}`).join("") + linkPart;
  // ponytail: budget the URL at X's t.co length (23), not its real length.
  const reserve = tail.length + (link ? Math.max(0, 23 - link.length) : 0);
  let out = caption;
  for (const h of repHandles) {
    const candidate = `${out} @${h}`;
    if (candidate.length + reserve <= 280) out = candidate;
  }
  if (out.length + reserve > 280) {
    out = out.slice(0, 280 - reserve).trimEnd();
  }
  return out + tail;
}

// Templated civic-complaint email (no LLM call). Returns subject + plain-text body
// referencing the report's location, waste type, details and the public link.
export function buildEmailDraft(
  report: ReportRow,
  escalations: EscalationFlag[],
  link = "",
): { subject: string; body: string } {
  const location = [report.area, report.landmark, report.constituency, report.district]
    .filter(Boolean).join(", ") || "Assam";
  const subject = `Garbage complaint: ${location}`;
  const body = [
    "Respected Sir/Madam,",
    "",
    `A garbage issue has been reported on Jabor (a public sanitation tracker for Assam) at ${location}.`,
    report.waste_type ? `Waste type: ${report.waste_type}.` : "",
    report.description ? `Details: ${report.description}` : "",
    escalations.length ? `Note: ${escalations.map((e) => e.guidance).join(" ")}` : "",
    "",
    "We request the concerned authority to arrange for its cleanup at the earliest.",
    link ? `Report details: ${link}` : "",
    "",
    "Regards,",
    "Team Jabor",
  ].filter(Boolean).join("\n");
  return { subject, body };
}

// Self-check: run `deno run supabase/functions/_shared/reasoning.ts`.
if (import.meta.main) {
  const M = ["iKaushikRai", "CMOfficeAssam", "SBMUrbanAssam", "sbmg_assam"];
  const LINK = "jabor.in";
  // Mandatory mentions + link survive even when the caption blows past the limit,
  // and X's counted length (URL billed as 23) stays within 280.
  const over = assembleCaption("x".repeat(300), ["LocalMla"], M, LINK);
  const counted = over.length + (23 - LINK.length);
  if (counted > 280) throw new Error(`over 280 (t.co counted): ${counted}`);
  for (const h of M) {
    if (!over.includes(`@${h}`)) throw new Error(`mandatory mention dropped: @${h}`);
  }
  if (!over.includes(`More: ${LINK}`)) throw new Error("link dropped");
  // A rep handle that fits is kept; order is rep handles, mandatory, then link.
  const ok = assembleCaption("Garbage at MG Road, Nalbari.", ["LocalMla"], M, LINK);
  if (ok !== "Garbage at MG Road, Nalbari. @LocalMla @iKaushikRai @CMOfficeAssam @SBMUrbanAssam @sbmg_assam More: jabor.in") {
    throw new Error(`unexpected assembly: ${ok}`);
  }
  const mail = buildEmailDraft(
    { id: "1", area: "MG Road", district: "Nalbari", waste_type: "plastic" },
    [],
    LINK,
  );
  if (!mail.subject.includes("MG Road") || !mail.body.includes("jabor.in")) {
    throw new Error(`unexpected email draft: ${JSON.stringify(mail)}`);
  }
  console.log("reasoning.ts self-check OK");
}
