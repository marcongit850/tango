import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import worker from "../src/index";
import { todayIso } from "../src/lib/dates";
import { invoiceOwnerEmail } from "../src/lib/email";
import { INVOICE_EMAIL_HELP } from "../src/views/help";
import { runDueInvoiceEmails, saveInvoiceEmailSetting } from "../src/lib/invoice-emails";
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

const FROM = "Tang-O-Mar <donotreply@mytangomar.com>";

type SentMail = { from: string; to: string[]; subject: string; text: string; html?: string };

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database, apiKey = "re_test"): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: FROM,
    RESEND_API_KEY: apiKey,
    DOCUMENTS: { put: async () => {} },
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
  const params = new URLSearchParams(fields);
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

function insertInvoice(
  sqlite: DatabaseSync,
  row: {
    id: string;
    propertyId?: string;
    number: string;
    description?: string;
    amount?: number;
    issuedOn: string;
    dueOn?: string;
    status?: string;
    createdAt?: string;
    associationId?: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO invoices (
         id, association_id, property_id, invoice_number, description, amount_cents, late_fee_cents,
         issued_on, due_on, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.associationId ?? "assoc_tango_mar",
      row.propertyId ?? "prop_14",
      row.number,
      row.description ?? "2027 annual assessment",
      row.amount ?? 125000,
      row.issuedOn,
      row.dueOn ?? "2027-03-01",
      row.status ?? "open",
      row.createdAt ?? "2026-12-01T15:00:00.000Z",
    );
}

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((sqlite.prepare(sql).get(...params) as { n: number }).n);
}

describe("invoice letter", () => {
  it("names the association and the invoice, with a view and pay link and no em or en dashes", () => {
    const letter = invoiceOwnerEmail({
      associationName: "Tang-O-Mar",
      invoiceNumber: "2027-14-ANNUAL",
      description: "2027 annual assessment",
      amountCents: 125000,
      dueOn: "2027-03-01",
      timeZone: "America/Chicago",
      payUrl: "https://myhoadashboard.com/tangomar/invoices/invoice_future",
    });
    expect(letter.subject).toBe("Tang-O-Mar: 2027 annual assessment invoice");
    expect(letter.text).toContain("Tang-O-Mar");
    expect(letter.text).toContain("Invoice 2027-14-ANNUAL");
    expect(letter.text).toContain("2027 annual assessment");
    expect(letter.text).toContain("Amount: $1,250.00");
    expect(letter.text).toContain("Due: March 1, 2027");
    expect(letter.text).toContain("View and pay: https://myhoadashboard.com/tangomar/invoices/invoice_future");
    expect(letter.html).toContain('<a href="https://myhoadashboard.com/tangomar/invoices/invoice_future">View and pay</a>');
    expect(letter.html).toContain("Invoice 2027-14-ANNUAL");
    for (const part of [letter.subject, letter.text, letter.html]) {
      expect(part).not.toContain("\u2014");
      expect(part).not.toContain("\u2013");
    }
  });
});

describe("invoice emails", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let env: Env;
  let calls: SentMail[];
  let failNext: boolean;
  let throwNext: boolean;

  beforeEach(() => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    db = opened.db;
    env = portalEnv(db);
    calls = [];
    failNext = false;
    throwNext = false;
  });

  afterEach(() => {
    sqlite.close();
  });

  function fetchImpl(): typeof fetch {
    return async (_input, init) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("network down");
      }
      const body = JSON.parse(String(init?.body)) as SentMail;
      calls.push(body);
      if (failNext) {
        failNext = false;
        return new Response("nope", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    };
  }

  async function enable(today: string): Promise<void> {
    const saved = await saveInvoiceEmailSetting(db, "assoc_tango_mar", true, today);
    expect(saved.ok).toBe(true);
  }

  it("emails on the issue date, waits for a future date, and does not send twice", async () => {
    await enable("2026-12-01");
    insertInvoice(sqlite, {
      id: "invoice_future",
      number: "2027-14-FUTURE",
      issuedOn: "2027-01-01",
      createdAt: "2026-12-01T15:00:00.000Z",
    });
    const december = await runDueInvoiceEmails(env, new Date("2026-12-15T18:00:00.000Z"), fetchImpl());
    expect(december).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);

    const stillDecember = await runDueInvoiceEmails(env, new Date("2027-01-01T05:30:00.000Z"), fetchImpl());
    expect(stillDecember).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);

    const issued = await runDueInvoiceEmails(env, new Date("2027-01-01T06:15:00.000Z"), fetchImpl());
    expect(issued).toEqual({ sent: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe(FROM);
    expect(calls[0]?.to).toEqual(["sam.rivera@example.com"]);
    expect(calls[0]?.subject).toBe("Tang-O-Mar: 2027 annual assessment invoice");
    expect(calls[0]?.text).toContain("View and pay: https://myhoadashboard.com/tangomar/invoices/invoice_future");
    expect(calls[0]?.html).toContain("https://myhoadashboard.com/tangomar/invoices/invoice_future");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_events WHERE invoice_id = ?", "invoice_future")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = ?", "user_sam", "2027 annual assessment invoice")).toBe(1);
    const stored = sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = ?").get("invoice_future") as { emailed_at: string };
    expect(stored.emailed_at).toBe("2027-01-01T06:15:00.000Z");

    const again = await runDueInvoiceEmails(env, new Date("2027-01-02T06:15:00.000Z"), fetchImpl());
    expect(again).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'account' AND title LIKE '%invoice'", "user_sam")).toBe(1);
  });

  it("does not email invoices issued before the switch was turned on, including after it is turned off and on again", async () => {
    insertInvoice(sqlite, { id: "invoice_old", number: "2026-14-OLD", issuedOn: "2026-10-01", dueOn: "2026-11-01" });
    insertInvoice(sqlite, { id: "invoice_day", number: "2026-14-DAY", issuedOn: "2026-10-16", dueOn: "2026-11-01" });
    await enable("2026-10-16");
    const first = await runDueInvoiceEmails(env, new Date("2026-10-16T18:00:00.000Z"), fetchImpl());
    expect(first).toEqual({ sent: 1, failed: 0 });
    expect(calls.map((call) => call.subject)).toEqual(["Tang-O-Mar: 2027 annual assessment invoice"]);
    expect(calls[0]?.text).toContain("Invoice 2026-14-DAY");
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_old'").get()).toEqual({ emailed_at: null });

    await saveInvoiceEmailSetting(db, "assoc_tango_mar", false, "2026-12-20");
    insertInvoice(sqlite, { id: "invoice_gap", number: "2026-14-GAP", issuedOn: "2026-12-15", dueOn: "2027-01-15" });
    await saveInvoiceEmailSetting(db, "assoc_tango_mar", true, "2027-02-01");
    insertInvoice(sqlite, { id: "invoice_next", number: "2027-14-NEXT", issuedOn: "2027-02-01", dueOn: "2027-03-01" });
    calls.length = 0;
    const later = await runDueInvoiceEmails(env, new Date("2027-02-01T18:00:00.000Z"), fetchImpl());
    expect(later).toEqual({ sent: 1, failed: 0 });
    expect(calls[0]?.text).toContain("Invoice 2027-14-NEXT");
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_gap'").get()).toEqual({ emailed_at: null });
  });

  it("still emails an owner who turned off announcement emails", async () => {
    sqlite.prepare("UPDATE users SET email_announcements = 0 WHERE id = ?").run("user_sam");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at, email_announcements) VALUES (?, ?, ?, '', ?, 1)")
      .run("user_co", "co.owner@example.com", "Co Owner", "2026-10-16T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at) VALUES (?, 'assoc_tango_mar', 'user_co', 'homeowner', 'active', 0, ?)",
      )
      .run("mem_co", "2026-10-16T00:00:00.000Z");
    sqlite
      .prepare(
        "INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at) VALUES (?, 'assoc_tango_mar', 'prop_14', 'user_co', 0, ?)",
      )
      .run("own_co", "2026-10-16T00:00:00.000Z");
    await enable("2027-01-01");
    insertInvoice(sqlite, { id: "invoice_opt", number: "2027-14-OPT", issuedOn: "2027-01-01" });
    const result = await runDueInvoiceEmails(env, new Date("2027-01-01T06:15:00.000Z"), fetchImpl());
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(calls.map((call) => call.to[0]).sort()).toEqual(["co.owner@example.com", "sam.rivera@example.com"]);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE title = ?", "2027 annual assessment invoice")).toBe(2);
  });

  it("does not email a void invoice and does not send while the switch is off", async () => {
    await enable("2027-01-01");
    insertInvoice(sqlite, { id: "invoice_void", number: "2027-14-VOID", issuedOn: "2027-01-01", status: "void" });
    const off = await saveInvoiceEmailSetting(db, "assoc_tango_mar", false, "2027-01-01");
    expect(off.ok && off.changed).toBe(true);
    insertInvoice(sqlite, { id: "invoice_open", number: "2027-14-OPEN", issuedOn: "2027-01-01" });
    const quiet = await runDueInvoiceEmails(env, new Date("2027-01-01T18:00:00.000Z"), fetchImpl());
    expect(quiet).toEqual({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    await enable("2027-01-01");
    const sent = await runDueInvoiceEmails(env, new Date("2027-01-01T18:00:00.000Z"), fetchImpl());
    expect(sent).toEqual({ sent: 1, failed: 0 });
    expect(calls[0]?.text).toContain("Invoice 2027-14-OPEN");
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_void'").get()).toEqual({ emailed_at: null });
  });

  it("skips the demo association even when its switch is on", async () => {
    sqlite
      .prepare("INSERT INTO invoice_email_settings (association_id, enabled, enabled_on) VALUES ('assoc_seaside_demo', 1, '2026-01-01')")
      .run();
    await enable("2026-10-16");
    insertInvoice(sqlite, { id: "invoice_live", number: "2026-14-LIVE", issuedOn: "2026-10-16", dueOn: "2026-11-01" });
    const result = await runDueInvoiceEmails(env, new Date("2026-10-16T18:00:00.000Z"), fetchImpl());
    expect(result.sent).toBe(1);
    const recipients = calls.flatMap((call) => call.to);
    expect(recipients).toEqual(["sam.rivera@example.com"]);
    expect(recipients).not.toContain("riley.coast@example.com");
    expect(recipients).not.toContain("alex.marsh@example.com");
    expect(recipients).not.toContain("quinn.harbor@example.com");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_events WHERE association_id = 'assoc_seaside_demo'")).toBe(0);
  });

  it("retries a failed send the next day and does not mark the invoice emailed", async () => {
    await enable("2027-01-01");
    insertInvoice(sqlite, { id: "invoice_retry", number: "2027-14-RETRY", issuedOn: "2027-01-01" });
    failNext = true;
    const failed = await runDueInvoiceEmails(env, new Date("2027-01-01T06:15:00.000Z"), fetchImpl());
    expect(failed).toEqual({ sent: 0, failed: 1 });
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_retry'").get()).toEqual({ emailed_at: null });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_events WHERE invoice_id = 'invoice_retry'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'user_sam' AND title LIKE '%invoice'")).toBe(0);

    throwNext = true;
    const thrown = await runDueInvoiceEmails(env, new Date("2027-01-02T06:15:00.000Z"), fetchImpl());
    expect(thrown).toEqual({ sent: 0, failed: 1 });
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_retry'").get()).toEqual({ emailed_at: null });

    const retried = await runDueInvoiceEmails(env, new Date("2027-01-03T06:15:00.000Z"), fetchImpl());
    expect(retried).toEqual({ sent: 1, failed: 0 });
    expect(calls.filter((call) => call.to[0] === "sam.rivera@example.com")).toHaveLength(2);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_events WHERE invoice_id = 'invoice_retry'")).toBe(1);
    const stored = sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_retry'").get() as { emailed_at: string };
    expect(stored.emailed_at).toBe("2027-01-03T06:15:00.000Z");
  });

  it("keeps going when another association fails", async () => {
    sqlite
      .prepare("INSERT INTO associations (id, slug, name, legal_name, timezone) VALUES ('assoc_bad', 'bad-hoa', 'Bad HOA', 'Bad HOA', 'Not/AZone')")
      .run();
    sqlite
      .prepare("INSERT INTO invoice_email_settings (association_id, enabled, enabled_on) VALUES ('assoc_bad', 1, '2026-01-01')")
      .run();
    await enable("2027-01-01");
    insertInvoice(sqlite, { id: "invoice_ok", number: "2027-14-OK", issuedOn: "2027-01-01" });
    const result = await runDueInvoiceEmails(env, new Date("2027-01-01T18:00:00.000Z"), fetchImpl());
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(calls[0]?.to).toEqual(["sam.rivera@example.com"]);
  });

  it("does not mark an invoice emailed when the mail key is missing", async () => {
    await enable("2027-01-01");
    insertInvoice(sqlite, { id: "invoice_nokey", number: "2027-14-NOKEY", issuedOn: "2027-01-01" });
    const result = await runDueInvoiceEmails(portalEnv(db, ""), new Date("2027-01-01T18:00:00.000Z"), fetchImpl());
    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(0);
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = 'invoice_nokey'").get()).toEqual({ emailed_at: null });
  });

  it("sends from the daily job after invoices are created, not from the create form", async () => {
    const jordan = await signIn(sqlite, "user_jordan");
    const app = createApp();
    const today = todayIso("America/Chicago");
    await enable(today);
    const created = await app.request(
      formRequest("/a/tango-mar/admin/invoices", jordan, {
        property_id: "prop_14",
        description: "Special assessment",
        amount: "40.00",
        late_fee: "0",
        issued_on: today,
        due_on: "2027-03-01",
      }),
      {},
      env,
    );
    expect(created.status).toBe(303);
    expect(calls).toHaveLength(0);
    const row = sqlite.prepare("SELECT id, invoice_number FROM invoices WHERE description = 'Special assessment'").get() as {
      id: string;
      invoice_number: string;
    };
    const result = await runDueInvoiceEmails(env, new Date(), fetchImpl());
    expect(result.sent).toBe(1);
    expect(calls[0]?.subject).toBe("Tang-O-Mar: Special assessment invoice");
    expect(calls[0]?.text).toContain(`Invoice ${row.invoice_number}`);
    expect(calls[0]?.text).toContain(`https://myhoadashboard.com/tangomar/invoices/${row.id}`);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'invoice_email' AND entity_id = ?", row.id)).toBe(1);
  });

  it("runs from the scheduled handler on the issue date and not before", async () => {
    await enable("2026-12-01");
    sqlite
      .prepare(
        `INSERT INTO assessments (id, association_id, name, description, amount_cents, due_on, created_at, opens_on, lot_type)
         VALUES ('assessment_email_day', 'assoc_tango_mar', '2027 spring dues', '', 5000, '2027-03-01', '2026-12-01T00:00:00.000Z', '2027-01-01', 'improved')`,
      )
      .run();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl();
    try {
      await worker.scheduled?.(
        { scheduledTime: Date.parse("2026-12-15T18:00:00.000Z"), cron: "15 6 * * *", noRetry() {} },
        env,
      );
      expect(calls).toHaveLength(0);
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_email_day'")).toBe(0);

      await worker.scheduled?.(
        { scheduledTime: Date.parse("2027-01-01T05:30:00.000Z"), cron: "15 6 * * *", noRetry() {} },
        env,
      );
      expect(calls).toHaveLength(0);

      await worker.scheduled?.(
        { scheduledTime: Date.parse("2027-01-01T06:15:00.000Z"), cron: "15 6 * * *", noRetry() {} },
        env,
      );
      expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_email_day'")).toBe(3);
      expect(calls.map((call) => call.to[0]).sort()).toEqual([
        "casey.nguyen@example.com",
        "jordan.lee@example.com",
        "sam.rivera@example.com",
      ]);
      expect(calls[0]?.subject).toBe("Tang-O-Mar: 2027 spring dues invoice");
      expect(calls.every((call) => call.from === FROM)).toBe(true);

      await worker.scheduled?.(
        { scheduledTime: Date.parse("2027-01-02T06:15:00.000Z"), cron: "15 6 * * *", noRetry() {} },
        env,
      );
      expect(calls).toHaveLength(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("invoice email setting", () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let jordan: string;
  let casey: string;

  beforeEach(async () => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    env = portalEnv(opened.db);
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
    sqlite.close();
  });

  it("defaults off, allows only edit access, and audits the old and new value", async () => {
    const app = createApp();
    const ownerDenied = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${casey}` } }, env);
    expect(ownerDenied.status).toBe(403);
    const ownerPost = await app.request(formRequest("/a/tango-mar/admin/payment-settings/invoice-emails", casey, { invoice_emails: "yes" }), {}, env);
    expect(ownerPost.status).toBe(403);

    const board = await signIn(sqlite, "user_board_view");
    const boardDenied = await app.request(
      "http://localhost/a/tango-mar/admin/payment-settings/invoice-emails",
      { method: "POST", headers: { Cookie: `tango_session=${board}`, Origin: "http://localhost" } },
      env,
    );
    expect(boardDenied.status).toBe(403);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_settings")).toBe(0);

    const page = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${jordan}` } }, env);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain(INVOICE_EMAIL_HELP);
    expect(html).toContain('aria-label="Help: Invoice emails"');
    expect(html).toContain('name="invoice_emails"');
    expect(html).not.toContain('name="invoice_emails" value="yes" checked');

    const turnedOn = await app.request(
      formRequest("/a/tango-mar/admin/payment-settings/invoice-emails", jordan, { invoice_emails: "yes" }),
      {},
      env,
    );
    expect(turnedOn.status).toBe(303);
    const onAudit = sqlite
      .prepare("SELECT detail FROM audit_log WHERE action = 'invoice_emails_setting' ORDER BY created_at DESC")
      .get() as { detail: string };
    expect(onAudit.detail).toContain("from off to on");
    expect(onAudit.detail).toContain("Invoices issued before");
    const enabledOn = (sqlite.prepare("SELECT enabled_on FROM invoice_email_settings WHERE association_id = 'assoc_tango_mar'").get() as { enabled_on: string }).enabled_on;
    expect(onAudit.detail).toContain(enabledOn);

    const onPage = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${jordan}` } }, env);
    expect(await onPage.text()).toContain('name="invoice_emails" value="yes" checked');

    const turnedOff = await app.request(formRequest("/a/tango-mar/admin/payment-settings/invoice-emails", jordan, {}), {}, env);
    expect(turnedOff.status).toBe(303);
    const offAudit = sqlite
      .prepare("SELECT detail FROM audit_log WHERE action = 'invoice_emails_setting' ORDER BY created_at DESC")
      .get() as { detail: string };
    expect(offAudit.detail).toContain("from on to off");
  });

  it("shows Emailed and the date on the admin invoice page after the send", async () => {
    const jordanToken = jordan;
    insertInvoice(sqlite, { id: "invoice_shown", number: "2027-14-SHOWN", issuedOn: "2027-01-01" });
    await saveInvoiceEmailSetting(env.DB, "assoc_tango_mar", true, "2026-12-01");
    await runDueInvoiceEmails(env, new Date("2027-01-01T06:15:00.000Z"), async () => new Response("{}", { status: 200 }));
    const app = createApp();
    const page = await app.request("http://localhost/a/tango-mar/admin/invoices/invoice_shown", { headers: { Cookie: `tango_session=${jordanToken}` } }, env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Emailed January 1, 2027");
  });
});
