import type { MembershipRole, RoleId } from "../types";

export function isStaff(role: RoleId | MembershipRole | null | undefined): boolean {
  return role === "board" || role === "officer";
}

/**
 * Homeowners see ledgers only for lots they own.
 * Board and officers see ledgers inside their own association.
 * Public visitors see none. The caller must already have scoped the lot to that association.
 */
export function canViewPropertyFinancials(
  role: RoleId | MembershipRole | null | undefined,
  viewerUserId: string,
  ownerUserIds: readonly string[],
): boolean {
  if (isStaff(role)) return true;
  if (role !== "homeowner") return false;
  return ownerUserIds.includes(viewerUserId);
}

export function shouldRevealMagicLink(options: {
  appEnv: string;
  hostname: string;
  emailSent: boolean;
}): boolean {
  if (options.emailSent) return false;
  if (options.hostname === "localhost" || options.hostname === "127.0.0.1") return true;
  return options.appEnv === "development";
}

export function safeNextPath(slug: string, value: string): string {
  const dashboard = `/a/${slug}/dashboard`;
  if (!value.startsWith(`/a/${slug}/`)) return dashboard;
  if (value.startsWith("//") || value.includes("\\") || value.includes("/login")) return dashboard;
  return value;
}
