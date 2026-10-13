import type { CSSProperties } from "react";

// Small inline SVG icons for the public site, in place of emoji. They take the colour of the text around them.
const PATHS = {
  trash: "M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5",
  bottle: "M10 3h4v3l1.5 2.5V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V8.5L10 6V3ZM8.5 12.5h7",
  brick: "M3.5 6.5h17v11h-17ZM3.5 12h17M9 6.5V12M15 12v5.5",
  leaf: "M5 19c0-8 5-13 14-14 0 9-5 14-13 14M5 19l7-7",
  drop: "M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5Z",
  alert: "M12 4 3 19.5h18L12 4ZM12 10v4.5M12 17.2h.01",
  pin: "M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10c0 5.3 6.5 11 6.5 11ZM12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z",
  camera: "M4 8h3l1.5-2.5h7L17 8h3v11H4ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  check: "m5 12.5 4.5 4.5L19 7.5",
  checkCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.5l3 3 5-6",
  user: "M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5ZM4.5 20.5c.6-4 3.7-6 7.5-6s6.9 2 7.5 6",
  menu: "M4 6.5h16M4 12h16M4 17.5h16",
  flag: "M6 21V4M6 5h11l-2 4 2 4H6",
  feed: "M5 5h14v14H5ZM8.5 9h7M8.5 12.5h7M8.5 16h4",
  quote: "M9.5 7C6.5 8 5 10 5 13v4h5v-5H7.5c0-1.6 1-2.6 2.5-3.2ZM18.5 7c-3 1-4.5 3-4.5 6v4h5v-5h-2.5c0-1.6 1-2.6 2.5-3.2Z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5.5M12 7.8h.01",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.5-3.4 3-5.2 6.5-5.2s6 1.8 6.5 5.2M16 4.5a3.2 3.2 0 0 1 0 6.2M18 14.8c1.9.5 3.2 2 3.5 4.7",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z",
  chevronLeft: "m15 5-7 7 7 7",
  chevronRight: "m9 5 7 7-7 7",
  shield: "M12 3 5 6v5.5c0 4.3 2.9 7.6 7 9.5 4.1-1.9 7-5.2 7-9.5V6l-7-3ZM12 9v4M12 15.5h.01",
  shieldCheck: "M12 3 5 6v5.5c0 4.3 2.9 7.6 7 9.5 4.1-1.9 7-5.2 7-9.5V6l-7-3ZM8.8 12l2.2 2.2 4.2-4.4",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  grid: "M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM13 13h7v7h-7Z",
  chart: "M4 20V10M10 20V4M16 20v-7M21 20H3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2",
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 16, style }: { name: GlyphName; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flex: "none", verticalAlign: "-0.2em", ...style }}>
      <path d={PATHS[name]} />
    </svg>
  );
}

// One icon for each kind of waste.
const WASTE_GLYPH: Record<string, GlyphName> = { mixed: "trash", plastic: "bottle", construction: "brick", organic: "leaf", water: "drop", medical: "alert" };
export const WasteIcon = ({ type, size = 16 }: { type: string; size?: number }) => <Glyph name={WASTE_GLYPH[type] ?? "trash"} size={size} />;
