import { useId, type ReactNode } from "react";
import Select, { type Option } from "../ui/Select.tsx";
import { Icon } from "./icons.tsx";

// The pieces every admin list uses for its filters, so they all look and work the same: a panel with a heading
// and the page's action at the right, labelled fields in two columns (one on a phone), and a cross inside a field
// that has a value, which clears just that field.

export function FilterPanel({ title, actions, children, footer, className = "" }: { title: string; actions?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <section className={`adm-filterpanel ${className}`.trim()} aria-label={title}>
      <div className="adm-filterhead">
        <h2>{title}</h2>
        {actions}
      </div>
      <div className="adm-filtergrid">{children}</div>
      {footer && <div className="adm-filterfoot">{footer}</div>}
    </section>
  );
}

const ClearButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" className="adm-fclear" aria-label={`Clear ${label}`} onClick={onClick}><Icon name="close" size={16} /></button>
);

export function TextField({ label, value, onChange, placeholder, maxLength = 80 }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; maxLength?: number }) {
  const id = useId();
  return (
    <div className="adm-ff">
      <label htmlFor={id}>{label}</label>
      <div className="adm-fcontrol">
        {/* type text, not search: the browser's own cross would be a second one */}
        <input id={id} className="inp adm-finput" type="text" inputMode="search" autoComplete="off" value={value} placeholder={placeholder} maxLength={maxLength} onChange={e => onChange(e.target.value)} />
        {value !== "" && <ClearButton label={label.toLowerCase()} onClick={() => onChange("")} />}
      </div>
    </div>
  );
}

export function DateField({ label, value, onChange, min, max, clearable = true, type = "date" }: { label: string; value: string; onChange: (value: string) => void; min?: string; max?: string; clearable?: boolean; type?: "date" | "month" }) {
  const id = useId();
  return (
    <div className="adm-ff">
      <label htmlFor={id}>{label}</label>
      <div className="adm-fcontrol adm-fdate">
        <input id={id} className="inp adm-finput" type={type} value={value} min={min} max={max} onChange={e => onChange(e.target.value)} />
        {clearable && value !== "" && <ClearButton label={label.toLowerCase()} onClick={() => onChange("")} />}
      </div>
    </div>
  );
}

export function SelectField({ label, value, options, onChange, placeholder, clearable = true }: { label: string; value: string; options: Option[]; onChange: (value: string) => void; placeholder: string; clearable?: boolean }) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="adm-ff">
      <span id={labelId} className="adm-flabel">{label}</span>
      <Select id={id} labelledBy={labelId} label={label.toLowerCase()} value={value} options={options} onChange={onChange} placeholder={placeholder} clearable={clearable} />
    </div>
  );
}

export function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="adm-fcheck">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
