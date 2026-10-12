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
  { id: "admins", label: "Municipal admins", icon: "users", roles: ["super_admin"] },
];

export const navFor = (role: Role, extra: { id: string; label: string }[] = []): NavItem[] => [
  ...NAV.filter(item => !item.roles || item.roles.includes(role)),
  // the older owner screens the page that mounts the app supplies (Cleanup Verification, Moderation)
  ...extra.map(({ id, label }): NavItem => ({ id, label, icon: "tool", roles: ["super_admin"] })),
];

export const ROLE_LABEL: Record<Role, string> = { super_admin: "Super admin", municipality_admin: "Municipality admin" };

// The header: "Jabor - Jorhat Municipal Board admin" or "Jabor - Super admin".
export const headerTitle = (role: Role, municipalityName: string | null | undefined) =>
  role === "super_admin" ? "Jabor - Super admin" : `Jabor - ${municipalityName || "Your municipality"} admin`;
