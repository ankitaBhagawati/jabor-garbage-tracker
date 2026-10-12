// The pure parts of the Select component: filtering, keyboard movement and where the panel opens.
// No React and no DOM, so api/_lib/select.check.js can test them from node.

export type Option = { value: string; label: string };

export const SEARCH_THRESHOLD = 8; // a list longer than this gets a search box
export const SHEET_BREAKPOINT = 640; // below this width the panel is a bottom sheet
export const PANEL_MAX_HEIGHT = 280; // desktop panel, in px
export const PANEL_GAP = 4;
export const EDGE_MARGIN = 8;

export const needsSearch = (count: number) => count > SEARCH_THRESHOLD;

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// Options whose label contains what was typed (ignoring case and extra spaces). Empty input keeps all.
export function filterOptions(options: Option[], query: string): Option[] {
  const q = norm(query);
  return q ? options.filter(o => norm(o.label).includes(q)) : options;
}

export type Move = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";

// The next highlighted row. -1 means nothing is highlighted yet. It does not wrap: the ends stop.
export function nextIndex(current: number, key: Move, length: number): number {
  if (length <= 0) return -1;
  switch (key) {
    case "ArrowDown": return Math.min(length - 1, current < 0 ? 0 : current + 1);
    case "ArrowUp": return Math.max(0, current < 0 ? length - 1 : current - 1);
    case "Home": return 0;
    case "End": return length - 1;
    case "PageDown": return Math.min(length - 1, (current < 0 ? 0 : current) + 5);
    case "PageUp": return Math.max(0, (current < 0 ? 0 : current) - 5);
  }
}

export type Placement =
  | { mode: "sheet" }
  | { mode: "below" | "above"; left: number; width: number; top?: number; bottom?: number; maxHeight: number };

// Where the panel goes. On a narrow screen it is a bottom sheet. Otherwise it opens below the control, or
// above it when there is not enough room below and more room above, and it is never taller than the room
// it has, so it cannot run off the screen. rect is the control's bounding box in viewport pixels.
export function choosePlacement(rect: { top: number; bottom: number; left: number; width: number }, viewportWidth: number, viewportHeight: number, wanted = PANEL_MAX_HEIGHT): Placement {
  if (viewportWidth < SHEET_BREAKPOINT) return { mode: "sheet" };
  const below = viewportHeight - rect.bottom - PANEL_GAP - EDGE_MARGIN;
  const above = rect.top - PANEL_GAP - EDGE_MARGIN;
  const width = Math.min(rect.width, viewportWidth - 2 * EDGE_MARGIN);
  const left = Math.max(EDGE_MARGIN, Math.min(rect.left, viewportWidth - EDGE_MARGIN - width));
  if (below >= wanted || below >= above) return { mode: "below", left, width, top: rect.bottom + PANEL_GAP, maxHeight: Math.max(120, Math.min(wanted, below)) };
  return { mode: "above", left, width, bottom: viewportHeight - rect.top + PANEL_GAP, maxHeight: Math.max(120, Math.min(wanted, above)) };
}
