// The admin area is addressed by the URL hash, so a refresh stays on the same page:
//   #/dashboard   #/reports   #/reports/unassigned   #/reports/all?status=invalid   #/reports/all?overdue=1
//   #/hotspots    #/monthly   #/audit
// Pure functions, tested by src/admin/shell.check.js.
import type { TileKey } from "./queryBuilders.ts";
import type { ReportTab, StatusFilter } from "./types.ts";

export const REPORT_TABS: { id: ReportTab; label: string }[] = [
  { id: "all", label: "All reports" },
  { id: "unassigned", label: "Unassigned wards" },
  { id: "active", label: "Active" },
  { id: "in_progress", label: "In progress" },
  { id: "cleaned", label: "Cleaned" },
  { id: "hidden", label: "Hidden" },
];
const STATUS_VALUES: StatusFilter[] = ["active", "in_progress", "cleaned", "invalid", "auto_cleaned"];

export type Route = { page: string; tab: ReportTab; status: StatusFilter; overdue: boolean };
export const DEFAULT_ROUTE: Route = { page: "dashboard", tab: "all", status: "", overdue: false };

// pages: the ids this person may open. Anything else (a typo, an old link, a page their role does not have) is the dashboard.
export function parseRoute(hash: string, pages: string[]): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page = "", tab = ""] = path.split("/");
  if (!pages.includes(page)) return DEFAULT_ROUTE;
  if (page !== "reports") return { ...DEFAULT_ROUTE, page };
  const params = new URLSearchParams(query);
  const status = params.get("status") as StatusFilter;
  const tabId = REPORT_TABS.some(t => t.id === tab) ? (tab as ReportTab) : "all";
  return {
    page,
    tab: tabId,
    status: tabId === "all" && STATUS_VALUES.includes(status) ? status : "",
    overdue: params.get("overdue") === "1" && (tabId === "all" || tabId === "active" || tabId === "unassigned"),
  };
}

export function formatRoute(route: Partial<Route> & { page: string }): string {
  if (route.page !== "reports") return `#/${route.page}`;
  const tab = route.tab ?? "all";
  const params = new URLSearchParams();
  if (tab === "all" && route.status) params.set("status", route.status);
  if (route.overdue) params.set("overdue", "1");
  const query = params.toString();
  return `#/reports${tab === "all" && !query ? "" : `/${tab}`}${query ? `?${query}` : ""}`;
}

// Where a tile leads: the Reports page with that filter applied.
export const TILE_ROUTE: Record<TileKey, Route> = {
  total: { page: "reports", tab: "all", status: "", overdue: false },
  active: { page: "reports", tab: "active", status: "", overdue: false },
  in_progress: { page: "reports", tab: "in_progress", status: "", overdue: false },
  cleaned: { page: "reports", tab: "cleaned", status: "", overdue: false },
  invalid: { page: "reports", tab: "all", status: "invalid", overdue: false },
  overdue: { page: "reports", tab: "all", status: "", overdue: true },
  unassigned: { page: "reports", tab: "unassigned", status: "", overdue: false },
  auto_cleaned: { page: "reports", tab: "all", status: "auto_cleaned", overdue: false },
};
