import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./select.css";
import { choosePlacement, filterOptions, needsSearch, nextIndex, type Move, type Option, type Placement } from "./selectLogic.ts";

export type { Option };

type Props = {
  id?: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder: string; // shown when nothing is chosen
  label: string; // the control's name, for screen readers and the phone sheet's title
  labelledBy?: string; // id of a visible label, if there is one
  clearable?: boolean; // a cross that appears when a value is chosen and sets it back to ""
  disabled?: boolean;
  searchable?: boolean; // by default, a list of more than 8 options gets a search box
};

const MOVES: Move[] = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];

const Chevron = () => (
  <svg className="jsel-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 7.5 5 5 5-5" /></svg>
);
const Cross = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
);
const Check = () => (
  <svg className="jsel-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8" /></svg>
);

// A select that looks like the other inputs. Closed it is one line; open it is a panel with a fixed maximum
// height that scrolls inside, searchable when long, and a bottom sheet on a phone. Pattern: ARIA 1.2 select-only
// combobox (the button) with a listbox.
export default function Select({ id, value, options, onChange, placeholder, label, labelledBy, clearable = false, disabled = false, searchable }: Props) {
  const uid = useId();
  const triggerId = id ?? `${uid}-trigger`;
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [keyboardGap, setKeyboardGap] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const hasSearch = searchable ?? needsSearch(options.length);
  const shown = useMemo(() => (hasSearch ? filterOptions(options, query) : options), [hasSearch, options, query]);
  const selected = options.find(o => o.value === value);
  const sheet = placement?.mode === "sheet";

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openPanel = () => {
    if (disabled) return;
    const index = options.findIndex(o => o.value === value);
    setQuery("");
    setActive(index >= 0 ? index : 0);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = shown[index];
    if (!option) return;
    onChange(option.value);
    close(true);
  };

  // Where the panel goes: measured when it opens and again when the page scrolls or resizes.
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const viewport = window.visualViewport;
    const next = choosePlacement(trigger.getBoundingClientRect(), window.innerWidth, viewport?.height ?? window.innerHeight);
    setPlacement(next);
    // a phone's keyboard covers the bottom of the layout viewport: keep the sheet above it
    setKeyboardGap(next.mode === "sheet" && viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    place();
    const onMove = (e: Event) => { if (!(e.target instanceof Node && panelRef.current?.contains(e.target))) place(); };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open, place]);

  // Close on a press outside the control and the panel.
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [open, close]);

  // Focus the search box when there is one, and keep the highlighted row in view.
  useEffect(() => { if (open && hasSearch && placement) searchRef.current?.focus(); }, [open, hasSearch, placement]);
  useEffect(() => {
    if (open && active >= 0) listRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, placement]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); openPanel(); }
      return;
    }
    if (MOVES.includes(e.key as Move)) {
      // Home and End belong to the search box's text cursor while it has text
      if (hasSearch && (e.key === "Home" || e.key === "End") && query) return;
      e.preventDefault();
      setActive(a => nextIndex(a, e.key as Move, shown.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === " " && !hasSearch) {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close();
    }
  };

  const focusOwner = open && active >= 0 && shown[active] ? optionId(active) : undefined;
  const showClear = clearable && value !== "" && !disabled;
  const panelStyle = !placement ? { visibility: "hidden" as const } : placement.mode === "sheet" ? { bottom: keyboardGap } : {
    left: placement.left, width: placement.width, maxHeight: placement.maxHeight,
    ...(placement.mode === "below" ? { top: placement.top } : { bottom: placement.bottom }),
  };

  return (
    <div className={`jsel${open ? " is-open" : ""}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        className="jsel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={!hasSearch ? focusOwner : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
        aria-label={labelledBy ? undefined : label}
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={onKeyDown}
      >
        <span className={`jsel-value${selected ? "" : " jsel-placeholder"}`}>{selected ? selected.label : placeholder}</span>
        <Chevron />
      </button>
      {showClear && (
        <button type="button" className="jsel-clear" aria-label={`Clear ${label}`} onClick={() => { onChange(""); close(); triggerRef.current?.focus(); }}>
          <Cross />
        </button>
      )}
      {open && createPortal(
        <>
          {sheet && <div className="jsel-backdrop" aria-hidden="true" />}
          <div ref={panelRef} className={`jsel-panel${sheet ? " jsel-sheet" : ""}`} style={panelStyle}>
            {sheet && (
              <div className="jsel-head">
                <span>{label}</span>
                <button type="button" className="jsel-close" aria-label="Close" onClick={() => close(true)}><Cross /></button>
              </div>
            )}
            {hasSearch && (
              <input
                ref={searchRef}
                type="text"
                role="searchbox"
                className="jsel-search"
                placeholder="Type to search"
                aria-label={`Search ${label}`}
                aria-controls={listId}
                aria-activedescendant={focusOwner}
                autoComplete="off"
                value={query}
                onChange={e => { setQuery(e.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
              />
            )}
            <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="jsel-list">
              {shown.map((option, i) => (
                <li
                  key={option.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={option.value === value}
                  className={`jsel-option${i === active ? " is-active" : ""}`}
                  onMouseDown={e => e.preventDefault()}
                  onMouseMove={() => active !== i && setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Check />}
                </li>
              ))}
            </ul>
            {shown.length === 0 && <div className="jsel-empty" role="status">No matches</div>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
