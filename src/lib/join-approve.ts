import { clearJoinRequestNotices, findMembership, findUserByEmail } from "../db";
import type { MembershipRole } from "../types";

const LOGIN_URL = "https://mytangomar.com/login";
const HOME_URL = "https://mytangomar.com";

export type LotCandidate = {
  id: string;
  lotNumber: string;
  streetAddress: string;
  ownerCount: number;
  ownedByUser: boolean;
};

export type LotPlan =
  | { kind: "link"; propertyId: string; lotNumber: string }
  | { kind: "already"; propertyId: string; lotNumber: string }
  | { kind: "skip"; reason: "blank" | "none" | "ambiguous" | "occupied"; lotNumber?: string };

export type LotOutcome =
  | { kind: "linked"; lotNumber: string }
  | { kind: "already"; lotNumber: string }
  | { kind: "skipped"; reason: "blank" | "none" | "ambiguous" | "occupied"; lotNumber?: string };

type MembershipSnapshot = { role_id: string; status: string; is_admin?: number | null } | null;

export function planUserName(existingName: string | null | undefined, requestedName: string): string {
  if (existingName && existingName.trim()) return existingName;
  return requestedName.trim();
}

export function planMembership(existing: MembershipSnapshot): { roleId: MembershipRole; isAdmin: 0 | 1 } {
  if (existing && existing.status !== "inactive" && (existing.role_id === "board" || existing.role_id === "officer")) {
    const isAdmin = existing.role_id === "officer" || Number(existing.is_admin) === 1 ? 1 : 0;
    return { roleId: "board", isAdmin };
  }
  return { roleId: "homeowner", isAdmin: 0 };
}

function normalizeAddress(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lotAliases(lotNumber: string): Set<string> {
  const lot = normalizeAddress(lotNumber);
  return new Set([lot, `lot ${lot}`, `lot number ${lot}`, `lot no ${lot}`, `number ${lot}`]);
}

export function planLotLink(address: string, properties: LotCandidate[]): LotPlan {
  const normalized = normalizeAddress(address);
  if (!normalized) return { kind: "skip", reason: "blank" };

  const matches = properties.filter((property) => {
    if (lotAliases(property.lotNumber).has(normalized)) return true;
    return normalizeAddress(property.streetAddress) === normalized;
  });
  if (matches.length === 0) return { kind: "skip", reason: "none" };
  if (matches.length > 1) return { kind: "skip", reason: "ambiguous" };

  const match = matches[0];
  if (match.ownedByUser) return { kind: "already", propertyId: match.id, lotNumber: match.lotNumber };
  if (match.ownerCount > 0) return { kind: "skip", reason: "occupied", lotNumber: match.lotNumber };
  return { kind: "link", propertyId: match.id, lotNumber: match.lotNumber };
}

export function welcomeEmail(input: { associationName: string; email: string; name: string }): { subject: string; text: string } {
  const name = input.name.replace(/[\r\n]+/g, " ").trim();
  const hello = name ? `Hello ${name},` : "Hello,";
  return {
    subject: `You are approved for ${input.associationName}`,
    text: [
      hello,
      "",
      `You are approved to use the ${input.associationName} owner portal.`,
      "",
      `Go to ${LOGIN_URL} and sign in with the same email you used on your request:`,
      input.email,
      "",
      `Enter that email and the site will send you a link to log in. There is no password. You can also start from ${HOME_URL} and choose Resident login.`,
      "",
      "If you did not ask to join, you can ignore this email.",
    ].join("\n"),
  };
}

export function approvalSummary(input: {
  createdUser: boolean;
  roleId: MembershipRole;
  lot: LotOutcome;
  emailSent: boolean;
}): string {
  const access = input.createdUser
    ? "Homeowner login created."
    : input.roleId === "board"
      ? "Existing board login reused."
      : "Existing login reused.";
  let lot = "No lot matched that address, so no lot was linked.";
  if (input.lot.kind === "linked") lot = `Linked to lot ${input.lot.lotNumber}.`;
  else if (input.lot.kind === "already") lot = `Already linked to lot ${input.lot.lotNumber}.`;
  else if (input.lot.reason === "blank") lot = "No address was on the request, so no lot was linked.";
  else if (input.lot.reason === "ambiguous") lot = "That address matches more than one lot, so no lot was linked.";
  else if (input.lot.reason === "occupied") lot = `Lot ${input.lot.lotNumber} already has an owner, so no lot was linked.`;
  const email = input.emailSent
    ? "Welcome email sent."
    : "The login is ready, but the welcome email was not sent.";
  return `${access} ${lot} ${email}`;
}

type JoinRequestRecord = {
  id: string;
  name: string;
  email: string;
  address: string;
  status: string;
};

type PropertyMatchRow = {
  id: string;
  lot_number: string;
  street_address: string;
  owner_count: number;
  owned_by_user: number;
};

export type ApproveJoinResult =
  | {
      ok: true;
      requestId: string;
      email: string;
      name: string;
      userId: string;
      createdUser: boolean;
      roleId: MembershipRole;
      isAdmin: 0 | 1;
      lot: LotOutcome;
    }
  | { ok: false; reason: "missing" | "invalid_email" };

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function approveJoinRequest(
  db: D1Database,
  input: { associationId: string; requestId: string },
): Promise<ApproveJoinResult> {
  const request = await db
    .prepare(
      `SELECT id, name, email, address, status
       FROM join_requests
       WHERE association_id = ? AND id = ? AND status IN ('pending', 'reviewed', 'declined')`,
    )
    .bind(input.associationId, input.requestId)
    .first<JoinRequestRecord>();
  if (!request) return { ok: false, reason: "missing" };

  const email = request.email.trim().toLowerCase();
  if (!validEmail(email)) return { ok: false, reason: "invalid_email" };

  const existing = await findUserByEmail(db, email);
  const membership = existing ? await findMembership(db, input.associationId, existing.id) : null;
  const role = planMembership(membership);
  const name = planUserName(existing?.name, request.name);
  const userIdForMatch = existing?.id ?? "";
  const { results: propertyRows } = await db
    .prepare(
      `SELECT p.id, p.lot_number, p.street_address,
              (SELECT COUNT(*) FROM property_owners po
               WHERE po.association_id = p.association_id AND po.property_id = p.id) AS owner_count,
              (SELECT COUNT(*) FROM property_owners po
               WHERE po.association_id = p.association_id AND po.property_id = p.id AND po.user_id = ?) AS owned_by_user
       FROM properties p
       WHERE p.association_id = ? AND p.status = 'active'`,
    )
    .bind(userIdForMatch, input.associationId)
    .all<PropertyMatchRow>();
  const lotPlan = planLotLink(
    request.address,
    propertyRows.map((row) => ({
      id: row.id,
      lotNumber: row.lot_number,
      streetAddress: row.street_address,
      ownerCount: Number(row.owner_count),
      ownedByUser: Number(row.owned_by_user) > 0,
    })),
  );

  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO users (id, email, name, phone, created_at)
         VALUES (?, ?, ?, '', ?)
         ON CONFLICT(email) DO UPDATE SET
           name = CASE WHEN trim(users.name) != '' THEN users.name ELSE excluded.name END`,
      )
      .bind(existing?.id ?? crypto.randomUUID(), email, request.name.trim(), now),
    db
      .prepare(
        `INSERT INTO memberships (id, association_id, user_id, role_id, status, created_at)
         SELECT ?, ?, u.id, ?, 'active', ?
         FROM users u
         WHERE u.email = ?
         ON CONFLICT(association_id, user_id) DO UPDATE SET
           role_id = excluded.role_id,
           status = 'active'`,
      )
      .bind(crypto.randomUUID(), input.associationId, role.roleId, now, email),
  ];
  if (lotPlan.kind === "link") {
    statements.push(
      db
        .prepare(
          `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
           SELECT ?, ?, ?, u.id, 1, ?
           FROM users u
           WHERE u.email = ?
             AND NOT EXISTS (
               SELECT 1 FROM property_owners po
               WHERE po.association_id = ? AND po.property_id = ?
             )`,
        )
        .bind(crypto.randomUUID(), input.associationId, lotPlan.propertyId, now, email, input.associationId, lotPlan.propertyId),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE join_requests
         SET status = 'approved'
         WHERE association_id = ? AND id = ? AND status IN ('pending', 'reviewed', 'declined')
           AND EXISTS (
             SELECT 1 FROM users u
             JOIN memberships m ON m.user_id = u.id AND m.association_id = ?
             WHERE u.email = ? AND m.status = 'active'
           )`,
      )
      .bind(input.associationId, request.id, input.associationId, email),
  );

  const results = await db.batch(statements);
  const approved = (results[results.length - 1]?.meta.changes ?? 0) > 0;
  if (!approved) {
    const current = await db
      .prepare("SELECT status FROM join_requests WHERE association_id = ? AND id = ?")
      .bind(input.associationId, request.id)
      .first<{ status: string }>();
    if (!current || current.status === "approved") return { ok: false, reason: "missing" };
    throw new Error("Join approval did not attach a membership.");
  }

  const user = await findUserByEmail(db, email);
  if (!user) throw new Error("Join approval did not create a user.");
  await clearJoinRequestNotices(db, input.associationId, { id: request.id, name: request.name, email: request.email });

  let lot: LotOutcome;
  if (lotPlan.kind === "already") lot = { kind: "already", lotNumber: lotPlan.lotNumber };
  else if (lotPlan.kind === "skip") lot = { kind: "skipped", reason: lotPlan.reason, lotNumber: lotPlan.lotNumber };
  else {
    const lotChanges = results[results.length - 2]?.meta.changes ?? 0;
    lot =
      lotChanges > 0
        ? { kind: "linked", lotNumber: lotPlan.lotNumber }
        : { kind: "skipped", reason: "occupied", lotNumber: lotPlan.lotNumber };
  }

  return {
    ok: true,
    requestId: request.id,
    email,
    name,
    userId: user.id,
    createdUser: !existing,
    roleId: role.roleId,
    isAdmin: role.isAdmin,
    lot,
  };
}
