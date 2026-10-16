import { invoiceNetPaidSql, listStaffContacts, paymentFeeReady, paymentReversalsReady, paymentTestReady } from "../db";
import { invoiceStatus, parseMoneyToCents } from "./money";
import { formatMoney } from "./money";
import { todayIso } from "./dates";
import { isDemoAssociation } from "./demo";
import { deliverOwnerEmails, resendApiKey } from "./email";
import { isMissingTable, isUniqueConstraint } from "./errors";
import { tableExists } from "./fee-schedule-store";
import { canonicalPortalUrl } from "./hosts";
import { clip } from "./html";
import { logError } from "./log";
import { decryptPaymentSecret, encryptPaymentSecret, paymentKeyRing } from "./payment-crypto";
import {
  BANK_TRANSFER_FEE_LABEL,
  BANK_TRANSFER_PROCESSING_BLOCK,
  BANK_TRANSFER_PROCESSING_STATUS,
  PROCESSING_BLOCK_MS,
  bankTransferFeeCents,
  DEFAULT_BANK_FEE,
  formatFeeCap,
  formatFeePercent,
  invoiceCreditReversalCents,
  MAX_BANK_FEE_CAP_CENTS,
  parseFeePercentBps,
  type BankFeeConfig,
} from "./bank-fee";
import {
  checkoutUrls,
  CHECKOUT_TTL_SECONDS,
  createCheckoutSession,
  isWebhookSecret,
  livemodeMatchesKey,
  redactSecrets,
  secretLast4,
  stripeSecretMode,
  type ParsedDisputeEvent,
  type ParsedRefundEvent,
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
  feeReady: boolean;
  feeEnabled: boolean;
  feePercent: string;
  feeCap: string;
};

type SettingsRow = {
  enabled: number;
  secret_key_ciphertext: string;
  secret_key_last4: string;
  secret_key_mode: string;
  webhook_secret_ciphertext: string;
  webhook_secret_last4: string;
  processing_fee_enabled?: number;
  processing_fee_bps?: number;
  processing_fee_cap_cents?: number;
};

type SettingsWrite = {
  enabled: number;
  secret_key_ciphertext: string;
  secret_key_last4: string;
  secret_key_mode: string;
  webhook_secret_ciphertext: string;
  webhook_secret_last4: string;
  processing_fee_enabled: number;
  processing_fee_bps: number;
  processing_fee_cap_cents: number;
};

export type PayableInvoice = {
  invoiceId: string;
  propertyId: string;
  lotNumber: string;
  invoiceNumber: string;
  description?: string;
  amountCents: number;
};

const ONLINE_NOTE = "Online (Stripe)";
const TEST_NOTE = "Test payment, not applied";
const CHECKOUT_START_LIMIT = 10;
const CHECKOUT_START_WINDOW_MS = 10 * 60 * 1000;

/** True when Pay now is switched on and a Stripe secret key is stored. */
export async function onlinePaymentsOn(db: D1Database, associationId: string): Promise<boolean> {
  try {
    const row = await settingsRow(db, associationId);
    return Boolean(row && Number(row.enabled) === 1 && row.secret_key_ciphertext);
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

export async function payOfferFor(db: D1Database, association: Association, canEdit: boolean): Promise<OwnerPayOffer> {
  if (isDemoAssociation(association)) return { kind: "demo" };
  try {
    const row = await settingsRow(db, association.id);
    if (!row || Number(row.enabled) !== 1) return { kind: "off" };
    if (row.secret_key_mode !== "test" && row.secret_key_mode !== "live") return { kind: "off" };
    if (!row.secret_key_ciphertext || !row.webhook_secret_ciphertext) return { kind: "off" };
    if (row.secret_key_mode === "test" && !canEdit) return { kind: "off" };
    return { kind: "stripe", mode: row.secret_key_mode };
  } catch (error) {
    if (isMissingTable(error)) return { kind: "off" };
    throw error;
  }
}

export async function paymentSettingsView(env: Env, db: D1Database, associationId: string): Promise<PaymentSettingsView> {
  const encryptionReady = Boolean(paymentKeyRing(env));
  const feeDefaults = {
    feeReady: false,
    feeEnabled: DEFAULT_BANK_FEE.enabled,
    feePercent: formatFeePercent(DEFAULT_BANK_FEE.percentBps),
    feeCap: formatFeeCap(DEFAULT_BANK_FEE.capCents),
  };
  if (!(await paymentsReady(db))) {
    return {
      ready: false,
      encryptionReady,
      enabled: false,
      status: "not enabled",
      secretLast4: "",
      secretMode: "",
      webhookLast4: "",
      ...feeDefaults,
    };
  }
  const row = await settingsRow(db, associationId);
  const feeReady = await bankFeeStorageReady(db);
  const view = viewFromRow(row, encryptionReady);
  if (!feeReady || !row || row.processing_fee_bps === undefined) {
    return { ...view, ...feeDefaults, feeReady };
  }
  return {
    ...view,
    feeReady: true,
    feeEnabled: Number(row.processing_fee_enabled) === 1,
    feePercent: formatFeePercent(Number(row.processing_fee_bps)),
    feeCap: formatFeeCap(Number(row.processing_fee_cap_cents)),
  };
}

export async function bankFeeConfig(db: D1Database, associationId: string): Promise<BankFeeConfig> {
  if (!(await bankFeeStorageReady(db))) return { ...DEFAULT_BANK_FEE, enabled: false };
  try {
    const row = await settingsRow(db, associationId);
    if (!row || row.processing_fee_bps === undefined) return { ...DEFAULT_BANK_FEE };
    return {
      enabled: Number(row.processing_fee_enabled) === 1,
      percentBps: Number(row.processing_fee_bps),
      capCents: Number(row.processing_fee_cap_cents),
    };
  } catch (error) {
    if (isMissingTable(error)) return { ...DEFAULT_BANK_FEE, enabled: false };
    throw error;
  }
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
  const ring = paymentKeyRing(env);
  if (!ring) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  let ciphertext = "";
  try {
    ciphertext = await encryptPaymentSecret(ring, associationId, "secret_key", secret.trim());
  } catch (error) {
    logError("payment_secret_encrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  }
  const current = await settingsRow(db, associationId);
  const action = current?.secret_key_ciphertext ? "payment_settings_secret_replaced" : "payment_settings_secret_set";
  await writeRow(db, associationId, userId, settingsWrite(current, {
    secret_key_ciphertext: ciphertext,
    secret_key_last4: secretLast4(secret),
    secret_key_mode: mode,
  }));
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
  await writeRow(db, associationId, userId, settingsWrite(current, {
    enabled: 0,
    secret_key_ciphertext: "",
    secret_key_last4: "",
    secret_key_mode: "",
  }));
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
  const ring = paymentKeyRing(env);
  if (!ring) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  let ciphertext = "";
  try {
    ciphertext = await encryptPaymentSecret(ring, associationId, "webhook_secret", secret.trim());
  } catch (error) {
    logError("payment_webhook_encrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  }
  const current = await settingsRow(db, associationId);
  const action = current?.webhook_secret_ciphertext ? "payment_settings_webhook_replaced" : "payment_settings_webhook_set";
  await writeRow(db, associationId, userId, settingsWrite(current, {
    webhook_secret_ciphertext: ciphertext,
    webhook_secret_last4: secretLast4(secret),
  }));
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
  await writeRow(db, associationId, userId, settingsWrite(current, {
    enabled: 0,
    webhook_secret_ciphertext: "",
    webhook_secret_last4: "",
  }));
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
    await writeRow(db, associationId, userId, settingsWrite(current, { enabled: 0 }));
    return { ok: true, changed: true };
  }
  if (!current?.secret_key_ciphertext || !current.webhook_secret_ciphertext) {
    return { ok: false, message: "Save both keys before turning payments on." };
  }
  const ring = paymentKeyRing(env);
  if (!ring) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  try {
    const secret = await decryptPaymentSecret(ring, associationId, "secret_key", current.secret_key_ciphertext);
    const webhook = await decryptPaymentSecret(ring, associationId, "webhook_secret", current.webhook_secret_ciphertext);
    const mode = stripeSecretMode(secret);
    if (!mode || !isWebhookSecret(webhook) || mode !== current.secret_key_mode) {
      return { ok: false, message: "The stored Stripe keys could not be read. Replace them, then turn payments on." };
    }
  } catch (error) {
    logError("payment_settings_read", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "The stored Stripe keys could not be read. Replace them, then turn payments on." };
  }
  await writeRow(db, associationId, userId, settingsWrite(current, { enabled: 1 }));
  return { ok: true, changed: true };
}

export async function saveBankTransferFee(
  db: D1Database,
  associationId: string,
  userId: string,
  enabled: boolean,
  percentInput: string,
  capInput: string,
): Promise<
  | {
      ok: true;
      changed: boolean;
      enabled: boolean;
      percent: string;
      cap: string;
      previousEnabled: boolean;
      previousPercent: string;
      previousCap: string;
    }
  | { ok: false; message: string }
> {
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  if (!(await bankFeeStorageReady(db))) {
    return {
      ok: false,
      message: "Apply migrations/0022_bank_transfer_fee.sql in D1, then try again. The steps are in the README under Online payments.",
    };
  }
  const bps = parseFeePercentBps(percentInput);
  if (bps === null) return { ok: false, message: "Enter a fee percent from 0 to 10, such as 0.8." };
  if (!capInput.trim()) return { ok: false, message: "Enter a cap from 0.00 to 25.00." };
  const cap = parseMoneyToCents(capInput);
  if (cap === null || cap < 0 || cap > MAX_BANK_FEE_CAP_CENTS) {
    return { ok: false, message: "Enter a cap from 0.00 to 25.00." };
  }
  const current = await settingsRow(db, associationId);
  const previous = storedFee(current);
  const unchanged = previous.processing_fee_enabled === (enabled ? 1 : 0)
    && previous.processing_fee_bps === bps
    && previous.processing_fee_cap_cents === cap;
  const summary = {
    enabled,
    percent: formatFeePercent(bps),
    cap: formatFeeCap(cap),
    previousEnabled: previous.processing_fee_enabled === 1,
    previousPercent: formatFeePercent(previous.processing_fee_bps),
    previousCap: formatFeeCap(previous.processing_fee_cap_cents),
  };
  if (unchanged && (current || (enabled && bps === DEFAULT_BANK_FEE.percentBps && cap === DEFAULT_BANK_FEE.capCents))) {
    return { ok: true, changed: false, ...summary };
  }
  await writeRow(db, associationId, userId, settingsWrite(current, {
    processing_fee_enabled: enabled ? 1 : 0,
    processing_fee_bps: bps,
    processing_fee_cap_cents: cap,
  }));
  return { ok: true, changed: true, ...summary };
}

export async function payableInvoicesForUser(db: D1Database, associationId: string, userId: string, today: string): Promise<PayableInvoice[]> {
  const paidSql = await netPaidSql(db);
  const { results } = await db
    .prepare(
      `SELECT i.id AS invoice_id, i.property_id, p.lot_number, i.invoice_number, i.description,
              i.amount_cents + i.late_fee_cents - ${paidSql} AS remaining_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       WHERE i.association_id = ? AND po.user_id = ? AND i.status IN ('open', 'partial')
         AND i.issued_on <= ?
       ORDER BY i.due_on, i.invoice_number`,
    )
    .bind(associationId, userId, today)
    .all<{ invoice_id: string; property_id: string; lot_number: string; invoice_number: string; description: string; remaining_cents: number }>();
  return results
    .filter((row) => Number(row.remaining_cents) > 0)
    .map((row) => ({
      invoiceId: row.invoice_id,
      propertyId: row.property_id,
      lotNumber: row.lot_number,
      invoiceNumber: row.invoice_number,
      description: row.description,
      amountCents: Number(row.remaining_cents),
    }));
}

async function netPaidSql(db: D1Database): Promise<string> {
  return invoiceNetPaidSql(await paymentReversalsReady(db), await paymentTestReady(db));
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
  if (ledgerCents <= 0) return { ok: false, message: "Nothing is due." };
  const blocked = await processingCoversInvoices(
    input.db,
    input.association.id,
    input.invoices.map((invoice) => invoice.invoiceId),
  );
  if (blocked) return { ok: false, message: BANK_TRANSFER_PROCESSING_BLOCK };
  const feeCents = bankTransferFeeCents(ledgerCents, await bankFeeConfig(input.db, input.association.id));
  if (feeCents === null) return { ok: false, message: "The bank transfer processing fee settings need to be corrected in Payment settings." };
  const ring = paymentKeyRing(input.env);
  if (!ring) return { ok: false, message: "Online payment is not available." };
  const row = await settingsRow(input.db, input.association.id);
  if (!row || Number(row.enabled) !== 1 || !row.secret_key_ciphertext) return { ok: false, message: "Online payment is not available." };
  let secretKey = "";
  try {
    secretKey = await decryptPaymentSecret(ring, input.association.id, "secret_key", row.secret_key_ciphertext);
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
  const invoiceKey = input.invoices.map((invoice) => invoice.invoiceId).sort().join(",");
  const allocation = input.invoices.map((invoice) => ({
    invoiceId: invoice.invoiceId,
    propertyId: invoice.propertyId,
    lotNumber: invoice.lotNumber,
    invoiceNumber: invoice.invoiceNumber,
    amountCents: invoice.amountCents,
  }));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const reusable = await reusableIntent(input.db, input.association.id, input.userId, ledgerCents, feeCents, invoiceKey);
  let intentId = reusable?.id ?? "";
  let expiresAtSeconds = reusable ? Math.floor(Date.parse(reusable.expires_at) / 1000) : 0;
  let reserved = false;
  if (!intentId) {
    intentId = crypto.randomUUID();
    expiresAtSeconds = nowSeconds + CHECKOUT_TTL_SECONDS;
    const reservedNow = await reserveCheckoutIntent(input.db, {
      id: intentId,
      associationId: input.association.id,
      userId: input.userId,
      amountCents: ledgerCents,
      feeCents,
      allocationJson: JSON.stringify(allocation),
      lotNumbers: lots.join(","),
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    });
    if (reservedNow) reserved = true;
    else {
      const raced = await reusableIntent(input.db, input.association.id, input.userId, ledgerCents, feeCents, invoiceKey);
      if (!raced) return { ok: false, message: "Too many checkout attempts. Wait a few minutes and try again." };
      intentId = raced.id;
      expiresAtSeconds = Math.floor(Date.parse(raced.expires_at) / 1000);
    }
  }
  const idempotencyKey = await sha256Hex(
    `${input.association.id}:${input.userId}:${invoiceKey}:${ledgerCents}:${feeCents}:${intentId}:${expiresAtSeconds}`,
  );
  let created: Awaited<ReturnType<typeof createCheckoutSession>>;
  try {
    created = await createCheckoutSession({
    secretKey,
    amountCents: ledgerCents,
    feeCents,
    name: productName(input.association.name, lots),
    customerEmail: input.email,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    intentId,
    idempotencyKey,
    expiresAt: expiresAtSeconds,
    metadata: {
      neighborhoodId: input.association.id,
      lot: lots.join(",").slice(0, 500),
      invoiceIds: invoiceIds.length <= 500 ? invoiceIds : "",
      userId: input.userId,
    },
    fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (reserved) await releaseCheckoutIntent(input.db, input.association.id, intentId);
    logError("payment_checkout", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "Stripe did not start checkout. The treasurer can check Payment settings." };
  }
  secretKey = "";
  if (!created.ok) {
    if (reserved) await releaseCheckoutIntent(input.db, input.association.id, intentId);
    return { ok: false, message: "Stripe did not start checkout. The treasurer can check Payment settings." };
  }
  await input.db
    .prepare("UPDATE checkout_intents SET stripe_session_id = ? WHERE association_id = ? AND id = ?")
    .bind(created.id, input.association.id, intentId)
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
  testOnly: boolean;
};

export async function applyStripeCheckout(input: {
  db: D1Database;
  association: Association;
  livemode: boolean | null;
  eventId: string;
  sessionId: string;
  paymentId: string;
  amountTotal: number;
  clientReferenceId: string;
  neighborhoodId: string;
  invoiceIds: string;
  userId: string;
}): Promise<{ ok: true; applied: AppliedStripePayment } | { ok: false; detail: string; review: boolean }> {
  const mode = await savedKeyMode(input.db, input.association.id);
  if (!livemodeMatchesKey(input.livemode, mode)) {
    return {
      ok: false,
      review: false,
      detail: `Stripe livemode did not match the saved key. Payment was not recorded. ${input.paymentId}`,
    };
  }
  if (!input.neighborhoodId || input.neighborhoodId !== input.association.id) {
    return { ok: false, review: true, detail: "Stripe neighborhood did not match this portal. Payment was not recorded." };
  }
  const feeSelect = (await checkoutFeeReady(input.db)) ? "fee_cents" : "0 AS fee_cents";
  const intent = await input.db
    .prepare(
      `SELECT id, user_id, amount_cents, ${feeSelect}, allocation_json, lot_numbers, stripe_session_id
       FROM checkout_intents WHERE association_id = ? AND id = ?`,
    )
    .bind(input.association.id, input.clientReferenceId)
    .first<{ id: string; user_id: string; amount_cents: number; fee_cents: number; allocation_json: string; lot_numbers: string; stripe_session_id: string }>();
  if (!intent) return { ok: false, review: true, detail: `Checkout was not found. Payment was not recorded. ${input.paymentId}` };
  if (!intent.stripe_session_id || intent.stripe_session_id !== input.sessionId) {
    return { ok: false, review: true, detail: `Stripe session did not match the checkout. Payment was not recorded. ${input.paymentId}` };
  }
  if (input.userId && input.userId !== intent.user_id) {
    return { ok: false, review: true, detail: "Stripe payer did not match the checkout. Payment was not recorded." };
  }
  const feeCents = Number(intent.fee_cents) || 0;
  if (Number(intent.amount_cents) + feeCents !== input.amountTotal) {
    return { ok: false, review: true, detail: `Stripe amount did not match the checkout. Payment was not recorded. ${input.paymentId}` };
  }
  const allocation = parseAllocation(intent.allocation_json);
  if (!allocation) return { ok: false, review: true, detail: "Checkout could not be read. Payment was not recorded." };
  const allocated = allocation.reduce((sum, item) => sum + item.amountCents, 0);
  if (allocated !== Number(intent.amount_cents)) {
    return { ok: false, review: true, detail: "Checkout allocation did not match the invoice total. Payment was not recorded." };
  }
  const metadataList = input.invoiceIds.trim();
  const metadataTruncated = metadataList.length >= 500;
  const given = metadataTruncated ? "" : metadataList.split(",").map((id) => id.trim()).filter(Boolean).sort().join(",");
  const expected = allocation.map((row) => row.invoiceId).sort().join(",");
  if (!metadataTruncated && given && given !== expected) {
    return { ok: false, review: true, detail: "Stripe invoice list did not match the checkout. Payment was not recorded." };
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
        testOnly: input.livemode === false,
      },
    };
  }
  const testOnly = input.livemode === false;
  const testColumn = await paymentTestReady(input.db);
  const feeColumn = await paymentFeeReady(input.db);
  if (testOnly && !testColumn) {
    return {
      ok: false,
      review: true,
      detail: "Apply migrations/0021_test_payments.sql before a test-mode payment can be recorded. The invoice was not marked paid.",
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
  if (await checkoutStatusReady(input.db)) {
    statements.push(
      input.db
        .prepare("UPDATE checkout_intents SET status = 'succeeded' WHERE association_id = ? AND id = ?")
        .bind(input.association.id, intent.id),
    );
  }
  const paymentIds: string[] = [];
  const invoiceNumbers: string[] = [];
  const paidSql = await netPaidSql(input.db);
  const note = testOnly ? TEST_NOTE : ONLINE_NOTE;
  let feeLeft = feeCents;
  const takeFee = (): number => {
    const fee = feeLeft;
    feeLeft = 0;
    return fee;
  };
  for (const item of allocation) {
    const invoice = await input.db
      .prepare(
        `SELECT i.invoice_number, i.amount_cents, i.late_fee_cents, i.status,
                ${paidSql} AS paid_cents
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
        feeCents: takeFee(),
        reference: input.paymentId,
        paidOn,
        userId: intent.user_id,
        now,
        testOnly,
        testColumn,
        feeColumn,
      }));
      if (!testOnly) {
        const status = invoiceStatus(Number(invoice?.amount_cents), Number(invoice?.late_fee_cents), Number(invoice?.paid_cents) + applied);
        statements.push(
          input.db
            .prepare("UPDATE invoices SET status = ? WHERE association_id = ? AND id = ? AND status != 'void'")
            .bind(status, input.association.id, item.invoiceId),
        );
      }
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
        feeCents: takeFee(),
        reference: input.paymentId,
        paidOn,
        userId: intent.user_id,
        now,
        testOnly,
        testColumn,
        feeColumn,
      }));
    }
  }
  if (paymentIds.length === 0) return { ok: false, review: true, detail: "Nothing was recorded for this Stripe payment." };
  const owners = testOnly ? [] : await ownerRecipients(input.db, input.association.id, allocation.map((item) => item.propertyId));
  const staff = await listStaffContacts(input.db, input.association.id);
  const subtotal = Number(intent.amount_cents);
  const feeNote = feeCents > 0 ? `, plus ${formatMoney(feeCents)} bank transfer processing fee` : "";
  const notice = testOnly
    ? `${formatMoney(subtotal)} test payment for lot ${intent.lot_numbers}${feeNote}. Not applied to the balance. Stripe ${input.paymentId}.`
    : `${formatMoney(subtotal)} online payment for lot ${intent.lot_numbers}${feeNote}. Stripe ${input.paymentId}.`;
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
      title: testOnly ? TEST_NOTE : "Online payment",
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
        clip(
          `Lot ${intent.lot_numbers}. ${feeCents > 0 ? `${formatMoney(subtotal)} applied. ${BANK_TRANSFER_FEE_LABEL} ${formatMoney(feeCents)}.` : `${formatMoney(subtotal)}.`} ${note}. ${input.paymentId}.`,
          1000,
        ),
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
          testOnly,
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
      testOnly,
    },
  };
}

export type ProcessingCheckout = {
  id: string;
  amountCents: number;
  feeCents: number;
  lotNumbers: string;
  createdAt: string;
};

export async function processingCheckoutsForUser(
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<ProcessingCheckout[]> {
  if (!(await checkoutStatusReady(db))) return [];
  const feeSelect = (await checkoutFeeReady(db)) ? "fee_cents" : "0 AS fee_cents";
  const { results } = await db
    .prepare(
      `SELECT id, amount_cents, ${feeSelect}, lot_numbers, created_at
       FROM checkout_intents
       WHERE association_id = ? AND user_id = ? AND status = 'processing' AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .bind(associationId, userId, processingBlockCutoff())
    .all<{ id: string; amount_cents: number; fee_cents: number; lot_numbers: string; created_at: string }>();
  return results.map((row) => ({
    id: row.id,
    amountCents: Number(row.amount_cents),
    feeCents: Number(row.fee_cents) || 0,
    lotNumbers: row.lot_numbers,
    createdAt: row.created_at,
  }));
}

export type StuckProcessingCheckout = ProcessingCheckout;

/** Every processing bank transfer, including ones older than 14 days, so the board can clear a stuck one. */
export async function processingCheckoutsForAssociation(
  db: D1Database,
  associationId: string,
): Promise<StuckProcessingCheckout[]> {
  if (!(await checkoutStatusReady(db))) return [];
  const feeSelect = (await checkoutFeeReady(db)) ? "fee_cents" : "0 AS fee_cents";
  const { results } = await db
    .prepare(
      `SELECT id, amount_cents, ${feeSelect}, lot_numbers, created_at
       FROM checkout_intents
       WHERE association_id = ? AND status = 'processing'
       ORDER BY created_at`,
    )
    .bind(associationId)
    .all<{ id: string; amount_cents: number; fee_cents: number; lot_numbers: string; created_at: string }>();
  return results.map((row) => ({
    id: row.id,
    amountCents: Number(row.amount_cents),
    feeCents: Number(row.fee_cents) || 0,
    lotNumbers: row.lot_numbers,
    createdAt: row.created_at,
  }));
}

/** Marks a processing checkout abandoned. Does not insert a payment and does not credit an invoice. */
export async function abandonProcessingCheckout(
  db: D1Database,
  associationId: string,
  intentId: string,
): Promise<{ ok: true; lotNumbers: string; amountCents: number } | { ok: false; message: string }> {
  if (!(await checkoutStatusReady(db))) {
    return { ok: false, message: "Apply migrations/0022_bank_transfer_fee.sql in D1, then try again." };
  }
  const intent = await db
    .prepare(
      `SELECT id, status, lot_numbers, amount_cents FROM checkout_intents WHERE association_id = ? AND id = ?`,
    )
    .bind(associationId, intentId)
    .first<{ id: string; status: string; lot_numbers: string; amount_cents: number }>();
  if (!intent) return { ok: false, message: "That bank transfer was not found." };
  if (intent.status === "abandoned") return { ok: false, message: "That bank transfer is already cleared." };
  if (intent.status !== "processing") return { ok: false, message: "Only a processing bank transfer can be cleared." };
  const saved = await db
    .prepare(
      `UPDATE checkout_intents SET status = 'abandoned'
       WHERE association_id = ? AND id = ? AND status = 'processing'`,
    )
    .bind(associationId, intentId)
    .run();
  if (Number(saved.meta.changes) === 0) return { ok: false, message: "That bank transfer was not cleared. Try again." };
  return { ok: true, lotNumbers: intent.lot_numbers, amountCents: Number(intent.amount_cents) };
}

export async function checkoutReturnState(
  db: D1Database,
  associationId: string,
  userId: string,
  sessionId: string,
): Promise<"processing" | "succeeded" | "failed"> {
  if (!sessionId.startsWith("cs_") || !(await checkoutStatusReady(db))) return "processing";
  const row = await db
    .prepare(
      `SELECT status FROM checkout_intents
       WHERE association_id = ? AND user_id = ? AND stripe_session_id = ?`,
    )
    .bind(associationId, userId, sessionId)
    .first<{ status: string }>();
  if (row?.status === "succeeded") return "succeeded";
  if (row?.status === "failed" || row?.status === "abandoned") return "failed";
  return "processing";
}

export async function markCheckoutProcessing(input: {
  db: D1Database;
  association: Association;
  livemode: boolean | null;
  eventId: string;
  sessionId: string;
  amountTotal: number;
  clientReferenceId: string;
  neighborhoodId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; detail: string; review: boolean }> {
  return markCheckoutLifecycle(input, "processing");
}

export async function markCheckoutFailed(input: {
  db: D1Database;
  association: Association;
  livemode: boolean | null;
  eventId: string;
  sessionId: string;
  amountTotal: number;
  clientReferenceId: string;
  neighborhoodId: string;
  userId: string;
}): Promise<{ ok: true } | { ok: false; detail: string; review: boolean }> {
  return markCheckoutLifecycle(input, "failed");
}

async function markCheckoutLifecycle(
  input: {
    db: D1Database;
    association: Association;
    livemode: boolean | null;
    eventId: string;
    sessionId: string;
    amountTotal: number;
    clientReferenceId: string;
    neighborhoodId: string;
    userId: string;
  },
  next: "processing" | "failed",
): Promise<{ ok: true } | { ok: false; detail: string; review: boolean }> {
  const mode = await savedKeyMode(input.db, input.association.id);
  const label = input.sessionId;
  if (!livemodeMatchesKey(input.livemode, mode)) {
    return { ok: false, review: false, detail: `Stripe livemode did not match the saved key. Nothing was applied. ${label}` };
  }
  if (!input.neighborhoodId || input.neighborhoodId !== input.association.id) {
    return { ok: false, review: true, detail: "Stripe neighborhood did not match this portal. Nothing was applied." };
  }
  if (!(await checkoutStatusReady(input.db))) {
    return {
      ok: false,
      review: true,
      detail: "Apply migrations/0022_bank_transfer_fee.sql before a bank transfer can be marked processing or failed. Nothing was applied to an invoice.",
    };
  }
  const feeSelect = (await checkoutFeeReady(input.db)) ? "fee_cents" : "0 AS fee_cents";
  const intent = await input.db
    .prepare(
      `SELECT id, user_id, amount_cents, ${feeSelect}, lot_numbers, stripe_session_id, status
       FROM checkout_intents WHERE association_id = ? AND id = ?`,
    )
    .bind(input.association.id, input.clientReferenceId)
    .first<{ id: string; user_id: string; amount_cents: number; fee_cents: number; lot_numbers: string; stripe_session_id: string; status: string }>();
  if (!intent) return { ok: false, review: true, detail: `Checkout was not found. Nothing was applied. ${label}` };
  if (!intent.stripe_session_id || intent.stripe_session_id !== input.sessionId) {
    return { ok: false, review: true, detail: `Stripe session did not match the checkout. Nothing was applied. ${label}` };
  }
  if (input.userId && input.userId !== intent.user_id) {
    return { ok: false, review: true, detail: "Stripe payer did not match the checkout. Nothing was applied." };
  }
  const feeCents = Number(intent.fee_cents) || 0;
  if (Number(intent.amount_cents) + feeCents !== input.amountTotal) {
    return { ok: false, review: true, detail: `Stripe amount did not match the checkout. Nothing was applied. ${label}` };
  }
  if (intent.status === "succeeded") {
    if (next === "processing") return { ok: true };
    return recordCheckoutStatus(input, intent.id, {
      kind: "checkout_failed",
      action: "payment_failed_after_success",
      title: "Bank transfer needs review",
      body: `Stripe reported this bank transfer failed after it had already succeeded. Nothing was reversed. ${label}.`,
      detail: `Bank transfer reported failed after success. Nothing was reversed. ${input.eventId}. ${label}.`,
      statusSql: null,
    });
  }
  if (intent.status === "abandoned") return { ok: true };
  if (intent.status === next) return { ok: true };
  if (next === "processing" && intent.status === "failed") return { ok: true };
  const copy = next === "processing"
    ? {
        kind: "processing",
        action: "payment_processing",
        title: "Bank transfer processing",
        body: `${BANK_TRANSFER_PROCESSING_STATUS}. Lot ${intent.lot_numbers}. ${formatMoney(Number(intent.amount_cents))}.`,
        detail: `Bank transfer processing. ${BANK_TRANSFER_PROCESSING_STATUS}. ${input.eventId}. ${label}.`,
        statusSql: "processing" as const,
      }
    : {
        kind: "checkout_failed",
        action: "payment_failed",
        title: "Bank transfer failed",
        body: `This bank transfer did not go through. Nothing was applied to the invoice. ${label}.`,
        detail: `Bank transfer failed. Nothing was applied. ${input.eventId}. ${label}.`,
        statusSql: "failed" as const,
      };
  return recordCheckoutStatus(input, intent.id, copy);
}

async function recordCheckoutStatus(
  input: {
    db: D1Database;
    association: Association;
    eventId: string;
    sessionId: string;
  },
  intentId: string,
  copy: {
    kind: string;
    action: string;
    title: string;
    body: string;
    detail: string;
    statusSql: "processing" | "failed" | null;
  },
): Promise<{ ok: true } | { ok: false; detail: string; review: boolean }> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    input.db
      .prepare(
        `INSERT INTO stripe_adjustment_events (association_id, event_id, kind, stripe_payment_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(input.association.id, input.eventId, copy.kind, input.sessionId, now),
  ];
  if (copy.statusSql) {
    statements.push(
      input.db
        .prepare(
          `UPDATE checkout_intents SET status = ?
           WHERE association_id = ? AND id = ? AND status IN ('open', 'processing')`,
        )
        .bind(copy.statusSql, input.association.id, intentId),
    );
  }
  const staff = await listStaffContacts(input.db, input.association.id);
  const intentUser = await input.db
    .prepare("SELECT user_id FROM checkout_intents WHERE association_id = ? AND id = ?")
    .bind(input.association.id, intentId)
    .first<{ user_id: string }>();
  if (intentUser?.user_id) {
    statements.push(noticeInsert(input.db, {
      associationId: input.association.id,
      userId: intentUser.user_id,
      title: copy.title,
      body: copy.body,
      href: `/a/${input.association.slug}/payments`,
      now,
    }));
  }
  for (const person of staff) {
    statements.push(noticeInsert(input.db, {
      associationId: input.association.id,
      userId: person.user_id,
      title: copy.title,
      body: copy.body,
      href: `/a/${input.association.slug}/admin/ledger`,
      now,
    }));
  }
  statements.push(
    input.db
      .prepare(
        `INSERT INTO audit_log (id, association_id, actor_user_id, action, entity_type, entity_id, detail, created_at)
         VALUES (?, ?, NULL, ?, 'checkout_intent', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.association.id, copy.action, intentId, clip(copy.detail, 1000), now),
  );
  try {
    await input.db.batch(statements);
  } catch (error) {
    if (isUniqueConstraint(error)) return { ok: true };
    throw error;
  }
  return { ok: true };
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
  const feeColumn = (await paymentFeeReady(input.db)) ? "pay.fee_cents" : "0 AS fee_cents";
  const { results } = await input.db
    .prepare(
      `SELECT pay.amount_cents, ${feeColumn}, p.lot_number, i.invoice_number
       FROM payments pay
       JOIN properties p ON p.id = pay.property_id AND p.association_id = pay.association_id
       LEFT JOIN invoices i ON i.id = pay.invoice_id AND i.association_id = pay.association_id
       WHERE pay.association_id = ? AND pay.reference = ? AND pay.method = 'stripe'
       ORDER BY pay.created_at`,
    )
    .bind(input.association.id, input.stripePaymentId)
    .all<{ amount_cents: number; fee_cents: number; lot_number: string; invoice_number: string | null }>();
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
  const fee = results.reduce((sum, row) => sum + Number(row.fee_cents), 0);
  const lines = results.map((row) => {
    const invoice = row.invoice_number ? `Invoice ${row.invoice_number}. ` : "";
    return `Lot ${row.lot_number}. ${invoice}${formatMoney(Number(row.amount_cents))}.`;
  });
  const receiptUrl = canonicalPortalUrl(input.association, `/payments/${receiptId?.id ?? ""}`);
  const amounts = fee > 0
    ? [`Invoices: ${formatMoney(total)}`, `${BANK_TRANSFER_FEE_LABEL}: ${formatMoney(fee)}`, `Charged: ${formatMoney(total + fee)}`]
    : [`Amount: ${formatMoney(total)}`];
  const text = [
    `${input.association.name} received your online payment.`,
    "",
    ...amounts,
    ...lines,
    `Method: ${ONLINE_NOTE}`,
    `Reference: ${input.stripePaymentId}`,
    "",
    `Receipt: ${receiptUrl}`,
    "",
    "Bank account numbers are not stored by this portal. Credit and debit cards are not accepted. This note is not a bank statement.",
    ...(fee > 0 ? ["The bank transfer processing fee is not applied to the invoice."] : []),
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
  const ring = paymentKeyRing(env);
  if (!ring) return null;
  const row = await settingsRow(db, associationId);
  if (!row?.webhook_secret_ciphertext) return null;
  try {
    const secret = await decryptPaymentSecret(ring, associationId, "webhook_secret", row.webhook_secret_ciphertext);
    return isWebhookSecret(secret) ? secret : null;
  } catch (error) {
    logError("payment_webhook_decrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return null;
  }
}

export async function reencryptPaymentSecrets(
  env: Env,
  db: D1Database,
  associationId: string,
  userId: string,
): Promise<{ ok: true; changed: boolean } | { ok: false; message: string }> {
  const ring = paymentKeyRing(env);
  if (!ring) return { ok: false, message: "Online payments cannot be saved yet. The encryption secret is not set. No key was stored." };
  if (!(await paymentsReady(db))) return { ok: false, message: migrationMessage() };
  const current = await settingsRow(db, associationId);
  if (!current?.secret_key_ciphertext && !current?.webhook_secret_ciphertext) {
    return { ok: false, message: "No Stripe keys are stored." };
  }
  const secretOnCurrent = !current.secret_key_ciphertext || ciphertextKid(current.secret_key_ciphertext) === ring.currentKid;
  const webhookOnCurrent = !current.webhook_secret_ciphertext || ciphertextKid(current.webhook_secret_ciphertext) === ring.currentKid;
  if (secretOnCurrent && webhookOnCurrent && current.secret_key_ciphertext.startsWith("v2.") && (!current.webhook_secret_ciphertext || current.webhook_secret_ciphertext.startsWith("v2."))) {
    return { ok: true, changed: false };
  }
  let secretCipher = current.secret_key_ciphertext;
  let webhookCipher = current.webhook_secret_ciphertext;
  try {
    if (current.secret_key_ciphertext) {
      const plain = await decryptPaymentSecret(ring, associationId, "secret_key", current.secret_key_ciphertext);
      secretCipher = await encryptPaymentSecret(ring, associationId, "secret_key", plain);
    }
    if (current.webhook_secret_ciphertext) {
      const plain = await decryptPaymentSecret(ring, associationId, "webhook_secret", current.webhook_secret_ciphertext);
      webhookCipher = await encryptPaymentSecret(ring, associationId, "webhook_secret", plain);
    }
  } catch (error) {
    logError("payment_settings_reencrypt", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
    return { ok: false, message: "The stored Stripe keys could not be read. Replace them before rotating the encryption key." };
  }
  const now = new Date().toISOString();
  const saved = await db
    .prepare(
      `UPDATE payment_settings SET
         secret_key_ciphertext = ?,
         webhook_secret_ciphertext = ?,
         updated_at = ?,
         updated_by_user_id = ?
       WHERE association_id = ?
         AND secret_key_ciphertext = ?
         AND webhook_secret_ciphertext = ?`,
    )
    .bind(
      secretCipher,
      webhookCipher,
      now,
      userId,
      associationId,
      current.secret_key_ciphertext,
      current.webhook_secret_ciphertext,
    )
    .run();
  if (Number(saved.meta.changes) === 0) {
    return { ok: false, message: "Payment settings changed while re-encrypting. Nothing was overwritten. Try again." };
  }
  return { ok: true, changed: true };
}

export async function paymentsReady(db: D1Database): Promise<boolean> {
  return tableExists(db, "payment_settings");
}

function viewFromRow(
  row: SettingsRow | null,
  encryptionReady: boolean,
): Omit<PaymentSettingsView, "feeReady" | "feeEnabled" | "feePercent" | "feeCap"> {
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
  const feeColumns = (await hasColumn(db, "payment_settings", "processing_fee_enabled"))
    ? ", processing_fee_enabled, processing_fee_bps, processing_fee_cap_cents"
    : "";
  return db
    .prepare(
      `SELECT enabled, secret_key_ciphertext, secret_key_last4, secret_key_mode, webhook_secret_ciphertext, webhook_secret_last4${feeColumns}
       FROM payment_settings WHERE association_id = ?`,
    )
    .bind(associationId)
    .first<SettingsRow>();
}

function storedFee(row: SettingsRow | null): Pick<SettingsWrite, "processing_fee_enabled" | "processing_fee_bps" | "processing_fee_cap_cents"> {
  if (!row || row.processing_fee_bps === undefined) {
    return {
      processing_fee_enabled: DEFAULT_BANK_FEE.enabled ? 1 : 0,
      processing_fee_bps: DEFAULT_BANK_FEE.percentBps,
      processing_fee_cap_cents: DEFAULT_BANK_FEE.capCents,
    };
  }
  return {
    processing_fee_enabled: Number(row.processing_fee_enabled) === 1 ? 1 : 0,
    processing_fee_bps: Number(row.processing_fee_bps),
    processing_fee_cap_cents: Number(row.processing_fee_cap_cents),
  };
}

function settingsWrite(current: SettingsRow | null, overrides: Partial<SettingsWrite> = {}): SettingsWrite {
  return {
    enabled: Number(current?.enabled) === 1 ? 1 : 0,
    secret_key_ciphertext: current?.secret_key_ciphertext ?? "",
    secret_key_last4: current?.secret_key_last4 ?? "",
    secret_key_mode: current?.secret_key_mode ?? "",
    webhook_secret_ciphertext: current?.webhook_secret_ciphertext ?? "",
    webhook_secret_last4: current?.webhook_secret_last4 ?? "",
    ...storedFee(current),
    ...overrides,
  };
}

async function writeRow(db: D1Database, associationId: string, userId: string, row: SettingsWrite): Promise<void> {
  const now = new Date().toISOString();
  const feeReady = await hasColumn(db, "payment_settings", "processing_fee_enabled");
  if (!feeReady) {
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
    return;
  }
  await db
    .prepare(
      `INSERT INTO payment_settings (
         association_id, enabled, secret_key_ciphertext, secret_key_last4, secret_key_mode,
         webhook_secret_ciphertext, webhook_secret_last4, processing_fee_enabled, processing_fee_bps,
         processing_fee_cap_cents, updated_at, updated_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET
         enabled = excluded.enabled,
         secret_key_ciphertext = excluded.secret_key_ciphertext,
         secret_key_last4 = excluded.secret_key_last4,
         secret_key_mode = excluded.secret_key_mode,
         webhook_secret_ciphertext = excluded.webhook_secret_ciphertext,
         webhook_secret_last4 = excluded.webhook_secret_last4,
         processing_fee_enabled = excluded.processing_fee_enabled,
         processing_fee_bps = excluded.processing_fee_bps,
         processing_fee_cap_cents = excluded.processing_fee_cap_cents,
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
      Number(row.processing_fee_enabled) === 1 ? 1 : 0,
      row.processing_fee_bps,
      row.processing_fee_cap_cents,
      now,
      userId,
    )
    .run();
}

export async function applyStripeAdjustment(input: {
  db: D1Database;
  association: Association;
  event: ParsedRefundEvent | ParsedDisputeEvent;
}): Promise<{ ok: true; duplicate: boolean } | { ok: false; detail: string; review: boolean }> {
  const mode = await savedKeyMode(input.db, input.association.id);
  const label = input.event.paymentId || (input.event.kind === "refund" ? input.event.chargeId : input.event.disputeId);
  if (!livemodeMatchesKey(input.event.livemode, mode)) {
    return { ok: false, review: false, detail: `Stripe livemode did not match the saved key. Adjustment was not recorded. ${label}` };
  }
  if (input.event.neighborhoodId && input.event.neighborhoodId !== input.association.id) {
    return { ok: false, review: true, detail: "Stripe neighborhood did not match this portal. Adjustment was not recorded." };
  }
  if (!(await paymentReversalsReady(input.db))) {
    return { ok: false, review: true, detail: "Apply migrations/0020_payment_controls.sql before this Stripe event can reach the ledger." };
  }
  const seen = await input.db
    .prepare("SELECT event_id FROM stripe_adjustment_events WHERE association_id = ? AND event_id = ?")
    .bind(input.association.id, input.event.eventId)
    .first<{ event_id: string }>();
  if (seen) return { ok: true, duplicate: true };
  if (input.event.kind === "refund") return postRefund(input.db, input.association, input.event);
  return postDispute(input.db, input.association, input.event);
}

// DOCUMENTS is a private R2 bucket. This file is not a public URL.
export async function exportPaymentAudit(env: Env, now: Date): Promise<void> {
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT id, association_id, action, entity_type, entity_id, detail, created_at
         FROM audit_log WHERE action LIKE 'payment%' ORDER BY created_at`,
      )
      .all<{ id: string; association_id: string; action: string; entity_type: string; entity_id: string; detail: string; created_at: string }>();
    const day = now.toISOString().slice(0, 10);
    const body = results
      .map((row) =>
        JSON.stringify({
          id: row.id,
          associationId: row.association_id,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          detail: row.detail,
          createdAt: row.created_at,
        }),
      )
      .join("\n");
    await env.DOCUMENTS.put(`audit/payment-activity-${day}.jsonl`, body ? `${body}\n` : "\n");
  } catch (error) {
    logError("payment_audit_export", { message: redactSecrets(error instanceof Error ? error.message : "unknown") });
  }
}

async function postRefund(
  db: D1Database,
  association: Association,
  event: ParsedRefundEvent,
): Promise<{ ok: true; duplicate: boolean } | { ok: false; detail: string; review: boolean }> {
  const payments = event.paymentId ? await stripePayments(db, association.id, event.paymentId) : [];
  if (payments.length > 0 && ledgerPayments(payments).length === 0) {
    await finishAdjustment(db, association, {
      eventId: event.eventId,
      kind: "refund",
      stripePaymentId: event.paymentId,
      title: TEST_NOTE,
      body: `A test-mode refund was not applied to the ledger. ${event.paymentId}.`,
      action: "payment_refund",
      detail: `Test refund was not applied. ${event.paymentId}. ${event.chargeId}.`,
      statements: [],
    });
    return { ok: true, duplicate: false };
  }
  const ledger = ledgerPayments(payments);
  if (ledger.length === 0) {
    await finishAdjustment(db, association, {
      eventId: event.eventId,
      kind: "refund",
      stripePaymentId: event.paymentId || event.chargeId,
      title: "Online refund needs review",
      body: `Stripe refund ${event.chargeId} could not be matched to a ledger payment.`,
      action: "payment_refund",
      detail: `Refund was not matched. ${event.chargeId}. ${event.paymentId}.`,
      statements: [],
    });
    return { ok: true, duplicate: false };
  }
  const already = await reversedCents(db, association.id, event.paymentId, "refund");
  const ledgerSubtotal = ledger.reduce((sum, payment) => sum + Number(payment.amount_cents), 0);
  const feeCents = ledger.reduce((sum, payment) => sum + Number(payment.fee_cents), 0);
  // Refunds are fee-first. A refund of only the processing fee does not reverse invoice credit.
  const delta = invoiceCreditReversalCents(event.amountRefunded, already, ledgerSubtotal, feeCents);
  if (delta <= 0) {
    const feeOnly = feeCents > 0 && event.amountRefunded <= feeCents;
    const body = feeOnly
      ? `The Stripe refund was the bank transfer processing fee and was not applied to the invoice. ${event.paymentId}.`
      : `Stripe reported a refund that was already on the ledger. ${event.paymentId}.`;
    const detail = feeOnly
      ? `Fee-only refund was not applied to the invoice. ${event.paymentId}. ${event.chargeId}.`
      : `Refund already recorded. ${event.paymentId}.`;
    await finishAdjustment(db, association, {
      eventId: event.eventId,
      kind: "refund",
      stripePaymentId: event.paymentId,
      title: "Online refund",
      body,
      action: "payment_refund",
      detail,
      statements: [],
    });
    return { ok: true, duplicate: false };
  }
  const slices = await reversalSlices(db, association.id, ledger, delta);
  const statements: D1PreparedStatement[] = [];
  const deltas = new Map<string, number>();
  for (const slice of slices) {
    statements.push(reversalInsert(db, association.id, slice, {
      kind: "refund",
      status: "refunded",
      stripePaymentId: event.paymentId,
      stripeObjectId: event.chargeId,
      eventId: event.eventId,
    }));
    if (slice.invoiceId) deltas.set(slice.invoiceId, (deltas.get(slice.invoiceId) ?? 0) - slice.amountCents);
  }
  for (const [invoiceId, change] of deltas) {
    statements.push(await invoiceStatusUpdate(db, association.id, invoiceId, change));
  }
  const applied = slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  const feeCovered = Math.min(feeCents, Math.max(0, event.amountRefunded));
  const feeSentence = feeCovered > 0
    ? ` ${formatMoney(feeCovered)} of the Stripe refund was the bank transfer processing fee and was not applied to the invoice.`
    : "";
  await finishAdjustment(db, association, {
    eventId: event.eventId,
    kind: "refund",
    stripePaymentId: event.paymentId,
    title: "Online refund",
    body: `${formatMoney(applied)} of invoice credit was reversed.${feeSentence} ${event.paymentId}.`,
    action: "payment_refund",
    detail: `Refund ${formatMoney(applied)} of invoice credit.${feeSentence} ${event.paymentId}. ${event.chargeId}.`,
    statements,
    propertyIds: slices.map((slice) => slice.propertyId),
  });
  return { ok: true, duplicate: false };
}

async function postDispute(
  db: D1Database,
  association: Association,
  event: ParsedDisputeEvent,
): Promise<{ ok: true; duplicate: boolean } | { ok: false; detail: string; review: boolean }> {
  if (event.action === "closed") return closeDispute(db, association, event);
  const prior = await db
    .prepare(
      `SELECT id FROM payment_reversals
       WHERE association_id = ? AND kind = 'dispute' AND stripe_object_id = ?
       LIMIT 1`,
    )
    .bind(association.id, event.disputeId)
    .first<{ id: string }>();
  if (prior) {
    await finishAdjustment(db, association, {
      eventId: event.eventId,
      kind: "dispute",
      stripePaymentId: event.paymentId || event.disputeId,
      title: "Online dispute",
      body: `Stripe dispute ${event.disputeId} was already on the ledger.`,
      action: "payment_dispute",
      detail: `Dispute already recorded. ${event.disputeId}. ${event.paymentId}.`,
      statements: [],
    });
    return { ok: true, duplicate: true };
  }
  const payments = event.paymentId ? await stripePayments(db, association.id, event.paymentId) : [];
  if (payments.length > 0 && ledgerPayments(payments).length === 0) {
    await finishAdjustment(db, association, {
      eventId: event.eventId,
      kind: "dispute",
      stripePaymentId: event.paymentId || event.disputeId,
      title: TEST_NOTE,
      body: `A test-mode dispute was not applied to the ledger. ${event.disputeId}.`,
      action: "payment_dispute",
      detail: `Test dispute was not applied. ${event.disputeId}. ${event.paymentId}.`,
      statements: [],
    });
    return { ok: true, duplicate: false };
  }
  const ledger = ledgerPayments(payments);
  if (ledger.length === 0) {
    await finishAdjustment(db, association, {
      eventId: event.eventId,
      kind: "dispute",
      stripePaymentId: event.paymentId || event.disputeId,
      title: "Online dispute needs review",
      body: `Stripe dispute ${event.disputeId} could not be matched to a ledger payment.`,
      action: "payment_dispute",
      detail: `Dispute was not matched. ${event.disputeId}. ${event.paymentId}.`,
      statements: [],
    });
    return { ok: true, duplicate: false };
  }
  const ledgerSubtotal = ledger.reduce((sum, payment) => sum + Number(payment.amount_cents), 0);
  const slices = await reversalSlices(db, association.id, ledger, invoiceCreditReversalCents(event.amount, 0, ledgerSubtotal));
  const statements: D1PreparedStatement[] = [];
  const deltas = new Map<string, number>();
  for (const slice of slices) {
    statements.push(reversalInsert(db, association.id, slice, {
      kind: "dispute",
      status: "open",
      stripePaymentId: event.paymentId,
      stripeObjectId: event.disputeId,
      eventId: event.eventId,
    }));
    if (slice.invoiceId) deltas.set(slice.invoiceId, (deltas.get(slice.invoiceId) ?? 0) - slice.amountCents);
  }
  for (const [invoiceId, change] of deltas) {
    statements.push(await invoiceStatusUpdate(db, association.id, invoiceId, change));
  }
  const applied = slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  const feePortion = Math.max(0, event.amount - ledgerSubtotal);
  const feeSentence = feePortion > 0
    ? ` ${formatMoney(feePortion)} of the dispute was the bank transfer processing fee and was not applied to the invoice.`
    : "";
  await finishAdjustment(db, association, {
    eventId: event.eventId,
    kind: "dispute",
    stripePaymentId: event.paymentId,
    title: "Online dispute",
    body: `${formatMoney(applied)} is in dispute at Stripe.${feeSentence} ${event.paymentId}.`,
    action: "payment_dispute",
    detail: `Dispute opened ${formatMoney(applied)}.${feeSentence} ${event.disputeId}. ${event.paymentId}.`,
    statements,
    propertyIds: slices.map((slice) => slice.propertyId),
  });
  return { ok: true, duplicate: false };
}

async function closeDispute(
  db: D1Database,
  association: Association,
  event: ParsedDisputeEvent,
): Promise<{ ok: true; duplicate: boolean }> {
  const won = event.status === "won" || event.status === "warning_closed";
  const { results } = await db
    .prepare(
      `SELECT id, invoice_id, amount_cents, status
       FROM payment_reversals
       WHERE association_id = ? AND stripe_object_id = ? AND kind = 'dispute'`,
    )
    .bind(association.id, event.disputeId)
    .all<{ id: string; invoice_id: string | null; amount_cents: number; status: string }>();
  const statements: D1PreparedStatement[] = [];
  const deltas = new Map<string, number>();
  if (won) {
    for (const row of results) {
      if (row.status === "won") continue;
      statements.push(
        db.prepare("UPDATE payment_reversals SET status = 'won' WHERE association_id = ? AND id = ?").bind(association.id, row.id),
      );
      if (row.invoice_id) deltas.set(row.invoice_id, (deltas.get(row.invoice_id) ?? 0) + Number(row.amount_cents));
    }
    for (const [invoiceId, change] of deltas) {
      statements.push(await invoiceStatusUpdate(db, association.id, invoiceId, change));
    }
  } else {
    for (const row of results) {
      if (row.status === "won" || row.status === "lost") continue;
      statements.push(
        db.prepare("UPDATE payment_reversals SET status = 'lost' WHERE association_id = ? AND id = ?").bind(association.id, row.id),
      );
    }
  }
  const outcome = won ? "won" : "lost";
  await finishAdjustment(db, association, {
    eventId: event.eventId,
    kind: "dispute",
    stripePaymentId: event.paymentId || event.disputeId,
    title: "Online dispute closed",
    body: results.length
      ? `Stripe dispute ${event.disputeId} closed as ${outcome}. ${event.paymentId}.`
      : `Stripe dispute ${event.disputeId} closed and was not matched to a ledger reversal.`,
    action: "payment_dispute_closed",
    detail: `Dispute ${outcome}. ${event.disputeId}. ${event.paymentId}.`,
    statements,
  });
  return { ok: true, duplicate: false };
}

async function finishAdjustment(
  db: D1Database,
  association: Association,
  input: {
    eventId: string;
    kind: string;
    stripePaymentId: string;
    title: string;
    body: string;
    action: string;
    detail: string;
    statements: D1PreparedStatement[];
    propertyIds?: string[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO stripe_adjustment_events (association_id, event_id, kind, stripe_payment_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(association.id, input.eventId, input.kind, input.stripePaymentId, now),
    ...input.statements,
  ];
  const owners = await ownerRecipients(db, association.id, input.propertyIds ?? []);
  const staff = await listStaffContacts(db, association.id);
  for (const owner of owners) {
    statements.push(noticeInsert(db, {
      associationId: association.id,
      userId: owner.user_id,
      title: input.title,
      body: input.body,
      href: `/a/${association.slug}/dashboard`,
      now,
    }));
  }
  for (const person of staff) {
    statements.push(noticeInsert(db, {
      associationId: association.id,
      userId: person.user_id,
      title: input.title,
      body: input.body,
      href: `/a/${association.slug}/admin/ledger`,
      now,
    }));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log (id, association_id, actor_user_id, action, entity_type, entity_id, detail, created_at)
         VALUES (?, ?, NULL, ?, 'payment', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), association.id, input.action, input.eventId, clip(input.detail, 1000), now),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueConstraint(error)) return;
    throw error;
  }
}

type StripeLedgerPayment = { id: string; property_id: string; invoice_id: string | null; amount_cents: number; fee_cents: number; is_test: number };

function ledgerPayments(payments: StripeLedgerPayment[]): StripeLedgerPayment[] {
  return payments.filter((payment) => Number(payment.is_test) !== 1);
}

async function stripePayments(db: D1Database, associationId: string, paymentId: string): Promise<StripeLedgerPayment[]> {
  if (!paymentId) return [];
  const testColumn = (await paymentTestReady(db)) ? "is_test" : "0 AS is_test";
  const feeColumn = (await paymentFeeReady(db)) ? "fee_cents" : "0 AS fee_cents";
  const { results } = await db
    .prepare(
      `SELECT id, property_id, invoice_id, amount_cents, ${feeColumn}, ${testColumn}
       FROM payments
       WHERE association_id = ? AND method = 'stripe' AND reference = ?
       ORDER BY created_at`,
    )
    .bind(associationId, paymentId)
    .all<StripeLedgerPayment>();
  return results;
}

async function reversedCents(db: D1Database, associationId: string, paymentId: string, kind: "refund" | "dispute"): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS n
       FROM payment_reversals
       WHERE association_id = ? AND stripe_payment_id = ? AND kind = ? AND status != 'won'`,
    )
    .bind(associationId, paymentId, kind)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function reversalSlices(
  db: D1Database,
  associationId: string,
  payments: StripeLedgerPayment[],
  amountCents: number,
): Promise<{ paymentId: string; propertyId: string; invoiceId: string | null; amountCents: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT payment_id, COALESCE(SUM(amount_cents), 0) AS n
       FROM payment_reversals
       WHERE association_id = ? AND status != 'won' AND payment_id IS NOT NULL
       GROUP BY payment_id`,
    )
    .bind(associationId)
    .all<{ payment_id: string; n: number }>();
  const used = new Map(results.map((row) => [row.payment_id, Number(row.n)]));
  const slices: { paymentId: string; propertyId: string; invoiceId: string | null; amountCents: number }[] = [];
  let left = amountCents;
  for (const payment of payments) {
    if (left <= 0) break;
    const room = Number(payment.amount_cents) - (used.get(payment.id) ?? 0);
    if (room <= 0) continue;
    const take = Math.min(room, left);
    slices.push({
      paymentId: payment.id,
      propertyId: payment.property_id,
      invoiceId: payment.invoice_id,
      amountCents: take,
    });
    left -= take;
  }
  return slices;
}

function reversalInsert(
  db: D1Database,
  associationId: string,
  slice: { paymentId: string; propertyId: string; invoiceId: string | null; amountCents: number },
  meta: { kind: "refund" | "dispute"; status: string; stripePaymentId: string; stripeObjectId: string; eventId: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payment_reversals (
         id, association_id, payment_id, property_id, invoice_id, amount_cents, kind, status,
         stripe_payment_id, stripe_object_id, event_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      associationId,
      slice.paymentId,
      slice.propertyId,
      slice.invoiceId,
      slice.amountCents,
      meta.kind,
      meta.status,
      meta.stripePaymentId,
      meta.stripeObjectId,
      meta.eventId,
      new Date().toISOString(),
    );
}

async function invoiceStatusUpdate(
  db: D1Database,
  associationId: string,
  invoiceId: string,
  deltaCents: number,
): Promise<D1PreparedStatement> {
  const invoice = await db
    .prepare(
      `SELECT i.amount_cents, i.late_fee_cents, i.status, ${await netPaidSql(db)} AS paid_cents
       FROM invoices i WHERE i.association_id = ? AND i.id = ?`,
    )
    .bind(associationId, invoiceId)
    .first<{ amount_cents: number; late_fee_cents: number; status: string; paid_cents: number }>();
  const status = !invoice || invoice.status === "void"
    ? "void"
    : invoiceStatus(Number(invoice.amount_cents), Number(invoice.late_fee_cents), Number(invoice.paid_cents) + deltaCents);
  return db
    .prepare("UPDATE invoices SET status = ? WHERE association_id = ? AND id = ? AND status != 'void'")
    .bind(status, associationId, invoiceId);
}

async function reusableIntent(
  db: D1Database,
  associationId: string,
  userId: string,
  amountCents: number,
  feeCents: number,
  invoiceKey: string,
): Promise<{ id: string; expires_at: string } | null> {
  const feeReady = await checkoutFeeReady(db);
  const feeSql = feeReady ? "AND fee_cents = ?" : "";
  const statement = db
    .prepare(
      `SELECT id, expires_at, allocation_json
       FROM checkout_intents
       WHERE association_id = ? AND user_id = ? AND amount_cents = ? ${feeSql} AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 5`,
    );
  const bound = feeReady
    ? statement.bind(associationId, userId, amountCents, feeCents, new Date().toISOString())
    : statement.bind(associationId, userId, amountCents, new Date().toISOString());
  const { results } = await bound
    .all<{ id: string; expires_at: string; allocation_json: string }>();
  for (const row of results) {
    const allocation = parseAllocation(row.allocation_json);
    if (!allocation) continue;
    const key = allocation.map((item) => item.invoiceId).sort().join(",");
    if (key === invoiceKey && Number.isFinite(Date.parse(row.expires_at))) return { id: row.id, expires_at: row.expires_at };
  }
  return null;
}

async function reserveCheckoutIntent(
  db: D1Database,
  row: {
    id: string;
    associationId: string;
    userId: string;
    amountCents: number;
    feeCents: number;
    allocationJson: string;
    lotNumbers: string;
    expiresAt: string;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - CHECKOUT_START_WINDOW_MS).toISOString();
  const feeReady = await checkoutFeeReady(db);
  const saved = feeReady
    ? await db
        .prepare(
          `INSERT INTO checkout_intents (
             id, association_id, user_id, amount_cents, fee_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, '', ?, ?
           WHERE (
             SELECT COUNT(*) FROM checkout_intents
             WHERE association_id = ? AND user_id = ? AND created_at >= ?
           ) < ?
           AND NOT EXISTS (
             SELECT 1 FROM checkout_intents
             WHERE association_id = ? AND user_id = ? AND amount_cents = ? AND fee_cents = ? AND expires_at > ? AND allocation_json = ?
           )`,
        )
        .bind(
          row.id,
          row.associationId,
          row.userId,
          row.amountCents,
          row.feeCents,
          row.allocationJson,
          row.lotNumbers,
          row.expiresAt,
          now,
          row.associationId,
          row.userId,
          cutoff,
          CHECKOUT_START_LIMIT,
          row.associationId,
          row.userId,
          row.amountCents,
          row.feeCents,
          now,
          row.allocationJson,
        )
        .run()
    : await db
        .prepare(
          `INSERT INTO checkout_intents (
             id, association_id, user_id, amount_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at
           )
           SELECT ?, ?, ?, ?, ?, ?, '', ?, ?
           WHERE (
             SELECT COUNT(*) FROM checkout_intents
             WHERE association_id = ? AND user_id = ? AND created_at >= ?
           ) < ?
           AND NOT EXISTS (
             SELECT 1 FROM checkout_intents
             WHERE association_id = ? AND user_id = ? AND amount_cents = ? AND expires_at > ? AND allocation_json = ?
           )`,
        )
        .bind(
          row.id,
          row.associationId,
          row.userId,
          row.amountCents,
          row.allocationJson,
          row.lotNumbers,
          row.expiresAt,
          now,
          row.associationId,
          row.userId,
          cutoff,
          CHECKOUT_START_LIMIT,
          row.associationId,
          row.userId,
          row.amountCents,
          now,
          row.allocationJson,
        )
        .run();
  return Number(saved.meta.changes) > 0;
}

async function releaseCheckoutIntent(db: D1Database, associationId: string, intentId: string): Promise<void> {
  await db
    .prepare("DELETE FROM checkout_intents WHERE association_id = ? AND id = ? AND stripe_session_id = ''")
    .bind(associationId, intentId)
    .run();
}

async function savedKeyMode(db: D1Database, associationId: string): Promise<"" | StripeKeyMode> {
  const row = await settingsRow(db, associationId);
  if (row?.secret_key_mode === "test" || row?.secret_key_mode === "live") return row.secret_key_mode;
  return "";
}

function ciphertextKid(stored: string): string | null {
  const parts = stored.split(".");
  if (parts[0] === "v2" && parts.length === 4 && parts[1]) return parts[1];
  return null;
}

function paymentInsert(
  db: D1Database,
  row: {
    id: string;
    associationId: string;
    propertyId: string;
    invoiceId: string | null;
    amountCents: number;
    feeCents: number;
    reference: string;
    paidOn: string;
    userId: string;
    now: string;
    testOnly: boolean;
    testColumn: boolean;
    feeColumn: boolean;
  },
): D1PreparedStatement {
  const note = row.testOnly ? TEST_NOTE : ONLINE_NOTE;
  const columns = [
    "id",
    "association_id",
    "property_id",
    "invoice_id",
    "amount_cents",
    "method",
    "reference",
    "paid_on",
    "notes",
    "recorded_by_user_id",
    "created_at",
  ];
  const values: (string | number | null)[] = [
    row.id,
    row.associationId,
    row.propertyId,
    row.invoiceId,
    row.amountCents,
    "stripe",
    row.reference,
    row.paidOn,
    note,
    row.userId,
    row.now,
  ];
  if (row.testColumn) {
    columns.push("is_test");
    values.push(row.testOnly ? 1 : 0);
  }
  if (row.feeColumn) {
    columns.push("fee_cents");
    values.push(row.feeCents);
  }
  const placeholders = columns.map(() => "?").join(", ");
  return db.prepare(`INSERT INTO payments (${columns.join(", ")}) VALUES (${placeholders})`).bind(...values);
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

async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  if (!/^[a-z_]+$/.test(table)) return false;
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.some((row) => row.name === column);
}

async function checkoutFeeReady(db: D1Database): Promise<boolean> {
  return hasColumn(db, "checkout_intents", "fee_cents");
}

async function checkoutStatusReady(db: D1Database): Promise<boolean> {
  return hasColumn(db, "checkout_intents", "status");
}

function processingBlockCutoff(now = Date.now()): string {
  return new Date(now - PROCESSING_BLOCK_MS).toISOString();
}

async function processingCoversInvoices(
  db: D1Database,
  associationId: string,
  invoiceIds: string[],
): Promise<boolean> {
  if (invoiceIds.length === 0 || !(await checkoutStatusReady(db))) return false;
  const { results } = await db
    .prepare(
      `SELECT allocation_json FROM checkout_intents
       WHERE association_id = ? AND status = 'processing' AND created_at >= ?`,
    )
    .bind(associationId, processingBlockCutoff())
    .all<{ allocation_json: string }>();
  const wanted = new Set(invoiceIds);
  for (const row of results) {
    const allocation = parseAllocation(row.allocation_json);
    if (!allocation) continue;
    if (allocation.some((item) => wanted.has(item.invoiceId))) return true;
  }
  return false;
}

async function bankFeeStorageReady(db: D1Database): Promise<boolean> {
  return (
    (await hasColumn(db, "payment_settings", "processing_fee_enabled"))
    && (await checkoutFeeReady(db))
    && (await paymentFeeReady(db))
  );
}
