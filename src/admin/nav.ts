import type { Role } from "./types.ts";

export type IconName = "dashboard" | "reports" | "hotspots" | "monthly" | "audit" | "tool";
export type NavItem = { id: string; label: string; icon: IconName; roles?: Role[] };

// The sidebar, in order. An item with `roles` shows only to those roles; one without shows to everyone.
// A super-admin-only page goes here, with its page added in AdminApp's `pages`, for example:
//   { id: "admins", label: "Municipal admins", icon: "audit", roles: ["super_admin"] }
export const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "reports", label: "Reports", icon: "reports" },
  { id: "hotspots", label: "Hotspots", icon: "hotspots" },
  { id: "monthly", label: "Monthly report", icon: "monthly" },
  { id: "audit", label: "Audit log", icon: "audit" },
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
