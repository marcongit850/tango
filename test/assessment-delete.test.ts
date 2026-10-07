import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { deleteAssessment } from "../src/db";
import { todayIso } from "../src/lib/dates";
import { defaultDuesYear } from "../src/lib/dues";
import { sha256Hex } from "../src/lib/tokens";
import type { AssessmentAdminRow } from "../src/db";
import type { Association } from "../src/types";
import { ledgerPage } from "../src/views/admin";

const association: Association = {
  id: "assoc_tango_mar",
  slug: "tango-mar",
  name: "Tango Mar",
  legal_name: "Tango Mar Property Owners Association",
  address_line1: "31 Tang O Mar Drive",
  city: "Miramar Beach",
  state: "FL",
  postal_code: "32550",
  county: "Walton County",
  timezone: "America/Chicago",
};

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
  ]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function count(sqlite: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number };
  return Number(row.n);
}

function portalEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
    RESEND_API_KEY: "",
  } as Env;
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
  return token;
}

function formByAction(html: string, action: string): string {
  const marker = `action="${action}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const formStart = html.lastIndexOf("<form", start);
  const end = html.indexOf("</form>", start);
  return html.slice(formStart, end);
}

function assessment(id: string, name: string, invoiceCount: number): AssessmentAdminRow {
  return {
    id,
    name,
    description: "",
    amount_cents: 62500,
    due_on: "2027-03-01",
    opens_on: "2027-01-01",
    lot_type: "improved",
    invoice_count: invoiceCount,
  };
}

function insertAssessment(sqlite: DatabaseSync, id: string, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO assessments (id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at)
       VALUES (?, 'assoc_tango_mar', ?, '', 62500, '2027-03-01', '2027-01-01', 'improved', '2026-10-06T00:00:00Z')`,
    )
    .run(id, name);
}

function insertInvoice(
  sqlite: DatabaseSync,
  row: { id: string; propertyId: string; assessmentId: string; number: string; status: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO invoices (
         id, association_id, property_id, assessment_id, invoice_number, description,
         amount_cents, late_fee_cents, issued_on, due_on, status, created_at
       ) VALUES (?, 'assoc_tango_mar', ?, ?, ?, '2027 annual assessment', 62500, 0, '2027-01-01', '2027-03-01', ?, '2027-01-01T00:00:00Z')`,
    )
    .run(row.id, row.propertyId, row.assessmentId, row.number, row.status);
}

describe("annual dues delete", () => {
  it("shows Delete with a confirm checkbox when the assessment already has invoices", () => {
    const html = ledgerPage({
      association,
      ledger: [],
      ownersByProperty: new Map(),
      properties: [],
      invoices: [],
      assessments: [
        assessment("assessment_2027_improved", "2027 annual assessment (improved lots)", 3),
        assessment("assessment_2028_improved", "2028 annual assessment (improved lots)", 0),
      ],
      duesReady: true,
      duesYear: 2027,
    });
    expect(html).toContain("Delete removes the assessment and its unpaid invoices.");
    expect(html).toContain("Delete is blocked when a payment is recorded on one of those invoices.");
    const assigned = formByAction(html, "/a/tango-mar/admin/assessments/assessment_2027_improved/delete");
    expect(assigned).toContain('type="checkbox" name="confirm" value="yes" required');
    expect(assigned).toContain("Delete this assessment and its unpaid invoices");
    expect(assigned).toContain(">Delete</button>");
    const empty = formByAction(html, "/a/tango-mar/admin/assessments/assessment_2028_improved/delete");
    expect(empty).toContain('name="confirm" value="yes" required');
    expect(empty).toContain("> Confirm</label>");
    expect(empty).not.toContain("Delete this assessment and its unpaid invoices");
  });

  it("removes an assigned assessment and invoices that have no payment", async () => {
    const { sqlite, db } = openPortal();
    insertAssessment(sqlite, "assessment_mistake", "2027 annual assessment (improved lots)");
    insertInvoice(sqlite, { id: "inv_3", propertyId: "prop_3", assessmentId: "assessment_mistake", number: "DUES-3-MISTAKE", status: "open" });
    insertInvoice(sqlite, { id: "inv_14", propertyId: "prop_14", assessmentId: "assessment_mistake", number: "DUES-14-MISTAKE", status: "open" });
    insertInvoice(sqlite, { id: "inv_void", propertyId: "prop_27", assessmentId: "assessment_mistake", number: "DUES-27-VOID", status: "void" });
    sqlite
      .prepare(
        `INSERT INTO payments (
           id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
         ) VALUES ('pay_unallocated', 'assoc_tango_mar', 'prop_3', NULL, 1000, 'check', '99', '2027-02-01', '', 'user_jordan', '2027-02-01T00:00:00Z')`,
      )
      .run();

    const outcome = await deleteAssessment(db, "assoc_tango_mar", "assessment_mistake");
    expect(outcome).toEqual({
      ok: true,
      name: "2027 annual assessment (improved lots)",
      invoicesRemoved: 3,
    });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_mistake'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_mistake'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE id = 'pay_unallocated'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE id = 'invoice_sam_2026'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE id = 'payment_sam_2026'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_2026_annual'")).toBe(1);
    sqlite.close();
  });

  it("leaves the assessment and every invoice when any invoice has a payment", async () => {
    const { sqlite, db } = openPortal();
    insertAssessment(sqlite, "assessment_paid", "2027 annual assessment (unimproved lots)");
    insertInvoice(sqlite, { id: "inv_open", propertyId: "prop_3", assessmentId: "assessment_paid", number: "DUES-3-PAID", status: "open" });
    insertInvoice(sqlite, { id: "inv_paid", propertyId: "prop_14", assessmentId: "assessment_paid", number: "DUES-14-PAID", status: "partial" });
    sqlite
      .prepare(
        `INSERT INTO payments (
           id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
         ) VALUES ('pay_partial', 'assoc_tango_mar', 'prop_14', 'inv_paid', 5000, 'check', '100', '2027-02-01', '', 'user_jordan', '2027-02-01T00:00:00Z')`,
      )
      .run();

    const outcome = await deleteAssessment(db, "assoc_tango_mar", "assessment_paid");
    expect(outcome).toEqual({ ok: false, reason: "payments" });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_paid'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_paid'")).toBe(2);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE id = 'pay_partial'")).toBe(1);
    expect(await deleteAssessment(db, "assoc_tango_mar", "missing")).toEqual({ ok: false, reason: "missing" });
    expect(await deleteAssessment(db, "other", "assessment_2026_annual")).toEqual({ ok: false, reason: "missing" });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_2026_annual'")).toBe(1);
    sqlite.close();
  });
});

describe("annual dues delete route", () => {
  it("lets an admin delete an assigned assessment whose invoices are unpaid", async () => {
    const { sqlite, db } = openPortal();
    insertAssessment(sqlite, "assessment_mistake", "2027 annual assessment (improved lots)");
    insertInvoice(sqlite, { id: "inv_3", propertyId: "prop_3", assessmentId: "assessment_mistake", number: "DUES-3-MISTAKE", status: "open" });
    insertInvoice(sqlite, { id: "inv_14", propertyId: "prop_14", assessmentId: "assessment_mistake", number: "DUES-14-MISTAKE", status: "open" });
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const owner = await signIn(sqlite, "user_sam");
    const headers = { Cookie: `tango_session=${admin}`, Origin: "http://localhost" };

    const page = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    expect(page.status).toBe(200);
    const html = await page.text();
    const assigned = formByAction(html, "/a/tango-mar/admin/assessments/assessment_mistake/delete");
    expect(assigned).toContain("Delete this assessment and its unpaid invoices");
    const seeded = formByAction(html, "/a/tango-mar/admin/assessments/assessment_2026_annual/delete");
    expect(seeded).toContain("Delete this assessment and its unpaid invoices");
    const scheduled = formByAction(html, "/a/tango-mar/admin/assessments/assessment_2027_annual/delete");
    expect(scheduled).toContain("> Confirm</label>");

    const unconfirmed = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_mistake/delete",
      { method: "POST", headers, body: "" },
      env,
    );
    expect(unconfirmed.status).toBe(303);
    expect(decodeURIComponent(unconfirmed.headers.get("Set-Cookie") ?? "")).toContain("warn:Confirm the delete first.");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_mistake'")).toBe(1);

    const forbidden = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_mistake/delete",
      {
        method: "POST",
        headers: { Cookie: `tango_session=${owner}`, Origin: "http://localhost" },
        body: new URLSearchParams({ confirm: "yes" }),
      },
      env,
    );
    expect(forbidden.status).toBe(403);

    const deleted = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_mistake/delete",
      { method: "POST", headers, body: new URLSearchParams({ confirm: "yes" }) },
      env,
    );
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("Location")).toBe("/a/tango-mar/admin/ledger#dues");
    expect(decodeURIComponent(deleted.headers.get("Set-Cookie") ?? "")).toContain(
      "ok:Assessment deleted. 2 unpaid invoices were removed.",
    );
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_mistake'")).toBe(0);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE id IN ('inv_3', 'inv_14')")).toBe(0);
    const audit = sqlite
      .prepare("SELECT detail FROM audit_log WHERE action = 'assessment_delete' AND entity_id = 'assessment_mistake'")
      .get() as { detail: string };
    expect(audit.detail).toBe("2027 annual assessment (improved lots). 2 unpaid invoices were removed.");

    const blocked = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2026_annual/delete",
      { method: "POST", headers, body: new URLSearchParams({ confirm: "yes" }) },
      env,
    );
    expect(blocked.status).toBe(303);
    expect(decodeURIComponent(blocked.headers.get("Set-Cookie") ?? "")).toContain(
      "warn:That assessment was not deleted. A payment is recorded on one of its invoices.",
    );
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE id = 'assessment_2026_annual'")).toBe(1);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_2026_annual'")).toBe(2);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM payments WHERE id = 'payment_sam_2026'")).toBe(1);

    const missing = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/does-not-exist/delete",
      { method: "POST", headers, body: new URLSearchParams({ confirm: "yes" }) },
      env,
    );
    const missingFlash = decodeURIComponent(missing.headers.get("Set-Cookie") ?? "");
    expect(missingFlash).toContain("warn:That assessment was not deleted.");
    expect(missingFlash).not.toContain("A payment is recorded");
    expect(missingFlash).not.toContain("may already have invoices");
    sqlite.close();
  });
});

describe("annual dues assign", () => {
  it("keeps Assign to matching lots and requires a confirm checkbox", () => {
    const html = ledgerPage({
      association,
      ledger: [],
      ownersByProperty: new Map(),
      properties: [],
      invoices: [],
      assessments: [assessment("assessment_2027_improved", "2027 annual assessment (improved lots)", 0)],
      duesReady: true,
      duesYear: 2027,
    });
    const assign = formByAction(html, "/a/tango-mar/admin/assessments/assessment_2027_improved/assign");
    expect(assign).toContain('type="checkbox" name="confirm" value="yes" required');
    expect(assign).toContain("Assign this assessment to matching lots");
    expect(assign).toContain('class="secondary" type="submit">Assign to matching lots</button>');
    expect(html).toContain(
      "Pick a schedule and the amount per installment for improved and unimproved lots. Annual is the amount for the year. Add a year creates each installment for both lot types. The open date and due date are for the first installment. Later installments keep that gap and step forward by the period.",
    );
    expect(html).not.toContain("improved lots at $625");
    expect(html).not.toContain("unimproved lots at $100");
    expect(html).toContain("On the open date, each active lot of that type that does not already have this assessment gets an invoice.");
    expect(html).toContain("A voided invoice stays void.");
    expect(html).toContain("Leave the open date blank if you want to invoice only by hand.");
    expect(html).toContain("Upcoming stays Scheduled until that open date.");
    expect(html).not.toContain("A blank open date is not automatic.");
    expect(assign).not.toContain('type="hidden" name="confirm"');
    expect(html.indexOf('action="/a/tango-mar/admin/assessments/assessment_2027_improved/assign"')).toBeLessThan(
      html.indexOf("<h3>Add a year</h3>"),
    );
  });

  it("refuses assign until the checkbox is confirmed, then writes invoices", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const owner = await signIn(sqlite, "user_sam");
    const headers = { Cookie: `tango_session=${admin}`, Origin: "http://localhost" };
    const before = count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_2027_annual'");

    const page = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    expect(page.status).toBe(200);
    const assign = formByAction(await page.text(), "/a/tango-mar/admin/assessments/assessment_2027_annual/assign");
    expect(assign).toContain("Assign this assessment to matching lots");
    expect(assign).toContain(">Assign to matching lots</button>");

    const unconfirmed = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2027_annual/assign",
      { method: "POST", headers, body: "" },
      env,
    );
    expect(unconfirmed.status).toBe(303);
    expect(unconfirmed.headers.get("Location")).toBe("/a/tango-mar/admin/ledger#dues");
    expect(decodeURIComponent(unconfirmed.headers.get("Set-Cookie") ?? "")).toContain("warn:Confirm the assign first.");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_2027_annual'")).toBe(before);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'assessment_assign'")).toBe(0);

    const unchecked = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2027_annual/assign",
      { method: "POST", headers, body: new URLSearchParams({ confirm: "no" }) },
      env,
    );
    expect(decodeURIComponent(unchecked.headers.get("Set-Cookie") ?? "")).toContain("warn:Confirm the assign first.");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_2027_annual'")).toBe(before);

    const forbidden = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2027_annual/assign",
      {
        method: "POST",
        headers: { Cookie: `tango_session=${owner}`, Origin: "http://localhost" },
        body: new URLSearchParams({ confirm: "yes" }),
      },
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_2027_annual'")).toBe(before);

    const assigned = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2027_annual/assign",
      { method: "POST", headers, body: new URLSearchParams({ confirm: "yes" }) },
      env,
    );
    expect(assigned.status).toBe(303);
    expect(assigned.headers.get("Location")).toBe("/a/tango-mar/admin/ledger#dues");
    const flash = decodeURIComponent(assigned.headers.get("Set-Cookie") ?? "");
    expect(flash).toContain("ok:Assigned 2027 annual assessment to ");
    expect(flash).not.toContain("Confirm the assign first.");
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_2027_annual'")).toBeGreaterThan(before);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'assessment_assign' AND entity_id = 'assessment_2027_annual'")).toBe(1);
    sqlite.close();
  });
});

describe("annual dues add year", () => {
  function addForm(html: string): string {
    return formByAction(html, "/a/tango-mar/admin/assessments");
  }

  it("prefills amounts from the previous year and still edits amount and dates on a row", () => {
    const html = ledgerPage({
      association,
      ledger: [],
      ownersByProperty: new Map(),
      properties: [],
      invoices: [],
      assessments: [
        {
          id: "assessment_2026_improved",
          name: "2026 annual assessment (improved lots)",
          description: "",
          amount_cents: 70000,
          due_on: "2026-03-01",
          opens_on: "2026-01-01",
          lot_type: "improved",
          invoice_count: 2,
        },
        {
          id: "assessment_2026_unimproved",
          name: "2026 annual assessment (unimproved lots)",
          description: "",
          amount_cents: 15000,
          due_on: "2026-03-01",
          opens_on: "2026-01-01",
          lot_type: "unimproved",
          invoice_count: 0,
        },
      ],
      duesReady: true,
      duesYear: 2027,
    });
    const add = addForm(html);
    expect(add.indexOf(">Year<input")).toBeLessThan(add.indexOf(">Schedule<select"));
    expect(add.indexOf(">Schedule<select")).toBeLessThan(add.indexOf('data-dues-amount="improved"'));
    expect(add.indexOf('data-dues-amount="improved"')).toBeLessThan(add.indexOf('data-dues-amount="unimproved"'));
    expect(add).toContain(">Improved lot amount per year<input");
    expect(add).toContain(">Unimproved lot amount per year<input");
    expect(add).toContain('value="annual" selected');
    expect(add.indexOf('data-dues-amount="unimproved"')).toBeLessThan(add.indexOf(">Open date<input"));
    expect(add.indexOf(">Open date<input")).toBeLessThan(add.indexOf(">Due date<input"));
    expect(add).toContain('name="year" type="text" value="2027" required');
    expect(add).toContain('name="improved_amount" type="text" value="700.00" required');
    expect(add).toContain('name="unimproved_amount" type="text" value="150.00" required');
    expect(add).toContain('name="opens_on" type="date" value="2027-01-01" required');
    expect(add).toContain('name="due_on" type="date" value="2027-03-01" required');
    expect(add).toContain(">Add improved and unimproved dues</button>");
    expect(html).toContain('<script src="/dues-schedule.js"></script>');
    expect(html).toContain("Pick a schedule and the amount per installment");

    const edit = formByAction(html, "/a/tango-mar/admin/assessments/assessment_2026_improved");
    expect(html).toContain("2026 annual assessment (improved lots)");
    expect(html).toContain("2026 annual assessment (unimproved lots)");
    expect(html).toContain("<td>Improved</td>");
    expect(html).toContain("<td>Unimproved</td>");
    expect(edit).toContain('name="amount" type="text" value="700.00" required');
    expect(edit).toContain('name="opens_on" type="date" value="2026-01-01"');
    expect(edit).toContain('name="due_on" type="date" value="2026-03-01" required');
    expect(edit).toContain(">Save assessment</button>");
  });

  it("falls back to 625 and 100, then prefills the previous year on the ledger", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const headers = { Cookie: `tango_session=${admin}` };
    const year = defaultDuesYear(todayIso("America/Chicago"));

    const first = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    expect(first.status).toBe(200);
    const fallback = addForm(await first.text());
    expect(fallback).toContain('name="improved_amount" type="text" value="625.00" required');
    expect(fallback).toContain('name="unimproved_amount" type="text" value="100.00" required');
    expect(fallback).toContain(">Improved lot amount per year<input");
    expect(fallback).toContain('value="annual" selected');
    expect(fallback).toContain(`name="opens_on" type="date" value="${year}-01-01" required`);
    expect(fallback).toContain(`name="due_on" type="date" value="${year}-03-01" required`);

    sqlite
      .prepare(
        `INSERT INTO assessments (id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at)
         VALUES
           ('dues_2026_improved', 'assoc_tango_mar', '2026 annual assessment (improved lots)', '', 70000, '2026-03-01', '2026-01-01', 'improved', '2026-01-01T00:00:00Z'),
           ('dues_2026_unimproved', 'assoc_tango_mar', '2026 annual assessment (unimproved lots)', '', 15000, '2026-03-01', '2026-01-01', 'unimproved', '2026-01-01T00:00:00Z')`,
      )
      .run();
    const second = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    const prefilled = addForm(await second.text());
    expect(prefilled).toContain('name="improved_amount" type="text" value="700.00" required');
    expect(prefilled).toContain('name="unimproved_amount" type="text" value="150.00" required');
    expect(prefilled).toContain(`name="year" type="text" value="${year}" required`);
    sqlite.close();
  });

  it("saves the amounts and dates entered for a new year", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const headers = { Cookie: `tango_session=${admin}`, Origin: "http://localhost" };

    const created = await app.request(
      "http://localhost/a/tango-mar/admin/assessments",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          year: "2028",
          improved_amount: "750.00",
          unimproved_amount: "125.50",
          opens_on: "2028-01-15",
          due_on: "2028-04-01",
        }),
      },
      env,
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("Location")).toBe("/a/tango-mar/admin/ledger#dues");
    expect(decodeURIComponent(created.headers.get("Set-Cookie") ?? "")).toContain(
      "ok:Added 2028 annual assessment (improved lots) and 2028 annual assessment (unimproved lots).",
    );
    const rows = sqlite
      .prepare(
        `SELECT name, description, amount_cents, opens_on, due_on, lot_type
         FROM assessments
         WHERE name LIKE '2028 annual assessment%'
         ORDER BY lot_type`,
      )
      .all() as { name: string; description: string; amount_cents: number; opens_on: string; due_on: string; lot_type: string }[];
    expect(rows).toEqual([
      {
        name: "2028 annual assessment",
        description: "HOA dues for improved lots.",
        amount_cents: 75000,
        opens_on: "2028-01-15",
        due_on: "2028-04-01",
        lot_type: "improved",
      },
      {
        name: "2028 annual assessment",
        description: "HOA dues for unimproved lots.",
        amount_cents: 12550,
        opens_on: "2028-01-15",
        due_on: "2028-04-01",
        lot_type: "unimproved",
      },
    ]);

    for (const improvedAmount of ["0", "-10", "abc", ""]) {
      const rejected = await app.request(
        "http://localhost/a/tango-mar/admin/assessments",
        {
          method: "POST",
          headers,
          body: new URLSearchParams({
            year: "2029",
            improved_amount: improvedAmount,
            unimproved_amount: "100",
            opens_on: "2029-01-01",
            due_on: "2029-03-01",
          }),
        },
        env,
      );
      expect(rejected.status).toBe(303);
      expect(decodeURIComponent(rejected.headers.get("Set-Cookie") ?? "")).toContain(
        "warn:Enter positive amounts and valid open and due dates.",
      );
    }
    const badDate = await app.request(
      "http://localhost/a/tango-mar/admin/assessments",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          year: "2029",
          improved_amount: "625",
          unimproved_amount: "100.00",
          opens_on: "2029-02-31",
          due_on: "2029-03-01",
        }),
      },
      env,
    );
    expect(badDate.status).toBe(303);
    expect(decodeURIComponent(badDate.headers.get("Set-Cookie") ?? "")).toContain(
      "warn:Enter positive amounts and valid open and due dates.",
    );
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM assessments WHERE name LIKE '2029 annual assessment%'")).toBe(0);
    const badSchedule = await app.request(
      "http://localhost/a/tango-mar/admin/assessments",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          year: "2029",
          schedule: "weekly",
          improved_amount: "625",
          unimproved_amount: "100.00",
          opens_on: "2029-01-01",
          due_on: "2029-03-01",
        }),
      },
      env,
    );
    expect(badSchedule.status).toBe(303);
    expect(decodeURIComponent(badSchedule.headers.get("Set-Cookie") ?? "")).toContain(
      "warn:Choose Monthly, Quarterly, Semi-annual, or Annual.",
    );
    sqlite.close();
  });

  it("creates four installments per lot type for a quarterly year", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const headers = { Cookie: `tango_session=${admin}`, Origin: "http://localhost" };

    const created = await app.request(
      "http://localhost/a/tango-mar/admin/assessments",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          year: "2027",
          schedule: "quarterly",
          improved_amount: "150.00",
          unimproved_amount: "40.00",
          opens_on: "2027-01-01",
          due_on: "2027-03-01",
        }),
      },
      env,
    );
    expect(created.status).toBe(303);
    expect(decodeURIComponent(created.headers.get("Set-Cookie") ?? "")).toContain(
      "ok:Added 2027 dues, Q1 (improved lots) and 2027 dues, Q1 (unimproved lots) and 2027 dues, Q2 (improved lots) and 2027 dues, Q2 (unimproved lots) and 2027 dues, Q3 (improved lots) and 2027 dues, Q3 (unimproved lots) and 2027 dues, Q4 (improved lots) and 2027 dues, Q4 (unimproved lots).",
    );
    const rows = sqlite
      .prepare(
        `SELECT name, description, amount_cents, opens_on, due_on, lot_type
         FROM assessments
         WHERE name LIKE '2027 dues, Q%'
         ORDER BY due_on, lot_type`,
      )
      .all() as { name: string; description: string; amount_cents: number; opens_on: string; due_on: string; lot_type: string }[];
    expect(rows).toEqual([
      { name: "2027 dues, Q1", description: "HOA dues for improved lots.", amount_cents: 15000, opens_on: "2027-01-01", due_on: "2027-03-01", lot_type: "improved" },
      { name: "2027 dues, Q1", description: "HOA dues for unimproved lots.", amount_cents: 4000, opens_on: "2027-01-01", due_on: "2027-03-01", lot_type: "unimproved" },
      { name: "2027 dues, Q2", description: "HOA dues for improved lots.", amount_cents: 15000, opens_on: "2027-04-01", due_on: "2027-06-01", lot_type: "improved" },
      { name: "2027 dues, Q2", description: "HOA dues for unimproved lots.", amount_cents: 4000, opens_on: "2027-04-01", due_on: "2027-06-01", lot_type: "unimproved" },
      { name: "2027 dues, Q3", description: "HOA dues for improved lots.", amount_cents: 15000, opens_on: "2027-07-01", due_on: "2027-09-01", lot_type: "improved" },
      { name: "2027 dues, Q3", description: "HOA dues for unimproved lots.", amount_cents: 4000, opens_on: "2027-07-01", due_on: "2027-09-01", lot_type: "unimproved" },
      { name: "2027 dues, Q4", description: "HOA dues for improved lots.", amount_cents: 15000, opens_on: "2027-10-01", due_on: "2027-12-01", lot_type: "improved" },
      { name: "2027 dues, Q4", description: "HOA dues for unimproved lots.", amount_cents: 4000, opens_on: "2027-10-01", due_on: "2027-12-01", lot_type: "unimproved" },
    ]);
    sqlite.close();
  });

  it("lists dues by year, then installment, and prefills a newer quarterly schedule", () => {
    const html = ledgerPage({
      association,
      ledger: [],
      ownersByProperty: new Map(),
      properties: [],
      invoices: [],
      assessments: [
        { id: "q2u", name: "2027 dues, Q2", description: "", amount_cents: 15000, due_on: "2027-06-01", opens_on: "2027-04-01", lot_type: "unimproved", invoice_count: 0 },
        { id: "a2026", name: "2026 annual assessment (improved lots)", description: "", amount_cents: 70000, due_on: "2026-03-01", opens_on: "2026-01-01", lot_type: "improved", invoice_count: 0 },
        { id: "q1u", name: "2027 dues, Q1", description: "", amount_cents: 4000, due_on: "2027-03-01", opens_on: "2027-01-01", lot_type: "unimproved", invoice_count: 0 },
        { id: "q1i", name: "2027 dues, Q1", description: "", amount_cents: 16000, due_on: "2027-03-01", opens_on: "2027-01-01", lot_type: "improved", invoice_count: 0 },
        { id: "walk", name: "Walkway repair", description: "", amount_cents: 5000, due_on: "2027-11-15", opens_on: "2027-11-01", lot_type: "improved", invoice_count: 0 },
      ],
      duesReady: true,
      duesYear: 2028,
    });
    const q1 = html.indexOf("<td>2027 dues, Q1</td>");
    const q1Next = html.indexOf("<td>2027 dues, Q1</td>", q1 + 1);
    const q2 = html.indexOf("<td>2027 dues, Q2</td>");
    const older = html.indexOf("<td>2026 annual assessment (improved lots)</td>");
    const walk = html.indexOf("<td>Walkway repair</td>");
    expect(q1).toBeGreaterThan(-1);
    expect(q1).toBeLessThan(q1Next);
    expect(html.slice(q1, q1Next)).toContain("<td>Improved</td>");
    expect(q1Next).toBeLessThan(q2);
    expect(q2).toBeLessThan(walk);
    expect(walk).toBeLessThan(older);
    const add = addForm(html);
    expect(add).toContain('value="quarterly" selected');
    expect(add).toContain(">Improved lot amount per quarter<input");
    expect(add).toContain('name="improved_amount" type="text" value="160.00" required');
    expect(add).toContain('name="unimproved_amount" type="text" value="150.00" required');
    expect(add).toContain('name="opens_on" type="date" value="2028-01-01" required');
    expect(add).toContain('name="due_on" type="date" value="2028-03-01" required');
  });

  it("lets a later amount edit stand without rewriting invoices already assigned", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const headers = { Cookie: `tango_session=${admin}`, Origin: "http://localhost" };

    const page = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    const edit = formByAction(await page.text(), "/a/tango-mar/admin/assessments/assessment_2026_annual");
    expect(edit).toContain('name="amount"');
    expect(edit).toContain('name="opens_on"');
    expect(edit).toContain('name="due_on"');

    const saved = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2026_annual",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          name: "2026 annual assessment",
          amount: "999.00",
          opens_on: "2026-01-01",
          due_on: "2026-03-20",
          lot_type: "",
        }),
      },
      env,
    );
    expect(saved.status).toBe(303);
    expect(decodeURIComponent(saved.headers.get("Set-Cookie") ?? "")).toContain(
      "ok:Assessment saved. Invoices already assigned were not changed.",
    );
    expect(sqlite.prepare("SELECT amount_cents, opens_on, due_on FROM assessments WHERE id = 'assessment_2026_annual'").get()).toEqual({
      amount_cents: 99900,
      opens_on: "2026-01-01",
      due_on: "2026-03-20",
    });
    expect(sqlite.prepare("SELECT amount_cents, due_on FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual({
      amount_cents: 120000,
      due_on: "2026-03-01",
    });
    expect(sqlite.prepare("SELECT amount_cents, due_on FROM invoices WHERE id = 'invoice_casey_2026'").get()).toEqual({
      amount_cents: 120000,
      due_on: "2026-03-01",
    });
    sqlite.close();
  });
});

describe("assessment titles", () => {
  it("keeps the lot type on annual dues rows and hides it on owner and admin lists", async () => {
    const { sqlite, db } = openPortal();
    sqlite
      .prepare(
        `INSERT INTO assessments (
           id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at
         ) VALUES (
           'assessment_display', 'assoc_tango_mar', '2027 annual assessment (improved lots)', '',
           62500, '2027-03-01', '2027-01-01', 'improved', '2026-10-06T00:00:00Z'
         )`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, description,
           amount_cents, late_fee_cents, issued_on, due_on, status, created_at
         ) VALUES (
           'inv_display', 'assoc_tango_mar', 'prop_14', 'assessment_display', 'DUES-DISPLAY',
           '2027 annual assessment (improved lots)', 62500, 0, '2026-01-15', '2027-03-01', 'open', '2026-01-15T00:00:00Z'
         )`,
      )
      .run();
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const owner = await signIn(sqlite, "user_sam");

    const ledger = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers: { Cookie: `tango_session=${admin}` } }, env);
    expect(ledger.status).toBe(200);
    const ledgerHtml = await ledger.text();
    expect(ledgerHtml).toContain("2027 annual assessment (improved lots)");
    expect(ledgerHtml).toContain("<td>Improved</td>");
    const payment = formByAction(ledgerHtml, "/a/tango-mar/admin/payments");
    expect(payment).toContain("DUES-DISPLAY");
    expect(payment).toContain("2027 annual assessment");
    expect(payment).not.toContain("(improved lots)");
    expect(payment).not.toContain("(unimproved lots)");

    const lot = await app.request(
      "http://localhost/a/tango-mar/admin/ledger/prop_14",
      { headers: { Cookie: `tango_session=${admin}` } },
      env,
    );
    const lotHtml = await lot.text();
    expect(lotHtml).toContain("DUES-DISPLAY");
    expect(lotHtml).toContain("2027 annual assessment");
    expect(lotHtml).not.toContain("(improved lots)");

    const invoice = await app.request(
      "http://localhost/a/tango-mar/admin/invoices/inv_display",
      { headers: { Cookie: `tango_session=${admin}` } },
      env,
    );
    const invoiceHtml = await invoice.text();
    expect(invoiceHtml).toContain('value="2027 annual assessment"');
    expect(invoiceHtml).not.toContain("(improved lots)");

    const ownerHeaders = { Cookie: `tango_session=${owner}` };
    for (const path of ["/a/tango-mar/dashboard", "/a/tango-mar/invoices", "/a/tango-mar/invoices/inv_display"]) {
      const page = await app.request(`http://localhost${path}`, { headers: ownerHeaders }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("2027 annual assessment");
      expect(html).not.toContain("(improved lots)");
      expect(html).not.toContain("(unimproved lots)");
    }

    expect(sqlite.prepare("SELECT name FROM assessments WHERE id = 'assessment_display'").get()).toEqual({
      name: "2027 annual assessment (improved lots)",
    });
    expect(sqlite.prepare("SELECT description FROM invoices WHERE id = 'inv_display'").get()).toEqual({
      description: "2027 annual assessment (improved lots)",
    });
    sqlite.close();
  });
});
