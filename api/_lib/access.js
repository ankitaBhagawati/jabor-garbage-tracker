// What each staff role may do through the admin proxy (/api/admin/rest). Everything is denied unless
// it is listed here. The request is checked piece by piece (path, method, query parameters, filters,
// select, order, body, Prefer) and then rebuilt from the validated pieces, so what is checked is exactly
// what Supabase receives. For a municipality admin the proxy also adds the municipality filter itself;
// RLS enforces the same scope again in the database.
//
// Pure functions only, so the rules can be tested without a network. See docs/ACCESS-MATRIX.md.

export class Denied extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason; // a short code for the log; never a value from the request
  }
}
const deny = reason => { throw new Denied(reason); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT = /^[a-z_]+$/;
const MAX_LIMIT = 1000;
const MAX_PARAMS = 12;

const STATUSES = new Set(["active", "in_progress", "cleaned", "invalid"]);
const CLEANED_BY = new Set(["jmb", "citizen", "other"]);

// Every column of reports a staff member may read. The embedding is left out: large and not needed.
const REPORT_READ = [
  "id", "constituency", "district", "lok_sabha_seat", "mla", "mla_party", "mp", "mp_party", "area", "landmark",
  "waste_type", "description", "photo_url", "lat", "lng", "status", "assigned_to", "rejected_at", "is_deleted",
  "created_at", "updated_at", "tweeted_at", "emailed_at", "municipality_id", "ward_id", "gps_accuracy", "gps_source",
  "claimed_in_municipality", "in_municipality", "invalid_reason", "cleaned_by_name", "cleaned_by_type", "cleaned_at",
  "cleaned_marked_at", "cleaned_marked_by", "assigned_to_text", "due_at", "admin_note", "source",
];
const REPORT_FILTER = [
  "id", "status", "ward_id", "created_at", "updated_at", "area", "landmark", "district", "constituency", "waste_type",
  "description", "is_deleted", "invalid_reason", "assigned_to_text", "due_at", "cleaned_by_type", "cleaned_at",
  "claimed_in_municipality", "source",
];
const REPORT_ORDER = ["created_at", "updated_at", "status", "ward_id", "area", "id", "cleaned_at", "due_at"];

// Per table: which roles may select or update, which columns they may read, filter and order by,
// which embedded tables a select may pull in, which body keys an update may send, and the column the
// proxy adds as a server-side scope for a municipality admin (the client may never send that key).
const TABLES = {
  reports: {
    select: ["super_admin", "municipality_admin"],
    update: ["super_admin", "municipality_admin"],
    read: REPORT_READ,
    filter: { super_admin: [...REPORT_FILTER, "municipality_id"], municipality_admin: REPORT_FILTER },
    order: { super_admin: REPORT_ORDER, municipality_admin: REPORT_ORDER },
    embeds: {},
    statuses: STATUSES,
    body: {
      // Legacy admin screen: hide and restore (is_deleted), approve a proof (status), and the T5 actions.
      super_admin: ["status", "is_deleted", "ward_id", "assigned_to_text", "due_at", "cleaned_by_name", "cleaned_by_type", "cleaned_at", "invalid_reason", "admin_note", "updated_at"],
      // Status, ward and note, plus the fields the status trigger demands with a status change, and is_deleted to
      // hide or unhide a report of their municipality (a soft hide, recorded with a reason; never a delete).
      municipality_admin: ["status", "ward_id", "admin_note", "invalid_reason", "cleaned_by_name", "cleaned_by_type", "cleaned_at", "is_deleted"],
    },
    scope: { municipality_admin: "municipality_id" },
  },
  cleanup_proofs: {
    select: ["super_admin"],
    update: ["super_admin"],
    read: ["id", "report_id", "image_url", "submitted_by", "cleaned_date_estimate", "status", "admin_notes", "created_at", "updated_at"],
    star: true,
    filter: { super_admin: ["id", "status", "report_id", "created_at", "updated_at"] },
    order: { super_admin: ["created_at", "updated_at"] },
    embeds: {
      reports: { columns: ["id", "photo_url", "area", "landmark", "district", "constituency", "description", "waste_type", "mla", "mp", "created_at", "status", "municipality_id", "ward_id"] },
    },
    statuses: new Set(["approved", "rejected"]),
    body: { super_admin: ["status", "admin_notes", "updated_at"] },
  },
  report_contacts: {
    select: ["super_admin"],
    read: ["report_id", "name", "email", "created_at"],
    filter: { super_admin: ["report_id"] },
    order: { super_admin: ["created_at"] },
    embeds: {},
  },
  audit_log: {
    select: ["super_admin", "municipality_admin"],
    read: ["id", "municipality_id", "entity_type", "entity_id", "actor_id", "actor_email", "action", "from_value", "to_value", "note", "created_at"],
    filter: {
      super_admin: ["id", "entity_type", "entity_id", "actor_email", "action", "created_at", "municipality_id"],
      municipality_admin: ["id", "entity_type", "entity_id", "actor_email", "action", "created_at"],
    },
    order: { super_admin: ["created_at", "id"], municipality_admin: ["created_at", "id"] },
    embeds: {},
    scope: { municipality_admin: "municipality_id" },
  },
  wards: {
    select: ["super_admin", "municipality_admin"],
    read: ["id", "municipality_id", "number", "name"],
    filter: { super_admin: ["id", "number", "municipality_id"], municipality_admin: ["id", "number"] },
    order: { super_admin: ["number"], municipality_admin: ["number"] },
    embeds: {},
    scope: { municipality_admin: "municipality_id" },
  },
  ward_localities: {
    select: ["super_admin"],
    read: ["id", "ward_id", "municipality_id", "name", "aliases"],
    filter: { super_admin: ["id", "ward_id", "municipality_id"] },
    order: { super_admin: ["name"] },
    embeds: {},
  },
  municipalities: {
    select: ["super_admin", "municipality_admin"],
    read: ["id", "slug", "name", "logo_url", "is_active", "settings"],
    filter: { super_admin: ["id", "slug"], municipality_admin: [] },
    order: { super_admin: ["name"], municipality_admin: ["name"] },
    embeds: {},
    scope: { municipality_admin: "id" },
  },
  staff_profiles: {
    select: ["super_admin", "municipality_admin"],
    read: ["user_id", "municipality_id", "role", "email", "full_name", "designation", "is_active", "created_at"],
    filter: { super_admin: ["user_id", "municipality_id", "role", "is_active"], municipality_admin: [] },
    order: { super_admin: ["created_at"], municipality_admin: ["created_at"] },
    embeds: {},
    scope: { municipality_admin: "user_id" },
  },
};

// Edge functions. Only a super admin may call them. jabor-notify is not here: it is called by the
// server with a shared secret, never through this proxy.
const FUNCTIONS = { "jabor-recommendations": ["super_admin"], "jabor-execute": ["super_admin"], "jabor-embed": ["super_admin"] };

// Database functions (RPC), called as POST /rest/v1/rpc/<name> with a JSON body of arguments. Each lists its
// roles and an exact check per argument. The functions are SECURITY INVOKER and check the caller again, so
// RLS and the functions themselves are the second layer. A municipality admin never sends p_municipality:
// the proxy adds their own, as it does for the table scope.
const MONTH_START = /^(\d{4})-(\d{2})-01$/;
const RPCS = {
  monthly_ward_report: {
    roles: ["super_admin", "municipality_admin"],
    args: { p_month: v => typeof v === "string" && MONTH_START.test(v) && +MONTH_START.exec(v)[2] >= 1 && +MONTH_START.exec(v)[2] <= 12 && +MONTH_START.exec(v)[1] >= 2020 },
  },
  ward_hotspots: {
    roles: ["super_admin", "municipality_admin"],
    args: { p_days: v => v === 30 || v === 60 || v === 90 },
  },
};

const PREFER_ALLOWED = new Set(["return=minimal", "return=representation", "count=exact"]);
const OPERATORS = "eq|neq|gt|gte|lt|lte|in|is|ilike|like";
const CONDITION = new RegExp(`^(?:not\\.)?([a-z_]+)\\.(?:not\\.)?(?:${OPERATORS})\\.`, "s");
const FILTER_VALUE = new RegExp(`^(?:not\\.)?(?:${OPERATORS})\\.`, "s");

// Splits on commas that are not inside parentheses or double quotes.
function splitTop(text) {
  const parts = [];
  let depth = 0, quoted = false, current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === "\\") { current += ch + (text[++i] ?? ""); continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")" && --depth < 0) deny("filter-syntax");
    if (ch === "," && depth === 0 && !quoted) { parts.push(current); current = ""; } else current += ch;
  }
  if (depth !== 0 || quoted) deny("filter-syntax");
  parts.push(current);
  return parts;
}

// or=(...) and and=(...): every column used anywhere inside, however nested, must be one the role may filter by.
function checkLogic(value, columns, level = 0) {
  if (level > 3 || !value.startsWith("(") || !value.endsWith(")")) deny("logic-syntax");
  const parts = splitTop(value.slice(1, -1));
  if (parts.length > 20) deny("logic-size");
  for (const part of parts) {
    const group = /^(?:not\.)?(?:and|or)(\(.*\))$/s.exec(part);
    if (group) { checkLogic(group[1], columns, level + 1); continue; }
    const condition = CONDITION.exec(part);
    if (!condition || !columns.has(condition[1])) deny("logic-column");
  }
}

function parseSelect(value, table) {
  for (const part of splitTop(value)) {
    if (part === "*") { if (!table.star) deny("select-star"); continue; }
    if (IDENT.test(part)) { if (!table.read.includes(part)) deny("select-column"); continue; }
    const embed = /^(?:[a-z_]+:)?([a-z_]+)(?:!inner)?\((.*)\)$/s.exec(part);
    const spec = embed && table.embeds[embed[1]];
    if (!spec) deny("select-embed");
    for (const inner of splitTop(embed[2])) {
      if (!spec.columns.includes(inner) && !(inner === "*" && spec.star)) deny("select-embed-column");
    }
  }
}

function parseOrder(value, columns) {
  const seen = new Set();
  const parts = value.split(",");
  if (parts.length > 3) deny("order-size");
  for (const part of parts) {
    const match = /^([a-z_]+)(?:\.(?:asc|desc))?(?:\.(?:nullsfirst|nullslast))?$/.exec(part);
    if (!match || !columns.includes(match[1]) || seen.has(match[1])) deny("order-column");
    seen.add(match[1]);
  }
}

const decode = text => {
  try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return deny("encoding"); }
};

// staff: { role, userId, municipalityId }. request: { path, method, prefer, body }.
// Returns { path, method, prefer, body } to send to Supabase, or throws Denied.
export function authorize(staff, request) {
  const { role } = staff;
  const method = request.method;
  const rawPath = request.path;
  // Long enough for an in.(...) list of a few hundred ids; the admin lists are paged.
  if (typeof rawPath !== "string" || rawPath.length > 12000 || /[#\s\\]/.test(rawPath)) deny("path");
  const queryAt = rawPath.indexOf("?");
  const pathOnly = queryAt === -1 ? rawPath : rawPath.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? "" : rawPath.slice(queryAt + 1);

  // ── Edge functions ─────────────────────────────────────────────────────────
  const fn = /^\/functions\/v1\/(jabor-[a-z]+)$/.exec(pathOnly);
  if (fn) {
    if (method !== "POST" || rawQuery || !FUNCTIONS[fn[1]]?.includes(role)) deny("function");
    if (request.prefer != null) deny("prefer");
    const body = request.body ?? {};
    const text = JSON.stringify(body);
    if (typeof body !== "object" || body === null || Array.isArray(body) || text.length > 100_000) deny("function-body");
    return { path: pathOnly, method, prefer: undefined, body: text };
  }

  // ── Database functions ─────────────────────────────────────────────────────
  const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(pathOnly);
  if (rpc) {
    const spec = RPCS[rpc[1]];
    if (!spec || method !== "POST" || rawQuery || !spec.roles.includes(role)) deny("rpc");
    if (request.prefer != null) deny("prefer");
    const data = request.body;
    if (typeof data !== "object" || data === null || Array.isArray(data)) deny("body-shape");
    const scoped = role === "municipality_admin";
    const allowed = [...Object.keys(spec.args), ...(scoped ? [] : ["p_municipality"])];
    const keys = Object.keys(data);
    if (scoped && keys.includes("p_municipality")) deny("scope-key");
    if (keys.length !== allowed.length || keys.some(k => !allowed.includes(k))) deny("body-key");
    for (const [name, valid] of Object.entries(spec.args)) if (!valid(data[name])) deny("rpc-arg");
    const municipality = scoped ? staff.municipalityId : data.p_municipality;
    if (typeof municipality !== "string" || !UUID.test(municipality)) deny(scoped ? "scope-missing" : "rpc-arg");
    const clean = { p_municipality: municipality };
    for (const name of Object.keys(spec.args)) clean[name] = data[name];
    return { path: pathOnly, method, prefer: undefined, body: JSON.stringify(clean) };
  }

  // ── Tables ─────────────────────────────────────────────────────────────────
  const match = /^\/rest\/v1\/([a-z_]+)$/.exec(pathOnly);
  const table = match && TABLES[match[1]];
  if (!table) deny("table");
  const operation = method === "GET" ? "select" : method === "PATCH" ? "update" : null;
  if (!operation || !table[operation]?.includes(role)) deny("operation");

  if (request.prefer != null && !PREFER_ALLOWED.has(request.prefer)) deny("prefer");

  const filterColumns = new Set(table.filter[role] ?? []);
  const scopeKey = table.scope?.[role];
  const pairs = [];
  const seenKeys = new Set();
  const params = rawQuery ? rawQuery.split("&") : [];
  if (params.length > MAX_PARAMS) deny("params");
  for (const param of params) {
    const eq = param.indexOf("=");
    const key = decode(eq === -1 ? param : param.slice(0, eq));
    const value = eq === -1 ? "" : decode(param.slice(eq + 1));
    if (seenKeys.has(key)) deny("duplicate-key");
    seenKeys.add(key);
    if (value.length > 10000) deny("value-size");
    if (key === scopeKey) deny("scope-key");
    pairs.push([key, value]);
  }

  for (const [key, value] of pairs) {
    if (key === "select") parseSelect(value, table);
    else if (key === "order") { if (operation !== "select") deny("order"); parseOrder(value, table.order[role] ?? []); }
    else if (key === "limit") { if (operation !== "select" || !/^\d{1,4}$/.test(value) || +value < 1 || +value > MAX_LIMIT) deny("limit"); }
    else if (key === "offset") { if (operation !== "select" || !/^\d{1,6}$/.test(value)) deny("offset"); }
    else if (key === "or" || key === "and") checkLogic(value, filterColumns);
    else if (filterColumns.has(key)) { if (!FILTER_VALUE.test(value)) deny("filter-value"); }
    else deny("param-key");
  }

  if (operation === "select" && !seenKeys.has("select")) deny("select-required");
  if (operation === "select" && !seenKeys.has("limit")) pairs.push(["limit", String(MAX_LIMIT)]);

  let body;
  if (operation === "update") {
    // One row at a time, by id: a PATCH can never match many rows.
    const idFilter = pairs.find(([key]) => key === "id");
    if (!idFilter || !/^eq\./.test(idFilter[1]) || !UUID.test(idFilter[1].slice(3))) deny("update-id");
    if (pairs.some(([key]) => key !== "id" && key !== "select")) deny("update-filter");
    const data = request.body;
    const allowedKeys = table.body?.[role] ?? [];
    if (typeof data !== "object" || data === null || Array.isArray(data)) deny("body-shape");
    const keys = Object.keys(data);
    if (keys.length === 0 || keys.length > 12 || keys.some(k => !allowedKeys.includes(k))) deny("body-key");
    for (const k of keys) {
      const v = data[k];
      if (v !== null && !["string", "number", "boolean"].includes(typeof v)) deny("body-value");
      if (typeof v === "string" && v.length > 2000) deny("body-value");
    }
    if (data.status !== undefined && !table.statuses.has(data.status)) deny("body-status");
    if (data.is_deleted !== undefined && typeof data.is_deleted !== "boolean") deny("body-is-deleted");
    if (data.cleaned_by_type != null && !CLEANED_BY.has(data.cleaned_by_type)) deny("body-cleaned-by");
    if (data.ward_id != null && !UUID.test(String(data.ward_id))) deny("body-ward");
    body = JSON.stringify(data);
  } else if (request.body !== undefined && request.body !== null) {
    deny("body-on-read");
  }

  // The server's own scope goes last, on top of whatever the client sent.
  if (scopeKey) {
    const scopeValue = scopeKey === "user_id" ? staff.userId : staff.municipalityId;
    if (!scopeValue || !UUID.test(scopeValue)) deny("scope-missing");
    pairs.push([scopeKey, `eq.${scopeValue}`]);
  }

  const query = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return { path: `${pathOnly}?${query}`, method, prefer: request.prefer, body };
}

// Used by tests and docs: the tables a role may touch, and with which operations.
export function summary(role) {
  const out = {};
  for (const [name, table] of Object.entries(TABLES)) {
    const ops = ["select", "update"].filter(op => table[op]?.includes(role));
    if (ops.length) out[name] = ops;
  }
  out.functions = Object.keys(FUNCTIONS).filter(f => FUNCTIONS[f].includes(role));
  out.rpc = Object.keys(RPCS).filter(f => RPCS[f].roles.includes(role));
  return out;
}
