type AccessMembership = {
  role_id: string;
  is_admin?: number | boolean | string | null;
  status?: string | null;
} | null | undefined;

export function isBoardMember(membership: AccessMembership): boolean {
  if (!membership || membership.status === "inactive") return false;
  return membership.role_id === "board" || membership.role_id === "officer";
}

/**
 * Edit access (`is_admin`) on a homeowner or a board member.
 * Officers are treated as admins until the role migration is applied.
 */
export function isAdmin(membership: AccessMembership): boolean {
  if (!membership || membership.status === "inactive") return false;
  if (membership.role_id === "officer") return true;
  if (membership.role_id !== "board" && membership.role_id !== "homeowner") return false;
  return Number(membership.is_admin) === 1;
}

/** Board members can open admin read pages. A homeowner can open them only with edit access. */
export function canViewAdmin(membership: AccessMembership): boolean {
  return isBoardMember(membership) || isAdmin(membership);
}

/** Edit access: create, edit, and delete in admin tools. */
export function canEditAdmin(membership: AccessMembership): boolean {
  return isAdmin(membership);
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

export type AdminContact = { user_id: string; name: string; email: string; is_master?: 0 | 1 };

export const MASTER_ADMIN_DELETE_MESSAGE = "The master admin cannot be deleted.";
export const MASTER_ADMIN_EDIT_MESSAGE = "The master admin must keep edit access.";

/** Active people with edit access, one row per person, in the given order. */
export function activeAdminContacts(
  people: ({
    user_id: string;
    name: string;
    email: string;
    role_id: string;
    is_admin?: number | boolean | string | null;
    is_master?: number | boolean | string | null;
    status?: string | null;
  })[],
): AdminContact[] {
  const seen = new Set<string>();
  const contacts: AdminContact[] = [];
  for (const person of people) {
    if (person.status !== "active" || !isAdmin(person) || seen.has(person.user_id)) continue;
    const name = person.name.trim();
    const email = person.email.trim();
    if (!name && !email) continue;
    seen.add(person.user_id);
    const contact: AdminContact = { user_id: person.user_id, name, email };
    if (Number(person.is_master) === 1) contact.is_master = 1;
    contacts.push(contact);
  }
  return contacts;
}

/**
 * The master admin keeps admin writes. Turning off edit access, marking them inactive,
 * or moving them to a role that cannot write is refused. Other people are unchanged.
 */
export function masterKeepsAdminWrites(input: {
  isMaster: boolean;
  nextIsAdmin: boolean;
  nextStatus: string;
  nextRole?: string;
}): boolean {
  if (!input.isMaster) return true;
  if (!input.nextIsAdmin) return false;
  if (input.nextStatus === "inactive") return false;
  if (input.nextRole && input.nextRole !== "board" && input.nextRole !== "homeowner" && input.nextRole !== "officer") {
    return false;
  }
  return true;
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
