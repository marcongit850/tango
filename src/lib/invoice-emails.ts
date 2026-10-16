import { invoiceById, invoiceNetPaidSql, listAssociations, notify, paymentReversalsReady, paymentTestReady, writeAudit } from "../db";
import type { Association } from "../types";
import { formatCentralDateTime, todayIso } from "./dates";
import { isDemoAssociationId } from "./demo";
import { assessmentDisplayName } from "./dues";
import { invoiceAmountDueCents, invoiceOwnerEmail, resendApiKey, sendResendEmail, uniqueLoginEmails } from "./email";
import { tableExists } from "./fee-schedule-store";
import { canonicalPortalUrl } from "./hosts";
import { feeLineForEmail, invoiceMailSettings, mailLinesForEmail } from "./invoice-mail";
import { logError, logInfo } from "./log";
import { bankFeeConfig, onlinePaymentsOn } from "./online-payments";

export type InvoiceEmailSettings = {
  ready: boolean;
  enabled: boolean;
  enabledOn: string | null;
};

export type InvoiceEmailSave =
  | {
      ok: true;
      changed: boolean;
      previousEnabled: boolean;
      enabled: boolean;
      enabledOn: string | null;
    }
  | { ok: false; message: string };

const MIGRATION_MESSAGE = "Apply migrations/0024_invoice_emails.sql in D1, then try again.";
const RESEND_GAP_MS = 60_000;

export const DEMO_INVOICE_EMAIL_MESSAGE = "This demo does not send invoice email.";
export const INVOICE_RESEND_MIGRATION_MESSAGE =
  "Apply migrations/0025_invoice_resend.sql in D1, then reload, before this invoice can be emailed.";
export const INVOICE_RESEND_NO_EMAIL = "No owner on this lot has an email on file.";
export const INVOICE_RESEND_NOT_CONFIGURED = "Invoice email is not set up yet, so this invoice was not sent.";
export const INVOICE_RESEND_WAIT = "Wait a minute before emailing this invoice again.";
export const INVOICE_RESEND_FAILED = "The email could not be sent.";

export type InvoiceResendBlock = "void" | "not_issued" | "paid";

export function invoiceResendBlock(
  invoice: {
    status: string;
    issued_on: string;
    amount_cents: number;
    late_fee_cents: number;
    paid_cents: number;
  },
  today: string,
): InvoiceResendBlock | null {
  if (invoice.status === "void") return "void";
  if (invoice.issued_on > today) return "not_issued";
  const remaining = Number(invoice.amount_cents) + Number(invoice.late_fee_cents) - Number(invoice.paid_cents);
  if (invoice.status === "paid" || remaining <= 0) return "paid";
  return null;
}

export function invoiceResendReason(block: InvoiceResendBlock): string {
  if (block === "void") return "This invoice is void.";
  if (block === "not_issued") return "This invoice is not issued yet.";
  return "This invoice is paid.";
}

export function emailedOwnersMessage(sent: number, failed: number): string {
  const noun = sent === 1 ? "owner" : "owners";
  const base = `Emailed this invoice to ${sent} ${noun}.`;
  if (failed <= 0) return base;
  const missed = failed === 1 ? "1 could not be sent." : `${failed} could not be sent.`;
  return `${base} ${missed}`;
}

export async function invoiceEmailSettings(db: D1Database, associationId: string): Promise<InvoiceEmailSettings> {
  if (!(await tableExists(db, "invoice_email_settings"))) {
    return { ready: false, enabled: false, enabledOn: null };
  }
  const row = await db
    .prepare("SELECT enabled, enabled_on FROM invoice_email_settings WHERE association_id = ?")
    .bind(associationId)
    .first<{ enabled: number; enabled_on: string | null }>();
  if (!row) return { ready: true, enabled: false, enabledOn: null };
  return { ready: true, enabled: Number(row.enabled) === 1, enabledOn: row.enabled_on };
}

/**
 * Turns invoice emails on or off for one association.
 * Turning on sets enabled_on to `today` (association-local). Invoices issued before that date are not emailed.
 * Turning on again later moves enabled_on forward, so the off period is not backfilled.
 */
export async function saveInvoiceEmailSetting(
  db: D1Database,
  associationId: string,
  enabled: boolean,
  today: string,
): Promise<InvoiceEmailSave> {
  const current = await invoiceEmailSettings(db, associationId);
  if (!current.ready) return { ok: false, message: MIGRATION_MESSAGE };
  if (current.enabled === enabled) {
    return { ok: true, changed: false, previousEnabled: current.enabled, enabled, enabledOn: current.enabledOn };
  }
  const enabledOn = enabled ? today : current.enabledOn;
  await db
    .prepare(
      `INSERT INTO invoice_email_settings (association_id, enabled, enabled_on) VALUES (?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET enabled = excluded.enabled, enabled_on = excluded.enabled_on`,
    )
    .bind(associationId, enabled ? 1 : 0, enabledOn)
    .run();
  return { ok: true, changed: true, previousEnabled: current.enabled, enabled, enabledOn };
}

export type InvoiceEmailRun = {
  sent: number;
  failed: number;
};

type DueInvoice = {
  id: string;
  property_id: string;
  lot_number: string;
  invoice_number: string;
  description: string;
  amount_cents: number;
  late_fee_cents: number;
  paid_cents: number;
  due_on: string;
  billed_user_id: string | null;
};

/** Emails invoices whose issued_on is today or earlier in the association time zone. Failures stay unmarked and retry next run. */
export async function runDueInvoiceEmails(env: Env, now: Date, fetchImpl?: typeof fetch): Promise<InvoiceEmailRun> {
  const totals: InvoiceEmailRun = { sent: 0, failed: 0 };
  const db = env.DB;
  try {
    if (!(await tableExists(db, "invoice_email_settings"))) return totals;
    if (!(await columnReady(db, "invoices", "emailed_at"))) return totals;
    const associations = await listAssociations(db);
    for (const association of associations) {
      if (isDemoAssociationId(association.id)) continue;
      try {
        const result = await emailAssociation(env, association, now, fetchImpl);
        totals.sent += result.sent;
        totals.failed += result.failed;
      } catch (error) {
        logError("invoice_emails", {
          associationId: association.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  } catch (error) {
    logError("invoice_emails", { message: error instanceof Error ? error.message : "unknown" });
  }
  return totals;
}

async function emailAssociation(
  env: Env,
  association: Association,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<InvoiceEmailRun> {
  const db = env.DB;
  const settings = await invoiceEmailSettings(db, association.id);
  if (!settings.ready || !settings.enabled || !settings.enabledOn) return { sent: 0, failed: 0 };
  const today = todayIso(association.timezone, now);
  const invoices = await unsentInvoices(db, association.id, today, settings.enabledOn);
  if (invoices.length === 0) return { sent: 0, failed: 0 };
  const apiKey = resendApiKey(env);
  if (!apiKey) {
    logError("invoice_emails", { associationId: association.id, message: "RESEND_API_KEY is not set." });
    return { sent: 0, failed: invoices.length };
  }
  const sentAt = now.toISOString();
  let sent = 0;
  let failed = 0;
  for (const invoice of invoices) {
    try {
      const result = await emailInvoice(env, association, invoice, apiKey, sentAt, fetchImpl);
      sent += result.sent;
      failed += result.failed;
      if (result.sent > 0) {
        const who = result.addresses.join(", ");
        const detail =
          result.failed > 0
            ? `Emailed ${invoice.invoice_number} to ${who}. ${result.failed} failed and will retry.`
            : `Emailed ${invoice.invoice_number} to ${who}.`;
        try {
          await writeAudit(db, {
            associationId: association.id,
            actorUserId: null,
            action: "invoice_email",
            entityType: "invoice",
            entityId: invoice.id,
            detail,
          });
        } catch (error) {
          logError("invoice_email_audit", {
            associationId: association.id,
            invoiceId: invoice.id,
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      } else if (result.failed > 0) {
        logError("invoice_emails", {
          associationId: association.id,
          invoiceId: invoice.id,
          message: "Invoice email failed and will retry.",
          failed: result.failed,
        });
      }
    } catch (error) {
      failed += 1;
      logError("invoice_emails", {
        associationId: association.id,
        invoiceId: invoice.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  logInfo("invoice_emails", { associationId: association.id, today, sent, failed });
  return { sent, failed };
}

async function emailInvoice(
  env: Env,
  association: Association,
  invoice: DueInvoice,
  apiKey: string,
  sentAt: string,
  fetchImpl?: typeof fetch,
): Promise<{ sent: number; failed: number; addresses: string[] }> {
  const db = env.DB;
  const owners = await invoiceOwners(db, association.id, invoice);
  if (owners.length === 0) {
    logInfo("invoice_emails", { associationId: association.id, invoiceId: invoice.id, message: "No owner to email." });
    return { sent: 0, failed: 0, addresses: [] };
  }
  const already = await emailedUserIds(db, invoice.id);
  const delivery = await deliverInvoiceLetter(env, association, invoice, owners, apiKey, fetchImpl, already, async (ownerId) => {
    await db
      .prepare(
        `INSERT INTO invoice_email_events (id, association_id, invoice_id, user_id, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), association.id, invoice.id, ownerId, sentAt)
      .run();
    already.add(ownerId);
  });
  const covered = owners.every((owner) => already.has(owner.id));
  if (covered) {
    await db
      .prepare("UPDATE invoices SET emailed_at = ? WHERE association_id = ? AND id = ? AND emailed_at IS NULL")
      .bind(sentAt, association.id, invoice.id)
      .run();
  }
  return { sent: delivery.sent, failed: delivery.failed, addresses: delivery.addresses };
}

async function deliverInvoiceLetter(
  env: Env,
  association: Association,
  invoice: DueInvoice,
  owners: { id: string; email: string }[],
  apiKey: string,
  fetchImpl: typeof fetch | undefined,
  skipUserIds: Set<string>,
  onSent?: (ownerId: string) => Promise<void>,
): Promise<{ sent: number; failed: number; addresses: string[]; recipients: { id: string; email: string }[] }> {
  const db = env.DB;
  const description = assessmentDisplayName(invoice.description);
  const payUrl = canonicalPortalUrl(association, `/invoices/${invoice.id}`);
  const [mail, payOnline, fee] = await Promise.all([
    invoiceMailSettings(db, association.id),
    onlinePaymentsOn(db, association.id),
    bankFeeConfig(db, association.id),
  ]);
  const letter = invoiceOwnerEmail({
    associationName: association.name,
    invoiceNumber: invoice.invoice_number,
    description,
    lotNumber: invoice.lot_number,
    amountDueCents: invoiceAmountDueCents(Number(invoice.amount_cents), Number(invoice.late_fee_cents), Number(invoice.paid_cents)),
    lateFeeCents: Number(invoice.late_fee_cents),
    dueOn: invoice.due_on,
    timeZone: association.timezone,
    payUrl,
    payOnline,
    feeLine: feeLineForEmail(payOnline, fee),
    payableTo: mail.payableTo,
    mailLines: mailLinesForEmail(mail, association),
    boardNote: mail.ready ? mail.boardNote : "",
  });
  const addressOk = new Map<string, boolean>();
  const addresses: string[] = [];
  const recipients: { id: string; email: string }[] = [];
  let sent = 0;
  let failed = 0;
  for (const owner of owners) {
    if (skipUserIds.has(owner.id)) continue;
    const key = owner.email.trim().toLowerCase();
    let ok = addressOk.get(key);
    if (ok === undefined) {
      try {
        ok = await sendResendEmail({
          apiKey,
          from: env.EMAIL_FROM,
          to: owner.email,
          subject: letter.subject,
          text: letter.text,
          html: letter.html,
          fetchImpl,
        });
      } catch (error) {
        ok = false;
        logError("invoice_emails", {
          associationId: association.id,
          invoiceId: invoice.id,
          userId: owner.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
      addressOk.set(key, ok);
      if (ok) {
        sent += 1;
        addresses.push(owner.email);
        recipients.push({ id: owner.id, email: owner.email });
      } else {
        failed += 1;
      }
    }
    if (!ok) continue;
    if (onSent) await onSent(owner.id);
    try {
      await notify(db, {
        associationId: association.id,
        userId: owner.id,
        kind: "account",
        title: `${description} invoice`,
        body: letter.text,
        href: `/a/${association.slug}/invoices/${invoice.id}`,
      });
    } catch (error) {
      logError("invoice_email_notice", {
        associationId: association.id,
        invoiceId: invoice.id,
        userId: owner.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return { sent, failed, addresses, recipients };
}

export type InvoiceResendRecord = {
  sentAt: string;
  actorName: string;
  recipientCount: number;
};

export type InvoiceEmailHistoryEntry = {
  sentAt: string;
  kind: "automatic" | "resent";
  actorName: string | null;
  emails: string[];
  recipientCount: number;
};

export function invoiceEmailHistoryLine(entry: InvoiceEmailHistoryEntry): string {
  const when = formatCentralDateTime(entry.sentAt);
  const emails = [...new Set(entry.emails.map((email) => email.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const reached = emails.length > 0 ? emails.join(", ") : entry.recipientCount === 1 ? "1 owner" : `${entry.recipientCount} owners`;
  if (entry.kind === "automatic") return `${when}. Automatic to ${reached}.`;
  return `${when}. Resent by ${entry.actorName?.trim() || "an admin"} to ${reached}.`;
}

export async function invoiceEmailHistory(db: D1Database, associationId: string, invoiceId: string): Promise<InvoiceEmailHistoryEntry[]> {
  const entries: InvoiceEmailHistoryEntry[] = [];
  if (await tableExists(db, "invoice_email_events")) {
    const { results } = await db
      .prepare(
        `SELECT e.sent_at, u.email
         FROM invoice_email_events e
         JOIN users u ON u.id = e.user_id
         WHERE e.association_id = ? AND e.invoice_id = ?
         ORDER BY e.sent_at DESC, u.email`,
      )
      .bind(associationId, invoiceId)
      .all<{ sent_at: string; email: string }>();
    const grouped = new Map<string, string[]>();
    for (const row of results) {
      const emails = grouped.get(row.sent_at) ?? [];
      emails.push(row.email);
      grouped.set(row.sent_at, emails);
    }
    for (const [sentAt, emails] of grouped) {
      entries.push({ sentAt, kind: "automatic", actorName: null, emails, recipientCount: emails.length });
    }
  }
  if (await invoiceResendsReady(db)) {
    const recipientsReady = await tableExists(db, "invoice_resend_recipients");
    const { results } = recipientsReady
      ? await db
          .prepare(
            `SELECT r.id, r.sent_at, r.actor_name, r.recipient_count, p.email
             FROM invoice_resends r
             LEFT JOIN invoice_resend_recipients p ON p.resend_id = r.id
             WHERE r.association_id = ? AND r.invoice_id = ?
             ORDER BY r.sent_at DESC, p.email`,
          )
          .bind(associationId, invoiceId)
          .all<{ id: string; sent_at: string; actor_name: string; recipient_count: number; email: string | null }>()
      : await db
          .prepare(
            `SELECT id, sent_at, actor_name, recipient_count, NULL AS email
             FROM invoice_resends
             WHERE association_id = ? AND invoice_id = ?
             ORDER BY sent_at DESC`,
          )
          .bind(associationId, invoiceId)
          .all<{ id: string; sent_at: string; actor_name: string; recipient_count: number; email: string | null }>();
    const grouped = new Map<string, InvoiceEmailHistoryEntry>();
    for (const row of results) {
      let entry = grouped.get(row.id);
      if (!entry) {
        entry = {
          sentAt: row.sent_at,
          kind: "resent",
          actorName: row.actor_name,
          emails: [],
          recipientCount: Number(row.recipient_count),
        };
        grouped.set(row.id, entry);
      }
      if (row.email) entry.emails.push(row.email);
    }
    entries.push(...grouped.values());
  }
  entries.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : a.kind === b.kind ? 0 : a.kind === "resent" ? -1 : 1));
  return entries;
}

export type InvoiceResendResult = { ok: true; sent: number; failed: number } | { ok: false; message: string };

export async function invoiceResendsReady(db: D1Database): Promise<boolean> {
  return tableExists(db, "invoice_resends");
}

export async function latestInvoiceResend(db: D1Database, associationId: string, invoiceId: string): Promise<InvoiceResendRecord | null> {
  if (!(await invoiceResendsReady(db))) return null;
  const row = await db
    .prepare(
      `SELECT sent_at, actor_name, recipient_count
       FROM invoice_resends
       WHERE association_id = ? AND invoice_id = ?
       ORDER BY sent_at DESC
       LIMIT 1`,
    )
    .bind(associationId, invoiceId)
    .first<{ sent_at: string; actor_name: string; recipient_count: number }>();
  if (!row) return null;
  return { sentAt: row.sent_at, actorName: row.actor_name, recipientCount: Number(row.recipient_count) };
}

/** Emails one issued invoice now. Does not set invoices.emailed_at or invoice_email_events. */
export async function resendInvoiceEmail(
  env: Env,
  association: Association,
  invoiceId: string,
  actor: { id: string; name: string; email: string },
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<InvoiceResendResult> {
  const db = env.DB;
  if (!(await invoiceResendsReady(db))) return { ok: false, message: INVOICE_RESEND_MIGRATION_MESSAGE };
  const invoice = await invoiceById(db, association.id, invoiceId);
  if (!invoice) return { ok: false, message: "That invoice was not found." };
  const today = todayIso(association.timezone, now);
  const block = invoiceResendBlock(invoice, today);
  if (block) return { ok: false, message: invoiceResendReason(block) };
  const latest = await latestInvoiceResend(db, association.id, invoiceId);
  if (latest) {
    const elapsed = now.getTime() - Date.parse(latest.sentAt);
    if (Number.isFinite(elapsed) && elapsed < RESEND_GAP_MS) return { ok: false, message: INVOICE_RESEND_WAIT };
  }
  const billed = await billedUserId(db, association.id, invoiceId);
  const due: DueInvoice = {
    id: invoice.id,
    property_id: invoice.property_id,
    lot_number: invoice.lot_number,
    invoice_number: invoice.invoice_number,
    description: invoice.description,
    amount_cents: Number(invoice.amount_cents),
    late_fee_cents: Number(invoice.late_fee_cents),
    paid_cents: Number(invoice.paid_cents),
    due_on: invoice.due_on,
    billed_user_id: billed,
  };
  const owners = await invoiceOwners(db, association.id, due);
  if (owners.length === 0) return { ok: false, message: INVOICE_RESEND_NO_EMAIL };
  const apiKey = resendApiKey(env);
  if (!apiKey) {
    logError("invoice_emails", { associationId: association.id, invoiceId, message: "RESEND_API_KEY is not set." });
    return { ok: false, message: INVOICE_RESEND_NOT_CONFIGURED };
  }
  const sentAt = now.toISOString();
  const delivery = await deliverInvoiceLetter(env, association, due, owners, apiKey, fetchImpl, new Set());
  if (delivery.sent === 0) return { ok: false, message: INVOICE_RESEND_FAILED };
  const actorName = actor.name.trim() || actor.email;
  const resendId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO invoice_resends (
         id, association_id, invoice_id, actor_user_id, actor_name, sent_at, recipient_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(resendId, association.id, invoice.id, actor.id, actorName, sentAt, delivery.sent)
    .run();
  if (await tableExists(db, "invoice_resend_recipients")) {
    for (const recipient of delivery.recipients) {
      try {
        await db
          .prepare(
            `INSERT INTO invoice_resend_recipients (id, resend_id, association_id, invoice_id, user_id, email)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), resendId, association.id, invoice.id, recipient.id, recipient.email)
          .run();
      } catch (error) {
        logError("invoice_resend_recipient", {
          associationId: association.id,
          invoiceId: invoice.id,
          userId: recipient.id,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }
  try {
    await writeAudit(db, {
      associationId: association.id,
      actorUserId: actor.id,
      action: "invoice_resend",
      entityType: "invoice",
      entityId: invoice.id,
      detail: `${emailedOwnersMessage(delivery.sent, delivery.failed)} ${actorName}. ${invoice.invoice_number}.`,
    });
  } catch (error) {
    logError("invoice_resend_audit", {
      associationId: association.id,
      invoiceId: invoice.id,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  return { ok: true, sent: delivery.sent, failed: delivery.failed };
}

async function billedUserId(db: D1Database, associationId: string, invoiceId: string): Promise<string | null> {
  if (!(await columnReady(db, "invoices", "billed_user_id"))) return null;
  const row = await db
    .prepare("SELECT billed_user_id FROM invoices WHERE association_id = ? AND id = ?")
    .bind(associationId, invoiceId)
    .first<{ billed_user_id: string | null }>();
  return row?.billed_user_id ?? null;
}

async function unsentInvoices(db: D1Database, associationId: string, today: string, enabledOn: string): Promise<DueInvoice[]> {
  const billed = (await columnReady(db, "invoices", "billed_user_id")) ? "i.billed_user_id" : "NULL AS billed_user_id";
  const reversals = await paymentReversalsReady(db);
  const excludeTest = await paymentTestReady(db);
  const { results } = await db
    .prepare(
      `SELECT i.id, i.property_id, p.lot_number, i.invoice_number, i.description, i.amount_cents, i.late_fee_cents, i.due_on, ${billed},
              ${invoiceNetPaidSql(reversals, excludeTest)} AS paid_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       WHERE i.association_id = ?
         AND i.status != 'void'
         AND i.issued_on <= ?
         AND i.issued_on >= ?
         AND i.emailed_at IS NULL
       ORDER BY i.issued_on, i.invoice_number`,
    )
    .bind(associationId, today, enabledOn)
    .all<DueInvoice>();
  return results;
}

async function invoiceOwners(
  db: D1Database,
  associationId: string,
  invoice: DueInvoice,
): Promise<{ id: string; email: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email
       FROM property_owners po
       JOIN users u ON u.id = po.user_id
       JOIN memberships m ON m.association_id = po.association_id AND m.user_id = u.id
       WHERE po.association_id = ? AND po.property_id = ? AND m.status != 'inactive'
       ORDER BY po.is_primary DESC, u.name`,
    )
    .bind(associationId, invoice.property_id)
    .all<{ id: string; email: string }>();
  const people = [...results];
  if (invoice.billed_user_id && !people.some((person) => person.id === invoice.billed_user_id)) {
    const billed = await db
      .prepare(
        `SELECT u.id, u.email
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.association_id = ?
         WHERE u.id = ? AND m.status != 'inactive'`,
      )
      .bind(associationId, invoice.billed_user_id)
      .first<{ id: string; email: string }>();
    if (billed) people.push(billed);
  }
  return uniqueLoginEmails(people);
}

async function emailedUserIds(db: D1Database, invoiceId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT user_id FROM invoice_email_events WHERE invoice_id = ?")
    .bind(invoiceId)
    .all<{ user_id: string }>();
  return new Set(results.map((row) => row.user_id));
}

async function columnReady(db: D1Database, table: string, column: string): Promise<boolean> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.some((row) => row.name === column);
}
