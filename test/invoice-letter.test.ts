import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEFAULT_BANK_FEE, invoiceBankFeeLine } from "../src/lib/bank-fee";
import { invoiceAmountDueCents, invoiceOwnerEmail, sampleInvoiceOwnerEmail } from "../src/lib/email";
import { associationCheckMailLines, DEMO_INVOICE_BOARD_NOTE, invoiceMailSettings, mailedCheckAddressHint, mailLinesForEmail } from "../src/lib/invoice-mail";
import { MAILED_CHECKS_HELP } from "../src/views/help";
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
  "migrations/0023_late_fees.sql",
  "migrations/0024_invoice_emails.sql",
  "migrations/0025_invoice_resend.sql",
  "migrations/0026_invoice_resend_recipients.sql",
  "migrations/0027_invoice_mail.sql",
];

const PAY_URL = "https://myhoadashboard.com/tangomar/invoices/invoice_sample";
const FEE_LINE = "Pay securely online by bank transfer. A bank fee of 0.8% (up to $5) is added.";

function letter(overrides: Partial<Parameters<typeof invoiceOwnerEmail>[0]> = {}) {
  return invoiceOwnerEmail({
    associationName: "Tang-O-Mar",
    invoiceNumber: "2027-14-ANNUAL",
    description: "2027 annual assessment",
    lotNumber: "14",
    amountDueCents: 125000,
    dueOn: "2027-03-01",
    timeZone: "America/Chicago",
    payUrl: PAY_URL,
    ...overrides,
  });
}

function openPortal(files = MIGRATIONS): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of files) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
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

function flash(response: Response): string {
  const cookie = response.headers.get("Set-Cookie") ?? "";
  const match = cookie.match(/tango_flash=([^;]+)/);
  return decodeURIComponent(match?.[1] ?? "");
}

describe("branded invoice email", () => {
  it("uses the remaining balance, and shows a late fee row only when one applies", () => {
    expect(invoiceAmountDueCents(10000, 0, 2500)).toBe(7500);
    expect(invoiceAmountDueCents(10000, 2500, 4000)).toBe(8500);
    expect(invoiceAmountDueCents(10000, 0, 20000)).toBe(0);
    const partial = letter({ amountDueCents: 7500, lateFeeCents: 0 });
    expect(partial.text).toContain("Amount due: $75.00");
    expect(partial.text).not.toContain("Late fee:");
    expect(partial.html).not.toContain("$100.00");
    const late = letter({ amountDueCents: 8500, lateFeeCents: 2500 });
    expect(late.text).toContain("Late fee: $25.00");
    expect(late.text).toContain("Amount due: $85.00");
    expect(late.html).toContain("Late fee");
    expect(late.html).toContain("$85.00");
    expect(late.html).toContain('>Late fee</td><td align="right"');
    expect(late.html).toContain('font-size:18px');
  });

  it("shows Pay now and the fee line only when online payments are on", () => {
    expect(invoiceBankFeeLine(DEFAULT_BANK_FEE)).toBe(FEE_LINE);
    const off = letter();
    expect(off.text).toContain(`View invoice: ${PAY_URL}`);
    expect(off.html).toContain(">View invoice</a>");
    expect(off.text).not.toContain("Pay now");
    expect(off.html).not.toContain(FEE_LINE);
    const on = letter({ payOnline: true, feeLine: FEE_LINE });
    expect(on.text).toContain(`Pay now: ${PAY_URL}`);
    expect(on.text).toContain(FEE_LINE);
    expect(on.html).toContain(">Pay now</a>");
    expect(on.html).toContain(FEE_LINE);
    expect(on.html).not.toContain(">View invoice</a>");
  });

  it("includes the check box and board note only when they are set, and escapes them", () => {
    const bare = letter();
    expect(bare.text).not.toContain("Prefer to mail a check?");
    expect(bare.text).not.toContain("A note from the board:");
    const full = letter({
      payableTo: "",
      mailLines: ["Tang-O-Mar", "Attn: Treasurer", "PO Box <123>", "Sample Harbor, FL 32550"],
      boardNote: "Fish & chips <note>",
    });
    expect(full.text).toContain("Prefer to mail a check? No fee for checks.");
    expect(full.text).toContain("Make it payable to Tang-O-Mar and write your lot number on it.");
    expect(full.text).toContain("Mail to:");
    expect(full.text).toContain("PO Box <123>");
    expect(full.text).toContain("A note from the board:");
    expect(full.text).toContain("Fish & chips <note>");
    expect(full.html).toContain("payable to <strong>Tang-O-Mar</strong>");
    expect(full.html).toContain("<strong>Prefer to mail a check?</strong>");
    expect(full.html).toContain("<em>A note from the board:</em>");
    expect(full.html).toContain("#1d4e89");
    expect(full.html).toContain("#f3f5f7");
    expect(full.html).toContain("Arial, Helvetica, sans-serif");
    expect(full.html).toContain('align="right"');
    expect(full.html).toContain("border-left:4px solid #1d4e89");
    expect(full.html).not.toContain("Georgia");
    expect(full.html).not.toContain("#0e5e5b");
    expect(full.html).toContain(">Lot 14</td>");
    expect(full.html).toContain("PO Box &lt;123&gt;");
    expect(full.html).toContain("Fish &amp; chips &lt;note&gt;");
    expect(full.html).not.toContain("<note>");
    expect(full.html).toContain('width="560"');
    expect(full.html).toContain("Questions? Use the Support tab in your portal. This mailbox is not monitored.");
    expect(full.html).toContain("Sent by Tang-O-Mar through My HOA Dashboard.");
    expect(full.text).not.toContain("\u2014");
    expect(full.text).not.toContain("\u2013");
    expect(full.html).not.toContain("\u2014");
    expect(full.html).not.toContain("\u2013");
  });

  it("renders the approved sample letter", () => {
    const sample = sampleInvoiceOwnerEmail();
    expect(sample.subject).toBe("Seaside Demo HOA: 2027 Annual Assessment invoice");
    expect(sample.text).toContain("Your 2027 Annual Assessment invoice is ready.");
    expect(sample.text).toContain("Invoice: 2027-ANNUAL-014");
    expect(sample.text).toContain("Lot: Lot 12");
    expect(sample.text).toContain("Due: January 31, 2027");
    expect(sample.text).toContain("Amount due: $625.00");
    expect(sample.text).toContain("Pay now: https://myhoadashboard.com/seaside/invoices/sample");
    expect(sample.html).toContain(">Pay now</a>");
    expect(sample.html).toContain("Thank you for keeping our neighborhood beautiful. Dues are unchanged for 2027.");
    expect(sample.html).toContain('align="center"');
  });
});

describe("mailed check settings", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let env: Env;
  let jordan: string;

  afterEach(() => {
    sqlite.close();
  });

  async function signIn(userId: string): Promise<string> {
    const token = `session-${userId}`;
    sqlite
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-16T00:00:00.000Z");
    return token;
  }

  it("seeds the demo, saves plain text for an editor, and previews that HOA", async () => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    db = opened.db;
    env = { DB: db, APP_ENV: "production", EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>" } as unknown as Env;
    jordan = await signIn("user_jordan");
    const app = createApp();
    const demo = await app.request("http://localhost/a/seaside-demo/admin/payment-settings", { headers: { Cookie: "tango_demo=admin" } }, env);
    const demoHtml = await demo.text();
    expect(demo.status).toBe(200);
    expect(demoHtml).toContain(MAILED_CHECKS_HELP);
    expect(demoHtml).toContain("Checks payable to");
    expect(demoHtml).toContain("Seaside Demo HOA");
    expect(demoHtml).toContain("Attn: Treasurer");
    expect(demoHtml).toContain("PO Box 123");
    expect(demoHtml).toContain("Sample Harbor, FL 32550");
    expect(demoHtml).toContain(DEMO_INVOICE_BOARD_NOTE);
    expect(demoHtml).not.toContain("Blank uses the association address");
    expect(demoHtml).not.toContain("\u2014");
    expect(demoHtml).not.toContain("\u2013");

    const owner = await app.request("http://localhost/a/seaside-demo/admin/payment-settings", {}, env);
    expect(owner.status).toBe(403);

    const preview = await app.request("http://localhost/a/seaside-demo/admin/payment-settings/invoice-email-preview", {
      headers: { Cookie: "tango_demo=admin" },
    }, env);
    const previewHtml = await preview.text();
    expect(preview.status).toBe(200);
    expect(previewHtml).toContain(">View invoice</a>");
    expect(previewHtml).not.toContain(FEE_LINE);
    expect(previewHtml).toContain("payable to <strong>Seaside Demo HOA</strong>");
    expect(previewHtml).toContain("Your 2027 Annual Assessment invoice is ready.");
    expect(previewHtml).toContain("#1d4e89");
    expect(previewHtml).toContain(DEMO_INVOICE_BOARD_NOTE);
    expect(previewHtml).toContain('width="560"');

    const saved = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/mailed-checks", jordan, {
        payable_to: "Tang-O-Mar HOA",
        mailing_address: "Tang-O-Mar\nAttn: Treasurer\nPO Box <9>",
        board_note: "Bring a stamp & <thanks>",
      }),
      {},
      env,
    );
    expect(saved.status).toBe(303);
    expect(flash(saved)).toBe("ok:Mailed checks saved.");
    const row = sqlite.prepare("SELECT payable_to, mailing_address, board_note FROM invoice_mail_settings WHERE association_id = ?").get("assoc_tango_mar") as {
      payable_to: string;
      mailing_address: string;
      board_note: string;
    };
    expect(row.payable_to).toBe("Tang-O-Mar HOA");
    expect(row.mailing_address).toBe("Tang-O-Mar\nAttn: Treasurer\nPO Box <9>");
    expect(row.board_note).toBe("Bring a stamp & <thanks>");

    sqlite
      .prepare(
        "INSERT INTO payment_settings (association_id, enabled, secret_key_ciphertext, secret_key_last4, secret_key_mode, webhook_secret_ciphertext, webhook_secret_last4) VALUES ('assoc_tango_mar', 1, 'cipher', '1234', 'live', 'wh', '5678')",
      )
      .run();
    const tangoPreview = await app.request("http://localhost/a/tango-mar/admin/payment-settings/invoice-email-preview", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    const tangoHtml = await tangoPreview.text();
    expect(tangoHtml).toContain(">Pay now</a>");
    expect(tangoHtml).toContain(FEE_LINE);
    expect(tangoHtml).toContain("PO Box &lt;9&gt;");
    expect(tangoHtml).toContain("Bring a stamp &amp; &lt;thanks&gt;");
    expect(tangoHtml).not.toContain("<thanks>");

    const tooMany = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/mailed-checks", jordan, {
        payable_to: "",
        mailing_address: "1\n2\n3\n4\n5\n6",
        board_note: "",
      }),
      {},
      env,
    );
    expect(flash(tooMany)).toContain("Mailing address can be at most 5 lines.");
    expect(sqlite.prepare("SELECT mailing_address FROM invoice_mail_settings WHERE association_id = ?").get("assoc_tango_mar")).toEqual({
      mailing_address: "Tang-O-Mar\nAttn: Treasurer\nPO Box <9>",
    });

    const casey = await signIn("user_casey");
    const denied = await app.request(formRequest("/a/tango-mar/admin/payment-settings/mailed-checks", casey, { payable_to: "Nope" }), {}, env);
    expect(denied.status).toBe(403);
  });

  it("leaves the check box and note off when the migration is not applied", async () => {
    const opened = openPortal(MIGRATIONS.filter((file) => file !== "migrations/0027_invoice_mail.sql"));
    sqlite = opened.sqlite;
    db = opened.db;
    env = { DB: db, APP_ENV: "production" } as unknown as Env;
    jordan = await signIn("user_jordan");
    const mail = await invoiceMailSettings(db, "assoc_tango_mar");
    expect(mail.ready).toBe(false);
    const app = createApp();
    const page = await app.request("http://localhost/a/tango-mar/admin/payment-settings", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    const html = await page.text();
    expect(html).toContain("migrations/0027_invoice_mail.sql");
    const preview = await app.request("http://localhost/a/tango-mar/admin/payment-settings/invoice-email-preview", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain("Attn: Board of Directors");
    expect(previewHtml).toContain("31 Tang O Mar Drive, Miramar Beach, FL 32550");
    expect(previewHtml).not.toContain("A note from the board:");
    expect(previewHtml).toContain(">View invoice</a>");
  });

  it("falls back to the association address when the mailed check address is blank", async () => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    db = opened.db;
    env = { DB: db, APP_ENV: "production" } as unknown as Env;
    jordan = await signIn("user_jordan");
    const tango = {
      name: "Tang-O-Mar",
      address_line1: "31 Tang O Mar Drive",
      city: "Miramar Beach",
      state: "FL",
      postal_code: "32550",
    };
    const empty = { ready: true, payableTo: "", mailingAddress: "", boardNote: "" };
    expect(mailLinesForEmail(empty, tango)).toEqual([
      "Tang-O-Mar",
      "Attn: Board of Directors",
      "31 Tang O Mar Drive, Miramar Beach, FL 32550",
    ]);
    expect(mailedCheckAddressHint("PO Box 9", tango)).toBe("");
    expect(mailLinesForEmail({ ...empty, mailingAddress: "PO Box 9" }, tango)).toEqual(["PO Box 9"]);
    expect(associationCheckMailLines({ name: "Fish & Chips", address_line1: "TBD", city: "", state: "", postal_code: "" })).toEqual([
      "Fish & Chips",
      "Attn: Board of Directors",
      "TBD",
    ]);
    expect(mailLinesForEmail(empty, { ...tango, address_line1: " " })).toEqual([]);
    expect(mailLinesForEmail({ ...empty, ready: false }, tango)).toEqual(mailLinesForEmail(empty, tango));
    expect(mailedCheckAddressHint("", { ...tango, address_line1: "" })).toBe("");

    const app = createApp();
    const page = await app.request("http://localhost/a/tango-mar/admin/payment-settings", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    const html = await page.text();
    const hint = "Blank uses the association address: Tang-O-Mar, Attn: Board of Directors, 31 Tang O Mar Drive, Miramar Beach, FL 32550";
    expect(html).toContain(hint);
    expect(html).not.toContain("\u2014");
    expect(html).not.toContain("\u2013");

    const preview = await app.request("http://localhost/a/tango-mar/admin/payment-settings/invoice-email-preview", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain("Attn: Board of Directors");
    expect(previewHtml).toContain("31 Tang O Mar Drive, Miramar Beach, FL 32550");
    expect(previewHtml).toContain("payable to <strong>Tang-O-Mar</strong>");

    sqlite.prepare("UPDATE associations SET address_line1 = 'TBD', city = '', state = '', postal_code = '' WHERE id = 'assoc_tango_mar'").run();
    const tbdPage = await app.request("http://localhost/a/tango-mar/admin/payment-settings", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    expect(await tbdPage.text()).toContain("Blank uses the association address: Tang-O-Mar, Attn: Board of Directors, TBD");
    const tbdPreview = await app.request("http://localhost/a/tango-mar/admin/payment-settings/invoice-email-preview", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    const tbdHtml = await tbdPreview.text();
    expect(tbdHtml).toContain(">TBD<");
    expect(tbdHtml).toContain("Attn: Board of Directors");

    sqlite.prepare("UPDATE associations SET address_line1 = '' WHERE id = 'assoc_tango_mar'").run();
    const barePage = await app.request("http://localhost/a/tango-mar/admin/payment-settings", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    expect(await barePage.text()).not.toContain("Blank uses the association address");
    const barePreview = await app.request("http://localhost/a/tango-mar/admin/payment-settings/invoice-email-preview", {
      headers: { Cookie: `tango_session=${jordan}` },
    }, env);
    expect(await barePreview.text()).not.toContain("Prefer to mail a check?");
  });
});
