import { HttpError, SUPABASE_ANON_KEY, SUPABASE_URL, route, serviceRest } from "../_lib/server.js";
import { requireStaff } from "../_lib/admin.js";
import { Denied, authorize } from "../_lib/access.js";
import { plainDescription, toCsv } from "../../src/admin/csv.js";
import { ageDays, isOverdue, overdueDaysFrom, statusOf, wardLabel } from "../../src/admin/rules.js";

// CSV of the reports table, with the filters the dashboard is showing. The browser sends only the filter
// part of the query (the `and` condition and, for a super admin, the municipality). Everything else is
// decided here: the columns, the order and the paging. Every read goes through the same allowlist as the
// proxy (api/_lib/access.js), so a municipality admin gets their own municipality and nothing else.
// The export is written to audit_log before the file is sent; if that fails, nothing is sent.
export const MAX_ROWS = 10000;
const PAGE = 1000;
const COLUMNS = "id,created_at,ward_id,status,is_deleted,cleaned_by_type,cleaned_at,cleaned_marked_at,description";
export const HEADER = ["id", "date", "ward", "status", "age_days", "overdue", "cleaned_date", "cleaned_by_type", "description"];
const FILTER_KEYS = new Set(["and", "municipality_id"]);
const decode = text => { try { return decodeURIComponent(text); } catch { throw new HttpError(400, "Bad request."); } };
const istDate = iso => (iso ? new Date(Date.parse(iso) + 330 * 60 * 1000).toISOString().slice(0, 10) : "");

export default route("POST", async (req, res) => {
  const staff = await requireStaff(req, res);
  const envelope = req.body;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope) || Object.keys(envelope).some(k => k !== "path") || typeof envelope.path !== "string") {
    throw new HttpError(400, "Bad request.");
  }
  const [pathOnly, rawQuery = ""] = envelope.path.split("?");
  if (pathOnly !== "/rest/v1/reports") throw new HttpError(400, "Bad request.");
  const filters = [];
  for (const param of rawQuery ? rawQuery.split("&") : []) {
    const eq = param.indexOf("=");
    const key = decode(eq === -1 ? param : param.slice(0, eq));
    if (!FILTER_KEYS.has(key) || filters.some(([k]) => k === key)) throw new HttpError(400, "Bad request.");
    filters.push([key, decode(eq === -1 ? "" : param.slice(eq + 1))]);
  }
  const query = pairs => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  // Read as the caller, through the allowlist.
  const read = async (path, prefer) => {
    let plan;
    try {
      plan = authorize(staff, { path, method: "GET", prefer });
    } catch (error) {
      if (!(error instanceof Denied)) throw error;
      console.warn(`[jabor] admin export denied: user=${staff.userId} role=${staff.role} reason=${error.reason}`);
      throw new HttpError(403, "Not allowed.");
    }
    const upstream = await fetch(`${SUPABASE_URL}${plan.path}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${staff.token}`, ...(plan.prefer ? { Prefer: plan.prefer } : {}) },
    });
    if (!upstream.ok) throw new Error(`export read failed: ${upstream.status}`);
    const total = /\/(\d+)$/.exec(upstream.headers.get("content-range") || "")?.[1];
    return { rows: await upstream.json(), total: total === undefined ? null : Number(total) };
  };

  const municipalityFilter = filters.find(([k]) => k === "municipality_id")?.[1]; // "eq.<uuid>", a super admin only
  const municipalityId = staff.municipalityId || (/^eq\.([0-9a-f-]{36})$/i.exec(municipalityFilter || "")?.[1] ?? null);
  const page = offset => read(`/rest/v1/reports?${query([["select", COLUMNS], ...filters, ["order", "created_at.asc,id.asc"], ["limit", String(PAGE)], ["offset", String(offset)]])}`, "count=exact");

  const first = await page(0);
  if (first.total === null) throw new Error("export count missing");
  if (first.total > MAX_ROWS) {
    throw new HttpError(413, `${first.total.toLocaleString("en-IN")} reports match. An export holds at most ${MAX_ROWS.toLocaleString("en-IN")}. Narrow the filters (a date range or a ward) and try again.`);
  }
  let reports = first.rows;
  for (let offset = PAGE; offset < first.total; offset += PAGE) reports = reports.concat((await page(offset)).rows);

  // a municipality admin's own municipality is added by authorize(); only a super admin names one
  const named = staff.role === "super_admin" && municipalityId;
  const scope = named ? [["municipality_id", `eq.${municipalityId}`]] : [];
  const wardRows = (await read(`/rest/v1/wards?${query([["select", "id,number,name"], ...scope, ["order", "number"], ["limit", "1000"]])}`)).rows;
  const wards = new Map(wardRows.map(w => [w.id, wardLabel(w)]));
  const settings = (await read(`/rest/v1/municipalities?${query([["select", "id,settings"], ...(named ? [["id", `eq.${municipalityId}`]] : []), ["limit", "1"]])}`)).rows[0]?.settings;
  const threshold = overdueDaysFrom(settings);

  const now = new Date();
  const rows = reports.map(r => {
    const status = statusOf(r);
    const cleaned = status === "cleaned";
    return [
      r.id, istDate(r.created_at), r.ward_id ? wards.get(r.ward_id) ?? "Ward" : "Unassigned", status,
      ageDays(r.created_at, now), isOverdue(r, threshold, now) ? "yes" : "no",
      cleaned ? istDate(r.cleaned_at || r.cleaned_marked_at) : "", cleaned ? r.cleaned_by_type || "" : "",
      plainDescription(r.description),
    ];
  });

  // Who exported what: the filters as the server read them, and how many rows.
  await serviceRest("/rest/v1/audit_log", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      municipality_id: municipalityId, entity_type: "export", entity_id: "reports", actor_id: staff.userId, actor_email: staff.email,
      action: "export", from_value: null, to_value: { rows: rows.length, filters: query(filters).slice(0, 3000) }, note: null,
    }),
  });

  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="jabor-reports-${istDate(now.toISOString())}.csv"`);
  res.setHeader("X-Row-Count", String(rows.length));
  return res.end(toCsv(HEADER, rows));
});
