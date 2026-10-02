import {
  BarChart3Icon,
  BoxesIcon,
  ClipboardListIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  MessageSquareIcon,
  PackageIcon,
  PercentIcon,
  RotateCcwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UploadIcon,
  UsersIcon,
} from "lucide-react";

import type { Permission } from "@/lib/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  group: "Sell" | "Catalog" | "People" | "Store";
  /** Words the command palette also matches. */
  keywords?: string;
}

/** The whole admin, once: the sidebar, breadcrumbs and the command palette read it. */
export const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboardIcon, permission: "admin:access", group: "Sell" },
  { href: "/orders", label: "Orders", icon: ClipboardListIcon, permission: "orders:read", group: "Sell", keywords: "fulfil ship refund" },
  { href: "/returns", label: "Returns", icon: RotateCcwIcon, permission: "orders:read", group: "Sell", keywords: "rma" },
  { href: "/discounts", label: "Discounts", icon: PercentIcon, permission: "discounts:write", group: "Sell", keywords: "codes promotion coupon" },
  { href: "/analytics", label: "Analytics", icon: BarChart3Icon, permission: "reports:read", group: "Sell", keywords: "revenue reports funnel cohort" },
  { href: "/products", label: "Products", icon: PackageIcon, permission: "admin:access", group: "Catalog", keywords: "catalog variants media" },
  { href: "/inventory", label: "Inventory", icon: BoxesIcon, permission: "admin:access", group: "Catalog", keywords: "stock adjust" },
  { href: "/products/import", label: "Import products", icon: UploadIcon, permission: "catalog:write", group: "Catalog", keywords: "csv bulk" },
  { href: "/reviews", label: "Reviews", icon: MessageSquareIcon, permission: "catalog:write", group: "Catalog", keywords: "moderation" },
  { href: "/customers", label: "Customers", icon: UsersIcon, permission: "customers:read", group: "People" },
  { href: "/staff", label: "Staff", icon: ShieldCheckIcon, permission: "staff:manage", group: "People", keywords: "team invite roles" },
  { href: "/audit", label: "Audit log", icon: HistoryIcon, permission: "audit:read", group: "People", keywords: "history who" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, permission: "settings:manage", group: "Store", keywords: "shipping tax email payments store" },
]; // prettier-ignore

export const GROUPS = ["Sell", "Catalog", "People", "Store"] as const;

/** The nav item a path belongs to: the longest href that prefixes it. */
export function sectionOf(pathname: string): NavItem | undefined {
  return [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)));
}
