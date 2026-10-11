import { HttpError } from "./server.js";

// Where a public report sits: which municipality, and which ward. Decided on the server from the
// district and constituency the reporter chose and their answer to the municipal-area question.
// A municipality_id sent by the browser is never read.
//
// municipalities: rows of { id, name, is_active, settings }. The question is asked for a
// municipality when settings.public_form = { district, constituencies: [...] } matches.
// wardBelongs(wardId, municipalityId): resolves true when that ward is in that municipality.

const ANSWERS = new Set(["yes", "no", "not_sure"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function findMunicipality(municipalities, district, constituency) {
  return (municipalities || []).find(m => {
    const form = m.settings?.public_form;
    return m.is_active !== false
      && form?.district === district
      && Array.isArray(form.constituencies)
      && form.constituencies.includes(constituency);
  }) || null;
}

export async function resolvePlacement(body, { municipalities, wardBelongs }) {
  const district = typeof body?.district === "string" ? body.district.trim() : "";
  const constituency = typeof body?.constituency === "string" ? body.constituency.trim() : "";
  const wardId = body?.ward_id ?? null;
  if (wardId !== null && (typeof wardId !== "string" || !UUID.test(wardId))) {
    throw new HttpError(400, "That ward is not valid.");
  }

  const municipality = findMunicipality(municipalities, district, constituency);
  if (!municipality) {
    // No municipality asks the question here: the report is stored as it always was.
    if (wardId) throw new HttpError(400, "A ward can only be chosen inside a municipal area.");
    return { municipality_id: null, ward_id: null, claimed_in_municipality: null };
  }

  const answer = body?.municipality_answer;
  if (!ANSWERS.has(answer)) {
    throw new HttpError(400, `Please say whether this location is within the ${municipality.name} area. If you already did, refresh the page and try again.`);
  }
  if (answer !== "yes") {
    if (wardId) throw new HttpError(400, "A ward can only be chosen when the location is inside the municipal area.");
    return {
      municipality_id: answer === "not_sure" ? municipality.id : null,
      ward_id: null,
      claimed_in_municipality: answer,
    };
  }

  if (wardId && !(await wardBelongs(wardId, municipality.id))) {
    throw new HttpError(400, "That ward is not in this municipal area.");
  }
  return { municipality_id: municipality.id, ward_id: wardId, claimed_in_municipality: "yes" };
}
