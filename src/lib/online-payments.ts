import { listStaffContacts } from "../db";
import { invoiceStatus } from "./money";
import { formatMoney } from "./money";
import { todayIso } from "./dates";
import { isDemoAssociation } from "./demo";
import { deliverOwnerEmails, resendApiKey } from "./email";
import { isMissingTable, isUniqueConstraint } from "./errors";
import { tableExists } from "./fee-schedule-store";
import { canonicalPortalUrl } from "./hosts";
import { clip } from "./html";
import { logError } from "./log";
import { decryptPaymentSecret, encryptPaymentSecret, paymentEncryptionKey } from "./payment-crypto";
import {
  checkoutAmountCents,
  checkoutUrls,
  CHECKOUT_TTL_SECONDS,
  createCheckoutSession,
  isWebhookSecret,
  redactSecrets,
  secretLast4,
  stripeSecretMode,
  type StripeKeyMode,
} from "./stripe";
import { sha256Hex } from "./tokens";
import type { Association } from "../types";

export type OwnerPayOffer =
  | { kind: "off" }
  | { kind: "demo" }
  | { kind: "stripe"; mode: StripeKeyMode };

export type PaymentStatusLine = "not enabled" | "test mode" | "live";

export type PaymentSettingsView = {
  ready: boolean;
  encryptionReady: boolean;
  enabled: boolean;
  status: PaymentStatusLine;
  secretLast4: string;
  secretMode: "" | StripeKeyMode;
  webhookLast4: string;
};

type SettingsRow = {
  enabled: number;
  secret_key_ciphertext: string;
  secret_key_last4: string;
  secret_key_mode: string;
  webhook_secret_ciphertext: string;
  webhook_secret_last4: string;
};

export type PayableInvoice = {
  invoiceId: string;
  propertyId: string;
  lotNumber: string;
  invoiceNumber: string;
  amountCents: number;
};

const ONLINE_NOTE = "Online (Stripe)";

export async function payOfferFor(db: D1Database, association: Association): Promise<OwnerPayOffer> {
  if (isDemoAssociation(association)) return { kind: "demo" };
  try {
    const row = await settingsRow(db, association.id);
    if (!row || Number(row.enabled) !== 1) return { kind: "off" };
    if (row.secret_key_mode !== "test" && row.secret_key_mode !== "live") return { kind: "off" };
    if (!row.secret_key_ciphertext || !row.webhook_secret_ciphertext) return { kind: "off" };
    return { kind: "stripe", mode: row.secret_key_mode };
  } catch (error) {
    if (isMissingTable(error)) return { kind: "off" };
    throw error;
  }
}

export async function paymentSettingsView(env: Env, db: D1Database, associationId: string): Promise<PaymentSettingsView> {
  const encryptionReady = Boolean(paymentEncryptionKey(env));
  if (!(await paymentsReady(db))) {
    return { ready: false, encryptionReady, enabled: false, status: "not enabled", secretLast4: "", secretMode: "", webhookLast4: "" };
  }
  const row = await settingsRow(db, associationId);
  return viewFromRow(row, encryptionReady);
}

export function statusLine(view: Pick<PaymentSettingsView, "enabled" | "secretMode">): PaymentStatusLine {
  if (!view.enabled) return "not enabled";
  if (view.secretMode === "live") return "live";
  if (view.secretMode === "test") return "test mode";
  return "not enabled";
}

export async function saveStripeSecret(
  env: Env,
  db: D1Database,
  associationId: string,
  userId: string,
  secret: string,
): Promise<{ ok: true; action: "payment_settings_secret_set" | "payment_settings_secret_replaced"; mode: StripeKeyMode } | { ok: false; message: string }> {
  const mode = stripeSecretMode(secret);
  if (!mode) return { ok: false, message: "That does not look like a Stripe secret key." };
  const material = paymentEncryptionKey(env);
  if (!material) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  let ciphertext = "";
  try {
    ciphertext = await encryptPaymentSecret(material, secret.trim());
  } catch (error) {
    logError("payment_secret_encrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  }
  const current = await settingsRow(db, associationId);
  const action = current?.secret_key_ciphertext ? "payment_settings_secret_replaced" : "payment_settings_secret_set";
  await writeRow(db, associationId, userId, {
    enabled: current?.enabled ?? 0,
    secret_key_ciphertext: ciphertext,
    secret_key_last4: secretLast4(secret),
    secret_key_mode: mode,
    webhook_secret_ciphertext: current?.webhook_secret_ciphertext ?? "",
    webhook_secret_last4: current?.webhook_secret_last4 ?? "",
  });
  return { ok: true, action, mode };
}

export async function removeStripeSecret(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<{ ok: true; disabled: boolean } | { ok: false; message: string }> {
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  const current = await settingsRow(db, associationId);
  if (!current?.secret_key_ciphertext) return { ok: false, message: "No Stripe secret key is stored." };
  const disabled = Number(current.enabled) === 1;
  await writeRow(db, associationId, userId, {
    enabled: 0,
    secret_key_ciphertext: "",
    secret_key_last4: "",
    secret_key_mode: "",
    webhook_secret_ciphertext: current.webhook_secret_ciphertext,
    webhook_secret_last4: current.webhook_secret_last4,
  });
  return { ok: true, disabled };
}

export async function saveWebhookSecret(
  env: Env,
  db: D1Database,
  associationId: string,
  userId: string,
  secret: string,
): Promise<{ ok: true; action: "payment_settings_webhook_set" | "payment_settings_webhook_replaced" } | { ok: false; message: string }> {
  if (!isWebhookSecret(secret)) return { ok: false, message: "That does not look like a Stripe webhook signing secret." };
  const material = paymentEncryptionKey(env);
  if (!material) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  let ciphertext = "";
  try {
    ciphertext = await encryptPaymentSecret(material, secret.trim());
  } catch (error) {
    logError("payment_webhook_encrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  }
  const current = await settingsRow(db, associationId);
  const action = current?.webhook_secret_ciphertext ? "payment_settings_webhook_replaced" : "payment_settings_webhook_set";
  await writeRow(db, associationId, userId, {
    enabled: current?.enabled ?? 0,
    secret_key_ciphertext: current?.secret_key_ciphertext ?? "",
    secret_key_last4: current?.secret_key_last4 ?? "",
    secret_key_mode: current?.secret_key_mode ?? "",
    webhook_secret_ciphertext: ciphertext,
    webhook_secret_last4: secretLast4(secret),
  });
  return { ok: true, action };
}

export async function removeWebhookSecret(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<{ ok: true; disabled: boolean } | { ok: false; message: string }> {
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  const current = await settingsRow(db, associationId);
  if (!current?.webhook_secret_ciphertext) return { ok: false, message: "No webhook signing secret is stored." };
  const disabled = Number(current.enabled) === 1;
  await writeRow(db, associationId, userId, {
    enabled: 0,
    secret_key_ciphertext: current.secret_key_ciphertext,
    secret_key_last4: current.secret_key_last4,
    secret_key_mode: current.secret_key_mode,
    webhook_secret_ciphertext: "",
    webhook_secret_last4: "",
  });
  return { ok: true, disabled };
}

export async function setPaymentsEnabled(
  env: Env,
  db: D1Database,
  associationId: string,
  userId: string,
  enabled: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; message: string }> {
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  const current = await settingsRow(db, associationId);
  const already = Number(current?.enabled) === 1;
  if (already === enabled) return { ok: true, changed: false };
  if (!enabled) {
    if (!current) return { ok: true, changed: false };
    await writeRow(db, associationId, userId, { ...current, enabled: 0 });
    return { ok: true, changed: true };
  }
  if (!current?.secret_key_ciphertext || !current.webhook_secret_ciphertext) {
    return { ok: false, message: "Save both keys before turning payments on." };
  }
  const material = paymentEncryptionKey(env);
  if (!material) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  try {
    const secret = await decryptPaymentSecret(material, current.secret_key_ciphertext);
    const webhook = await decryptPaymentSecret(material, current.webhook_secret_ciphertext);
    const mode = stripeSecretMode(secret);
    if (!mode || !isWebhookSecret(webhook) || mode !== current.secret_key_mode) {
      return { ok: false, message: "The stored Stripe keys could not be read. Replace them, then turn payments on." };
    }
  } catch (error) {
    logError("payment_settings_read", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "The stored Stripe keys could not be read. Replace them, then turn payments on." };
  }
  await writeRow(db, associationId, userId, { ...current, enabled: 1 });
  return { ok: true, changed: true };
}

export async function payableInvoicesForUser(db: D1Database, associationId: string, userId: string, today: string): Promise<PayableInvoice[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id AS invoice_id, i.property_id, p.lot_number, i.invoice_number,
              i.amount_cents + i.late_fee_cents - COALESCE((
                SELECT SUM(pay.amount_cents) FROM payments pay
                WHERE pay.invoice_id = i.id AND pay.association_id = i.association_id
              ), 0) AS remaining_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       WHERE i.association_id = ? AND po.user_id = ? AND i.status IN ('open', 'partial')
         AND i.issued_on <= ?
       ORDER BY i.due_on, i.invoice_number`,
    )
    .bind(associationId, userId, today)
    .all<{ invoice_id: string; property_id: string; lot_number: string; invoice_number: string; remaining_cents: number }>();
  return results
    .filter((row) => Number(row.remaining_cents) > 0)
    .map((row) => ({
      invoiceId: row.invoice_id,
      propertyId: row.property_id,
      lotNumber: row.lot_number,
      invoiceNumber: row.invoice_number,
      amountCents: Number(row.remaining_cents),
    }));
}

export async function startCheckout(input: {
  env: Env;
  db: D1Database;
  association: Association;
  userId: string;
  email: string;
  requestUrl: string;
  invoices: PayableInvoice[];
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (input.invoices.length === 0) return { ok: false, message: "Nothing is due." };
  const ledgerCents = input.invoices.reduce((sum, row) => sum + row.amountCents, 0);
  const amountCents = checkoutAmountCents(ledgerCents);
  if (amountCents !== ledgerCents || amountCents <= 0) return { ok: false, message: "Nothing is due." };
  const material = paymentEncryptionKey(input.env);
  if (!material) return { ok: false, message: "Online payment is not available." };
  const row = await settingsRow(input.db, input.association.id);
  if (!row || Number(row.enabled) !== 1 || !row.secret_key_ciphertext) return { ok: false, message: "Online payment is not available." };
  let secretKey = "";
  try {
    secretKey = await decryptPaymentSecret(material, row.secret_key_ciphertext);
  } catch (error) {
    logError("payment_checkout_key", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Online payment is not available." };
  }
  const mode = stripeSecretMode(secretKey);
  if (!mode || mode !== row.secret_key_mode) return { ok: false, message: "Online payment is not available." };
  const urls = checkoutUrls(input.requestUrl, input.association);
  if (!urls) return { ok: false, message: "Online payment has to start on a secure page." };
  const lots = [...new Set(input.invoices.map((invoice) => invoice.lotNumber))];
  const invoiceIds = input.invoices.map((invoice) => invoice.invoiceId).join(",");
  const intentId = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(nowSeconds / CHECKOUT_TTL_SECONDS);
  const idempotencyKey = await sha256Hex(`${input.association.id}:${input.userId}:${invoiceIds}:${amountCents}:${bucket}`);
  let created: Awaited<ReturnType<typeof createCheckoutSession>>;
  try {
    created = await createCheckoutSession({
    secretKey,
    amountCents,
    name: productName(input.association.name, lots),
    customerEmail: input.email,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    intentId,
    idempotencyKey,
    expiresAt: nowSeconds + CHECKOUT_TTL_SECONDS,
    metadata: {
      neighborhoodId: input.association.id,
      lot: lots.join(",").slice(0, 500),
      invoiceIds: invoiceIds.length <= 500 ? invoiceIds : "",
      userId: input.userId,
    },
    fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    logError("payment_checkout", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Stripe did not start checkout. The treasurer can check Payment settings." };
  }
  secretKey = "";
  if (!created.ok) return { ok: false, message: "Stripe did not start checkout. The treasurer can check Payment settings." };
  const allocation = input.invoices.map((invoice) => ({
    invoiceId: invoice.invoiceId,
    propertyId: invoice.propertyId,
    lotNumber: invoice.lotNumber,
    amountCents: invoice.amountCents,
  }));
  const expiresAt = new Date((nowSeconds + CHECKOUT_TTL_SECONDS) * 1000).toISOString();
  await input.db
    .prepare(
      `INSERT INTO checkout_intents (
         id, association_id, user_id, amount_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET stripe_session_id = excluded.stripe_session_id`,
    )
    .bind(
      created.clientReferenceId,
      input.association.id,
      input.userId,
      amountCents,
      JSON.stringify(allocation),
      lots.join(","),
      created.id,
      expiresAt,
      new Date().toISOString(),
    )
    .run();
  return { ok: true, url: created.url };
}

type Allocation = PayableInvoice;

export type AppliedStripePayment = {
  duplicate: boolean;
  stripePaymentId: string;
  amountCents: number;
  lotNumbers: string;
  invoiceNumbers: string[];
  paymentIds: string[];
  ownerEmails: { email: string }[];
  emailed: boolean;
};

export async function applyStripeCheckout(input: {
  db: D1Database;
  association: Association;
  eventId: string;
  paymentId: string;
  amountTotal: number;
  clientReferenceId: string;
  neighborhoodId: string;
  invoiceIds: string;
  userId: string;
}): Promise<{ ok: true; applied: AppliedStripePayment } | { ok: false; detail: string }> {
  if (input.neighborhoodId && input.neighborhoodId !== input.association.id) {
    return { ok: false, detail: "Stripe neighborhood did not match this portal. Payment was not recorded." };
  }
  const intent = await input.db
    .prepare(
      `SELECT id, user_id, amount_cents, allocation_json, lot_numbers, expires_at
       FROM checkout_intents WHERE association_id = ? AND id = ?`,
    )
    .bind(input.association.id, input.clientReferenceId)
    .first<{ id: string; user_id: string; amount_cents: number; allocation_json: string; lot_numbers: string; expires_at: string }>();
  if (!intent) return { ok: false, detail: `Checkout was not found. Payment was not recorded. ${input.paymentId}` };
  if (input.userId && input.userId !== intent.user_id) {
    return { ok: false, detail: "Stripe payer did not match the checkout. Payment was not recorded." };
  }
  if (Number(intent.amount_cents) !== input.amountTotal) {
    return { ok: false, detail: `Stripe amount did not match the checkout. Payment was not recorded. ${input.paymentId}` };
  }
  const allocation = parseAllocation(intent.allocation_json);
  if (!allocation) return { ok: false, detail: "Checkout could not be read. Payment was not recorded." };
  if (input.invoiceIds) {
    const given = input.invoiceIds.split(",").filter(Boolean).sort().join(",");
    const expected = allocation.map((row) => row.invoiceId).sort().join(",");
    if (given !== expected) return { ok: false, detail: "Stripe invoice list did not match the checkout. Payment was not recorded." };
  }
  const existing = await input.db
    .prepare(
      `SELECT stripe_payment_id, receipt_emailed FROM stripe_event_receipts
       WHERE association_id = ? AND (event_id = ? OR stripe_payment_id = ?)`,
    )
    .bind(input.association.id, input.eventId, input.paymentId)
    .first<{ stripe_payment_id: string; receipt_emailed: number }>();
  if (existing) {
    return {
      ok: true,
      applied: {
        duplicate: true,
        stripePaymentId: existing.stripe_payment_id,
        amountCents: input.amountTotal,
        lotNumbers: intent.lot_numbers,
        invoiceNumbers: [],
        paymentIds: [],
        ownerEmails: [],
        emailed: Number(existing.receipt_emailed) === 1,
      },
    };
  }
  const paidOn = todayIso(input.association.timezone);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    input.db
      .prepare(
        `INSERT INTO stripe_event_receipts (association_id, event_id, stripe_payment_id, receipt_emailed, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .bind(input.association.id, input.eventId, input.paymentId, now),
  ];
  const paymentIds: string[] = [];
  const invoiceNumbers: string[] = [];
  for (const item of allocation) {
    const invoice = await input.db
      .prepare(
        `SELECT i.invoice_number, i.amount_cents, i.late_fee_cents, i.status,
                COALESCE((SELECT SUM(amount_cents) FROM payments pay WHERE pay.invoice_id = i.id AND pay.association_id = i.association_id), 0) AS paid_cents
         FROM invoices i WHERE i.association_id = ? AND i.id = ? AND i.property_id = ?`,
      )
      .bind(input.association.id, item.invoiceId, item.propertyId)
      .first<{ invoice_number: string; amount_cents: number; late_fee_cents: number; status: string; paid_cents: number }>();
    const remaining = invoice && invoice.status !== "void"
      ? Number(invoice.amount_cents) + Number(invoice.late_fee_cents) - Number(invoice.paid_cents)
      : 0;
    const applied = Math.min(Math.max(remaining, 0), item.amountCents);
    const unapplied = item.amountCents - applied;
    if (applied > 0) {
      const id = crypto.randomUUID();
      paymentIds.push(id);
      invoiceNumbers.push(invoice?.invoice_number ?? item.invoiceNumber);
      statements.push(paymentInsert(input.db, {
        id,
        associationId: input.association.id,
        propertyId: item.propertyId,
        invoiceId: item.invoiceId,
        amountCents: applied,
        reference: input.paymentId,
        paidOn,
        userId: intent.user_id,
        now,
      }));
      const status = invoiceStatus(Number(invoice?.amount_cents), Number(invoice?.late_fee_cents), Number(invoice?.paid_cents) + applied);
      statements.push(
        input.db
          .prepare("UPDATE invoices SET status = ? WHERE association_id = ? AND id = ? AND status != 'void'")
          .bind(status, input.association.id, item.invoiceId),
      );
    }
    if (unapplied > 0) {
      const id = crypto.randomUUID();
      paymentIds.push(id);
      statements.push(paymentInsert(input.db, {
        id,
        associationId: input.association.id,
        propertyId: item.propertyId,
        invoiceId: null,
        amountCents: unapplied,
        reference: input.paymentId,
        paidOn,
        userId: intent.user_id,
        now,
      }));
    }
  }
  if (paymentIds.length === 0) return { ok: false, detail: "Nothing was recorded for this Stripe payment." };
  const owners = await ownerRecipients(input.db, input.association.id, allocation.map((item) => item.propertyId));
  const staff = await listStaffContacts(input.db, input.association.id);
  const notice = `${formatMoney(input.amountTotal)} online payment for lot ${intent.lot_numbers}. Stripe ${input.paymentId}.`;
  for (const owner of owners) {
    statements.push(noticeInsert(input.db, {
      associationId: input.association.id,
      userId: owner.user_id,
      title: "Payment receipt",
      body: notice,
      href: `/a/${input.association.slug}/payments/${paymentIds[0]}`,
      now,
    }));
  }
  for (const person of staff) {
    statements.push(noticeInsert(input.db, {
      associationId: input.association.id,
      userId: person.user_id,
      title: "Online payment",
      body: notice,
      href: `/a/${input.association.slug}/admin/ledger`,
      now,
    }));
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO audit_log (id, association_id, actor_user_id, action, entity_type, entity_id, detail, created_at)
         VALUES (?, ?, ?, 'payment_record', 'payment', ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.association.id,
        intent.user_id,
        paymentIds[0],
        clip(`Lot ${intent.lot_numbers}. ${formatMoney(input.amountTotal)}. ${ONLINE_NOTE}. ${input.paymentId}.`, 1000),
        now,
      ),
  );
  try {
    await input.db.batch(statements);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const raced = await input.db
        .prepare(
          `SELECT stripe_payment_id, receipt_emailed FROM stripe_event_receipts
           WHERE association_id = ? AND (event_id = ? OR stripe_payment_id = ?)`,
        )
        .bind(input.association.id, input.eventId, input.paymentId)
        .first<{ stripe_payment_id: string; receipt_emailed: number }>();
      if (!raced) throw error;
      return {
        ok: true,
        applied: {
          duplicate: true,
          stripePaymentId: raced.stripe_payment_id,
          amountCents: input.amountTotal,
          lotNumbers: intent.lot_numbers,
          invoiceNumbers: [],
          paymentIds: [],
          ownerEmails: [],
          emailed: Number(raced.receipt_emailed) === 1,
        },
      };
    }
    throw error;
  }
  return {
    ok: true,
    applied: {
      duplicate: false,
      stripePaymentId: input.paymentId,
      amountCents: input.amountTotal,
      lotNumbers: intent.lot_numbers,
      invoiceNumbers,
      paymentIds,
      ownerEmails: owners.map((owner) => ({ email: owner.email })).filter((owner) => owner.email),
      emailed: false,
    },
  };
}

export async function emailStripeReceipt(input: {
  env: Env;
  db: D1Database;
  association: Association;
  stripePaymentId: string;
  recipients: { email: string }[];
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const apiKey = resendApiKey(input.env);
  if (!apiKey || input.recipients.length === 0) return false;
  const { results } = await input.db
    .prepare(
      `SELECT pay.amount_cents, p.lot_number, i.invoice_number
       FROM payments pay
       JOIN properties p ON p.id = pay.property_id AND p.association_id = pay.association_id
       LEFT JOIN invoices i ON i.id = pay.invoice_id AND i.association_id = pay.association_id
       WHERE pay.association_id = ? AND pay.reference = ? AND pay.method = 'stripe'
       ORDER BY pay.created_at`,
    )
    .bind(input.association.id, input.stripePaymentId)
    .all<{ amount_cents: number; lot_number: string; invoice_number: string | null }>();
  if (results.length === 0) return false;
  const receiptId = await input.db
    .prepare(
      `SELECT id FROM payments
       WHERE association_id = ? AND reference = ? AND method = 'stripe'
       ORDER BY created_at LIMIT 1`,
    )
    .bind(input.association.id, input.stripePaymentId)
    .first<{ id: string }>();
  const total = results.reduce((sum, row) => sum + Number(row.amount_cents), 0);
  const lines = results.map((row) => {
    const invoice = row.invoice_number ? `Invoice ${row.invoice_number}. ` : "";
    return `Lot ${row.lot_number}. ${invoice}${formatMoney(Number(row.amount_cents))}.`;
  });
  const receiptUrl = canonicalPortalUrl(input.association, `/payments/${receiptId?.id ?? ""}`);
  const text = [
    `${input.association.name} received your online payment.`,
    "",
    `Amount: ${formatMoney(total)}`,
    ...lines,
    `Method: ${ONLINE_NOTE}`,
    `Reference: ${input.stripePaymentId}`,
    "",
    `Receipt: ${receiptUrl}`,
    "",
    "Card details are not stored by this portal. This note is not a bank statement.",
  ].join("\n");
  try {
    const delivery = await deliverOwnerEmails({
      apiKey,
      from: input.env.EMAIL_FROM,
      recipients: input.recipients,
      subject: `${input.association.name} payment receipt`,
      text,
      fetchImpl: input.fetchImpl,
    });
    return delivery.sent > 0;
  } catch (error) {
    logError("payment_receipt_email", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return false;
  }
}

export async function markReceiptEmailed(db: D1Database, associationId: string, stripePaymentId: string): Promise<void> {
  await db
    .prepare("UPDATE stripe_event_receipts SET receipt_emailed = 1 WHERE association_id = ? AND stripe_payment_id = ?")
    .bind(associationId, stripePaymentId)
    .run();
}

export async function receiptRecipients(db: D1Database, associationId: string, stripePaymentId: string): Promise<{ email: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.email AS email
       FROM payments pay
       JOIN property_owners po ON po.property_id = pay.property_id AND po.association_id = pay.association_id
       JOIN users u ON u.id = po.user_id
       WHERE pay.association_id = ? AND pay.reference = ? AND pay.method = 'stripe'`,
    )
    .bind(associationId, stripePaymentId)
    .all<{ email: string }>();
  return results.filter((row) => row.email.trim());
}

export async function webhookSecret(env: Env, db: D1Database, associationId: string): Promise<string | null> {
  const material = paymentEncryptionKey(env);
  if (!material) return null;
  const row = await settingsRow(db, associationId);
  if (!row?.webhook_secret_ciphertext) return null;
  try {
    const secret = await decryptPaymentSecret(material, row.webhook_secret_ciphertext);
    return isWebhookSecret(secret) ? secret : null;
  } catch (error) {
    logError("payment_webhook_decrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return null;
  }
}

export async function paymentsReady(db: D1Database): Promise<boolean> {
  return tableExists(db, "payment_settings");
}

function viewFromRow(row: SettingsRow | null, encryptionReady: boolean): PaymentSettingsView {
  let secretMode: "" | StripeKeyMode = "";
  if (row?.secret_key_mode === "test" || row?.secret_key_mode === "live") secretMode = row.secret_key_mode;
  const enabled = Number(row?.enabled) === 1 && secretMode !== "";
  const view = {
    ready: true,
    encryptionReady,
    enabled,
    status: "not enabled" as PaymentStatusLine,
    secretLast4: row?.secret_key_last4 ?? "",
    secretMode,
    webhookLast4: row?.webhook_secret_last4 ?? "",
  };
  view.status = statusLine(view);
  return view;
}

async function settingsRow(db: D1Database, associationId: string): Promise<SettingsRow | null> {
  return db
    .prepare(
      `SELECT enabled, secret_key_ciphertext, secret_key_last4, secret_key_mode, webhook_secret_ciphertext, webhook_secret_last4
       FROM payment_settings WHERE association_id = ?`,
    )
    .bind(associationId)
    .first<SettingsRow>();
}

async function writeRow(
  db: D1Database,
  associationId: string,
  userId: string,
  row: {
    enabled: number;
    secret_key_ciphertext: string;
    secret_key_last4: string;
    secret_key_mode: string;
    webhook_secret_ciphertext: string;
    webhook_secret_last4: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO payment_settings (
         association_id, enabled, secret_key_ciphertext, secret_key_last4, secret_key_mode,
         webhook_secret_ciphertext, webhook_secret_last4, updated_at, updated_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET
         enabled = excluded.enabled,
         secret_key_ciphertext = excluded.secret_key_ciphertext,
         secret_key_last4 = excluded.secret_key_last4,
         secret_key_mode = excluded.secret_key_mode,
         webhook_secret_ciphertext = excluded.webhook_secret_ciphertext,
         webhook_secret_last4 = excluded.webhook_secret_last4,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    )
    .bind(
      associationId,
      Number(row.enabled) === 1 ? 1 : 0,
      row.secret_key_ciphertext,
      row.secret_key_last4,
      row.secret_key_mode,
      row.webhook_secret_ciphertext,
      row.webhook_secret_last4,
      now,
      userId,
    )
    .run();
}

function paymentInsert(
  db: D1Database,
  row: {
    id: string;
    associationId: string;
    propertyId: string;
    invoiceId: string | null;
    amountCents: number;
    reference: string;
    paidOn: string;
    userId: string;
    now: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payments (
         id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.associationId, row.propertyId, row.invoiceId, row.amountCents, row.reference, row.paidOn, ONLINE_NOTE, row.userId, row.now);
}

function noticeInsert(
  db: D1Database,
  row: { associationId: string; userId: string; title: string; body: string; href: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, association_id, user_id, kind, title, body, href, created_at)
       VALUES (?, ?, ?, 'account', ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), row.associationId, row.userId, row.title, row.body, row.href, row.now);
}

async function ownerRecipients(
  db: D1Database,
  associationId: string,
  propertyIds: string[],
): Promise<{ user_id: string; email: string }[]> {
  const unique = [...new Set(propertyIds)];
  if (unique.length === 0) return [];
  const marks = unique.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id AS user_id, u.email AS email
       FROM property_owners po
       JOIN users u ON u.id = po.user_id
       WHERE po.association_id = ? AND po.property_id IN (${marks})`,
    )
    .bind(associationId, ...unique)
    .all<{ user_id: string; email: string }>();
  return results;
}

function parseAllocation(json: string): Allocation[] | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value) || value.length === 0) return null;
    const rows: Allocation[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") return null;
      const row = item as Partial<Allocation>;
      if (typeof row.invoiceId !== "string" || typeof row.propertyId !== "string" || typeof row.lotNumber !== "string") return null;
      if (typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) return null;
      rows.push({
        invoiceId: row.invoiceId,
        propertyId: row.propertyId,
        lotNumber: row.lotNumber,
        invoiceNumber: typeof row.invoiceNumber === "string" ? row.invoiceNumber : "",
        amountCents: row.amountCents,
      });
    }
    return rows;
  } catch {
    return null;
  }
}

function productName(associationName: string, lots: string[]): string {
  const label = lots.length === 1 ? `lot ${lots[0]}` : `lots ${lots.join(", ")}`;
  return `${associationName} dues, ${label}`.slice(0, 120);
}

function migrationMessage(): string {
  return "Apply the online payments migration in D1, then try again. The steps are in the README under Online payments.";
}
