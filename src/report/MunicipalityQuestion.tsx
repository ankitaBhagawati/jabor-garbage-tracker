import { WARD_NOT_SURE, wardLabel, type Answer, type Municipality } from "./placement.ts";

type Props = {
  municipality: Municipality;
  answer: Answer;
  wardChoice: string;
  onAnswer: (answer: Answer) => void;
  onWard: (wardChoice: string) => void;
};

const OPTIONS: { value: Exclude<Answer, "">; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

// "Is this location within <municipality> area?" and, for Yes, a ward.
export default function MunicipalityQuestion({ municipality, answer, wardChoice, onAnswer, onWard }: Props) {
  return (
    <div style={{ marginBottom: 12 }}>
      {/* A span, not a legend: the anonymous-mode theme recolours labels and spans in the card, not legends. */}
      <fieldset aria-labelledby="municipality-question" style={{ border: 0, margin: 0, padding: 0 }}>
        <span id="municipality-question" className="lbl">
          IS THIS LOCATION WITHIN {municipality.name.toUpperCase()} AREA? <span style={{ color: "#10B981" }}>*</span>
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "6px 0" }}>
          {OPTIONS.map(option => (
            <label key={option.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, minHeight: 32, cursor: "pointer" }}>
              <input
                type="radio"
                name="municipality-answer"
                value={option.value}
                checked={answer === option.value}
                onChange={() => onAnswer(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {answer === "yes" && (
        <div style={{ marginTop: 8 }}>
          <label className="lbl" htmlFor="ward-select">WARD <span style={{ color: "#10B981" }}>*</span></label>
          <select id="ward-select" className="inp" value={wardChoice} onChange={e => onWard(e.target.value)}>
            <option value="">Select ward</option>
            {municipality.wards.map(ward => (
              <option key={ward.id} value={ward.id}>{wardLabel(ward)}</option>
            ))}
            <option value={WARD_NOT_SURE}>Not sure, JMB will assign</option>
          </select>
        </div>
      )}
    </div>
  );
}
