import type { IconName } from "./nav.ts";

type Name = IconName | "menu" | "user" | "close" | "chevron" | "signout" | "eye" | "eyeoff" | "copy" | "plus" | "key" | "check";

const PATHS: Record<Name, string> = {
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.5-3.4 3-5.2 6.5-5.2s6 1.8 6.5 5.2M16 4.5a3.2 3.2 0 0 1 0 6.2M18 14.8c1.9.5 3.2 2 3.5 4.7",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeoff: "M4 4l16 16M9.9 5.8A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3.2 3.9M6.4 7.5A15.6 15.6 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 4-.9M10 10a3 3 0 0 0 4 4",
  copy: "M8.5 8.5h11v11h-11ZM15.5 8.5v-4h-11v11h4",
  plus: "M12 5v14M5 12h14",
  key: "M14.5 9.5a4 4 0 1 1-1.2 2.8L3.5 12.5V15H6v-2.5h2.5V10l4.8-.5M16.5 8.5h.01",
  check: "m5 12.5 4.5 4.5L19 7.5",
  dashboard: "M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10M10 19.5v-5h4v5",
  reports: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  hotspots: "M12 3c1 3.5 4.5 5 4.5 9a4.5 4.5 0 0 1-9 0c0-1.7.8-2.8 1.5-3.8.5 1.3 1.2 1.8 2 1.8 0-2.5-.5-4.5 1-7Z",
  monthly: "M4 6.5h16V20H4ZM4 10.5h16M8 3.5v4M16 3.5v4",
  audit: "M7 3.5h8l4 4V20.5H7ZM15 3.5v4h4M10 12h6M10 16h6",
  tool: "M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5L15 12l-3-3Z",
  menu: "M4 6.5h16M4 12h16M4 17.5h16",
  user: "M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5ZM4.5 20.5c.6-4 3.7-6 7.5-6s6.9 2 7.5 6",
  close: "m5.5 5.5 13 13M18.5 5.5l-13 13",
  chevron: "m9 6 6 6-6 6",
  signout: "M10 4.5H5.5v15H10M14 8l4 4-4 4M18 12H9.5",
};

// Inline SVG icons. They are decorative: the text next to them carries the meaning.
export function Icon({ name, size = 20 }: { name: Name; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
