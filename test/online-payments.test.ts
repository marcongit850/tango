import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { decryptPaymentSecret, encryptPaymentSecret } from "../src/lib/payment-crypto";
import { checkoutAmountCents, checkoutUrls, stripeSignatureHex, verifyStripeSignature } from "../src/lib/stripe";
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

function formRequest(path: string, token: string, fields: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Cookie: `tango_session=${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
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

  it("keeps the owner charge equal to the ledger amount while fees are absorbed", () => {
    expect(checkoutAmountCents(40_050)).toBe(40_050);
    expect(checkoutAmountCents(0)).toBe(0);
  });

  it("builds https return urls and refuses an insecure public request", () => {
    const association = { slug: "tango-mar", vanity_slug: "tangomar" };
    expect(checkoutUrls("http://myhoadashboard.com/tangomar/pay", association)).toBeNull();
    expect(checkoutUrls("https://myhoadashboard.com/tangomar/pay", association)).toEqual({
      successUrl: "https://myhoadashboard.com/tangomar/pay/success?session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://myhoadashboard.com/tangomar/pay/cancel",
    });
  });

  it("encrypts a stripe key so the stored value is not the key", async () => {
    const material = encryptionKey();
    const stored = await encryptPaymentSecret(material, SECRET_KEY);
    expect(stored).not.toContain(SECRET_KEY);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(await decryptPaymentSecret(material, stored)).toBe(SECRET_KEY);
    await expect(decryptPaymentSecret(encryptionKey(), stored)).rejects.toThrow();
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

    const dashboard = await app.request("http://localhost/a/tango-mar/dashboard", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(await dashboard.text()).toContain("Pay now");

    let stripeBody = "";
    let stripeAuth = "";
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("api.stripe.com")) {
        stripeBody = String(init?.body ?? "");
        stripeAuth = new Headers(init?.headers).get("Authorization") ?? "";
      }
      return new Response(JSON.stringify({ id: "cs_test_session", url: "https://checkout.stripe.com/c/pay/cs_test_session" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const pay = await app.request(
      formRequest("/a/tango-mar/pay", casey, { invoice_id: "invoice_casey_open" }),
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
    expect(stripeBody).not.toContain("card%5Bnumber%5D");
    expect(stripeBody).not.toContain(SECRET_KEY);
    expect(stripeAuth).toBe(`Bearer ${SECRET_KEY}`);

    const intent = sqlite.prepare("SELECT id, amount_cents, expires_at FROM checkout_intents").get() as {
      id: string;
      amount_cents: number;
      expires_at: string;
    };
    expect(intent.amount_cents).toBe(40050);
    expect(Date.parse(intent.expires_at) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000 + 5_000);

    const payload = JSON.stringify({
      id: "evt_test_paid",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          object: "checkout.session",
          payment_status: "paid",
          amount_total: 40050,
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
    expect(payment).toMatchObject({ reference: "pi_test_recorded", notes: "Online (Stripe)", amount_cents: 40050 });
    expect((sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_casey_open'").get() as { status: string }).status).toBe("paid");
    const activity = sqlite
      .prepare("SELECT detail FROM audit_log WHERE action = 'payment_record' ORDER BY created_at DESC LIMIT 1")
      .get() as { detail: string };
    expect(activity.detail).toContain("pi_test_recorded");
    expect(activity.detail).toContain("Online (Stripe)");
    expect(activity.detail).not.toContain("4242424242424242");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE title = 'Payment receipt'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE title = 'Online payment'")).toBeGreaterThan(0);

    const again = await postWebhook(payload, `t=${timestamp},v1=${signature}`);
    expect(again.status).toBe(200);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE method = 'stripe'")).toBe(1);

    const replay = JSON.stringify({
      id: "evt_test_paid_replay",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_session",
          payment_status: "paid",
          amount_total: 40050,
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
  });

  it("shows the demo sample checkout without saving a payment", async () => {
    const app = createApp();
    const before = count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE association_id = 'assoc_seaside_demo'");
    const auditsBefore = count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE association_id = 'assoc_seaside_demo'");
    const enter = await app.request("http://localhost/demo", {}, env);
    const owner = await app.request("http://localhost/a/seaside-demo/dashboard", { headers: { Cookie: "tango_demo=owner" } }, env);
    const ownerHtml = await owner.text();
    expect(ownerHtml).toContain("Pay now");
    expect(ownerHtml).toContain("Pay full balance");
    expect(ownerHtml).toContain("Nothing here is real or saved");
    expect(ownerHtml).not.toContain(SECRET_KEY);

    const checkout = await app.request("http://localhost/a/seaside-demo/pay?invoice=invoice_demo_riley", { headers: { Cookie: "tango_demo=owner" } }, env);
    const checkoutHtml = await checkout.text();
    expect(checkoutHtml).toContain("Sample checkout");
    expect(checkoutHtml).toContain("Nothing is charged. Nothing here is real or saved.");
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
    expect(successHtml).toContain("sample_pi_demo");
    expect(successHtml).toContain("Online (Stripe)");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE association_id = 'assoc_seaside_demo'")).toBe(before);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE association_id = 'assoc_seaside_demo'")).toBe(auditsBefore);

    const still = await app.request("http://localhost/a/seaside-demo/dashboard", { headers: { Cookie: "tango_demo=owner" } }, env);
    expect(await still.text()).toContain("$300.00");
    expect(enter.status).toBe(303);
  });
});
