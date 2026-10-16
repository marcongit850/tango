import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEMO_INVOICE_EMAIL_MESSAGE, runDueInvoiceEmails, saveInvoiceEmailSetting } from "../src/lib/invoice-emails";
import { RESEND_INVOICE_HELP } from "../src/views/help";
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
  "migrations/0023_late_fees.sql",
  "migrations/0024_invoice_emails.sql",
  "migrations/0025_invoice_resend.sql",
];

const FROM = "Tang-O-Mar <donotreply@mytangomar.com>";
const OPEN = "invoice_casey_open";
const PAY_URL = "https://myhoadashboard.com/tangomar/invoices/invoice_casey_open";

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
    .run(`sess_${userId}_${token.length}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-16T00:00:00.000Z");
  return token;
}

function formRequest(path: string, token: string, fields: Record<string, string> = {}, origin = "http://localhost"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Cookie: token ? `tango_session=${token}` : "",
      ...(origin ? { Origin: origin } : {}),
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

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return Number((sqlite.prepare(sql).get(...params) as { n: number }).n);
}

describe("email this invoice", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  let env: Env;
  let calls: SentMail[];
  let failNext: boolean;
  let jordan: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const opened = openPortal();
    sqlite = opened.sqlite;
    db = opened.db;
    env = portalEnv(db);
    calls = [];
    failNext = false;
    jordan = await signIn(sqlite, "user_jordan");
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as SentMail;
      calls.push(body);
      if (failNext) {
        failNext = false;
        return new Response("nope", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sqlite.close();
  });

  async function send(token = jordan): Promise<Response> {
    const app = createApp();
    return app.request(formRequest(`/a/tango-mar/admin/invoices/${OPEN}/email`, token), {}, env);
  }

  it("emails the owners even when the daily switch is off, and the daily job can still send later", async () => {
    const app = createApp();
    const before = await app.request(`http://localhost/a/tango-mar/admin/invoices/${OPEN}`, { headers: { Cookie: `tango_session=${jordan}` } }, env);
    const beforeHtml = await before.text();
    expect(before.status).toBe(200);
    expect(beforeHtml).toContain(`<form method="post" action="/a/tango-mar/admin/invoices/${OPEN}/email">`);
    expect(beforeHtml).toContain(">Email this invoice</button>");
    expect(beforeHtml).toContain('aria-label="Help: Email this invoice"');
    expect(beforeHtml).toContain(RESEND_INVOICE_HELP);
    expect(beforeHtml).not.toContain("\u2014");
    expect(beforeHtml).not.toContain("\u2013");

    const sent = await send();
    expect(sent.status).toBe(303);
    expect(flash(sent)).toBe("ok:Emailed this invoice to 1 owner.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe(FROM);
    expect(calls[0]?.to).toEqual(["casey.nguyen@example.com"]);
    expect(calls[0]?.subject).toBe("Tang-O-Mar: Opening balance (CSV import) invoice");
    expect(calls[0]?.text).toContain("View and pay: " + PAY_URL);
    expect(calls[0]?.text).toContain("Late fee: $25.00");
    expect(calls[0]?.html).toContain(`<a href="${PAY_URL}">View and pay</a>`);
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = ?").get(OPEN)).toEqual({ emailed_at: null });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_events WHERE invoice_id = ?", OPEN)).toBe(0);
    const row = sqlite.prepare("SELECT actor_user_id, actor_name, recipient_count FROM invoice_resends WHERE invoice_id = ?").get(OPEN) as {
      actor_user_id: string;
      actor_name: string;
      recipient_count: number;
    };
    expect(row).toEqual({ actor_user_id: "user_jordan", actor_name: "Jordan Lee", recipient_count: 1 });

    const after = await app.request(`http://localhost/a/tango-mar/admin/invoices/${OPEN}`, { headers: { Cookie: `tango_session=${jordan}` } }, env);
    const afterHtml = await after.text();
    expect(afterHtml).toContain("Last emailed");
    expect(afterHtml).toContain("by Jordan Lee");
    expect(afterHtml).toContain("to 1 owner.");
    expect(afterHtml).not.toContain("\u2014");
    expect(afterHtml).not.toContain("\u2013");

    const saved = await saveInvoiceEmailSetting(db, "assoc_tango_mar", true, "2026-01-01");
    expect(saved.ok).toBe(true);
    const job = await runDueInvoiceEmails(env, new Date("2026-10-16T18:00:00.000Z"));
    expect(job.sent).toBeGreaterThan(0);
    expect(calls.some((mail) => mail.text.includes(PAY_URL))).toBe(true);
    expect(sqlite.prepare("SELECT emailed_at FROM invoices WHERE id = ?").get(OPEN)).not.toEqual({ emailed_at: null });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_email_events WHERE invoice_id = ?", OPEN)).toBe(1);
  });

  it("emails an invoice that is only partly paid", async () => {
    sqlite.prepare("UPDATE invoices SET status = 'partial' WHERE id = ?").run(OPEN);
    const sent = await send();
    expect(flash(sent)).toBe("ok:Emailed this invoice to 1 owner.");
    expect(calls).toHaveLength(1);
  });

  it("refuses paid, void, and not yet issued invoices", async () => {
    const app = createApp();
    const paid = await app.request("http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026", { headers: { Cookie: `tango_session=${jordan}` } }, env);
    const paidHtml = await paid.text();
    expect(paidHtml).toContain('disabled>Email this invoice</button>');
    expect(paidHtml).toContain("This invoice is paid.");
    expect(paidHtml).not.toContain('action="/a/tango-mar/admin/invoices/invoice_sam_2026/email"');
    const paidPost = await app.request(formRequest("/a/tango-mar/admin/invoices/invoice_sam_2026/email", jordan), {}, env);
    expect(paidPost.status).toBe(303);
    expect(flash(paidPost)).toContain("This invoice is paid.");
    expect(calls).toHaveLength(0);

    sqlite.prepare("UPDATE invoices SET amount_cents = 0, late_fee_cents = 0 WHERE id = ?").run(OPEN);
    const settled = await send();
    expect(flash(settled)).toContain("This invoice is paid.");
    expect(calls).toHaveLength(0);

    sqlite.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(OPEN);
    const voided = await send();
    expect(flash(voided)).toContain("This invoice is void.");
    expect(calls).toHaveLength(0);

    sqlite.prepare("UPDATE invoices SET status = 'open', issued_on = '2099-01-01' WHERE id = ?").run(OPEN);
    const future = await send();
    expect(flash(future)).toContain("This invoice is not issued yet.");
    expect(calls).toHaveLength(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_resends")).toBe(0);
  });

  it("says when no owner has an email and when email is not set up", async () => {
    sqlite.prepare("UPDATE users SET email = '' WHERE id = 'user_casey'").run();
    const missing = await send();
    expect(flash(missing)).toContain("No owner on this lot has an email on file.");
    expect(calls).toHaveLength(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_resends")).toBe(0);

    sqlite.prepare("UPDATE users SET email = 'casey.nguyen@example.com' WHERE id = 'user_casey'").run();
    env = portalEnv(db, "");
    const unconfigured = await send();
    expect(flash(unconfigured)).toContain("Invoice email is not set up yet, so this invoice was not sent.");
    expect(calls).toHaveLength(0);
  });

  it("allows one resend of the same invoice per minute", async () => {
    expect((await send()).status).toBe(303);
    expect(calls).toHaveLength(1);
    const again = await send();
    expect(flash(again)).toContain("Wait a minute before emailing this invoice again.");
    expect(calls).toHaveLength(1);
    sqlite.prepare("UPDATE invoice_resends SET sent_at = '2020-01-01T00:00:00.000Z' WHERE invoice_id = ?").run(OPEN);
    const later = await send();
    expect(flash(later)).toBe("ok:Emailed this invoice to 1 owner.");
    expect(calls).toHaveLength(2);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_resends WHERE invoice_id = ?", OPEN)).toBe(2);
  });

  it("still reaches an owner who turned off announcement emails, and counts each owner", async () => {
    sqlite.prepare("UPDATE users SET email_announcements = 0 WHERE id = 'user_casey'").run();
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES ('user_extra', 'extra.owner@example.com', 'Extra Owner', '', '2026-10-16T00:00:00.000Z')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at) VALUES ('mem_extra', 'assoc_tango_mar', 'user_extra', 'homeowner', 'active', 0, '2026-10-16T00:00:00.000Z')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at) VALUES ('own_extra', 'assoc_tango_mar', 'prop_27', 'user_extra', 0, '2026-10-16T00:00:00.000Z')",
      )
      .run();
    const sent = await send();
    expect(flash(sent)).toBe("ok:Emailed this invoice to 2 owners.");
    expect(calls.map((mail) => mail.to[0]).sort()).toEqual(["casey.nguyen@example.com", "extra.owner@example.com"]);
  });

  it("limits the button to edit access and does not send from the demo", async () => {
    const app = createApp();
    const casey = await signIn(sqlite, "user_casey");
    sqlite
      .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES ('user_board_view', 'board.view@example.com', 'Board View', '', '2026-10-16T00:00:00.000Z')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at) VALUES ('mem_board_view', 'assoc_tango_mar', 'user_board_view', 'board', 'active', 0, '2026-10-16T00:00:00.000Z')",
      )
      .run();
    const board = await signIn(sqlite, "user_board_view");
    const viewer = await app.request(`http://localhost/a/tango-mar/admin/invoices/${OPEN}`, { headers: { Cookie: `tango_session=${board}` } }, env);
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).not.toContain("Email this invoice");

    expect((await send(casey)).status).toBe(403);
    expect((await send(board)).status).toBe(403);
    const bare = await app.request(
      new Request(`http://localhost/a/tango-mar/admin/invoices/${OPEN}/email`, {
        method: "POST",
        headers: { Cookie: `tango_session=${jordan}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }),
      {},
      env,
    );
    expect(bare.status).toBe(403);
    expect(calls).toHaveLength(0);

    const demoPage = await app.request("http://localhost/a/seaside-demo/admin/invoices/invoice_demo_alex", { headers: { Cookie: "tango_demo=admin" } }, env);
    const demoHtml = await demoPage.text();
    expect(demoHtml).toContain('action="/a/seaside-demo/admin/invoices/invoice_demo_alex/email"');
    expect(demoHtml).not.toContain("Demo only, changes are not saved");
    const demoPost = await app.request(
      new Request("http://localhost/a/seaside-demo/admin/invoices/invoice_demo_alex/email", {
        method: "POST",
        headers: {
          Cookie: "tango_demo=admin",
          Origin: "http://localhost",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "",
      }),
      {},
      env,
    );
    expect(demoPost.status).toBe(303);
    expect(flash(demoPost)).toContain(DEMO_INVOICE_EMAIL_MESSAGE);
    expect(calls).toHaveLength(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_resends")).toBe(0);
  });
});
