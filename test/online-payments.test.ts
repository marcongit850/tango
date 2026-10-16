import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { decryptPaymentSecret, encryptPaymentSecret, paymentKeyRing } from "../src/lib/payment-crypto";
import { checkoutUrls, stripeSignatureHex, verifyStripeSignature } from "../src/lib/stripe";
import { sha256Hex } from "../src/lib/tokens";

class SqliteStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.sqlite, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...(this.params as (string | number | null | bigint)[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const rows = this.sqlite.prepare(this.sql).all(...(this.params as (string | number | null | bigint)[]));
    return { results: rows as T[] };
  }

  async run(): Promise<{ meta: { changes: number }; results: [] }> {
    const info = this.sqlite.prepare(this.sql).run(...(this.params as (string | number | null | bigint)[]));
    return { meta: { changes: Number(info.changes) }, results: [] };
  }
}

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.sqlite, query);
  }

  async batch(statements: SqliteStatement[]): Promise<{ meta: { changes: number } }[]> {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const MIGRATIONS = [
  "migrations/0001_schema.sql",
  "migrations/0002_seed_tango_mar.sql",
  "migrations/0003_join_requests.sql",
  "migrations/0004_join_request_approved.sql",
  "migrations/0005_admin_improvements.sql",
  "migrations/0006_notice_attachments.sql",
  "migrations/0007_message_reviewed.sql",
  "migrations/0008_document_folders.sql",
  "migrations/0009_master_admin.sql",
  "migrations/0010_document_date.sql",
  "migrations/0011_lot_details.sql",
  "migrations/0012_message_attachments.sql",
  "migrations/0013_co_owner_request.sql",
  "migrations/0014_email_preferences.sql",
  "migrations/0015_rename_display_name.sql",
  "migrations/0016_seed_seaside_demo.sql",
  "migrations/0017_neighborhood_codes.sql",
  "migrations/0018_fee_schedule.sql",
  "migrations/0019_online_payments.sql",
  "migrations/0020_payment_controls.sql",
  "migrations/0021_test_payments.sql",
  "migrations/0022_bank_transfer_fee.sql",
  "migrations/0024_invoice_emails.sql",
];

const SECRET_KEY = "sk_test_5123456789abcdef";
const WEBHOOK_SECRET = "whsec_testsigningsecretvalue";

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function encryptionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function portalEnv(db: D1Database, key: string): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {
      get() {
        throw new Error("payments touched R2");
      },
      put() {
        throw new Error("payments touched R2");
      },
      delete() {
        throw new Error("payments touched R2");
      },
    },
    RESEND_API_KEY: "re_test",
    PAYMENT_ENCRYPTION_KEY: key,
  } as unknown as Env;
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-16T00:00:00.000Z");
  return token;
}

function formRequest(path: string, token: string, fields: Record<string, string | string[]>): Request {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.set(key, value);
  }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Cookie: `tango_session=${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((sqlite.prepare(sql).get(...params) as { n: number }).n);
}

describe("stripe signature", () => {
  it("matches an independent HMAC and rejects a bad or stale signature", async () => {
    const payload = '{"id":"evt_test_webhook","object":"event"}';
    const secret = "whsec_test_secret";
    const timestamp = 1_492_774_577;
    const expected = "88a022085c6bdb887b02cb26ff76dd681234d9675c0f22844059f55552a8883a";
    expect(await stripeSignatureHex(secret, timestamp, payload)).toBe(expected);
    const header = `t=${timestamp},v1=${expected}`;
    expect(await verifyStripeSignature({ secret, header, payload, nowSeconds: timestamp })).toEqual({ ok: true });
    expect(
      await verifyStripeSignature({
        secret,
        header: `t=${timestamp},v1=${"ab".repeat(32)}`,
        payload,
        nowSeconds: timestamp,
      }),
    ).toEqual({ ok: false, reason: "signature mismatch" });
    expect(await verifyStripeSignature({ secret, header, payload, nowSeconds: timestamp + 600 })).toEqual({
      ok: false,
      reason: "stale timestamp",
    });
    expect(await verifyStripeSignature({ secret, header: null, payload, nowSeconds: timestamp })).toEqual({
      ok: false,
      reason: "missing signature",
    });
  });

  it("builds https return urls and refuses an insecure public request", () => {
    const association = { slug: "tango-mar", vanity_slug: "tangomar" };
    expect(checkoutUrls("http://myhoadashboard.com/tangomar/pay", association)).toBeNull();
    expect(checkoutUrls("https://myhoadashboard.com/tangomar/pay", association)).toEqual({
      successUrl: "https://myhoadashboard.com/tangomar/pay/success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://myhoadashboard.com/tangomar/pay/cancel",
    });
  });

  it("encrypts a stripe key so the stored value is not the key and is bound to the neighborhood", async () => {
    const material = encryptionKey();
    const ring = paymentKeyRing({ PAYMENT_ENCRYPTION_KEY: material } as unknown as Env);
    expect(ring?.currentKid).toBe("1");
    const stored = await encryptPaymentSecret(ring!, "assoc_tango_mar", "secret_key", SECRET_KEY);
    expect(stored).not.toContain(SECRET_KEY);
    expect(stored.startsWith("v2.1.")).toBe(true);
    expect(await decryptPaymentSecret(ring!, "assoc_tango_mar", "secret_key", stored)).toBe(SECRET_KEY);
    await expect(decryptPaymentSecret(ring!, "assoc_other", "secret_key", stored)).rejects.toThrow();
    await expect(decryptPaymentSecret(ring!, "assoc_tango_mar", "webhook_secret", stored)).rejects.toThrow();
    const other = paymentKeyRing({ PAYMENT_ENCRYPTION_KEY: encryptionKey() } as unknown as Env);
    await expect(decryptPaymentSecret(other!, "assoc_tango_mar", "secret_key", stored)).rejects.toThrow();
  });
});

describe("online payments", () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let jordan: string;
  let casey: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    env = portalEnv(opened.db, encryptionKey());
    jordan = await signIn(sqlite, "user_jordan");
    casey = await signIn(sqlite, "user_casey");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, '', ?)")
      .run("user_board_view", "board.view@example.com", "Board View", "2026-10-16T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at) VALUES (?, 'assoc_tango_mar', 'user_board_view', 'board', 'active', 0, ?)",
      )
      .run("mem_board_view", "2026-10-16T00:00:00.000Z");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("hides keys, restricts settings to admins, and records one idempotent stripe payment", async () => {
    const app = createApp();
    const before = await app.request("http://localhost/a/tango-mar/dashboard", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(await before.text()).not.toContain("Pay now");

    const denied = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(denied.status).toBe(403);
    const boardToken = await signIn(sqlite, "user_board_view");
    const boardDenied = await app.request(
      "http://localhost/a/tango-mar/admin/payment-settings",
      { headers: { Cookie: `tango_session=${boardToken}` } },
      env,
    );
    expect(boardDenied.status).toBe(403);

    const saveSecret = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: SECRET_KEY }),
      {},
      env,
    );
    expect(saveSecret.status).toBe(303);
    const saveWebhook = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }),
      {},
      env,
    );
    expect(saveWebhook.status).toBe(303);
    const enabled = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }),
      {},
      env,
    );
    expect(enabled.status).toBe(303);

    const settings = await app.request(
      "http://localhost/a/tango-mar/admin/payment-settings",
      { headers: { Cookie: `tango_session=${jordan}` } },
      env,
    );
    const settingsHtml = await settings.text();
    expect(settingsHtml).toContain("Payments: test mode.");
    expect(settingsHtml).toContain("Set, ending in cdef.");
    expect(settingsHtml).toContain("Test mode.");
    expect(settingsHtml).toContain("Set, ending in alue.");
    expect(settingsHtml).toContain(">Replace<");
    expect(settingsHtml).toContain("https://myhoadashboard.com/tangomar/webhooks/stripe");
    expect(settingsHtml).not.toContain(SECRET_KEY);
    expect(settingsHtml).not.toContain(WEBHOOK_SECRET);
    expect(settingsHtml).not.toContain("\u2014");
    expect(settingsHtml).not.toContain("\u2013");

    const stored = sqlite.prepare("SELECT secret_key_ciphertext, webhook_secret_ciphertext FROM payment_settings").get() as {
      secret_key_ciphertext: string;
      webhook_secret_ciphertext: string;
    };
    expect(stored.secret_key_ciphertext).not.toContain(SECRET_KEY);
    expect(stored.webhook_secret_ciphertext).not.toContain(WEBHOOK_SECRET);
    const audits = sqlite
      .prepare("SELECT action, detail FROM audit_log WHERE association_id = 'assoc_tango_mar' AND action LIKE 'payment_settings%'")
      .all() as { action: string; detail: string }[];
    expect(audits.map((row) => row.action)).toEqual([
      "payment_settings_secret_set",
      "payment_settings_webhook_set",
      "payment_settings_enabled",
    ]);
    for (const row of audits) {
      expect(row.detail).not.toContain(SECRET_KEY);
      expect(row.detail).not.toContain(WEBHOOK_SECRET);
    }

    const ownerDash = await app.request("http://localhost/a/tango-mar/dashboard", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(ownerDash.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://checkout.stripe.com");
    expect(await ownerDash.text()).not.toContain("Pay now");
    const ownerPay = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(ownerPay.status).toBe(303);
    expect(ownerPay.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");

    sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_casey'").run();
    const adminDash = await app.request("http://localhost/a/tango-mar/dashboard", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(await adminDash.text()).toContain("Pay now");

    const nowIso = new Date().toISOString();
    const laterIso = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    for (let index = 0; index < 10; index += 1) {
      sqlite
        .prepare(
          `INSERT INTO checkout_intents (
             id, association_id, user_id, amount_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at
           ) VALUES (?, 'assoc_tango_mar', 'user_casey', 1, ?, '1', '', ?, ?)`,
        )
        .run(
          `intent_limit_${index}`,
          JSON.stringify([{ invoiceId: `other_${index}`, propertyId: "prop_x", lotNumber: "1", invoiceNumber: "n", amountCents: 1 }]),
          laterIso,
          nowIso,
        );
    }
    const limited = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(limited.status).toBe(303);
    expect(limited.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");
    sqlite.prepare("DELETE FROM checkout_intents").run();

    let stripeBody = "";
    let stripeAuth = "";
    const idempotencyKeys: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.stripe.com")) {
        stripeBody = String(init?.body ?? "");
        stripeAuth = new Headers(init?.headers).get("Authorization") ?? "";
        idempotencyKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      }
      return new Response(JSON.stringify({ id: "cs_test_session", url: "https://checkout.stripe.com/c/pay/cs_test_session" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const pay = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }),
      {},
      env,
    );
    expect(pay.status).toBe(303);
    expect(pay.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_test_session");
    expect(await pay.text()).not.toContain(SECRET_KEY);
    expect(stripeBody).toContain("metadata%5Bneighborhood_id%5D=assoc_tango_mar");
    expect(stripeBody).toContain("metadata%5Blot%5D=27");
    expect(stripeBody).toContain("invoice_casey_open");
    expect(stripeBody).toContain("unit_amount%5D=40050");
    expect(stripeBody).toContain("unit_amount%5D=323");
    expect(stripeBody).toContain("payment_method_types%5B0%5D=us_bank_account");
    expect(stripeBody).toContain("verification_method%5D=automatic");
    expect(stripeBody).toContain("financial_connections%5D%5Bpermissions%5D%5B0%5D=payment_method");
    expect(stripeBody).toContain("Bank+transfer+processing+fee");
    expect(stripeBody).not.toContain("payment_method_types%5B0%5D=card");
    expect(stripeBody).not.toContain("card%5Bnumber%5D");
    expect(stripeBody).not.toContain(SECRET_KEY);
    expect(stripeAuth).toBe(`Bearer ${SECRET_KEY}`);
    const payAgain = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(payAgain.status).toBe(303);
    expect(payAgain.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_test_session");
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM checkout_intents")).toBe(1);

    const intent = sqlite.prepare("SELECT id, amount_cents, expires_at, stripe_session_id FROM checkout_intents").get() as {
      id: string;
      amount_cents: number;
      expires_at: string;
    };
    expect(intent.amount_cents).toBe(40050);
    expect((sqlite.prepare("SELECT fee_cents, status FROM checkout_intents").get() as { fee_cents: number; status: string }).fee_cents).toBe(323);
    expect(Date.parse(intent.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 5_000);

    const payload = JSON.stringify({
      id: "evt_test_paid",
      livemode: false,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          object: "checkout.session",
          payment_status: "paid",
          amount_total: 40373,
          currency: "usd",
          payment_intent: "pi_test_recorded",
          client_reference_id: intent.id,
          metadata: {
            neighborhood_id: "assoc_tango_mar",
            lot: "27",
            invoice_ids: "invoice_casey_open",
            user_id: "user_casey",
            card: { number: "4242424242424242" },
          },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, payload);
    const postWebhook = (body: string, header: string) =>
      app.request(
        "http://localhost/a/tango-mar/webhooks/stripe",
        { method: "POST", headers: { "Stripe-Signature": header, "Content-Type": "application/json" }, body },
        env,
      );

    const recorded = await postWebhook(payload, `t=${timestamp},v1=${signature}`);
    expect(recorded.status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);
    const payment = sqlite.prepare("SELECT reference, notes, amount_cents FROM payments WHERE method = 'stripe'").get() as {
      reference: string;
      notes: string;
      amount_cents: number;
    };
    expect(payment).toMatchObject({ reference: "pi_test_recorded", notes: "Test payment, not applied", amount_cents: 40050 });
    expect((sqlite.prepare("SELECT fee_cents FROM payments WHERE method = 'stripe'").get() as { fee_cents: number }).fee_cents).toBe(323);
    expect((sqlite.prepare("SELECT status FROM checkout_intents").get() as { status: string }).status).toBe("succeeded");
    expect((sqlite.prepare("SELECT is_test FROM payments WHERE method = 'stripe'").get() as { is_test: number }).is_test).toBe(1);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
    const activity = sqlite
      .prepare("SELECT detail FROM audit_log WHERE action = 'payment_record' ORDER BY created_at DESC LIMIT 1")
      .get() as { detail: string };
    expect(activity.detail).toContain("pi_test_recorded");
    expect(activity.detail).toContain("Test payment, not applied");
    expect(activity.detail).not.toContain("4242424242424242");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE title = 'Payment receipt'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE title = 'Test payment, not applied'")).toBeGreaterThan(0);
    const invoiceAdmin = await app.request(
      "http://localhost/a/tango-mar/admin/invoices/invoice_casey_open",
      { headers: { Cookie: `tango_session=${jordan}` } },
      env,
    );
    expect(await invoiceAdmin.text()).toContain("Test payment, not applied");

    const again = await postWebhook(payload, `t=${timestamp},v1=${signature}`);
    expect(again.status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);

    const replay = JSON.stringify({
      id: "evt_test_paid_replay",
      livemode: false,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          payment_status: "paid",
          amount_total: 40373,
          currency: "usd",
          payment_intent: "pi_test_recorded",
          client_reference_id: intent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", lot: "27", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    const replaySignature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, replay);
    const replayed = await postWebhook(replay, `t=${timestamp},v1=${replaySignature}`);
    expect(replayed.status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);

    const bad = await postWebhook(payload, `t=${timestamp},v1=${"ab".repeat(32)}`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(WEBHOOK_SECRET);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);
    const rejected = sqlite
      .prepare("SELECT detail FROM audit_log WHERE action = 'payment_webhook_rejected' ORDER BY created_at DESC LIMIT 1")
      .get() as { detail: string };
    expect(rejected.detail).toContain("signature mismatch");
    expect(rejected.detail).not.toContain(WEBHOOK_SECRET);
    expect(rejected.detail).not.toContain(SECRET_KEY);
    const flooded = await postWebhook(payload, `t=${timestamp},v1=${"cd".repeat(32)}`);
    expect(flooded.status).toBe(400);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_webhook_rejected'")).toBe(1);

    const liveMode = JSON.stringify({
      id: "evt_live_mismatch",
      livemode: true,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          payment_status: "paid",
          amount_total: 40373,
          currency: "usd",
          payment_intent: "pi_live_should_not_post",
          client_reference_id: intent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    const liveSignature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, liveMode);
    const ignored = await postWebhook(liveMode, `t=${timestamp},v1=${liveSignature}`);
    expect(ignored.status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_livemode_mismatch'")).toBe(1);

    const opened = JSON.stringify({
      id: "evt_dispute_open",
      livemode: false,
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_test_open",
          amount: 40050,
          currency: "usd",
          status: "needs_response",
          payment_intent: "pi_test_recorded",
        },
      },
    });
    const openSignature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, opened);
    expect((await postWebhook(opened, `t=${timestamp},v1=${openSignature}`)).status).toBe(200);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payment_reversals")).toBe(0);

    const closed = JSON.stringify({
      id: "evt_dispute_won",
      livemode: false,
      type: "charge.dispute.closed",
      data: {
        object: {
          id: "dp_test_open",
          amount: 40050,
          currency: "usd",
          status: "won",
          payment_intent: "pi_test_recorded",
        },
      },
    });
    const closedSignature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, closed);
    expect((await postWebhook(closed, `t=${timestamp},v1=${closedSignature}`)).status).toBe(200);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payment_reversals")).toBe(0);

    const refund = JSON.stringify({
      id: "evt_refund",
      livemode: false,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_test_refund",
          amount_refunded: 40050,
          currency: "usd",
          payment_intent: "pi_test_recorded",
        },
      },
    });
    const refundSignature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, refund);
    expect((await postWebhook(refund, `t=${timestamp},v1=${refundSignature}`)).status).toBe(200);
    expect((await postWebhook(refund, `t=${timestamp},v1=${refundSignature}`)).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payment_reversals")).toBe(0);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");

    const hand = await app.request(
      formRequest("/a/tango-mar/admin/payments", jordan, {
        property_id: "prop_27",
        amount: "10.00",
        method: "stripe",
        paid_on: "2026-10-16",
      }),
      {},
      env,
    );
    expect(hand.status).toBe(303);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);

    expect(() => sqlite.exec("DELETE FROM audit_log")).toThrow();
    expect(() => sqlite.exec("UPDATE audit_log SET detail = 'changed'")).toThrow();
    sqlite.exec("UPDATE audit_log SET actor_user_id = NULL WHERE action = 'payment_record'");
  });

  it("charges only the invoices the owner checked, and keeps a long list on the server", async () => {
    const app = createApp();
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: SECRET_KEY }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_casey'").run();

    const chooser = await app.request("http://localhost/a/tango-mar/pay", { headers: { Cookie: `tango_session=${casey}` } }, env);
    const chooserHtml = await chooser.text();
    expect(chooserHtml).toContain("Choose invoices");
    expect(chooserHtml).toContain('value="invoice_casey_open"');
    expect(chooserHtml).toContain('value="invoice_casey_2026"');
    expect(chooserHtml).toContain("checked");
    expect(chooserHtml).toContain("$1,600.50");
    expect(chooserHtml).toContain("Bank transfer processing fee");
    expect(chooserHtml).toContain("$5.00");
    expect(chooserHtml).toContain("$1,605.50");
    expect(chooserHtml).toContain("About 0.8%, at most $5.00.");
    expect(chooserHtml).toContain('name="fee_cents" value="500"');
    expect(chooserHtml).toContain("This fee covers bank transfer processing. To avoid it, mail a check to the association.");

    const none = await app.request(formRequest("/a/tango-mar/pay", casey, {}), {}, env);
    expect(none.status).toBe(303);
    expect(none.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");

    const foreign = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_not_casey", amount: "1.00" }), {}, env);
    expect(foreign.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");

    let stripeBody = "";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.stripe.com")) stripeBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "cs_one_invoice", url: "https://checkout.stripe.com/c/pay/cs_one_invoice" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const one = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_2026", amount: "1.00", fee_cents: "500" }),
      {},
      env,
    );
    expect(one.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_one_invoice");
    expect(stripeBody).toContain("unit_amount%5D=120000");
    expect(stripeBody).toContain("unit_amount%5D=500");
    expect(stripeBody).not.toContain("unit_amount%5D=100");
    expect(stripeBody).toContain("invoice_casey_2026");
    const storedOne = sqlite.prepare("SELECT allocation_json FROM checkout_intents WHERE stripe_session_id = 'cs_one_invoice'").get() as {
      allocation_json: string;
    };
    expect(storedOne.allocation_json).toContain("invoice_casey_2026");
    expect(storedOne.allocation_json).not.toContain("invoice_casey_open");

    const ids = Array.from({ length: 20 }, (_, index) => `invoice_bulk_selection_item_${String(index).padStart(2, "0")}`);
    const insert = sqlite.prepare(
      `INSERT INTO invoices (
         id, association_id, property_id, assessment_id, invoice_number, description,
         amount_cents, late_fee_cents, issued_on, due_on, status, created_at
       ) VALUES (?, 'assoc_tango_mar', 'prop_27', NULL, ?, 'Bulk invoice', 100, 0, '2026-01-15', '2026-01-15', 'open', '2026-01-15T00:00:00.000Z')`,
    );
    for (const id of ids) insert.run(id, id);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.stripe.com")) stripeBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "cs_bulk", url: "https://checkout.stripe.com/c/pay/cs_bulk" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const bulk = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: ids, fee_cents: "17" }), {}, env);
    expect(bulk.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_bulk");
    expect(stripeBody).not.toContain("invoice_ids");
    expect(stripeBody).not.toContain(ids[0]);
    expect(stripeBody).toContain("unit_amount%5D=2000");
    expect(stripeBody).toContain("unit_amount%5D=17");
    const storedBulk = sqlite.prepare("SELECT id, allocation_json FROM checkout_intents WHERE stripe_session_id = 'cs_bulk'").get() as {
      id: string;
      allocation_json: string;
    };
    for (const id of ids) expect(storedBulk.allocation_json).toContain(id);

    const payload = JSON.stringify({
      id: "evt_bulk",
      livemode: false,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_bulk",
          payment_status: "paid",
          amount_total: 2017,
          currency: "usd",
          payment_intent: "pi_bulk",
          client_reference_id: storedBulk.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "", user_id: "user_casey" },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, payload);
    const recorded = await app.request(
      "http://localhost/a/tango-mar/webhooks/stripe",
      { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}`, "Content-Type": "application/json" }, body: payload },
      env,
    );
    expect(recorded.status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE reference = 'pi_bulk'")).toBe(20);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE reference = 'pi_bulk' AND is_test = 1")).toBe(20);
    expect(count(sqlite, "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE reference = 'pi_bulk'")).toBe(2000);
    expect(count(sqlite, "SELECT COALESCE(SUM(fee_cents), 0) AS n FROM payments WHERE reference = 'pi_bulk'")).toBe(17);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE id LIKE 'invoice_bulk_selection_item_%' AND status = 'open'")).toBe(20);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_needs_review' AND detail LIKE '%pi_bulk%'")).toBe(0);

    const mismatch = JSON.stringify({
      id: "evt_bulk_mismatch",
      livemode: false,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_bulk",
          payment_status: "paid",
          amount_total: 2017,
          currency: "usd",
          payment_intent: "pi_bulk_mismatch",
          client_reference_id: storedBulk.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    const mismatchSignature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, mismatch);
    expect(
      (
        await app.request(
          "http://localhost/a/tango-mar/webhooks/stripe",
          {
            method: "POST",
            headers: { "Stripe-Signature": `t=${timestamp},v1=${mismatchSignature}`, "Content-Type": "application/json" },
            body: mismatch,
          },
          env,
        )
      ).status,
    ).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE reference = 'pi_bulk_mismatch'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_needs_review'")).toBe(1);
  });

  it("applies a live payment and does not double-post a dispute", async () => {
    const app = createApp();
    const liveKey = "sk_live_5123456789abcdef";
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: liveKey }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_live", url: "https://checkout.stripe.com/c/pay/cs_live" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const pay = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(pay.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_live");
    const intent = sqlite.prepare("SELECT id FROM checkout_intents WHERE stripe_session_id = 'cs_live'").get() as { id: string };
    const timestamp = Math.floor(Date.now() / 1000);
    const post = async (body: string) => {
      const signature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, body);
      return app.request(
        "http://localhost/a/tango-mar/webhooks/stripe",
        { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}`, "Content-Type": "application/json" }, body },
        env,
      );
    };
    const paid = JSON.stringify({
      id: "evt_live_paid",
      livemode: true,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_live",
          payment_status: "paid",
          amount_total: 40373,
          currency: "usd",
          payment_intent: "pi_live_recorded",
          client_reference_id: intent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    expect((await post(paid)).status).toBe(200);
    expect((sqlite.prepare("SELECT is_test, notes FROM payments WHERE reference = 'pi_live_recorded'").get() as { is_test: number; notes: string })).toEqual({
      is_test: 0,
      notes: "Online (Stripe)",
    });
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("paid");

    const dispute = (id: string) =>
      JSON.stringify({
        id,
        livemode: true,
        type: "charge.dispute.created",
        data: { object: { id: "dp_live", amount: 40050, currency: "usd", status: "needs_response", payment_intent: "pi_live_recorded" } },
      });
    expect((await post(dispute("evt_dispute_1"))).status).toBe(200);
    expect((await post(dispute("evt_dispute_2"))).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payment_reversals WHERE stripe_object_id = 'dp_live'")).toBe(1);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");

    const won = JSON.stringify({
      id: "evt_dispute_won_live",
      livemode: true,
      type: "charge.dispute.closed",
      data: { object: { id: "dp_live", amount: 40050, currency: "usd", status: "won", payment_intent: "pi_live_recorded" } },
    });
    expect((await post(won)).status).toBe(200);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("paid");

    const refund = JSON.stringify({
      id: "evt_live_refund",
      livemode: true,
      type: "charge.refunded",
      data: { object: { id: "ch_live", amount_refunded: 40373, currency: "usd", payment_intent: "pi_live_recorded" } },
    });
    expect((await post(refund)).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payment_reversals WHERE kind = 'refund'")).toBe(1);
    expect(count(sqlite, "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payment_reversals WHERE kind = 'refund'")).toBe(40050);
    const refundAudit = sqlite.prepare("SELECT detail FROM audit_log WHERE action = 'payment_refund' ORDER BY created_at DESC LIMIT 1").get() as { detail: string };
    expect(refundAudit.detail).toContain("bank transfer processing fee");
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
  });

  it("shows the demo sample checkout without saving a payment", async () => {
    const app = createApp();
    const before = count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE association_id = 'assoc_seaside_demo'");
    const auditsBefore = count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE association_id = 'assoc_seaside_demo'");
    const enter = await app.request("http://localhost/demo", {}, env);
    const owner = await app.request("http://localhost/a/seaside-demo/dashboard", { headers: { Cookie: "tango_demo=owner" } }, env);
    const ownerHtml = await owner.text();
    expect(ownerHtml).toContain("Pay now");
    expect(ownerHtml).not.toContain("Pay full balance");
    expect(ownerHtml).toContain("Nothing here is real or saved");
    expect(ownerHtml).not.toContain(SECRET_KEY);

    const chooser = await app.request("http://localhost/a/seaside-demo/pay", { headers: { Cookie: "tango_demo=owner" } }, env);
    const chooserHtml = await chooser.text();
    expect(chooserHtml).toContain("Choose invoices");
    expect(chooserHtml).toContain("invoice_demo_riley");
    expect(chooserHtml).toContain('type="checkbox"');
    expect(chooserHtml).toContain("checked");
    expect(chooserHtml).toMatch(
      /<label class="pay-invoice"><input type="checkbox" name="invoice_id" value="invoice_demo_riley" data-cents="\d+" checked><span>Lot [^<]+<\/span><\/label>/,
    );
    expect(chooserHtml).toContain("label.pay-invoice { display: flex; flex-direction: row;");
    expect(chooserHtml).toContain("pay-select.js");
    expect(chooserHtml).toContain("Bank transfer processing fee");
    expect(chooserHtml).toContain("$2.42");
    expect(chooserHtml).toContain("$302.42");
    expect(chooserHtml).toContain("About 0.8%, at most $5.00.");
    expect(chooserHtml).toContain('name="fee_cents" value="242"');
    expect(chooserHtml).toContain("This fee covers bank transfer processing. To avoid it, mail a check to the association.");
    expect(chooserHtml).not.toContain("\u2014");
    expect(chooserHtml).not.toContain("\u2013");

    const checkout = await app.request("http://localhost/a/seaside-demo/pay/sample?invoice_id=invoice_demo_riley", { headers: { Cookie: "tango_demo=owner" } }, env);
    const checkoutHtml = await checkout.text();
    expect(checkoutHtml).toContain("Sample checkout");
    expect(checkoutHtml).toContain("Nothing is charged. Nothing here is real or saved.");
    expect(checkoutHtml).toContain("Bank transfer processing fee");
    expect(checkoutHtml).toContain("About 0.8%, at most $5.00.");
    expect(checkoutHtml).toContain("$2.42");
    expect(checkoutHtml).toContain("Complete sample payment");
    expect(checkoutHtml).not.toContain("checkout.stripe.com");
    expect(checkoutHtml).not.toContain("\u2014");

    const success = await app.request(
      "http://localhost/a/seaside-demo/pay/success?sample=1&invoice=invoice_demo_riley",
      { headers: { Cookie: "tango_demo=owner" } },
      env,
    );
    const successHtml = await success.text();
    expect(successHtml).toContain("Sample payment applied");
    expect(successHtml).toContain("Nothing here is real or saved.");
    expect(successHtml).toContain("Bank transfer processing fee");
    expect(successHtml).not.toContain("Processing, usually 4 business days");
    expect(successHtml).toContain("sample_pi_demo");
    expect(successHtml).toContain("Online (Stripe)");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE association_id = 'assoc_seaside_demo'")).toBe(before);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE association_id = 'assoc_seaside_demo'")).toBe(auditsBefore);

    const still = await app.request("http://localhost/a/seaside-demo/dashboard", { headers: { Cookie: "tango_demo=owner" } }, env);
    expect(await still.text()).toContain("$300.00");
    expect(enter.status).toBe(303);

    const settings = await app.request("http://localhost/a/seaside-demo/admin/payment-settings", { headers: { Cookie: "tango_demo=admin" } }, env);
    const settingsHtml = await settings.text();
    expect(settingsHtml).toContain("Bank transfer processing fee");
    expect(settingsHtml).toContain('name="fee_percent"');
    expect(settingsHtml).toContain('value="0.8"');
    expect(settingsHtml).toContain('name="fee_cap"');
    expect(settingsHtml).toContain('value="5.00"');
    expect(settingsHtml).toContain("Charge a bank transfer processing fee");
    expect(settingsHtml).toContain("checkout.session.async_payment_failed");
    expect(settingsHtml).not.toContain("\u2014");
    expect(settingsHtml).not.toContain("\u2013");
  });

  it("credits an ACH payment only after it succeeds, and a failure applies nothing", async () => {
    const app = createApp();
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: SECRET_KEY }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_casey'").run();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_ach", url: "https://checkout.stripe.com/c/pay/cs_ach" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const pay = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(pay.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_ach");
    const intent = sqlite.prepare("SELECT id FROM checkout_intents WHERE stripe_session_id = 'cs_ach'").get() as { id: string };
    const timestamp = Math.floor(Date.now() / 1000);
    const post = async (body: string) => {
      const signature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, body);
      return app.request(
        "http://localhost/a/tango-mar/webhooks/stripe",
        { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}`, "Content-Type": "application/json" }, body },
        env,
      );
    };
    const session = (type: string, id: string, paymentStatus: string, paymentIntent = "") =>
      JSON.stringify({
        id,
        livemode: false,
        type,
        data: {
          object: {
            id: "cs_ach",
            payment_status: paymentStatus,
            amount_total: 40373,
            currency: "usd",
            payment_intent: paymentIntent,
            client_reference_id: intent.id,
            metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
          },
        },
      });
    expect((await post(session("checkout.session.completed", "evt_ach_open", "unpaid"))).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(0);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
    expect((sqlite.prepare("SELECT status FROM checkout_intents WHERE id = ?").get(intent.id) as { status: string }).status).toBe("processing");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM stripe_event_receipts")).toBe(0);

    const history = await app.request("http://localhost/a/tango-mar/payments", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(await history.text()).toContain("Processing, usually 4 business days");
    const success = await app.request(
      `http://localhost/a/tango-mar/pay/success?session_id=cs_ach`,
      { headers: { Cookie: `tango_session=${casey}` } },
      env,
    );
    expect(await success.text()).toContain("Processing, usually 4 business days");

    const again = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(again.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");

    expect((await post(session("checkout.session.async_payment_failed", "evt_ach_fail", "unpaid"))).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(0);
    expect((sqlite.prepare("SELECT status FROM checkout_intents WHERE id = ?").get(intent.id) as { status: string }).status).toBe("failed");
    expect((await post(session("checkout.session.async_payment_failed", "evt_ach_fail", "unpaid"))).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_failed'")).toBe(1);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_ach_paid", url: "https://checkout.stripe.com/c/pay/cs_ach_paid" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const retry = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }), {}, env);
    expect(retry.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_ach_paid");
    const paidIntent = sqlite.prepare("SELECT id FROM checkout_intents WHERE stripe_session_id = 'cs_ach_paid'").get() as { id: string };
    const settled = JSON.stringify({
      id: "evt_ach_paid",
      livemode: false,
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_ach_paid",
          payment_status: "paid",
          amount_total: 40373,
          currency: "usd",
          payment_intent: "pi_ach_paid",
          client_reference_id: paidIntent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    expect((await post(settled)).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE reference = 'pi_ach_paid'")).toBe(1);
    expect(count(sqlite, "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE reference = 'pi_ach_paid'")).toBe(40050);
    expect(count(sqlite, "SELECT COALESCE(SUM(fee_cents), 0) AS n FROM payments WHERE reference = 'pi_ach_paid'")).toBe(323);
    const short = JSON.stringify({
      id: "evt_ach_short",
      livemode: false,
      type: "checkout.session.async_payment_succeeded",
      data: {
        object: {
          id: "cs_ach_paid",
          payment_status: "paid",
          amount_total: 40050,
          currency: "usd",
          payment_intent: "pi_ach_short",
          client_reference_id: paidIntent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    expect((await post(short)).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE reference = 'pi_ach_short'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_needs_review' AND detail LIKE '%amount%'")).toBe(1);

    const lateFail = JSON.stringify({
      id: "evt_ach_late_fail",
      livemode: false,
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          id: "cs_ach_paid",
          payment_status: "unpaid",
          amount_total: 40373,
          currency: "usd",
          client_reference_id: paidIntent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    expect((await post(lateFail)).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE reference = 'pi_ach_paid'")).toBe(1);
    expect((sqlite.prepare("SELECT status FROM checkout_intents WHERE id = ?").get(paidIntent.id) as { status: string }).status).toBe("succeeded");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_failed_after_success'")).toBe(1);
  });

  it("turns the bank transfer fee off and records the settings change", async () => {
    const app = createApp();
    const page = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${jordan}` } }, env);
    const html = await page.text();
    expect(html).toContain("value=\"0.8\"");
    expect(html).toContain("value=\"5.00\"");
    const unchanged = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/fee", jordan, { fee_enabled: "yes", fee_percent: "0.8", fee_cap: "5.00" }),
      {},
      env,
    );
    expect(unchanged.status).toBe(303);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_settings_fee'")).toBe(0);

    const saved = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/fee", jordan, { fee_percent: "0.8", fee_cap: "5.00" }),
      {},
      env,
    );
    expect(saved.status).toBe(303);
    const audit = sqlite.prepare("SELECT detail FROM audit_log WHERE action = 'payment_settings_fee'").get() as { detail: string };
    expect(audit.detail).toBe("Bank transfer processing fee changed from on, 0.8% capped at $5.00 to off, 0.8% capped at $5.00.");

    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: SECRET_KEY }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_casey'").run();
    let stripeBody = "";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.stripe.com")) stripeBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "cs_nofee", url: "https://checkout.stripe.com/c/pay/cs_nofee" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const pay = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "0" }),
      {},
      env,
    );
    expect(pay.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_nofee");
    expect(stripeBody).toContain("unit_amount%5D=40050");
    expect(stripeBody).not.toContain("Bank+transfer+processing+fee");
    expect((sqlite.prepare("SELECT amount_cents, fee_cents FROM checkout_intents WHERE stripe_session_id = 'cs_nofee'").get() as { amount_cents: number; fee_cents: number })).toEqual({
      amount_cents: 40050,
      fee_cents: 0,
    });
    const staleOff = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "1" }),
      {},
      env,
    );
    expect(staleOff.status).toBe(200);
    expect(await staleOff.text()).toContain("The bank transfer processing fee was updated. Review the new total, then pay again.");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM checkout_intents")).toBe(1);
  });

  it("refuses checkout when the displayed fee does not match the server", async () => {
    const app = createApp();
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: SECRET_KEY }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_casey'").run();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_match", url: "https://checkout.stripe.com/c/pay/cs_match" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const stale = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "1" }),
      {},
      env,
    );
    expect(stale.status).toBe(200);
    const html = await stale.text();
    expect(html).toContain("The bank transfer processing fee was updated. Review the new total, then pay again.");
    expect(html).toContain('name="fee_cents" value="323"');
    expect(html).toContain('value="invoice_casey_open" data-cents="40050" checked');
    expect(stale.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM checkout_intents")).toBe(0);
    const missing = await app.request(formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open" }), {}, env);
    expect(missing.status).toBe(200);
    const nonsense = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "99999" }),
      {},
      env,
    );
    expect(nonsense.status).toBe(200);
    const pay = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }),
      {},
      env,
    );
    expect(pay.status).toBe(303);
    expect(pay.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_match");
  });

  it("does not reverse invoice credit for a fee-only refund, and a full refund still does", async () => {
    const app = createApp();
    const liveKey = "sk_live_5123456789abcdef";
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: liveKey }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_fee_refund", url: "https://checkout.stripe.com/c/pay/cs_fee_refund" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const pay = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }),
      {},
      env,
    );
    expect(pay.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_fee_refund");
    const intent = sqlite.prepare("SELECT id FROM checkout_intents WHERE stripe_session_id = 'cs_fee_refund'").get() as { id: string };
    const timestamp = Math.floor(Date.now() / 1000);
    const post = async (body: string) => {
      const signature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, body);
      return app.request(
        "http://localhost/a/tango-mar/webhooks/stripe",
        { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}`, "Content-Type": "application/json" }, body },
        env,
      );
    };
    const paid = JSON.stringify({
      id: "evt_fee_refund_paid",
      livemode: true,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_fee_refund",
          payment_status: "paid",
          amount_total: 40373,
          currency: "usd",
          payment_intent: "pi_fee_refund",
          client_reference_id: intent.id,
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    expect((await post(paid)).status).toBe(200);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("paid");
    const feeOnly = JSON.stringify({
      id: "evt_fee_only_refund",
      livemode: true,
      type: "charge.refunded",
      data: { object: { id: "ch_fee_only", amount_refunded: 323, currency: "usd", payment_intent: "pi_fee_refund" } },
    });
    expect((await post(feeOnly)).status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payment_reversals WHERE kind = 'refund'")).toBe(0);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("paid");
    const feeAudit = sqlite.prepare("SELECT detail FROM audit_log WHERE action = 'payment_refund' ORDER BY created_at DESC LIMIT 1").get() as { detail: string };
    expect(feeAudit.detail).toContain("Fee-only refund was not applied to the invoice.");
    expect(feeAudit.detail).not.toContain("already");
    const full = JSON.stringify({
      id: "evt_fee_full_refund",
      livemode: true,
      type: "charge.refunded",
      data: { object: { id: "ch_fee_full", amount_refunded: 40373, currency: "usd", payment_intent: "pi_fee_refund" } },
    });
    expect((await post(full)).status).toBe(200);
    expect(count(sqlite, "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payment_reversals WHERE kind = 'refund'")).toBe(40050);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
  });

  it("ignores a processing transfer older than 14 days and lets the board clear a stuck one without crediting", async () => {
    const app = createApp();
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/secret", jordan, { secret_key: SECRET_KEY }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/webhook", jordan, { webhook_secret: WEBHOOK_SECRET }), {}, env);
    await app.request(formRequest("/a/tango-mar/admin/payment-settings/enabled", jordan, { enabled: "yes" }), {}, env);
    sqlite.prepare("UPDATE memberships SET is_admin = 1 WHERE user_id = 'user_casey'").run();
    const oldCreated = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const allocation = JSON.stringify([
      { invoiceId: "invoice_casey_open", propertyId: "prop_27", lotNumber: "27", invoiceNumber: "OPEN-27", amountCents: 40050 },
    ]);
    sqlite
      .prepare(
        `INSERT INTO checkout_intents (
           id, association_id, user_id, amount_cents, fee_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at, status
         ) VALUES ('intent_old', 'assoc_tango_mar', 'user_casey', 40050, 323, ?, '27', 'cs_old', ?, ?, 'processing')`,
      )
      .run(allocation, oldCreated, oldCreated);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_after_old", url: "https://checkout.stripe.com/c/pay/cs_after_old" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const afterOld = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }),
      {},
      env,
    );
    expect(afterOld.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_after_old");
    const nowIso = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO checkout_intents (
           id, association_id, user_id, amount_cents, fee_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at, status
         ) VALUES ('intent_stuck', 'assoc_tango_mar', 'user_casey', 40050, 323, ?, '27', 'cs_stuck', ?, ?, 'processing')`,
      )
      .run(allocation, nowIso, nowIso);
    const blocked = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }),
      {},
      env,
    );
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("Location") ?? "").not.toContain("checkout.stripe.com");
    const before = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${jordan}` } }, env);
    const beforeHtml = await before.text();
    expect(beforeHtml).toContain("Clear stuck transfer");
    expect(beforeHtml).toContain("/processing/intent_stuck/abandon");
    const paymentsBefore = count(sqlite, "SELECT COUNT(*) AS n FROM payments");
    const cleared = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/processing/intent_stuck/abandon", jordan, {}),
      {},
      env,
    );
    expect(cleared.status).toBe(303);
    expect((sqlite.prepare("SELECT status FROM checkout_intents WHERE id = 'intent_stuck'").get() as { status: string }).status).toBe("abandoned");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments")).toBe(paymentsBefore);
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("open");
    const audit = sqlite.prepare("SELECT action, detail FROM audit_log WHERE action = 'payment_processing_abandoned'").get() as { action: string; detail: string };
    expect(audit.action).toBe("payment_processing_abandoned");
    expect(audit.detail).toContain("Nothing was applied to an invoice.");
    const after = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${jordan}` } }, env);
    expect(await after.text()).not.toContain("/processing/intent_stuck/abandon");
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ id: "cs_after_clear", url: "https://checkout.stripe.com/c/pay/cs_after_clear" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const again = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open", fee_cents: "323" }),
      {},
      env,
    );
    expect(again.headers.get("Location")).toBe("https://checkout.stripe.com/c/pay/cs_after_clear");
    const timestamp = Math.floor(Date.now() / 1000);
    const processing = JSON.stringify({
      id: "evt_abandoned_processing",
      livemode: false,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_stuck",
          payment_status: "unpaid",
          amount_total: 40373,
          currency: "usd",
          client_reference_id: "intent_stuck",
          metadata: { neighborhood_id: "assoc_tango_mar", invoice_ids: "invoice_casey_open", user_id: "user_casey" },
        },
      },
    });
    const signature = await stripeSignatureHex(WEBHOOK_SECRET, timestamp, processing);
    expect(
      (
        await app.request(
          "http://localhost/a/tango-mar/webhooks/stripe",
          { method: "POST", headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}`, "Content-Type": "application/json" }, body: processing },
          env,
        )
      ).status,
    ).toBe(200);
    expect((sqlite.prepare("SELECT status FROM checkout_intents WHERE id = 'intent_stuck'").get() as { status: string }).status).toBe("abandoned");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments")).toBe(paymentsBefore);
  });

  it("stores the bank transfer fee only inside the migration limits", () => {
    expect(() =>
      sqlite
        .prepare("INSERT INTO payment_settings (association_id, updated_at, processing_fee_bps) VALUES ('assoc_tango_mar', '', 1001)")
        .run(),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare("INSERT INTO payment_settings (association_id, updated_at, processing_fee_cap_cents) VALUES ('assoc_tango_mar', '', 2501)")
        .run(),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO checkout_intents (
             id, association_id, user_id, amount_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at, status
           ) VALUES ('bad_status', 'assoc_tango_mar', 'user_casey', 1, '[]', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'nope')`,
        )
        .run(),
    ).toThrow();
  });
});
