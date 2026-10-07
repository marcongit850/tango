import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { outstandingInvoiceCents } from "../src/db";
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

  async batch(statements: SqliteStatement[]): Promise<{ meta: { changes: number }; results: [] }[]> {
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

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "migrations/0001_schema.sql",
    "migrations/0002_seed_tango_mar.sql",
    "migrations/0003_join_requests.sql",
    "migrations/0004_join_request_approved.sql",
    "migrations/0005_admin_improvements.sql",
    "migrations/0006_notice_attachments.sql",
    "migrations/0007_message_reviewed.sql",
  ]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
  } as Env;
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

function post(token: string, body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      Cookie: `tango_session=${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  };
}

describe("ledger invoice edit", () => {
  it("opens a lot from Assessments and balances, then the invoice", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const ledger = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(ledger.status).toBe(200);
      const ledgerHtml = await ledger.text();
      expect(ledgerHtml).toContain("Assessments and balances");
      expect(ledgerHtml).toContain('class="money-link" href="/a/tango-mar/admin/ledger/prop_14"><span class="money owe">$1,200.00</span>');
      expect(ledgerHtml).toContain('class="money-link" href="/a/tango-mar/admin/ledger/prop_14"><span class="money settled">$0.00</span>');
      expect(ledgerHtml).toContain("Sam Rivera");

      const lot = await app.request("http://localhost/a/tango-mar/admin/ledger/prop_14", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(lot.status).toBe(200);
      const lotHtml = await lot.text();
      expect(lotHtml).toContain("<h1>Lot 14</h1>");
      expect(lotHtml).toContain("Sam Rivera");
      expect(lotHtml).toContain('class="money-link" href="/a/tango-mar/admin/invoices/invoice_sam_2026"><span class="money owe">$1,200.00</span>');
      expect(lotHtml).toContain("2026-14-ANNUAL");

      const owners = await app.request("http://localhost/a/tango-mar/admin/owners", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(owners.status).toBe(200);
      const ownersHtml = await owners.text();
      expect(ownersHtml).toContain('class="money-link" href="/a/tango-mar/admin/ledger/prop_14"');
      const person = await app.request(
        "http://localhost/a/tango-mar/admin/owners/user_sam",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(person.status).toBe(200);
      expect(await person.text()).toContain('Primary lot balance <a class="money-link" href="/a/tango-mar/admin/ledger/prop_14">');

      const invoice = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      expect(invoice.status).toBe(200);
      const html = await invoice.text();
      expect(html).toContain('action="/a/tango-mar/admin/invoices/invoice_sam_2026"');
      expect(html).toContain('name="amount"');
      expect(html).toContain('value="1200.00"');
      expect(html).toContain('name="due_on"');
      expect(html).toContain('value="2026-03-01"');
      expect(html).toContain("1042");
      expect(html).toContain('type="checkbox" name="confirm" value="yes" required');
      expect(html).toContain("Delete this payment");
      expect(html).toContain('action="/a/tango-mar/admin/invoices/invoice_sam_2026/payments/payment_sam_2026/delete"');
      expect(html).not.toContain("confirm(");
      expect(html).toContain("A payment is recorded on this invoice, so delete stays blocked.");
      expect(html).not.toContain('action="/a/tango-mar/admin/invoices/invoice_sam_2026/delete"');
    } finally {
      sqlite.close();
    }
  });

  it("lets an admin adjust lot 14 while the recorded payment blocks delete", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const saved = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026",
        post(token, {
          description: "Adjusted annual assessment",
          amount: "1500.00",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-04-15",
          status: "paid",
        }),
        env,
      );
      expect(saved.status).toBe(303);
      expect(saved.headers.get("Location")).toBe("/a/tango-mar/admin/invoices/invoice_sam_2026");
      expect(decodeURIComponent(saved.headers.get("Set-Cookie") ?? "")).toContain(
        "Status is partial based on payments on this invoice.",
      );
      expect(sqlite.prepare("SELECT description, amount_cents, due_on, status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({
        description: "Adjusted annual assessment",
        amount_cents: 150000,
        due_on: "2026-04-15",
        status: "partial",
      });
      expect(sqlite.prepare("SELECT amount_cents FROM payments WHERE id = 'payment_sam_2026'").get()).toEqual({ amount_cents: 120000 });

      const blocked = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(blocked.status).toBe(303);
      expect(decodeURIComponent(blocked.headers.get("Set-Cookie") ?? "")).toContain(
        "That invoice was not deleted because a payment is recorded on it.",
      );
      expect(sqlite.prepare("SELECT id FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ id: "invoice_sam_2026" });

      const assessment = await app.request(
        "http://localhost/a/tango-mar/admin/assessments/assessment_2026_annual/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(assessment.status).toBe(303);
      expect(sqlite.prepare("SELECT id FROM assessments WHERE id = 'assessment_2026_annual'").get()).toEqual({
        id: "assessment_2026_annual",
      });
      expect(sqlite.prepare("SELECT action, entity_id FROM audit_log WHERE action = 'invoice_update'").get()).toEqual({
        action: "invoice_update",
        entity_id: "invoice_sam_2026",
      });
    } finally {
      sqlite.close();
    }
  });

  it("deletes an invoice with no payment after confirmation and voids another", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const page = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_casey_open",
        { headers: { Cookie: `tango_session=${token}` } },
        env,
      );
      const html = await page.text();
      expect(html).toContain('action="/a/tango-mar/admin/invoices/invoice_casey_open/delete"');
      expect(html).toContain("Delete this invoice");

      const unconfirmed = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_casey_open/delete",
        post(token, {}),
        env,
      );
      expect(unconfirmed.status).toBe(303);
      expect(decodeURIComponent(unconfirmed.headers.get("Set-Cookie") ?? "")).toContain("Confirm the delete first.");
      expect(sqlite.prepare("SELECT id FROM invoices WHERE id = 'invoice_casey_open'").get()).toEqual({ id: "invoice_casey_open" });

      const removed = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_casey_open/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(removed.status).toBe(303);
      expect(removed.headers.get("Location")).toBe("/a/tango-mar/admin/ledger/prop_27");
      expect(sqlite.prepare("SELECT id FROM invoices WHERE id = 'invoice_casey_open'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT action, detail FROM audit_log WHERE action = 'invoice_delete'").get()).toEqual({
        action: "invoice_delete",
        detail: "OPEN-27 for lot 27",
      });

      const voided = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_casey_2026",
        post(token, {
          description: "2026 annual assessment",
          amount: "50.00",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-03-01",
          status: "void",
        }),
        env,
      );
      expect(voided.status).toBe(303);
      expect(decodeURIComponent(voided.headers.get("Set-Cookie") ?? "")).toContain("saved as void");
      expect(sqlite.prepare("SELECT amount_cents, status FROM invoices WHERE id = 'invoice_casey_2026'").get()).toEqual({
        amount_cents: 5000,
        status: "void",
      });

      const reopened = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_casey_2026",
        post(token, {
          description: "2026 annual assessment",
          amount: "50.00",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-03-01",
          status: "paid",
        }),
        env,
      );
      expect(reopened.status).toBe(303);
      expect(decodeURIComponent(reopened.headers.get("Set-Cookie") ?? "")).toContain("Status is open based on payments on this invoice.");
      expect(sqlite.prepare("SELECT amount_cents, status FROM invoices WHERE id = 'invoice_casey_2026'").get()).toEqual({
        amount_cents: 5000,
        status: "open",
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects a bad amount, a missing invoice, and anyone who is not a board admin", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const owner = await signIn(sqlite, "user_sam");
    try {
      const bad = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026",
        post(admin, {
          description: "",
          amount: "-5",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-02-31",
          status: "nope",
        }),
        env,
      );
      expect(bad.status).toBe(303);
      expect(decodeURIComponent(bad.headers.get("Set-Cookie") ?? "")).toContain("Check the description, amounts, dates, and status.");
      expect(sqlite.prepare("SELECT amount_cents, description FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({
        amount_cents: 120000,
        description: "2026 annual assessment",
      });

      const same = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026",
        post(admin, {
          description: "2026 annual assessment",
          amount: "1200.00",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-03-01",
          status: "paid",
        }),
        env,
      );
      expect(same.status).toBe(303);
      expect(sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ status: "paid" });

      const missing = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/missing",
        { headers: { Cookie: `tango_session=${admin}` } },
        env,
      );
      expect(missing.status).toBe(404);
      const missingLot = await app.request(
        "http://localhost/a/tango-mar/admin/ledger/missing",
        { headers: { Cookie: `tango_session=${admin}` } },
        env,
      );
      expect(missingLot.status).toBe(404);

      const resident = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026",
        { headers: { Cookie: `tango_session=${owner}` } },
        env,
      );
      expect(resident.status).toBe(403);
      const residentPost = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026",
        post(owner, {
          description: "Hacked",
          amount: "1.00",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-03-01",
          status: "void",
        }),
        env,
      );
      expect(residentPost.status).toBe(403);
      expect(sqlite.prepare("SELECT description, status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({
        description: "2026 annual assessment",
        status: "paid",
      });

      sqlite.prepare("UPDATE memberships SET is_admin = 0 WHERE user_id = 'user_jordan'").run();
      const board = await app.request(
        "http://localhost/a/tango-mar/admin/ledger",
        { headers: { Cookie: `tango_session=${admin}` } },
        env,
      );
      expect(board.status).toBe(200);
      const viewOnly = await board.text();
      expect(viewOnly).toContain("View only. Edit access is required to create, edit, or delete.");
      expect(viewOnly).not.toContain("Save invoice");
      const boardWrite = await app.request(
        "http://localhost/a/tango-mar/admin/invoices",
        post(admin, {
          property_id: "prop_14",
          description: "Should not save",
          amount: "1.00",
          late_fee: "0",
          issued_on: "2026-01-15",
          due_on: "2026-03-01",
        }),
        env,
      );
      expect(boardWrite.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });

  it("deletes the lot 14 payment, refreshes status, then lets the invoice be deleted", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    sqlite
      .prepare(
        `INSERT INTO payments (
           id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "payment_sam_partial",
        "assoc_tango_mar",
        "prop_14",
        "invoice_sam_2026",
        10000,
        "cash",
        "",
        "2026-02-21",
        "",
        "user_jordan",
        "2026-02-21T18:00:00.000Z",
      );
    try {
      const removed = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/payments/payment_sam_2026/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(removed.status).toBe(303);
      expect(removed.headers.get("Location")).toBe("/a/tango-mar/admin/invoices/invoice_sam_2026");
      expect(decodeURIComponent(removed.headers.get("Set-Cookie") ?? "")).toContain("Payment deleted.");
      expect(sqlite.prepare("SELECT id FROM payments WHERE id = 'payment_sam_2026'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ status: "partial" });
      expect(sqlite.prepare("SELECT action, actor_user_id, entity_type, entity_id, detail FROM audit_log WHERE action = 'payment_delete'").get()).toEqual({
        action: "payment_delete",
        actor_user_id: "user_jordan",
        entity_type: "payment",
        entity_id: "payment_sam_2026",
        detail: "Lot 14 · 2026-14-ANNUAL · $1,200.00 · check 1042",
      });

      const stillBlocked = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(stillBlocked.status).toBe(303);
      expect(decodeURIComponent(stillBlocked.headers.get("Set-Cookie") ?? "")).toContain(
        "That invoice was not deleted because a payment is recorded on it.",
      );
      expect(sqlite.prepare("SELECT id FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ id: "invoice_sam_2026" });

      const cleared = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/payments/payment_sam_partial/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(cleared.status).toBe(303);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM payments WHERE invoice_id = 'invoice_sam_2026'").get()).toEqual({ n: 0 });
      expect(sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ status: "open" });

      const invoice = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(invoice.status).toBe(303);
      expect(invoice.headers.get("Location")).toBe("/a/tango-mar/admin/ledger/prop_14");
      expect(sqlite.prepare("SELECT id FROM invoices WHERE id = 'invoice_sam_2026'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("keeps the payment when delete is not confirmed", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      const blocked = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/payments/payment_sam_2026/delete",
        post(token, {}),
        env,
      );
      expect(blocked.status).toBe(303);
      expect(blocked.headers.get("Location")).toBe("/a/tango-mar/admin/invoices/invoice_sam_2026");
      expect(decodeURIComponent(blocked.headers.get("Set-Cookie") ?? "")).toContain("Confirm the delete first.");
      expect(sqlite.prepare("SELECT id, amount_cents FROM payments WHERE id = 'payment_sam_2026'").get()).toEqual({
        id: "payment_sam_2026",
        amount_cents: 120000,
      });
      expect(sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ status: "paid" });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment_delete'").get()).toEqual({ n: 0 });

      const otherInvoice = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_casey_open/payments/payment_sam_2026/delete",
        post(token, { confirm: "yes" }),
        env,
      );
      expect(otherInvoice.status).toBe(404);
      expect(sqlite.prepare("SELECT id FROM payments WHERE id = 'payment_sam_2026'").get()).toEqual({ id: "payment_sam_2026" });
    } finally {
      sqlite.close();
    }
  });

  it("refuses payment delete for anyone who is not a board admin", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const owner = await signIn(sqlite, "user_sam");
    const admin = await signIn(sqlite, "user_jordan");
    try {
      const resident = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/payments/payment_sam_2026/delete",
        post(owner, { confirm: "yes" }),
        env,
      );
      expect(resident.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM payments WHERE id = 'payment_sam_2026'").get()).toEqual({ id: "payment_sam_2026" });
      expect(sqlite.prepare("SELECT status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({ status: "paid" });

      sqlite.prepare("UPDATE memberships SET is_admin = 0 WHERE user_id = 'user_jordan'").run();
      const board = await app.request(
        "http://localhost/a/tango-mar/admin/invoices/invoice_sam_2026/payments/payment_sam_2026/delete",
        post(admin, { confirm: "yes" }),
        env,
      );
      expect(board.status).toBe(403);
      expect(sqlite.prepare("SELECT id FROM payments WHERE id = 'payment_sam_2026'").get()).toEqual({ id: "payment_sam_2026" });
    } finally {
      sqlite.close();
    }
  });
});

describe("admin overview outstanding", () => {
  it("sums remaining balances on open and partial invoices", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const token = await signIn(sqlite, "user_jordan");
    try {
      expect(await outstandingInvoiceCents(db, "assoc_tango_mar")).toBe(160050);
      const overview = await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(overview.status).toBe(200);
      const html = await overview.text();
      expect(html).toContain('<a class="card" href="/a/tango-mar/admin/ledger"><h2>$1,600.50</h2><p>Total Outstanding</p></a>');
      expect(html).not.toContain("<h2>Total outstanding</h2>");
      const accessStart = html.indexOf("<summary>Current admins</summary>");
      const access = html.slice(accessStart, html.indexOf("</details>", accessStart));
      expect(access).toContain('href="/a/tango-mar/admin/owners/user_jordan">Jordan Lee</a>');
      expect(access).toContain("jordan.lee@example.com");
      expect(access).not.toContain("Sam Rivera");
      expect(access).not.toContain("Casey Nguyen");
      expect(html).not.toContain("$2,800.50");

      sqlite
        .prepare(
          `INSERT INTO invoices (
             id, association_id, property_id, invoice_number, description,
             amount_cents, late_fee_cents, issued_on, due_on, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "invoice_partial",
          "assoc_tango_mar",
          "prop_3",
          "PART-3",
          "Partial dues",
          10000,
          0,
          "2026-02-01",
          "2026-03-01",
          "partial",
          "2026-02-01T15:00:00Z",
        );
      sqlite
        .prepare(
          `INSERT INTO payments (
             id, association_id, property_id, invoice_id, amount_cents, method, reference,
             paid_on, notes, recorded_by_user_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "payment_partial",
          "assoc_tango_mar",
          "prop_3",
          "invoice_partial",
          2500,
          "check",
          "200",
          "2026-02-15",
          "",
          "user_jordan",
          "2026-02-15T15:00:00Z",
        );
      sqlite
        .prepare(
          `INSERT INTO invoices (
             id, association_id, property_id, invoice_number, description,
             amount_cents, late_fee_cents, issued_on, due_on, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "invoice_void",
          "assoc_tango_mar",
          "prop_3",
          "VOID-3",
          "Voided charge",
          50000,
          0,
          "2026-02-01",
          "2026-03-01",
          "void",
          "2026-02-01T15:00:00Z",
        );

      expect(await outstandingInvoiceCents(db, "assoc_tango_mar")).toBe(167550);
      const again = await app.request("http://localhost/a/tango-mar/admin", { headers: { Cookie: `tango_session=${token}` } }, env);
      expect(await again.text()).toContain("$1,675.50");
    } finally {
      sqlite.close();
    }
  });
});

describe("owner import template", () => {
  it("downloads the sample CSV for an admin and refuses a resident", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const resident = await signIn(sqlite, "user_sam");
    try {
      const page = await app.request("http://localhost/a/tango-mar/admin/import", { headers: { Cookie: `tango_session=${admin}` } }, env);
      expect(await page.text()).toContain('href="/a/tango-mar/admin/import/template.csv"');
      const denied = await app.request(
        "http://localhost/a/tango-mar/admin/import/template.csv",
        { headers: { Cookie: `tango_session=${resident}` } },
        env,
      );
      expect(denied.status).toBe(403);
      const file = await app.request(
        "http://localhost/a/tango-mar/admin/import/template.csv",
        { headers: { Cookie: `tango_session=${admin}` } },
        env,
      );
      expect(file.status).toBe(200);
      expect(file.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
      expect(file.headers.get("Content-Disposition")).toBe('attachment; filename="tango-mar-owners-template.csv"');
      const body = await file.text();
      expect(body).toBe(readFileSync("samples/owner-import-template.csv", "utf8"));
      expect(body.split("\n").filter((line) => line.length > 0)).toHaveLength(3);
    } finally {
      sqlite.close();
    }
  });
});
