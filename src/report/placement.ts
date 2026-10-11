// Logic for the municipal-area question on the public report form. No JSX here, so it can be
// tested with plain node. The server decides the municipality and ward again from these answers;
// nothing here is trusted.

export type Ward = { id: string; number: number; name: string | null; localities: string[] };
export type Municipality = {
  name: string;
  district: string;
  constituencies: string[];
  wards: Ward[];
};
export type Answer = "" | "yes" | "no" | "not_sure";

// Value of the ward dropdown option "Not sure, JMB will assign". Stored as no ward.
export const WARD_NOT_SURE = "none";

export function findMunicipality(municipalities: Municipality[], district: string, constituency: string) {
  return municipalities.find(m => m.district === district && m.constituencies.includes(constituency)) || null;
}

// "Ward 7", "Ward 7 · <name>", or "Ward 7 · <locality>, <locality>" when the ward has no name yet.
export function wardLabel(ward: Ward) {
  const detail = ward.name?.trim() || ward.localities.join(", ");
  return detail ? `Ward ${ward.number} · ${detail}` : `Ward ${ward.number}`;
}

// What the form must have before it can submit. Returns a message, or "" when it is fine.
export function placementError(municipality: Municipality | null, answer: Answer, wardChoice: string) {
  if (!municipality) return "";
  if (!answer) return `Please say whether this location is within the ${municipality.name} area.`;
  if (answer === "yes" && !wardChoice) return "Please choose a ward, or \"Not sure, JMB will assign\".";
  return "";
}

// The two fields added to the submit request. Empty when no municipality asks the question.
export function placementFields(municipality: Municipality | null, answer: Answer, wardChoice: string) {
  if (!municipality || !answer) return {};
  const ward_id = answer === "yes" && wardChoice && wardChoice !== WARD_NOT_SURE ? wardChoice : null;
  return { municipality_answer: answer, ward_id };
}

export async function loadMunicipalities(): Promise<Municipality[]> {
  const res = await fetch("/api/municipalities", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`municipalities ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.municipalities) ? data.municipalities : [];
}
