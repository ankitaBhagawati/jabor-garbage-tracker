import type { Role } from "./types.ts";

export type IconName = "dashboard" | "reports" | "hotspots" | "monthly" | "audit" | "tool" | "users";
export type NavItem = { id: string; label: string; icon: IconName; roles?: Role[] };

// The sidebar, in order. An item with `roles` shows only to those roles; one without shows to everyone.
// A super-admin-only page has `roles`. The server refuses these requests for anyone else anyway; a person who
// types the address of a page they do not have is sent to the Dashboard (parseRoute with the pages they have).
export const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "reports", label: "Reports", icon: "reports" },
  { id: "hotspots", label: "Hotspots", icon: "hotspots" },
  { id: "monthly", label: "Monthly report", icon: "monthly" },
  { id: "audit", label: "Audit log", icon: "audit" },
  { id: "admins", label: "Add admins", icon: "users", roles: ["super_admin"] },
];

export const navFor = (role: Role, extra: { id: string; label: string }[] = []): NavItem[] => [
  ...NAV.filter(item => !item.roles || item.roles.includes(role)),
  // the older owner screens the page that mounts the app supplies (Cleanup Verification, Moderation)
  ...extra.map(({ id, label }): NavItem => ({ id, label, icon: "tool", roles: ["super_admin"] })),
];

export const ROLE_LABEL: Record<Role, string> = { super_admin: "Super admin", municipality_admin: "Municipality admin" };

// The short name of a municipality, for the label under the profile icon ("JMB"). A municipality record may carry
// settings.short_name; the table has no column for it yet, so this small list is the fallback.
const SHORT_NAMES: Record<string, string> = { jorhat: "JMB", "Jorhat Municipal Board": "JMB" };
export const municipalityCode = (m?: { name?: string | null; slug?: string | null; settings?: object | null } | null): string => {
  const short = (m?.settings as { short_name?: unknown } | null | undefined)?.short_name;
  const fromSettings = typeof short === "string" ? short.trim() : "";
  return fromSettings || SHORT_NAMES[m?.slug ?? ""] || SHORT_NAMES[m?.name ?? ""] || "";
};

// The small label under the profile icon: "Super Admin", or "JMB Admin" (the fallback is "Municipal Admin").
export const roleBadge = (role: Role, m?: Parameters<typeof municipalityCode>[0]): string =>
  role === "super_admin" ? "Super Admin" : municipalityCode(m) ? `${municipalityCode(m)} Admin` : "Municipal Admin";
