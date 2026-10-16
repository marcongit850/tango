import { listAssociations, notify, writeAudit } from "../db";
import type { Association } from "../types";
import { todayIso } from "./dates";
import { isDemoAssociationId } from "./demo";
import { assessmentDisplayName } from "./dues";
import { invoiceOwnerEmail, resendApiKey, sendResendEmail, uniqueLoginEmails } from "./email";
import { tableExists } from "./fee-schedule-store";
import { canonicalPortalUrl } from "./hosts";
import { logError, logInfo } from "./log";

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

const MIGRATION_MESSAGE = "Apply migrations/0023_invoice_emails.sql in D1, then try again.";

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
  invoice_number: string;
  description: string;
  amount_cents: number;
  late_fee_cents: number;
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
  const description = assessmentDisplayName(invoice.description);
  const payUrl = canonicalPortalUrl(association, `/invoices/${invoice.id}`);
  const letter = invoiceOwnerEmail({
    associationName: association.name,
    invoiceNumber: invoice.invoice_number,
    description,
    amountCents: Number(invoice.amount_cents),
    lateFeeCents: Number(invoice.late_fee_cents),
    dueOn: invoice.due_on,
    timeZone: association.timezone,
    payUrl,
  });
  const addressOk = new Map<string, boolean>();
  const addresses: string[] = [];
  let sent = 0;
  let failed = 0;
  for (const owner of owners) {
    if (already.has(owner.id)) continue;
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
      } else {
        failed += 1;
      }
    }
    if (!ok) continue;
    await db
      .prepare(
        `INSERT INTO invoice_email_events (id, association_id, invoice_id, user_id, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), association.id, invoice.id, owner.id, sentAt)
      .run();
    already.add(owner.id);
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
  const covered = owners.every((owner) => already.has(owner.id));
  if (covered) {
    await db
      .prepare("UPDATE invoices SET emailed_at = ? WHERE association_id = ? AND id = ? AND emailed_at IS NULL")
      .bind(sentAt, association.id, invoice.id)
      .run();
  }
  return { sent, failed, addresses };
}

async function unsentInvoices(db: D1Database, associationId: string, today: string, enabledOn: string): Promise<DueInvoice[]> {
  const billed = (await columnReady(db, "invoices", "billed_user_id")) ? "i.billed_user_id" : "NULL AS billed_user_id";
  const { results } = await db
    .prepare(
      `SELECT i.id, i.property_id, i.invoice_number, i.description, i.amount_cents, i.late_fee_cents, i.due_on, ${billed}
       FROM invoices i
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
