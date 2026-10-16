import { BANK_TRANSFER_FEE_LABEL } from "./bank-fee";
import { portalUrl } from "./hosts";
import { fixedTimeEqual } from "./payment-crypto";

/** Checkout pages expire after 30 minutes, which is Stripe's shortest allowed session. */
export const CHECKOUT_TTL_SECONDS = 30 * 60;

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const SECRET_KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{8,}$/;

export type StripeKeyMode = "test" | "live";

export type SignatureFailure = "missing signature" | "stale timestamp" | "signature mismatch" | "unreadable signature";

export function stripeSecretMode(secret: string): StripeKeyMode | null {
  const value = secret.trim();
  if (!SECRET_KEY.test(value)) return null;
  return value.includes("_test_") ? "test" : "live";
}

export function isWebhookSecret(secret: string): boolean {
  return WEBHOOK_SECRET.test(secret.trim());
}

export function secretLast4(secret: string): string {
  const value = secret.trim();
  return value.slice(-4);
}

export function isSecurePaymentRequest(requestUrl: string): boolean {
  const url = new URL(requestUrl);
  if (url.protocol === "https:") return true;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

export function checkoutUrls(
  requestUrl: string,
  association: { slug: string; vanity_slug?: string | null },
): { successUrl: string; cancelUrl: string } | null {
  if (!isSecurePaymentRequest(requestUrl)) return null;
  const successUrl = portalUrl(requestUrl, association, "/pay/success?session_id={CHECKOUT_SESSION_ID}");
  const cancelUrl = portalUrl(requestUrl, association, "/pay/cancel");
  const local = new URL(requestUrl).hostname === "localhost" || new URL(requestUrl).hostname === "127.0.0.1";
  if (!local && (!successUrl.startsWith("https://") || !cancelUrl.startsWith("https://"))) return null;
  return { successUrl, cancelUrl };
}

export function isStripeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
}

export async function stripeSignatureHex(secret: string, timestamp: number, payload: string): Promise<string> {
  return hmacHex(secret, signedMessage(timestamp, payload));
}

export async function verifyStripeSignature(input: {
  secret: string;
  header: string | null;
  payload: string | Uint8Array;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): Promise<{ ok: true } | { ok: false; reason: SignatureFailure }> {
  if (!input.header) return { ok: false, reason: "missing signature" };
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: "unreadable signature" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: "stale timestamp" };
  const expected = await hmacHex(input.secret, signedMessage(parsed.timestamp, input.payload));
  let match = false;
  for (const candidate of parsed.signatures) {
    const equal = await fixedTimeEqual(expected, candidate);
    match = match || equal;
  }
  if (!match) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

/** True when a Stripe event's livemode matches the saved secret key. A missing livemode does not match. */
export function livemodeMatchesKey(livemode: boolean | null, mode: StripeKeyMode | ""): boolean {
  if (livemode === null) return false;
  if (mode === "live") return livemode;
  if (mode === "test") return !livemode;
  return false;
}

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, message);
  return [...new Uint8Array(signed)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function signedMessage(timestamp: number, payload: string | Uint8Array): Uint8Array {
  if (typeof payload === "string") return new TextEncoder().encode(`${timestamp}.${payload}`);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + payload.length);
  message.set(prefix, 0);
  message.set(payload, prefix.length);
  return message;
}

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && /^[a-f0-9]{64}$/.test(value)) signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return null;
  const parsed = Number(timestamp);
  if (!Number.isSafeInteger(parsed)) return null;
  return { timestamp: parsed, signatures };
}

export type CheckoutLine = {
  name: string;
  amountCents: number;
};

export type CheckoutRequest = {
  secretKey: string;
  /** Invoice subtotal in cents. This line is the dues the association keeps. */
  amountCents: number;
  /** Bank transfer processing fee in cents. Sent as its own line item. Zero omits the line. */
  feeCents?: number;
  name: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  intentId: string;
  idempotencyKey: string;
  expiresAt: number;
  metadata: {
    neighborhoodId: string;
    lot: string;
    invoiceIds: string;
    userId: string;
  };
  fetchImpl?: typeof fetch;
};

export async function createCheckoutSession(
  input: CheckoutRequest,
): Promise<{ ok: true; id: string; url: string; clientReferenceId: string } | { ok: false; status: number }> {
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("payment_method_types[0]", "us_bank_account");
  body.set("payment_method_options[us_bank_account][verification_method]", "automatic");
  body.set("payment_method_options[us_bank_account][financial_connections][permissions][0]", "payment_method");
  body.set("success_url", input.successUrl);
  body.set("cancel_url", input.cancelUrl);
  body.set("customer_email", input.customerEmail);
  body.set("client_reference_id", input.intentId);
  body.set("expires_at", String(input.expiresAt));
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", "usd");
  body.set("line_items[0][price_data][unit_amount]", String(input.amountCents));
  body.set("line_items[0][price_data][product_data][name]", input.name.slice(0, 120));
  const feeCents = input.feeCents ?? 0;
  if (feeCents > 0) {
    body.set("line_items[1][quantity]", "1");
    body.set("line_items[1][price_data][currency]", "usd");
    body.set("line_items[1][price_data][unit_amount]", String(feeCents));
    body.set("line_items[1][price_data][product_data][name]", BANK_TRANSFER_FEE_LABEL);
  }
  const metadata: Record<string, string> = {
    neighborhood_id: input.metadata.neighborhoodId,
    lot: input.metadata.lot,
    invoice_ids: input.metadata.invoiceIds,
    user_id: input.metadata.userId,
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (!value) continue;
    body.set(`metadata[${key}]`, value.slice(0, 500));
    body.set(`payment_intent_data[metadata][${key}]`, value.slice(0, 500));
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: body.toString(),
  });
  if (!response.ok) return { ok: false, status: response.status };
  const parsed = (await response.json()) as { id?: unknown; url?: unknown; client_reference_id?: unknown };
  if (typeof parsed.id !== "string" || typeof parsed.url !== "string" || !isStripeCheckoutUrl(parsed.url)) {
    return { ok: false, status: response.status };
  }
  const clientReferenceId =
    typeof parsed.client_reference_id === "string" && parsed.client_reference_id ? parsed.client_reference_id : input.intentId;
  return { ok: true, id: parsed.id, url: parsed.url, clientReferenceId };
}

export type ParsedCheckoutEvent = {
  kind: "checkout";
  livemode: boolean | null;
  eventId: string;
  paid: boolean;
  sessionId: string;
  amountTotal: number;
  currency: string;
  paymentId: string;
  clientReferenceId: string;
  neighborhoodId: string;
  lot: string;
  invoiceIds: string;
  userId: string;
};

export type ParsedRefundEvent = {
  kind: "refund";
  livemode: boolean | null;
  eventId: string;
  paymentId: string;
  chargeId: string;
  amountRefunded: number;
  currency: string;
  neighborhoodId: string;
};

export type ParsedDisputeEvent = {
  kind: "dispute";
  livemode: boolean | null;
  eventId: string;
  action: "created" | "closed";
  disputeId: string;
  paymentId: string;
  amount: number;
  status: string;
  currency: string;
  neighborhoodId: string;
};

export type ParsedCheckoutProcessingEvent = {
  kind: "processing";
  livemode: boolean | null;
  eventId: string;
  sessionId: string;
  amountTotal: number;
  currency: string;
  clientReferenceId: string;
  neighborhoodId: string;
  invoiceIds: string;
  userId: string;
};

export type ParsedCheckoutFailedEvent = {
  kind: "checkout_failed";
  livemode: boolean | null;
  eventId: string;
  sessionId: string;
  amountTotal: number;
  currency: string;
  clientReferenceId: string;
  neighborhoodId: string;
  invoiceIds: string;
  userId: string;
};

export type ParsedStripeEvent =
  | { kind: "ignore" }
  | ParsedCheckoutEvent
  | ParsedCheckoutProcessingEvent
  | ParsedCheckoutFailedEvent
  | ParsedRefundEvent
  | ParsedDisputeEvent;

/** Reads only the fields we record. Bank account numbers and payment method details are ignored. */
export function parseStripeEvent(payload: string): ParsedStripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: unknown } };
  if (typeof event.id !== "string" || event.id.length < 4 || event.id.length > 255) return null;
  const livemode = typeof event.livemode === "boolean" ? event.livemode : null;
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    return parseCheckout(event.id, livemode, event.type, event.data?.object);
  }
  if (event.type === "checkout.session.async_payment_failed") {
    return parseCheckoutFailed(event.id, livemode, event.data?.object);
  }
  if (event.type === "charge.refunded") return parseRefund(event.id, livemode, event.data?.object);
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    return parseDispute(event.id, livemode, event.type === "charge.dispute.created" ? "created" : "closed", event.data?.object);
  }
  return { kind: "ignore" };
}

function parseCheckout(
  eventId: string,
  livemode: boolean | null,
  eventType: string,
  session: unknown,
): ParsedStripeEvent | null {
  const row = checkoutSessionFields(session);
  if (!row) return null;
  const metadata = metadataStrings(row.metadata);
  const shared = {
    livemode,
    eventId,
    sessionId: row.id,
    amountTotal: row.amountTotal,
    currency: "usd" as const,
    clientReferenceId: row.clientReferenceId,
    neighborhoodId: metadata.neighborhood_id || metadata.association_id,
    invoiceIds: metadata.invoice_ids,
    userId: metadata.user_id,
  };
  if (row.paymentStatus === "paid") {
    return {
      kind: "checkout",
      ...shared,
      paid: true,
      paymentId: paymentIntentId(row.paymentIntent) || row.id,
      lot: metadata.lot,
    };
  }
  // ACH stays unpaid on checkout.session.completed until the bank debit settles.
  if (row.paymentStatus === "unpaid" && eventType === "checkout.session.completed") {
    return { kind: "processing", ...shared };
  }
  return { kind: "ignore" };
}

function parseCheckoutFailed(eventId: string, livemode: boolean | null, session: unknown): ParsedStripeEvent | null {
  const row = checkoutSessionFields(session);
  if (!row) return null;
  const metadata = metadataStrings(row.metadata);
  return {
    kind: "checkout_failed",
    livemode,
    eventId,
    sessionId: row.id,
    amountTotal: row.amountTotal,
    currency: "usd",
    clientReferenceId: row.clientReferenceId,
    neighborhoodId: metadata.neighborhood_id || metadata.association_id,
    invoiceIds: metadata.invoice_ids,
    userId: metadata.user_id,
  };
}

function checkoutSessionFields(session: unknown): {
  id: string;
  paymentStatus: string;
  amountTotal: number;
  clientReferenceId: string;
  paymentIntent: unknown;
  metadata: unknown;
} | null {
  if (!session || typeof session !== "object") return null;
  const row = session as {
    id?: unknown;
    payment_status?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    payment_intent?: unknown;
    client_reference_id?: unknown;
    metadata?: unknown;
  };
  if (typeof row.id !== "string" || !row.id.startsWith("cs_")) return null;
  if (typeof row.amount_total !== "number" || !Number.isSafeInteger(row.amount_total) || row.amount_total <= 0) return null;
  if (row.currency !== "usd") return null;
  if (typeof row.client_reference_id !== "string" || !row.client_reference_id) return null;
  return {
    id: row.id,
    paymentStatus: typeof row.payment_status === "string" ? row.payment_status : "",
    amountTotal: row.amount_total,
    clientReferenceId: row.client_reference_id,
    paymentIntent: row.payment_intent,
    metadata: row.metadata,
  };
}

function parseRefund(eventId: string, livemode: boolean | null, charge: unknown): ParsedStripeEvent | null {
  if (!charge || typeof charge !== "object") return null;
  const row = charge as {
    id?: unknown;
    amount_refunded?: unknown;
    currency?: unknown;
    payment_intent?: unknown;
    metadata?: unknown;
  };
  if (typeof row.id !== "string" || !row.id.startsWith("ch_")) return null;
  if (typeof row.amount_refunded !== "number" || !Number.isSafeInteger(row.amount_refunded) || row.amount_refunded < 0) return null;
  if (row.currency !== "usd") return null;
  const metadata = metadataStrings(row.metadata);
  return {
    kind: "refund",
    livemode,
    eventId,
    paymentId: paymentIntentId(row.payment_intent),
    chargeId: row.id,
    amountRefunded: row.amount_refunded,
    currency: "usd",
    neighborhoodId: metadata.neighborhood_id || metadata.association_id,
  };
}

function parseDispute(
  eventId: string,
  livemode: boolean | null,
  action: "created" | "closed",
  dispute: unknown,
): ParsedStripeEvent | null {
  if (!dispute || typeof dispute !== "object") return null;
  const row = dispute as {
    id?: unknown;
    amount?: unknown;
    currency?: unknown;
    status?: unknown;
    payment_intent?: unknown;
    metadata?: unknown;
  };
  if (typeof row.id !== "string" || !row.id.startsWith("dp_")) return null;
  if (typeof row.amount !== "number" || !Number.isSafeInteger(row.amount) || row.amount <= 0) return null;
  if (row.currency !== "usd") return null;
  if (typeof row.status !== "string" || !row.status) return null;
  const metadata = metadataStrings(row.metadata);
  return {
    kind: "dispute",
    livemode,
    eventId,
    action,
    disputeId: row.id,
    paymentId: paymentIntentId(row.payment_intent),
    amount: row.amount,
    status: row.status,
    currency: "usd",
    neighborhoodId: metadata.neighborhood_id || metadata.association_id,
  };
}

function paymentIntentId(value: unknown): string {
  if (typeof value === "string" && value.startsWith("pi_")) return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.startsWith("pi_")) return id;
  }
  return "";
}

function metadataStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

/** Drops Stripe key material if it ever reaches a log line. */
export function redactSecrets(value: string): string {
  return value
    .replace(/sk_(test|live)_[A-Za-z0-9]+/g, "sk_$1_[redacted]")
    .replace(/rk_(test|live)_[A-Za-z0-9]+/g, "rk_$1_[redacted]")
    .replace(/whsec_[A-Za-z0-9+/=]+/g, "whsec_[redacted]");
}
