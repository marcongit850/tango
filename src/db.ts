import type {
  AnnouncementKind,
  Association,
  DocumentCategory,
  DocumentVisibility,
  EventKind,
  InvoiceStatus,
  Membership,
  MembershipRole,
  PaymentMethod,
  User,
} from "./types";
import { balanceCents, invoiceStatus, isDelinquent } from "./lib/money";

export async function findAssociationBySlug(db: D1Database, slug: string): Promise<Association | null> {
  return db
    .prepare(
      `SELECT id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone
       FROM associations WHERE slug = ?`,
    )
    .bind(slug)
    .first<Association>();
}

export async function listAssociations(db: D1Database): Promise<Association[]> {
  const { results } = await db
    .prepare(
      `SELECT id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone
       FROM associations ORDER BY name`,
    )
    .all<Association>();
  return results;
}

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db
    .prepare("SELECT id, email, name, phone FROM users WHERE email = ?")
    .bind(email)
    .first<User>();
}

export async function findSessionUser(db: D1Database, tokenHash: string, nowIso: string): Promise<User | null> {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.phone
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, nowIso)
    .first<User>();
}

export async function findMembership(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<Membership | null> {
  return db
    .prepare(
      `SELECT id, association_id, user_id, role_id, status
       FROM memberships
       WHERE association_id = ? AND user_id = ?`,
    )
    .bind(associationId, userId)
    .first<Membership>();
}

export async function writeAudit(
  db: D1Database,
  entry: {
    associationId: string;
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    detail?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, association_id, actor_user_id, action, entity_type, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entry.associationId,
      entry.actorUserId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.detail ?? "",
      new Date().toISOString(),
    )
    .run();
}

export async function notify(
  db: D1Database,
  entry: { associationId: string; userId: string; kind: string; title: string; body?: string; href?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      entry.associationId,
      entry.userId,
      entry.kind,
      entry.title,
      entry.body ?? "",
      entry.href ?? "",
      new Date().toISOString(),
    )
    .run();
}

export type BalanceRow = {
  property_id: string;
  lot_number: string;
  street_address: string;
  charges_cents: number;
  late_fee_cents: number;
  payment_cents: number;
  past_due: number;
  balance_cents: number;
  delinquent: boolean;
};

type BalanceQueryRow = Omit<BalanceRow, "balance_cents" | "delinquent">;

function mapBalance(row: BalanceQueryRow): BalanceRow {
  const balance = balanceCents(Number(row.charges_cents), Number(row.payment_cents));
  const pastDue = Number(row.past_due) === 1;
  return {
    ...row,
    charges_cents: Number(row.charges_cents),
    late_fee_cents: Number(row.late_fee_cents),
    payment_cents: Number(row.payment_cents),
    past_due: pastDue ? 1 : 0,
    balance_cents: balance,
    delinquent: isDelinquent(balance, pastDue),
  };
}

const BALANCE_SQL = `
  SELECT
    p.id AS property_id,
    p.lot_number,
    p.street_address,
    COALESCE((
      SELECT SUM(amount_cents + late_fee_cents) FROM invoices i
      WHERE i.property_id = p.id AND i.association_id = p.association_id AND i.status != 'void'
    ), 0) AS charges_cents,
    COALESCE((
      SELECT SUM(late_fee_cents) FROM invoices i
      WHERE i.property_id = p.id AND i.association_id = p.association_id AND i.status != 'void'
    ), 0) AS late_fee_cents,
    COALESCE((
      SELECT SUM(amount_cents) FROM payments pay
      WHERE pay.property_id = p.id AND pay.association_id = p.association_id
    ), 0) AS payment_cents,
    CASE WHEN EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.property_id = p.id AND i.association_id = p.association_id
        AND i.status IN ('open', 'partial') AND i.due_on < ?
    ) THEN 1 ELSE 0 END AS past_due
  FROM properties p
`;

export async function ledgerForUser(
  db: D1Database,
  associationId: string,
  userId: string,
  today: string,
): Promise<BalanceRow[]> {
  const { results } = await db
    .prepare(
      `${BALANCE_SQL}
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       WHERE p.association_id = ? AND po.user_id = ?
       ORDER BY p.lot_number`,
    )
    .bind(today, associationId, userId)
    .all<BalanceQueryRow>();
  return results.map(mapBalance);
}

export async function ledgerForAssociation(
  db: D1Database,
  associationId: string,
  today: string,
): Promise<BalanceRow[]> {
  const { results } = await db
    .prepare(`${BALANCE_SQL} WHERE p.association_id = ? ORDER BY p.lot_number`)
    .bind(today, associationId)
    .all<BalanceQueryRow>();
  return results.map(mapBalance);
}

export async function ownerIdsForProperty(
  db: D1Database,
  associationId: string,
  propertyId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT user_id FROM property_owners WHERE association_id = ? AND property_id = ?")
    .bind(associationId, propertyId)
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

export type InvoiceRow = {
  id: string;
  property_id: string;
  lot_number: string;
  invoice_number: string;
  description: string;
  amount_cents: number;
  late_fee_cents: number;
  issued_on: string;
  due_on: string;
  status: InvoiceStatus;
  paid_cents: number;
};

export async function invoicesForUser(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<InvoiceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.property_id, p.lot_number, i.invoice_number, i.description, i.amount_cents,
              i.late_fee_cents, i.issued_on, i.due_on, i.status,
              COALESCE((SELECT SUM(amount_cents) FROM payments pay WHERE pay.invoice_id = i.id AND pay.association_id = i.association_id), 0) AS paid_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       WHERE i.association_id = ? AND po.user_id = ? AND i.status != 'void'
       ORDER BY i.due_on DESC, i.invoice_number`,
    )
    .bind(associationId, userId)
    .all<InvoiceRow>();
  return results;
}

export async function invoiceById(
  db: D1Database,
  associationId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  return db
    .prepare(
      `SELECT i.id, i.property_id, p.lot_number, i.invoice_number, i.description, i.amount_cents,
              i.late_fee_cents, i.issued_on, i.due_on, i.status,
              COALESCE((SELECT SUM(amount_cents) FROM payments pay WHERE pay.invoice_id = i.id AND pay.association_id = i.association_id), 0) AS paid_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       WHERE i.association_id = ? AND i.id = ?`,
    )
    .bind(associationId, invoiceId)
    .first<InvoiceRow>();
}

export type PaymentRow = {
  id: string;
  property_id: string;
  lot_number: string;
  invoice_id: string | null;
  invoice_number: string | null;
  amount_cents: number;
  method: PaymentMethod;
  reference: string;
  paid_on: string;
  notes: string;
};

export async function paymentsForUser(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<PaymentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT pay.id, pay.property_id, p.lot_number, pay.invoice_id, i.invoice_number, pay.amount_cents,
              pay.method, pay.reference, pay.paid_on, pay.notes
       FROM payments pay
       JOIN properties p ON p.id = pay.property_id AND p.association_id = pay.association_id
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       LEFT JOIN invoices i ON i.id = pay.invoice_id AND i.association_id = pay.association_id
       WHERE pay.association_id = ? AND po.user_id = ?
       ORDER BY pay.paid_on DESC, pay.created_at DESC`,
    )
    .bind(associationId, userId)
    .all<PaymentRow>();
  return results;
}

export async function paymentById(
  db: D1Database,
  associationId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  return db
    .prepare(
      `SELECT pay.id, pay.property_id, p.lot_number, pay.invoice_id, i.invoice_number, pay.amount_cents,
              pay.method, pay.reference, pay.paid_on, pay.notes
       FROM payments pay
       JOIN properties p ON p.id = pay.property_id AND p.association_id = pay.association_id
       LEFT JOIN invoices i ON i.id = pay.invoice_id AND i.association_id = pay.association_id
       WHERE pay.association_id = ? AND pay.id = ?`,
    )
    .bind(associationId, paymentId)
    .first<PaymentRow>();
}

export async function refreshInvoiceStatus(db: D1Database, associationId: string, invoiceId: string): Promise<void> {
  const invoice = await invoiceById(db, associationId, invoiceId);
  if (!invoice || invoice.status === "void") return;
  const status = invoiceStatus(Number(invoice.amount_cents), Number(invoice.late_fee_cents), Number(invoice.paid_cents));
  await db
    .prepare("UPDATE invoices SET status = ? WHERE association_id = ? AND id = ?")
    .bind(status, associationId, invoiceId)
    .run();
}

export type AssessmentRow = {
  id: string;
  name: string;
  description: string;
  amount_cents: number;
  due_on: string;
  invoice_count: number;
};

export async function upcomingAssessments(
  db: D1Database,
  associationId: string,
  today: string,
): Promise<AssessmentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.description, a.amount_cents, a.due_on,
              (SELECT COUNT(*) FROM invoices i WHERE i.assessment_id = a.id AND i.association_id = a.association_id) AS invoice_count
       FROM assessments a
       WHERE a.association_id = ? AND a.due_on >= ?
       ORDER BY a.due_on`,
    )
    .bind(associationId, today)
    .all<AssessmentRow>();
  return results;
}

export type NoticeRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  read_at: string | null;
  created_at: string;
};

export async function notificationsForUser(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<NoticeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, title, body, href, read_at, created_at
       FROM notifications
       WHERE association_id = ? AND user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .bind(associationId, userId)
    .all<NoticeRow>();
  return results;
}

export async function unreadCount(db: D1Database, associationId: string, userId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE association_id = ? AND user_id = ? AND read_at IS NULL",
    )
    .bind(associationId, userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export type AnnouncementRow = {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  pinned: number;
  published_at: string;
  expires_at: string | null;
};

export async function visibleAnnouncements(
  db: D1Database,
  associationId: string,
  nowIso: string,
  kind?: AnnouncementKind,
): Promise<AnnouncementRow[]> {
  const kindSql = kind ? "AND kind = ?" : "";
  const statement = db
    .prepare(
      `SELECT id, kind, title, body, pinned, published_at, expires_at
       FROM announcements
       WHERE association_id = ? AND published_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       ${kindSql}
       ORDER BY pinned DESC, published_at DESC`,
    )
    .bind(...(kind ? [associationId, nowIso, nowIso, kind] : [associationId, nowIso, nowIso]));
  const { results } = await statement.all<AnnouncementRow>();
  return results;
}

export async function allAnnouncements(db: D1Database, associationId: string): Promise<AnnouncementRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, title, body, pinned, published_at, expires_at
       FROM announcements WHERE association_id = ? ORDER BY published_at DESC`,
    )
    .bind(associationId)
    .all<AnnouncementRow>();
  return results;
}

export type EventRow = {
  id: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string | null;
  kind: EventKind;
};

export async function listEvents(db: D1Database, associationId: string): Promise<EventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, description, location, starts_at, ends_at, kind
       FROM events WHERE association_id = ? ORDER BY starts_at`,
    )
    .bind(associationId)
    .all<EventRow>();
  return results;
}

export type FaqRow = { id: string; question: string; answer: string; sort_order: number };

export async function listFaqs(db: D1Database, associationId: string): Promise<FaqRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, question, answer, sort_order FROM faqs
       WHERE association_id = ? ORDER BY sort_order, question`,
    )
    .bind(associationId)
    .all<FaqRow>();
  return results;
}

export type ContactRow = {
  id: string;
  name: string;
  role_title: string;
  email: string;
  phone: string;
  sort_order: number;
};

export async function listContacts(db: D1Database, associationId: string): Promise<ContactRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, role_title, email, phone, sort_order
       FROM board_contacts
       WHERE association_id = ? AND visible = 1
       ORDER BY sort_order, name`,
    )
    .bind(associationId)
    .all<ContactRow>();
  return results;
}

export type DocumentRow = {
  id: string;
  category: DocumentCategory;
  title: string;
  visibility: DocumentVisibility;
  current_version_id: string | null;
  version_number: number | null;
  filename: string | null;
  byte_size: number | null;
  created_at: string | null;
};

export async function listDocuments(
  db: D1Database,
  associationId: string,
  includeBoardOnly: boolean,
): Promise<DocumentRow[]> {
  const visibilitySql = includeBoardOnly ? "" : "AND d.visibility = 'residents'";
  const { results } = await db
    .prepare(
      `SELECT d.id, d.category, d.title, d.visibility, d.current_version_id,
              v.version_number, v.filename, v.byte_size, v.created_at
       FROM documents d
       LEFT JOIN document_versions v ON v.id = d.current_version_id AND v.association_id = d.association_id
       WHERE d.association_id = ? ${visibilitySql}
       ORDER BY d.category, d.title`,
    )
    .bind(associationId)
    .all<DocumentRow>();
  return results;
}

export type VersionRow = {
  id: string;
  document_id: string;
  version_number: number;
  r2_key: string;
  filename: string;
  content_type: string;
  byte_size: number;
  notes: string;
  created_at: string;
};

export async function documentVersions(
  db: D1Database,
  associationId: string,
  documentId: string,
): Promise<VersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, document_id, version_number, r2_key, filename, content_type, byte_size, notes, created_at
       FROM document_versions
       WHERE association_id = ? AND document_id = ?
       ORDER BY version_number DESC`,
    )
    .bind(associationId, documentId)
    .all<VersionRow>();
  return results;
}

export async function versionById(
  db: D1Database,
  associationId: string,
  versionId: string,
): Promise<VersionRow | null> {
  return db
    .prepare(
      `SELECT id, document_id, version_number, r2_key, filename, content_type, byte_size, notes, created_at
       FROM document_versions WHERE association_id = ? AND id = ?`,
    )
    .bind(associationId, versionId)
    .first<VersionRow>();
}

export type PropertyRow = {
  id: string;
  lot_number: string;
  street_address: string;
  city: string;
  state: string;
  postal_code: string;
  status: string;
};

export async function listProperties(db: D1Database, associationId: string): Promise<PropertyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, lot_number, street_address, city, state, postal_code, status
       FROM properties WHERE association_id = ? ORDER BY lot_number`,
    )
    .bind(associationId)
    .all<PropertyRow>();
  return results;
}

export async function propertyInAssociation(
  db: D1Database,
  associationId: string,
  propertyId: string,
): Promise<PropertyRow | null> {
  return db
    .prepare(
      `SELECT id, lot_number, street_address, city, state, postal_code, status
       FROM properties WHERE association_id = ? AND id = ?`,
    )
    .bind(associationId, propertyId)
    .first<PropertyRow>();
}

export type OwnerListRow = {
  user_id: string;
  email: string;
  name: string;
  phone: string;
  role_id: MembershipRole;
  status: string;
  property_id: string | null;
  lot_number: string | null;
  street_address: string | null;
};

export async function listOwners(db: D1Database, associationId: string): Promise<OwnerListRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.name, u.phone, m.role_id, m.status,
              p.id AS property_id, p.lot_number, p.street_address
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN property_owners po
         ON po.user_id = u.id AND po.association_id = m.association_id AND po.is_primary = 1
       LEFT JOIN properties p ON p.id = po.property_id AND p.association_id = m.association_id
       WHERE m.association_id = ?
       ORDER BY u.name`,
    )
    .bind(associationId)
    .all<OwnerListRow>();
  return results;
}

export async function countActiveOfficers(db: D1Database, associationId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM memberships
       WHERE association_id = ? AND role_id = 'officer' AND status = 'active'`,
    )
    .bind(associationId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export type StaffContact = {
  user_id: string;
  email: string;
  name: string;
};

export async function listStaffContacts(db: D1Database, associationId: string): Promise<StaffContact[]> {
  const { results } = await db
    .prepare(
      `SELECT m.user_id, u.email, u.name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.association_id = ? AND m.role_id IN ('board', 'officer') AND m.status != 'inactive'
       ORDER BY u.name`,
    )
    .bind(associationId)
    .all<StaffContact>();
  return results;
}

export type JoinRequestRow = {
  id: string;
  name: string;
  email: string;
  address: string;
  note: string;
  status: string;
  created_at: string;
};

export async function insertJoinRequest(
  db: D1Database,
  entry: { associationId: string; name: string; email: string; address: string; note: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO join_requests (id, association_id, name, email, address, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(id, entry.associationId, entry.name, entry.email, entry.address, entry.note, new Date().toISOString())
    .run();
  return id;
}

export async function listJoinRequests(db: D1Database, associationId: string): Promise<JoinRequestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, email, address, note, status, created_at
       FROM join_requests
       WHERE association_id = ?
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END, created_at DESC`,
    )
    .bind(associationId)
    .all<JoinRequestRow>();
  return results;
}

export async function countPendingJoinRequests(db: D1Database, associationId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM join_requests WHERE association_id = ? AND status = 'pending'")
    .bind(associationId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function reviewJoinRequest(db: D1Database, associationId: string, requestId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE join_requests SET status = 'reviewed' WHERE association_id = ? AND id = ? AND status = 'pending'")
    .bind(associationId, requestId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function staffUserIds(db: D1Database, associationId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id FROM memberships
       WHERE association_id = ? AND role_id IN ('board', 'officer') AND status != 'inactive'`,
    )
    .bind(associationId)
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

export type MessageRow = {
  id: string;
  thread_id: string;
  parent_id: string | null;
  from_user_id: string;
  from_name: string;
  property_id: string | null;
  lot_number: string | null;
  subject: string;
  body: string;
  created_at: string;
};

export async function threadMessages(
  db: D1Database,
  associationId: string,
  threadId: string,
): Promise<MessageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.thread_id, m.parent_id, m.from_user_id, u.name AS from_name, m.property_id,
              p.lot_number, m.subject, m.body, m.created_at
       FROM messages m
       JOIN users u ON u.id = m.from_user_id
       LEFT JOIN properties p ON p.id = m.property_id AND p.association_id = m.association_id
       WHERE m.association_id = ? AND m.thread_id = ?
       ORDER BY m.created_at`,
    )
    .bind(associationId, threadId)
    .all<MessageRow>();
  return results;
}

export async function threadsForViewer(
  db: D1Database,
  associationId: string,
  userId: string,
  staff: boolean,
): Promise<MessageRow[]> {
  const scope = staff
    ? ""
    : `AND m.thread_id IN (SELECT thread_id FROM messages WHERE association_id = ? AND from_user_id = ?)`;
  const statement = db.prepare(
    `SELECT m.id, m.thread_id, m.parent_id, m.from_user_id, u.name AS from_name, m.property_id,
            p.lot_number, m.subject, m.body, m.created_at
     FROM messages m
     JOIN users u ON u.id = m.from_user_id
     LEFT JOIN properties p ON p.id = m.property_id AND p.association_id = m.association_id
     JOIN (
       SELECT thread_id, MAX(created_at) AS latest
       FROM messages
       WHERE association_id = ?
       GROUP BY thread_id
     ) t ON t.thread_id = m.thread_id AND t.latest = m.created_at
     WHERE m.association_id = ? ${scope}
     ORDER BY m.created_at DESC`,
  );
  const bound = staff
    ? statement.bind(associationId, associationId)
    : statement.bind(associationId, associationId, associationId, userId);
  const { results } = await bound.all<MessageRow>();
  return results;
}

export type AuditRow = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
};

export async function listAudit(db: D1Database, associationId: string): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
              u.name AS actor_name, u.email AS actor_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE a.association_id = ?
       ORDER BY a.created_at DESC
       LIMIT 200`,
    )
    .bind(associationId)
    .all<AuditRow>();
  return results;
}
