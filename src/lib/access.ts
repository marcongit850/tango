type AccessMembership = {
  role_id: string;
  is_admin?: number | boolean | string | null;
  status?: string | null;
} | null | undefined;

export function isBoardMember(membership: AccessMembership): boolean {
  if (!membership || membership.status === "inactive") return false;
  return membership.role_id === "board" || membership.role_id === "officer";
}

/** Admin tools. Officers are treated as admins until the role migration is applied. */
export function isAdmin(membership: AccessMembership): boolean {
  if (!isBoardMember(membership) || !membership) return false;
  if (membership.role_id === "officer") return true;
  return Number(membership.is_admin) === 1;
}

/**
 * Admins see ledgers inside their own association.
 * Homeowners and board members without admin see only lots they own.
 * The caller must already have scoped the lot to that association.
 */
export function canViewPropertyFinancials(
  membership: AccessMembership,
  viewerUserId: string,
  ownerUserIds: readonly string[],
): boolean {
  if (isAdmin(membership)) return true;
  if (!membership || membership.status === "inactive") return false;
  if (membership.role_id !== "homeowner" && membership.role_id !== "board" && membership.role_id !== "officer") return false;
  return ownerUserIds.includes(viewerUserId);
}

export type AdminContact = { user_id: string; name: string; email: string };

/** Active board members with Admin access, one row per person, in the given order. */
export function activeAdminContacts(
  people: (AdminContact & { role_id: string; is_admin?: number | boolean | string | null; status?: string | null })[],
): AdminContact[] {
  const seen = new Set<string>();
  const contacts: AdminContact[] = [];
  for (const person of people) {
    if (person.status !== "active" || !isAdmin(person) || seen.has(person.user_id)) continue;
    const name = person.name.trim();
    const email = person.email.trim();
    if (!name && !email) continue;
    seen.add(person.user_id);
    contacts.push({ user_id: person.user_id, name, email });
  }
  return contacts;
}

export function keepsAnAdmin(input: {
  activeAdminCount: number;
  currentlyAdmin: boolean;
  nextAdmin: boolean;
}): boolean {
  if (!input.currentlyAdmin || input.nextAdmin) return true;
  return input.activeAdminCount > 1;
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
