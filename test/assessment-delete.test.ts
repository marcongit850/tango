import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { deleteAssessment } from "../src/db";
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
    expect(html).toContain("Delete is refused when a payment is recorded on one of those invoices.");
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
    expect(html).toContain("On the open date, each active lot of that type that does not already have this assessment gets an invoice.");
    expect(html).toContain("A voided invoice stays void.");
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
