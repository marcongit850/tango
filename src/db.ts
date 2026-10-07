import type {
  AnnouncementKind,
  Association,
  DocumentCategory,
  DocumentVisibility,
  EventKind,
  InvoiceStatus,
  Membership,
  MembershipRole,
  MembershipStatus,
  PaymentMethod,
  User,
} from "./types";
import type { LotType } from "./lib/dues";
import { assessmentOpenForInvoicing, lotsToInvoice } from "./lib/dues";
import { isForeignKey, isMissingColumn, isMissingTable } from "./lib/errors";
import { logError } from "./lib/log";
import { balanceCents, invoiceStatus, isDelinquent } from "./lib/money";

/** People who can create, edit, and delete: officers, or homeowners and board members with the flag. */
const EDIT_ACCESS_SQL = "(role_id = 'officer' OR (role_id IN ('board', 'homeowner') AND is_admin = 1))";
const EDIT_ACCESS_MEMBER_SQL =
  "(m.role_id = 'officer' OR (m.role_id IN ('board', 'homeowner') AND m.is_admin = 1))";

async function hasColumn(
  db: D1Database,
  table: "memberships" | "properties" | "assessments" | "messages" | "documents",
  column: string,
): Promise<boolean> {
  const names = await columnNames(db, table);
  return names.has(column);
}

async function columnNames(db: D1Database, table: string): Promise<Set<string>> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(results.map((row) => row.name));
}

async function addColumn(db: D1Database, sql: string): Promise<void> {
  try {
    await db.prepare(sql).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column/i.test(message)) return;
    throw error;
  }
}

/**
 * Production can be missing folder (migration 0008) and document_date.
 * Adding them here lets a date save on the next edit without a separate paste.
 */
export async function ensureDocumentColumns(db: D1Database): Promise<{ folder: boolean; documentDate: boolean }> {
  try {
    const names = await columnNames(db, "documents");
    if (!names.has("folder")) {
      await addColumn(db, "ALTER TABLE documents ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
      names.add("folder");
    }
    if (!names.has("document_date")) {
      await addColumn(db, "ALTER TABLE documents ADD COLUMN document_date TEXT NOT NULL DEFAULT ''");
      names.add("document_date");
    }
    return { folder: names.has("folder"), documentDate: names.has("document_date") };
  } catch (error) {
    logError("document_columns", { message: error instanceof Error ? error.message : "unknown" });
    try {
      const names = await columnNames(db, "documents");
      return { folder: names.has("folder"), documentDate: names.has("document_date") };
    } catch {
      return { folder: false, documentDate: false };
    }
  }
}

function asMembership(
  row: {
    id: string;
    association_id: string;
    user_id: string;
    role_id: string;
    status: MembershipStatus;
    is_admin?: number | null;
  } | null,
  legacyStaff: boolean,
): Membership | null {
  if (!row) return null;
  if (row.role_id === "officer" || (legacyStaff && row.role_id === "board")) {
    return { id: row.id, association_id: row.association_id, user_id: row.user_id, role_id: "board", status: row.status, is_admin: 1 };
  }
  if (row.role_id === "board") {
    return {
      id: row.id,
      association_id: row.association_id,
      user_id: row.user_id,
      role_id: "board",
      status: row.status,
      is_admin: Number(row.is_admin) === 1 ? 1 : 0,
    };
  }
  if (row.role_id === "homeowner") {
    return {
      id: row.id,
      association_id: row.association_id,
      user_id: row.user_id,
      role_id: "homeowner",
      status: row.status,
      is_admin: legacyStaff ? 0 : Number(row.is_admin) === 1 ? 1 : 0,
    };
  }
  return null;
}

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
  const flagged = await hasColumn(db, "memberships", "is_admin");
  const row = await db
    .prepare(
      flagged
        ? `SELECT id, association_id, user_id, role_id, status, is_admin
           FROM memberships
           WHERE association_id = ? AND user_id = ?`
        : `SELECT id, association_id, user_id, role_id, status
           FROM memberships
           WHERE association_id = ? AND user_id = ?`,
    )
    .bind(associationId, userId)
    .first<{
      id: string;
      association_id: string;
      user_id: string;
      role_id: string;
      status: MembershipStatus;
      is_admin?: number | null;
    }>();
  return asMembership(row, !flagged);
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

export type NoticeAttachment = {
  filename: string;
  contentType: string;
  r2Key: string;
  byteSize: number;
};

export async function notify(
  db: D1Database,
  entry: {
    associationId: string;
    userId: string;
    kind: string;
    title: string;
    body?: string;
    href?: string;
    id?: string;
    attachment?: NoticeAttachment;
  },
): Promise<string> {
  const id = entry.id ?? crypto.randomUUID();
  const createdAt = new Date().toISOString();
  if (entry.attachment) {
    await db
      .prepare(
        `INSERT INTO notifications (
           id, association_id, user_id, kind, title, body, href, created_at,
           attachment_filename, attachment_content_type, attachment_r2_key, attachment_byte_size
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        entry.associationId,
        entry.userId,
        entry.kind,
        entry.title,
        entry.body ?? "",
        entry.href ?? "",
        createdAt,
        entry.attachment.filename,
        entry.attachment.contentType,
        entry.attachment.r2Key,
        entry.attachment.byteSize,
      )
      .run();
    return id;
  }
  await db
    .prepare(
      `INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, entry.associationId, entry.userId, entry.kind, entry.title, entry.body ?? "", entry.href ?? "", createdAt)
    .run();
  return id;
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

// Charges count once the invoice issue date has arrived. Assigning a future
// assessment writes the invoice with issued_on set to its open date, so that
// amount stays off the balance until the assessment opens. Recorded payments
// still count immediately. Past due requires both the issue date and the due
// date to have passed, so a scheduled future year is never past due.
const BALANCE_SQL = `
  SELECT
    p.id AS property_id,
    p.lot_number,
    p.street_address,
    COALESCE((
      SELECT SUM(amount_cents + late_fee_cents) FROM invoices i
      WHERE i.property_id = p.id AND i.association_id = p.association_id AND i.status != 'void'
        AND i.issued_on <= ?
    ), 0) AS charges_cents,
    COALESCE((
      SELECT SUM(late_fee_cents) FROM invoices i
      WHERE i.property_id = p.id AND i.association_id = p.association_id AND i.status != 'void'
        AND i.issued_on <= ?
    ), 0) AS late_fee_cents,
    COALESCE((
      SELECT SUM(amount_cents) FROM payments pay
      WHERE pay.property_id = p.id AND pay.association_id = p.association_id
    ), 0) AS payment_cents,
    CASE WHEN EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.property_id = p.id AND i.association_id = p.association_id
        AND i.status IN ('open', 'partial') AND i.due_on < ? AND i.issued_on <= ?
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
    .bind(today, today, today, today, associationId, userId)
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
    .bind(today, today, today, today, associationId)
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
  today: string,
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
         AND i.issued_on <= ?
       ORDER BY i.due_on DESC, i.invoice_number`,
    )
    .bind(associationId, userId, today)
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

export async function outstandingInvoiceCents(db: D1Database, associationId: string, today: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(
         i.amount_cents + i.late_fee_cents - COALESCE((
           SELECT SUM(pay.amount_cents) FROM payments pay
           WHERE pay.invoice_id = i.id AND pay.association_id = i.association_id
         ), 0)
       ), 0) AS outstanding_cents
       FROM invoices i
       WHERE i.association_id = ? AND i.status IN ('open', 'partial')
         AND i.issued_on <= ?`,
    )
    .bind(associationId, today)
    .first<{ outstanding_cents: number }>();
  return Number(row?.outstanding_cents ?? 0);
}

export async function invoicesForProperty(
  db: D1Database,
  associationId: string,
  propertyId: string,
): Promise<InvoiceRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.property_id, p.lot_number, i.invoice_number, i.description, i.amount_cents,
              i.late_fee_cents, i.issued_on, i.due_on, i.status,
              COALESCE((SELECT SUM(amount_cents) FROM payments pay WHERE pay.invoice_id = i.id AND pay.association_id = i.association_id), 0) AS paid_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       WHERE i.association_id = ? AND i.property_id = ?
       ORDER BY i.due_on DESC, i.invoice_number`,
    )
    .bind(associationId, propertyId)
    .all<InvoiceRow>();
  return results;
}

export type InvoicePaymentRow = {
  id: string;
  amount_cents: number;
  method: PaymentMethod;
  reference: string;
  paid_on: string;
  notes: string;
};

export async function paymentsForInvoice(
  db: D1Database,
  associationId: string,
  invoiceId: string,
): Promise<InvoicePaymentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, amount_cents, method, reference, paid_on, notes
       FROM payments
       WHERE association_id = ? AND invoice_id = ?
       ORDER BY paid_on DESC, created_at DESC`,
    )
    .bind(associationId, invoiceId)
    .all<InvoicePaymentRow>();
  return results;
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
  opens_on: string | null;
  lot_type: string | null;
  invoice_count: number;
};

// Upcoming means scheduled, not currently due: the due date is still ahead, or
// the assessment has not opened yet. Due-today and past-due rows stay off this
// list. A row is included only when its lot type matches a linked lot in this
// association, or when the assessment applies to every lot (NULL lot_type).
// A lot with no type (NULL or blank) has not been marked improved or
// unimproved, so that owner still sees both annual rows. An owner with no
// linked lot sees nothing. Invoice assignment still follows assessment lot type.
const UPCOMING_WHEN_SQL = `
  AND (
    a.due_on > ?
    OR (a.opens_on IS NOT NULL AND a.opens_on > ?)
  )`;

const UPCOMING_LOT_SQL = `
  AND EXISTS (
    SELECT 1 FROM properties p
    JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
    WHERE po.user_id = ? AND p.association_id = ?
      AND (
        a.lot_type IS NULL
        OR a.lot_type = p.lot_type
        OR p.lot_type IS NULL
        OR TRIM(p.lot_type) = ''
      )
  )`;

export async function upcomingAssessments(
  db: D1Database,
  associationId: string,
  userId: string,
  today: string,
): Promise<AssessmentRow[]> {
  const typed = await hasColumn(db, "assessments", "lot_type");
  if (!typed) {
    const { results } = await db
      .prepare(
        `SELECT a.id, a.name, a.description, a.amount_cents, a.due_on,
                NULL AS opens_on, NULL AS lot_type,
                (SELECT COUNT(*) FROM invoices i
                 JOIN property_owners po ON po.property_id = i.property_id AND po.association_id = i.association_id
                 WHERE i.assessment_id = a.id AND i.association_id = a.association_id
                   AND po.user_id = ? AND i.status != 'void') AS invoice_count
         FROM assessments a
         WHERE a.association_id = ? AND a.due_on > ?
         ORDER BY a.due_on`,
      )
      .bind(userId, associationId, today)
      .all<AssessmentRow>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.description, a.amount_cents, a.due_on, a.opens_on, a.lot_type,
              (SELECT COUNT(*) FROM invoices i
               JOIN property_owners po ON po.property_id = i.property_id AND po.association_id = i.association_id
               WHERE i.assessment_id = a.id AND i.association_id = a.association_id
                 AND po.user_id = ? AND i.status != 'void') AS invoice_count
       FROM assessments a
       WHERE a.association_id = ?${UPCOMING_WHEN_SQL}${UPCOMING_LOT_SQL}
       ORDER BY a.due_on, a.lot_type`,
    )
    .bind(userId, associationId, today, today, userId, associationId)
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
  attachment_filename?: string;
  attachment_content_type?: string;
  attachment_r2_key?: string;
  attachment_byte_size?: number;
};

export type NoticeFile = {
  filename: string;
  content_type: string;
  r2_key: string;
};

const JOIN_NOTICE_PREFIX = "Join request from ";

export function joinRequestNoticeTitle(name: string): string {
  return `${JOIN_NOTICE_PREFIX}${name}`;
}

export function joinRequestNoticeHref(slug: string, requestId: string): string {
  return `/a/${slug}/admin/join-requests?request=${requestId}`;
}

// A join-request notice is still pending only when a pending join_requests row matches it.
// Newer notices carry the request id in the href. Older notices match the stored name and email.
const OPEN_JOIN_NOTICE = `(
  notifications.kind != 'join_request'
  OR (
    instr(notifications.href || '&', 'request=') > 0
    AND EXISTS (
      SELECT 1 FROM join_requests jr
      WHERE jr.association_id = notifications.association_id
        AND jr.status = 'pending'
        AND instr(notifications.href || '&', 'request=' || jr.id || '&') > 0
    )
  )
  OR (
    instr(notifications.href, 'request=') = 0
    AND EXISTS (
      SELECT 1 FROM join_requests jr
      WHERE jr.association_id = notifications.association_id
        AND jr.status = 'pending'
        AND jr.email = notifications.body
        AND notifications.title = '${JOIN_NOTICE_PREFIX}' || jr.name
    )
  )
)`;

async function withOpenJoinNotices<T>(filtered: () => Promise<T>, plain: () => Promise<T>): Promise<T> {
  try {
    return await filtered();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return await plain();
  }
}

const NOTICE_COLUMNS = "id, kind, title, body, href, read_at, created_at";
const NOTICE_FILE_COLUMNS = "attachment_filename, attachment_content_type, attachment_r2_key, attachment_byte_size";

function withNoticeFile(row: NoticeRow): NoticeRow {
  return {
    ...row,
    attachment_filename: row.attachment_filename ?? "",
    attachment_content_type: row.attachment_content_type ?? "",
    attachment_r2_key: row.attachment_r2_key ?? "",
    attachment_byte_size: Number(row.attachment_byte_size ?? 0),
  };
}

async function selectNotices(
  db: D1Database,
  associationId: string,
  userId: string,
  openOnly: boolean,
  withAttachment: boolean,
): Promise<NoticeRow[]> {
  const columns = withAttachment ? `${NOTICE_COLUMNS}, ${NOTICE_FILE_COLUMNS}` : NOTICE_COLUMNS;
  const filter = openOnly ? ` AND ${OPEN_JOIN_NOTICE}` : "";
  const { results } = await db
    .prepare(
      `SELECT ${columns}
       FROM notifications
       WHERE association_id = ? AND user_id = ?${filter}
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .bind(associationId, userId)
    .all<NoticeRow>();
  return results.map(withNoticeFile);
}

export async function notificationsForUser(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<NoticeRow[]> {
  let openOnly = true;
  let withAttachment = true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await selectNotices(db, associationId, userId, openOnly, withAttachment);
    } catch (error) {
      if (openOnly && isMissingTable(error)) {
        openOnly = false;
        continue;
      }
      if (withAttachment && isMissingColumn(error)) {
        withAttachment = false;
        continue;
      }
      throw error;
    }
  }
  return [];
}

export async function noticeFileForUser(
  db: D1Database,
  associationId: string,
  userId: string,
  noticeId: string,
): Promise<NoticeFile | null> {
  try {
    const row = await db
      .prepare(
        `SELECT attachment_filename AS filename, attachment_content_type AS content_type, attachment_r2_key AS r2_key
         FROM notifications
         WHERE association_id = ? AND user_id = ? AND id = ?`,
      )
      .bind(associationId, userId, noticeId)
      .first<NoticeFile>();
    if (!row?.r2_key || !row.filename) return null;
    return row;
  } catch (error) {
    if (isMissingColumn(error)) return null;
    throw error;
  }
}

export async function unreadCount(db: D1Database, associationId: string, userId: string): Promise<number> {
  const load = (openOnly: boolean) => {
    const filter = openOnly ? ` AND ${OPEN_JOIN_NOTICE}` : "";
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications
         WHERE association_id = ? AND user_id = ? AND read_at IS NULL${filter}`,
      )
      .bind(associationId, userId)
      .first<{ n: number }>();
  };
  const row = await withOpenJoinNotices(
    () => load(true),
    () => load(false),
  );
  return Number(row?.n ?? 0);
}

type JoinNoticeTarget = { id: string; name: string; email: string };

async function joinNoticeTarget(db: D1Database, associationId: string, requestId: string): Promise<JoinNoticeTarget | null> {
  return db
    .prepare("SELECT id, name, email FROM join_requests WHERE association_id = ? AND id = ?")
    .bind(associationId, requestId)
    .first<JoinNoticeTarget>();
}

export async function retireLegacyJoinNotices(
  db: D1Database,
  associationId: string,
  request: { name: string; email: string },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM notifications
       WHERE association_id = ? AND kind = 'join_request'
         AND instr(href, 'request=') = 0
         AND body = ? AND title = ?`,
    )
    .bind(associationId, request.email, joinRequestNoticeTitle(request.name))
    .run();
}

export async function clearJoinRequestNotices(db: D1Database, associationId: string, request: JoinNoticeTarget): Promise<void> {
  await db
    .prepare(
      `DELETE FROM notifications
       WHERE association_id = ? AND kind = 'join_request'
         AND instr(href || '&', 'request=' || ? || '&') > 0`,
    )
    .bind(associationId, request.id)
    .run();
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM join_requests
       WHERE association_id = ? AND status = 'pending' AND email = ? AND name = ?`,
    )
    .bind(associationId, request.email, request.name)
    .first<{ n: number }>();
  if (Number(pending?.n ?? 0) > 0) return;
  await retireLegacyJoinNotices(db, associationId, request);
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
  content_type: string | null;
  byte_size: number | null;
  created_at: string | null;
  /** Optional subfolder path. Blank means the file sits directly in its category. */
  folder?: string | null;
  /** Meeting or document date (YYYY-MM-DD). Blank when unset. */
  document_date?: string | null;
};

export async function listDocuments(
  db: D1Database,
  associationId: string,
  includeBoardOnly: boolean,
): Promise<DocumentRow[]> {
  const visibilitySql = includeBoardOnly ? "" : "AND d.visibility = 'residents'";
  const columns = await ensureDocumentColumns(db);
  const folderSql = columns.folder ? "d.folder" : "'' AS folder";
  const dateSql = columns.documentDate ? "d.document_date" : "'' AS document_date";
  const orderSql =
    columns.folder && columns.documentDate
      ? "d.category, d.folder, d.document_date, d.title"
      : columns.folder
        ? "d.category, d.folder, d.title"
        : "d.category, d.title";
  const { results } = await db
    .prepare(
      `SELECT d.id, d.category, d.title, d.visibility, d.current_version_id,
              ${folderSql},
              ${dateSql},
              v.version_number, v.filename, v.content_type, v.byte_size, v.created_at
       FROM documents d
       LEFT JOIN document_versions v ON v.id = d.current_version_id AND v.association_id = d.association_id
       WHERE d.association_id = ? ${visibilitySql}
       ORDER BY ${orderSql}`,
    )
    .bind(associationId)
    .all<DocumentRow>();
  return results.map((row) => ({ ...row, folder: row.folder ?? "", document_date: row.document_date ?? "" }));
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
  lot_type: LotType;
};

const PROPERTY_COLUMNS = "id, lot_number, street_address, city, state, postal_code, status, lot_type";
const PROPERTY_COLUMNS_PLAIN =
  "id, lot_number, street_address, city, state, postal_code, status, 'improved' AS lot_type";

export async function listProperties(db: D1Database, associationId: string): Promise<PropertyRow[]> {
  const typed = await hasColumn(db, "properties", "lot_type");
  const { results } = await db
    .prepare(
      `SELECT ${typed ? PROPERTY_COLUMNS : PROPERTY_COLUMNS_PLAIN}
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
  const typed = await hasColumn(db, "properties", "lot_type");
  return db
    .prepare(
      `SELECT ${typed ? PROPERTY_COLUMNS : PROPERTY_COLUMNS_PLAIN}
       FROM properties WHERE association_id = ? AND id = ?`,
    )
    .bind(associationId, propertyId)
    .first<PropertyRow>();
}

/**
 * Removes a person from this association.
 * A login used only here is deleted, along with sessions and other rows that
 * would otherwise leave a broken foreign key. A login still used by another
 * association keeps the account and loses only this association's membership.
 */
export async function deletePersonAccount(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<"removed" | "unlinked" | "missing" | "master"> {
  const user = await db
    .prepare(
      `SELECT u.id, u.email
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.association_id = ?
       WHERE u.id = ?`,
    )
    .bind(associationId, userId)
    .first<{ id: string; email: string }>();
  if (!user) return "missing";
  if (await hasColumn(db, "memberships", "is_master")) {
    const lock = await db
      .prepare("SELECT is_master FROM memberships WHERE association_id = ? AND user_id = ?")
      .bind(associationId, userId)
      .first<{ is_master: number }>();
    if (Number(lock?.is_master) === 1) return "master";
  }

  const others = await db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND association_id != ?")
    .bind(userId, associationId)
    .first<{ n: number }>();
  const shared = Number(others?.n ?? 0) > 0;

  const statements = shared
    ? [
        db.prepare("DELETE FROM notifications WHERE association_id = ? AND user_id = ?").bind(associationId, userId),
        db.prepare("DELETE FROM messages WHERE association_id = ? AND from_user_id = ?").bind(associationId, userId),
        db.prepare("DELETE FROM property_owners WHERE association_id = ? AND user_id = ?").bind(associationId, userId),
        db.prepare("DELETE FROM memberships WHERE association_id = ? AND user_id = ?").bind(associationId, userId),
      ]
    : [
        db.prepare("UPDATE payments SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ?").bind(userId),
        db.prepare("UPDATE document_versions SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id = ?").bind(userId),
        db.prepare("UPDATE announcements SET created_by_user_id = NULL WHERE created_by_user_id = ?").bind(userId),
        db.prepare("UPDATE events SET created_by_user_id = NULL WHERE created_by_user_id = ?").bind(userId),
        db.prepare("UPDATE audit_log SET actor_user_id = NULL WHERE actor_user_id = ?").bind(userId),
        db.prepare("DELETE FROM notifications WHERE user_id = ?").bind(userId),
        db.prepare("DELETE FROM messages WHERE from_user_id = ?").bind(userId),
        db.prepare("DELETE FROM property_owners WHERE user_id = ?").bind(userId),
        db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(userId),
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
        db.prepare("DELETE FROM magic_links WHERE email = ? COLLATE NOCASE").bind(user.email),
        db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
      ];
  await db.batch(statements);
  return shared ? "unlinked" : "removed";
}

/** Deletes a lot that has no invoices and no payments. Owner links are removed. */
export async function deletePropertyIfClear(
  db: D1Database,
  associationId: string,
  propertyId: string,
): Promise<"deleted" | "blocked" | "missing"> {
  const property = await propertyInAssociation(db, associationId, propertyId);
  if (!property) return "missing";
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM invoices WHERE association_id = ? AND property_id = ?) AS invoices,
         (SELECT COUNT(*) FROM payments WHERE association_id = ? AND property_id = ?) AS payments`,
    )
    .bind(associationId, propertyId, associationId, propertyId)
    .first<{ invoices: number; payments: number }>();
  if (Number(counts?.invoices ?? 0) > 0 || Number(counts?.payments ?? 0) > 0) return "blocked";
  try {
    const results = await db.batch([
      db.prepare("UPDATE messages SET property_id = NULL WHERE association_id = ? AND property_id = ?").bind(associationId, propertyId),
      db.prepare("DELETE FROM property_owners WHERE association_id = ? AND property_id = ?").bind(associationId, propertyId),
      db.prepare("DELETE FROM properties WHERE association_id = ? AND id = ?").bind(associationId, propertyId),
    ]);
    const removed = results[results.length - 1]?.meta.changes ?? 0;
    return removed > 0 ? "deleted" : "missing";
  } catch (error) {
    if (isForeignKey(error)) return "blocked";
    throw error;
  }
}

export type LotRow = PropertyRow & {
  owner_user_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
};

export async function listLots(db: D1Database, associationId: string): Promise<LotRow[]> {
  const typed = await hasColumn(db, "properties", "lot_type");
  const lotType = typed ? "p.lot_type" : "'improved' AS lot_type";
  const { results } = await db
    .prepare(
      `SELECT p.id, p.lot_number, p.street_address, p.city, p.state, p.postal_code, p.status, ${lotType},
              u.id AS owner_user_id, u.name AS owner_name, u.email AS owner_email
       FROM properties p
       LEFT JOIN property_owners po
         ON po.id = (
           SELECT po2.id FROM property_owners po2
           WHERE po2.association_id = p.association_id AND po2.property_id = p.id AND po2.is_primary = 1
           ORDER BY po2.created_at
           LIMIT 1
         )
       LEFT JOIN users u ON u.id = po.user_id
       WHERE p.association_id = ?
       ORDER BY p.lot_number`,
    )
    .bind(associationId)
    .all<LotRow>();
  return results;
}

export type OwnerListRow = {
  user_id: string;
  email: string;
  name: string;
  phone: string;
  role_id: MembershipRole;
  is_admin: number;
  is_master: number;
  status: string;
  property_id: string | null;
  lot_number: string | null;
  street_address: string | null;
};

export async function listOwners(db: D1Database, associationId: string): Promise<OwnerListRow[]> {
  const flagged = await hasColumn(db, "memberships", "is_admin");
  const mastered = await hasColumn(db, "memberships", "is_master");
  const masterSql = mastered ? "m.is_master" : "0 AS is_master";
  const { results } = await db
    .prepare(
      flagged
        ? `SELECT u.id AS user_id, u.email, u.name, u.phone, m.role_id, m.is_admin, ${masterSql}, m.status,
                  p.id AS property_id, p.lot_number, p.street_address
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN property_owners po
             ON po.user_id = u.id AND po.association_id = m.association_id AND po.is_primary = 1
           LEFT JOIN properties p ON p.id = po.property_id AND p.association_id = m.association_id
           WHERE m.association_id = ?
           ORDER BY u.name`
        : `SELECT u.id AS user_id, u.email, u.name, u.phone, m.role_id,
                  CASE WHEN m.role_id IN ('board', 'officer') THEN 1 ELSE 0 END AS is_admin, ${masterSql}, m.status,
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
    .all<Omit<OwnerListRow, "role_id" | "is_master"> & { role_id: string; is_master?: number | null }>();
  return results.map((row) => ({
    ...row,
    role_id: row.role_id === "officer" ? "board" : row.role_id === "board" ? "board" : "homeowner",
    is_admin: row.role_id === "officer" || Number(row.is_admin) === 1 ? 1 : 0,
    is_master: Number(row.is_master) === 1 ? 1 : 0,
  }));
}

export async function countActiveAdmins(db: D1Database, associationId: string): Promise<number> {
  const flagged = await hasColumn(db, "memberships", "is_admin");
  const row = await db
    .prepare(
      flagged
        ? `SELECT COUNT(*) AS n FROM memberships
           WHERE association_id = ? AND status = 'active' AND ${EDIT_ACCESS_SQL}`
        : `SELECT COUNT(*) AS n FROM memberships
           WHERE association_id = ? AND role_id IN ('board', 'officer') AND status = 'active'`,
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
  const flagged = await hasColumn(db, "memberships", "is_admin");
  const { results } = await db
    .prepare(
      flagged
        ? `SELECT m.user_id, u.email, u.name
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           WHERE m.association_id = ? AND m.status != 'inactive' AND ${EDIT_ACCESS_MEMBER_SQL}
           ORDER BY u.name`
        : `SELECT m.user_id, u.email, u.name
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
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'declined' THEN 2 ELSE 3 END, created_at DESC`,
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
  const request = await joinNoticeTarget(db, associationId, requestId);
  if (!request) return false;
  const result = await db
    .prepare("UPDATE join_requests SET status = 'reviewed' WHERE association_id = ? AND id = ? AND status = 'pending'")
    .bind(associationId, requestId)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await clearJoinRequestNotices(db, associationId, request);
  return true;
}

export async function declineJoinRequest(db: D1Database, associationId: string, requestId: string): Promise<boolean> {
  const request = await joinNoticeTarget(db, associationId, requestId);
  if (!request) return false;
  const result = await db
    .prepare(
      "UPDATE join_requests SET status = 'declined' WHERE association_id = ? AND id = ? AND status IN ('pending', 'reviewed')",
    )
    .bind(associationId, requestId)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await clearJoinRequestNotices(db, associationId, request);
  return true;
}

export async function deleteJoinRequest(db: D1Database, associationId: string, requestId: string): Promise<boolean> {
  const request = await joinNoticeTarget(db, associationId, requestId);
  if (!request) return false;
  const result = await db
    .prepare("DELETE FROM join_requests WHERE association_id = ? AND id = ?")
    .bind(associationId, requestId)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await clearJoinRequestNotices(db, associationId, request);
  return true;
}

export async function activeLoginEmails(
  db: D1Database,
  associationId: string,
  audience: "owners" | "board",
): Promise<{ id: string; email: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.association_id = ?
         AND m.status = 'active'
         AND TRIM(u.email) != ''
         AND (
           (? = 'owners' AND m.role_id IN ('homeowner', 'board', 'officer'))
           OR (? = 'board' AND m.role_id IN ('board', 'officer'))
         )
       ORDER BY u.email COLLATE NOCASE`,
    )
    .bind(associationId, audience, audience)
    .all<{ id: string; email: string }>();
  return results;
}

export async function staffUserIds(db: D1Database, associationId: string): Promise<string[]> {
  const flagged = await hasColumn(db, "memberships", "is_admin");
  const { results } = await db
    .prepare(
      flagged
        ? `SELECT user_id FROM memberships
           WHERE association_id = ? AND status != 'inactive' AND ${EDIT_ACCESS_SQL}`
        : `SELECT user_id FROM memberships
           WHERE association_id = ? AND role_id IN ('board', 'officer') AND status != 'inactive'`,
    )
    .bind(associationId)
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

export type AssessmentAdminRow = {
  id: string;
  name: string;
  description: string;
  amount_cents: number;
  due_on: string;
  opens_on: string | null;
  lot_type: LotType | null;
  invoice_count: number;
};

export async function duesColumnsReady(db: D1Database): Promise<boolean> {
  return hasColumn(db, "assessments", "lot_type");
}

export async function listAssessments(db: D1Database, associationId: string): Promise<AssessmentAdminRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.description, a.amount_cents, a.due_on, a.opens_on, a.lot_type,
              (SELECT COUNT(*) FROM invoices i
               WHERE i.assessment_id = a.id AND i.association_id = a.association_id AND i.status != 'void') AS invoice_count
       FROM assessments a
       WHERE a.association_id = ?
       ORDER BY a.due_on DESC, a.lot_type`,
    )
    .bind(associationId)
    .all<AssessmentAdminRow>();
  return results;
}

export async function assignAssessmentInvoices(
  db: D1Database,
  input: { associationId: string; assessmentId: string; today: string; includeVoided?: boolean },
): Promise<{ created: number; already: number; name: string; issuedOn: string } | null> {
  const assessment = await db
    .prepare(
      `SELECT id, name, amount_cents, due_on, opens_on, lot_type
       FROM assessments WHERE association_id = ? AND id = ?`,
    )
    .bind(input.associationId, input.assessmentId)
    .first<{ id: string; name: string; amount_cents: number; due_on: string; opens_on: string | null; lot_type: LotType | null }>();
  if (!assessment) return null;
  const lots = await listLots(db, input.associationId);
  // A voided invoice is still an invoice. Manual assign can replace one. The daily
  // job passes includeVoided so a void is not opened again the next morning.
  const voidClause = input.includeVoided ? "" : " AND status != 'void'";
  const { results: existing } = await db
    .prepare(
      `SELECT property_id FROM invoices
       WHERE association_id = ? AND assessment_id = ?${voidClause}`,
    )
    .bind(input.associationId, assessment.id)
    .all<{ property_id: string }>();
  const plan = lotsToInvoice(
    lots.map((lot) => ({
      id: lot.id,
      lotNumber: lot.lot_number,
      status: lot.status,
      lotType: lot.lot_type === "unimproved" ? "unimproved" : "improved",
    })),
    assessment.lot_type === "improved" || assessment.lot_type === "unimproved" ? assessment.lot_type : null,
    new Set(existing.map((row) => row.property_id)),
  );
  // Keep the invoice even when assign runs before the open date. issued_on is
  // that open date, and balances ignore the row until then.
  const issuedOn = assessment.opens_on && /^\d{4}-\d{2}-\d{2}$/.test(assessment.opens_on) ? assessment.opens_on : input.today;
  const now = new Date().toISOString();
  let created = 0;
  for (const lot of plan.create) {
    const id = crypto.randomUUID();
    const invoiceNumber = `DUES-${lot.lotNumber}-${assessment.id.slice(0, 8)}`.slice(0, 40);
    await db
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, description,
           amount_cents, late_fee_cents, issued_on, due_on, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'open', ?)`,
      )
      .bind(
        id,
        input.associationId,
        lot.id,
        assessment.id,
        invoiceNumber,
        assessment.name,
        assessment.amount_cents,
        issuedOn,
        assessment.due_on,
        now,
      )
      .run();
    created += 1;
  }
  return { created, already: plan.already, name: assessment.name, issuedOn };
}

export type IssuedAssessmentInvoices = {
  assessmentId: string;
  name: string;
  created: number;
  already: number;
  issuedOn: string;
};

/** Creates invoices for assessments whose open date is today or earlier and still have matching lots without an invoice. */
export async function issueOpenAssessmentInvoices(
  db: D1Database,
  input: { associationId: string; today: string },
): Promise<IssuedAssessmentInvoices[]> {
  if (!(await duesColumnsReady(db))) return [];
  const { results } = await db
    .prepare(
      `SELECT id, opens_on
       FROM assessments
       WHERE association_id = ? AND opens_on IS NOT NULL AND opens_on <= ?
       ORDER BY opens_on, id`,
    )
    .bind(input.associationId, input.today)
    .all<{ id: string; opens_on: string }>();

  const issued: IssuedAssessmentInvoices[] = [];
  for (const row of results) {
    if (!assessmentOpenForInvoicing(row.opens_on, input.today)) continue;
    const result = await assignAssessmentInvoices(db, {
      associationId: input.associationId,
      assessmentId: row.id,
      today: input.today,
      includeVoided: true,
    });
    if (!result) continue;
    issued.push({
      assessmentId: row.id,
      name: result.name,
      created: result.created,
      already: result.already,
      issuedOn: result.issuedOn,
    });
  }
  return issued;
}

export type AssessmentDeleteResult =
  | { ok: true; name: string; invoicesRemoved: number }
  | { ok: false; reason: "missing" | "payments" };

/** Removes an assessment and invoices that have no payment. Any recorded payment blocks the delete. */
export async function deleteAssessment(
  db: D1Database,
  associationId: string,
  assessmentId: string,
): Promise<AssessmentDeleteResult> {
  const assessment = await db
    .prepare("SELECT name FROM assessments WHERE association_id = ? AND id = ?")
    .bind(associationId, assessmentId)
    .first<{ name: string }>();
  if (!assessment) return { ok: false, reason: "missing" };

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM invoices
         WHERE rowid IN (
           SELECT i.rowid FROM invoices i
           WHERE i.association_id = ? AND i.assessment_id = ?
             AND NOT EXISTS (
               SELECT 1
               FROM payments pay
               JOIN invoices paid ON paid.id = pay.invoice_id AND paid.association_id = pay.association_id
               WHERE paid.association_id = i.association_id AND paid.assessment_id = i.assessment_id
             )
         )`,
      )
      .bind(associationId, assessmentId),
    db
      .prepare(
        `DELETE FROM assessments
         WHERE association_id = ? AND id = ?
           AND NOT EXISTS (
             SELECT 1 FROM invoices i
             WHERE i.association_id = assessments.association_id AND i.assessment_id = assessments.id
           )`,
      )
      .bind(associationId, assessmentId),
  ]);

  if ((results[1]?.meta.changes ?? 0) > 0) {
    return { ok: true, name: assessment.name, invoicesRemoved: results[0]?.meta.changes ?? 0 };
  }

  const paid = await db
    .prepare(
      `SELECT 1 AS found
       FROM payments pay
       JOIN invoices i ON i.id = pay.invoice_id AND i.association_id = pay.association_id
       WHERE i.association_id = ? AND i.assessment_id = ?
       LIMIT 1`,
    )
    .bind(associationId, assessmentId)
    .first<{ found: number }>();
  return { ok: false, reason: paid ? "payments" : "missing" };
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
  reviewed_at: string | null;
};

export function messageWaitingOnBoard(
  message: Pick<MessageRow, "from_user_id" | "reviewed_at">,
  staffIds: ReadonlySet<string>,
): boolean {
  return !staffIds.has(message.from_user_id) && !message.reviewed_at;
}

function messageSelect(includeReviewedAt: boolean): string {
  const reviewedAt = includeReviewedAt ? "m.reviewed_at" : "NULL AS reviewed_at";
  return `m.id, m.thread_id, m.parent_id, m.from_user_id, u.name AS from_name, m.property_id,
          p.lot_number, m.subject, m.body, m.created_at, ${reviewedAt}`;
}

export async function threadMessages(
  db: D1Database,
  associationId: string,
  threadId: string,
): Promise<MessageRow[]> {
  const reviewed = await hasColumn(db, "messages", "reviewed_at");
  const { results } = await db
    .prepare(
      `SELECT ${messageSelect(reviewed)}
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

export async function markThreadReviewed(
  db: D1Database,
  associationId: string,
  threadId: string,
): Promise<{ found: boolean; changed: boolean }> {
  if (!(await hasColumn(db, "messages", "reviewed_at"))) {
    throw new Error("no such column: messages.reviewed_at");
  }
  const latest = await db
    .prepare(
      `SELECT id, reviewed_at
       FROM messages
       WHERE association_id = ? AND thread_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(associationId, threadId)
    .first<{ id: string; reviewed_at: string | null }>();
  if (!latest) return { found: false, changed: false };
  if (latest.reviewed_at) return { found: true, changed: false };
  const result = await db
    .prepare("UPDATE messages SET reviewed_at = ? WHERE association_id = ? AND id = ? AND reviewed_at IS NULL")
    .bind(new Date().toISOString(), associationId, latest.id)
    .run();
  return { found: true, changed: (result.meta.changes ?? 0) > 0 };
}

export async function threadsForViewer(
  db: D1Database,
  associationId: string,
  userId: string,
  staff: boolean,
): Promise<MessageRow[]> {
  const reviewed = await hasColumn(db, "messages", "reviewed_at");
  const scope = staff
    ? ""
    : `AND m.thread_id IN (SELECT thread_id FROM messages WHERE association_id = ? AND from_user_id = ?)`;
  const statement = db.prepare(
    `SELECT ${messageSelect(reviewed)}
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

export function messageThreadHrefs(slug: string, threadId: string): { resident: string; admin: string } {
  return {
    resident: `/a/${slug}/messages/${threadId}`,
    admin: `/a/${slug}/admin/messages/${threadId}`,
  };
}

/** Drops portal notices that still point at a message thread. */
export async function clearMessageThreadNotices(
  db: D1Database,
  associationId: string,
  slug: string,
  threadId: string,
): Promise<void> {
  const hrefs = messageThreadHrefs(slug, threadId);
  await db
    .prepare(
      `DELETE FROM notifications
       WHERE association_id = ? AND kind = 'message' AND href IN (?, ?)`,
    )
    .bind(associationId, hrefs.resident, hrefs.admin)
    .run();
}

export async function deleteMessageThread(
  db: D1Database,
  associationId: string,
  slug: string,
  threadId: string,
): Promise<boolean> {
  if (!threadId) return false;
  const result = await db
    .prepare("DELETE FROM messages WHERE association_id = ? AND thread_id = ?")
    .bind(associationId, threadId)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  await clearMessageThreadNotices(db, associationId, slug, threadId);
  return true;
}

export async function deleteMessage(
  db: D1Database,
  associationId: string,
  slug: string,
  threadId: string,
  messageId: string,
): Promise<boolean> {
  if (!threadId || !messageId) return false;
  const result = await db
    .prepare("DELETE FROM messages WHERE association_id = ? AND thread_id = ? AND id = ?")
    .bind(associationId, threadId, messageId)
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;
  const remaining = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE association_id = ? AND thread_id = ?")
    .bind(associationId, threadId)
    .first<{ n: number }>();
  if (Number(remaining?.n ?? 0) === 0) await clearMessageThreadNotices(db, associationId, slug, threadId);
  return true;
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
