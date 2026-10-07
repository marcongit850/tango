import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  assignAssessmentInvoices,
  invoicesForUser,
  ledgerForUser,
  outstandingInvoiceCents,
  upcomingAssessments,
} from "../src/db";
import { sha256Hex } from "../src/lib/tokens";
import type { Association } from "../src/types";
import { dashboardPage, invoiceDetailPage } from "../src/views/resident";

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
    "migrations/0007_message_reviewed.sql",
  ]) {
    sqlite.exec(readFileSync(file, "utf8"));
  }
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function openTypedLots(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE properties (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      lot_number TEXT NOT NULL,
      street_address TEXT NOT NULL DEFAULT '',
      lot_type TEXT
    );
    CREATE TABLE property_owners (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      user_id TEXT NOT NULL
    );
    CREATE TABLE assessments (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL,
      due_on TEXT NOT NULL,
      opens_on TEXT,
      lot_type TEXT
    );
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      assessment_id TEXT,
      invoice_number TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      amount_cents INTEGER NOT NULL,
      late_fee_cents INTEGER NOT NULL DEFAULT 0,
      issued_on TEXT NOT NULL,
      due_on TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      invoice_id TEXT,
      amount_cents INTEGER NOT NULL
    );
  `);
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function addLot(
  sqlite: DatabaseSync,
  row: { id: string; ownerId: string; lotType: string | null; lotNumber: string; associationId?: string },
): void {
  const associationId = row.associationId ?? "assoc_tango_mar";
  sqlite
    .prepare(
      `INSERT INTO properties (id, association_id, lot_number, street_address, lot_type)
       VALUES (?, ?, ?, 'Tang O Mar Drive', ?)`,
    )
    .run(row.id, associationId, row.lotNumber, row.lotType);
  sqlite
    .prepare(
      `INSERT INTO property_owners (id, association_id, property_id, user_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`own_${row.id}`, associationId, row.id, row.ownerId);
}

function addAssessment(
  sqlite: DatabaseSync,
  row: {
    id: string;
    name: string;
    dueOn: string;
    opensOn: string | null;
    lotType: string | null;
    amount?: number;
    associationId?: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO assessments (id, association_id, name, description, amount_cents, due_on, opens_on, lot_type)
       VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.associationId ?? "assoc_tango_mar",
      row.name,
      row.amount ?? 62500,
      row.dueOn,
      row.opensOn,
      row.lotType,
    );
}

function addAnnualRows(sqlite: DatabaseSync, associationId = "assoc_tango_mar"): void {
  addAssessment(sqlite, {
    id: `dues_2027_all_${associationId}`,
    name: "2027 annual assessment (all lots)",
    dueOn: "2027-03-01",
    opensOn: "2027-01-01",
    lotType: null,
    associationId,
  });
  addAssessment(sqlite, {
    id: `dues_2027_improved_${associationId}`,
    name: "2027 annual assessment (improved lots)",
    dueOn: "2027-03-01",
    opensOn: "2027-01-01",
    lotType: "improved",
    associationId,
  });
  addAssessment(sqlite, {
    id: `dues_2027_unimproved_${associationId}`,
    name: "2027 annual assessment (unimproved lots)",
    dueOn: "2027-03-01",
    opensOn: "2027-01-01",
    lotType: "unimproved",
    amount: 10000,
    associationId,
  });
}

const annualNames = [
  "2027 annual assessment (all lots)",
  "2027 annual assessment (improved lots)",
  "2027 annual assessment (unimproved lots)",
];

const improvedNames = [
  "2027 annual assessment (all lots)",
  "2027 annual assessment (improved lots)",
];

const unimprovedNames = [
  "2027 annual assessment (all lots)",
  "2027 annual assessment (unimproved lots)",
];

async function names(db: D1Database, userId: string, today: string): Promise<string[]> {
  const rows = await upcomingAssessments(db, "assoc_tango_mar", userId, today);
  return rows.map((row) => row.name);
}

describe("upcoming assessments", () => {
  const today = "2026-10-07";

  it("shows improved and all-lot rows to an owner with only an improved lot", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_improved", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addAnnualRows(sqlite);

    const rows = await upcomingAssessments(db, "assoc_tango_mar", "user_marc", today);
    expect(rows.map((row) => row.name)).toEqual(improvedNames);
    expect(rows.map((row) => row.lot_type)).toEqual([null, "improved"]);
    expect(rows.every((row) => row.invoice_count === 0)).toBe(true);
    sqlite.close();
  });

  it("shows improved, unimproved, and all-lot rows when the owner's lot type is missing", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_blank", ownerId: "user_marc", lotType: null, lotNumber: "14" });
    addAnnualRows(sqlite);

    expect(await names(db, "user_marc", today)).toEqual(annualNames);

    sqlite.prepare("UPDATE properties SET lot_type = '' WHERE id = 'prop_blank'").run();
    expect(await names(db, "user_marc", today)).toEqual(annualNames);
    sqlite.close();
  });

  it("hides a past-due assessment and an assessment that is due today", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_improved", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addAssessment(sqlite, {
      id: "dues_past",
      name: "2026 annual assessment (improved lots)",
      dueOn: "2026-03-01",
      opensOn: "2026-01-01",
      lotType: "improved",
    });
    addAssessment(sqlite, {
      id: "dues_today",
      name: "Due today assessment",
      dueOn: today,
      opensOn: "2026-01-01",
      lotType: "improved",
    });
    addAssessment(sqlite, {
      id: "dues_not_open",
      name: "Not open yet",
      dueOn: today,
      opensOn: "2027-01-01",
      lotType: "improved",
    });

    expect(await names(db, "user_marc", today)).toEqual(["Not open yet"]);
    sqlite.close();
  });

  it("shows unimproved and all-lot rows to an owner with only an unimproved lot", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_unimproved", ownerId: "user_casey", lotType: "unimproved", lotNumber: "27" });
    addAnnualRows(sqlite);

    expect(await names(db, "user_casey", today)).toEqual(unimprovedNames);
    sqlite.close();
  });

  it("shows improved, unimproved, and all-lot rows when the owner has both lot types", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_improved", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addLot(sqlite, { id: "prop_unimproved", ownerId: "user_marc", lotType: "unimproved", lotNumber: "15" });
    addAnnualRows(sqlite);

    expect(await names(db, "user_marc", today)).toEqual(annualNames);
    sqlite.close();
  });

  it("shows nothing when the owner has no linked lot", async () => {
    const { sqlite, db } = openTypedLots();
    addAnnualRows(sqlite);

    expect(await names(db, "user_marc", today)).toEqual([]);
    sqlite.close();
  });

  it("keeps each association's upcoming list to lots in that association", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_tango", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addLot(sqlite, {
      id: "prop_other",
      ownerId: "user_pat",
      lotType: "unimproved",
      lotNumber: "2",
      associationId: "assoc_other",
    });
    addAnnualRows(sqlite);
    addAnnualRows(sqlite, "assoc_other");

    expect(await names(db, "user_marc", today)).toEqual(improvedNames);
    const other = await upcomingAssessments(db, "assoc_other", "user_pat", today);
    expect(other.map((row) => row.name)).toEqual(unimprovedNames);
    expect(await upcomingAssessments(db, "assoc_tango_mar", "user_pat", today)).toEqual([]);
    expect(await upcomingAssessments(db, "assoc_other", "user_marc", today)).toEqual([]);
    sqlite.close();
  });

  it("counts only this owner's non-void invoices", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_marc", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addLot(sqlite, { id: "prop_sam", ownerId: "user_sam", lotType: "improved", lotNumber: "3" });
    addAssessment(sqlite, {
      id: "dues_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, amount_cents, issued_on, due_on, status
         ) VALUES
           ('inv_marc', 'assoc_tango_mar', 'prop_marc', 'dues_2027_improved', 'DUES-14', 62500, '2027-01-01', '2027-03-01', 'open'),
           ('inv_void', 'assoc_tango_mar', 'prop_marc', 'dues_2027_improved', 'DUES-VOID', 62500, '2027-01-01', '2027-03-01', 'void'),
           ('inv_sam', 'assoc_tango_mar', 'prop_sam', 'dues_2027_improved', 'DUES-3', 62500, '2027-01-01', '2027-03-01', 'open')`,
      )
      .run();

    const beforeOpen = await upcomingAssessments(db, "assoc_tango_mar", "user_marc", today);
    expect(beforeOpen).toHaveLength(1);
    expect(beforeOpen[0]?.invoice_count).toBe(0);

    const opened = await upcomingAssessments(db, "assoc_tango_mar", "user_marc", "2027-01-01");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.invoice_count).toBe(1);
    sqlite.close();
  });

  it("ignores an invoice whose issued date is still ahead, even after the assessment has opened", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_marc", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addAssessment(sqlite, {
      id: "dues_future_issue",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2026-01-01",
      lotType: "improved",
    });
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, amount_cents, issued_on, due_on, status
         ) VALUES (
           'inv_future', 'assoc_tango_mar', 'prop_marc', 'dues_future_issue', 'DUES-14', 62500, '2027-06-01', '2027-03-01', 'open'
         )`,
      )
      .run();

    const rows = await upcomingAssessments(db, "assoc_tango_mar", "user_marc", today);
    expect(rows[0]?.invoice_count).toBe(0);
    const html = dashboardPage({
      association,
      name: "Marc",
      ledger: [],
      upcoming: rows,
      invoices: [],
      payments: [],
      notices: [],
      emergencies: [],
      today,
    });
    expect(html).toContain("Scheduled");
    expect(html).not.toContain("Invoiced");
    sqlite.close();
  });

  it("shows Scheduled until the open date, then Invoiced only for live invoices", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_marc", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    addAssessment(sqlite, {
      id: "dues_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });

    const render = async (today: string) => {
      const rows = await upcomingAssessments(db, "assoc_tango_mar", "user_marc", today);
      return dashboardPage({
        association,
        name: "Marc",
        ledger: [],
        upcoming: rows,
        invoices: [],
        payments: [],
        notices: [],
        emergencies: [],
        today,
      });
    };

    const unassigned = await render("2027-01-01");
    expect(unassigned).toContain("Scheduled");
    expect(unassigned).not.toContain("Invoiced");

    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, amount_cents, issued_on, due_on, status
         ) VALUES (
           'inv_marc', 'assoc_tango_mar', 'prop_marc', 'dues_2027_improved', 'DUES-14', 62500, '2027-01-01', '2027-03-01', 'open'
         )`,
      )
      .run();

    const early = await render("2026-12-31");
    expect(early).toContain("Opens January 1, 2027. Due March 1, 2027. Not due yet.");
    expect(early).toContain("$625.00");
    expect(early).toContain("Scheduled");
    expect(early).not.toContain("Invoiced");

    const opened = await render("2027-01-01");
    expect(opened).toContain("Opens January 1, 2027. Due March 1, 2027. Not due yet.");
    expect(opened).toContain("Invoiced");
    expect(opened).not.toContain("Scheduled");
    sqlite.close();
  });
});

describe("scheduled invoices and the balance", () => {
  it("keeps a future open date off the balance until that date", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_marc", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, invoice_number, description, amount_cents, late_fee_cents, issued_on, due_on, status
         ) VALUES
           ('inv_now', 'assoc_tango_mar', 'prop_marc', 'OPEN-14', 'Opening balance', 10000, 0, '2026-01-15', '2026-03-01', 'open'),
           ('inv_2027', 'assoc_tango_mar', 'prop_marc', 'DUES-14', '2027 annual assessment', 62500, 0, '2027-01-01', '2027-03-01', 'open')`,
      )
      .run();

    const before = await ledgerForUser(db, "assoc_tango_mar", "user_marc", "2026-10-07");
    expect(before[0]).toMatchObject({ balance_cents: 10000, delinquent: true });
    expect(await outstandingInvoiceCents(db, "assoc_tango_mar", "2026-10-07")).toBe(10000);
    const hidden = await invoicesForUser(db, "assoc_tango_mar", "user_marc", "2026-10-07");
    expect(hidden.map((row) => row.invoice_number)).toEqual(["OPEN-14"]);

    const opened = await ledgerForUser(db, "assoc_tango_mar", "user_marc", "2027-01-01");
    expect(opened[0]).toMatchObject({ balance_cents: 72500, delinquent: true });
    const visible = await invoicesForUser(db, "assoc_tango_mar", "user_marc", "2027-01-01");
    expect(visible.map((row) => row.invoice_number)).toEqual(["DUES-14", "OPEN-14"]);
    sqlite.close();
  });

  it("does not treat a not-yet-open invoice as past due", async () => {
    const { sqlite, db } = openTypedLots();
    addLot(sqlite, { id: "prop_marc", ownerId: "user_marc", lotType: "improved", lotNumber: "14" });
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, invoice_number, amount_cents, issued_on, due_on, status
         ) VALUES ('inv_future', 'assoc_tango_mar', 'prop_marc', 'DUES-14', 62500, '2027-01-01', '2026-03-01', 'open')`,
      )
      .run();

    const row = await ledgerForUser(db, "assoc_tango_mar", "user_marc", "2026-10-07");
    expect(row[0]).toMatchObject({ balance_cents: 0, delinquent: false, past_due: 0 });
    sqlite.close();
  });
});

describe("assigning a future assessment", () => {
  it("records the invoice without adding it to the current balance", async () => {
    const { sqlite, db } = openPortal();
    sqlite
      .prepare(
        `INSERT INTO assessments (
           id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at
         ) VALUES (
           'assessment_2027_improved', 'assoc_tango_mar', '2027 annual assessment (improved lots)', '',
           62500, '2027-03-01', '2027-01-01', 'improved', '2026-10-06T00:00:00Z'
         )`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO assessments (
           id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at
         ) VALUES (
           'assessment_2027_unimproved', 'assoc_tango_mar', '2027 annual assessment (unimproved lots)', '',
           10000, '2027-03-01', '2027-01-01', 'unimproved', '2026-10-06T00:00:00Z'
         )`,
      )
      .run();

    const samBefore = await ledgerForUser(db, "assoc_tango_mar", "user_sam", "2026-10-07");
    const caseyBefore = await ledgerForUser(db, "assoc_tango_mar", "user_casey", "2026-10-07");
    expect(samBefore[0]?.balance_cents).toBe(0);
    expect(caseyBefore[0]?.balance_cents).toBe(160050);

    const assigned = await assignAssessmentInvoices(db, {
      associationId: "assoc_tango_mar",
      assessmentId: "assessment_2027_improved",
      today: "2026-10-07",
    });
    expect(assigned).toMatchObject({ created: 3, issuedOn: "2027-01-01", name: "2027 annual assessment" });
    expect(sqlite.prepare("SELECT name FROM assessments WHERE id = 'assessment_2027_improved'").get()).toEqual({
      name: "2027 annual assessment (improved lots)",
    });
    expect(
      sqlite.prepare("SELECT description FROM invoices WHERE assessment_id = 'assessment_2027_improved' AND property_id = 'prop_14'").get(),
    ).toEqual({ description: "2027 annual assessment" });
    expect(
      sqlite.prepare("SELECT issued_on, due_on, status FROM invoices WHERE assessment_id = 'assessment_2027_improved' AND property_id = 'prop_14'").get(),
    ).toEqual({ issued_on: "2027-01-01", due_on: "2027-03-01", status: "open" });

    const samAfter = await ledgerForUser(db, "assoc_tango_mar", "user_sam", "2026-10-07");
    const caseyAfter = await ledgerForUser(db, "assoc_tango_mar", "user_casey", "2026-10-07");
    expect(samAfter[0]).toMatchObject({ balance_cents: 0, delinquent: false });
    expect(caseyAfter[0]?.balance_cents).toBe(160050);
    expect(await outstandingInvoiceCents(db, "assoc_tango_mar", "2026-10-07")).toBe(160050);

    const upcoming = await upcomingAssessments(db, "assoc_tango_mar", "user_sam", "2026-10-07");
    const improved = upcoming.find((row) => row.id === "assessment_2027_improved");
    expect(improved).toMatchObject({ invoice_count: 0, due_on: "2027-03-01", opens_on: "2027-01-01" });
    const live = await upcomingAssessments(db, "assoc_tango_mar", "user_sam", "2027-01-01");
    expect(live.find((row) => row.id === "assessment_2027_improved")).toMatchObject({ invoice_count: 1 });
    expect(upcoming.some((row) => row.id === "assessment_2027_unimproved")).toBe(false);
    expect(upcoming.some((row) => row.due_on < "2026-10-07")).toBe(false);
    expect(upcoming.some((row) => row.due_on === "2026-10-07")).toBe(false);

    const history = await invoicesForUser(db, "assoc_tango_mar", "user_sam", "2026-10-07");
    expect(history.some((row) => row.description.includes("2027"))).toBe(false);

    const opened = await ledgerForUser(db, "assoc_tango_mar", "user_sam", "2027-01-01");
    expect(opened[0]).toMatchObject({ balance_cents: 62500, delinquent: false });

    sqlite.prepare("UPDATE properties SET lot_type = 'unimproved' WHERE id = 'prop_14'").run();
    const retyped = await upcomingAssessments(db, "assoc_tango_mar", "user_sam", "2026-10-07");
    expect(retyped.some((row) => row.id === "assessment_2027_improved")).toBe(false);
    expect(retyped.some((row) => row.id === "assessment_2027_unimproved")).toBe(true);
    sqlite.close();
  });
});

function upcomingDashboard(today: string, invoiceCount: number): string {
  return dashboardPage({
    association,
    name: "Marc",
    ledger: [],
    upcoming: [
      {
        id: "assessment_2027_improved",
        name: "2027 annual assessment (improved lots)",
        description: "",
        amount_cents: 62500,
        due_on: "2027-03-01",
        opens_on: "2027-01-01",
        lot_type: "improved",
        invoice_count: invoiceCount,
      },
    ],
    invoices: [],
    payments: [],
    notices: [],
    emergencies: [],
    today,
  });
}

describe("upcoming assessment copy", () => {
  it("stays Scheduled before the open date even when invoice rows exist", () => {
    const html = upcomingDashboard("2026-10-07", 1);
    expect(html).toContain("2027 annual assessment");
    expect(html).not.toContain("(improved lots)");
    expect(html).not.toContain("(unimproved lots)");
    expect(html).toContain("Opens January 1, 2027. Due March 1, 2027. Not due yet.");
    expect(html).toContain("Scheduled");
    expect(html).not.toContain("Invoiced");
    expect(html).toContain('<span class="money">$625.00</span>');
    expect(html).not.toContain("money owe");
    expect(html).not.toContain("Past due");
  });

  it("says Invoiced on and after the open date when invoices are live", () => {
    for (const today of ["2027-01-01", "2027-02-15"]) {
      const html = upcomingDashboard(today, 1);
      expect(html).toContain("Opens January 1, 2027. Due March 1, 2027. Not due yet.");
      expect(html).toContain("Invoiced");
      expect(html).not.toContain("Scheduled");
      expect(html).toContain('<span class="money">$625.00</span>');
    }
  });

  it("stays Scheduled when no invoices exist", () => {
    for (const today of ["2026-10-07", "2027-01-01"]) {
      const html = upcomingDashboard(today, 0);
      expect(html).toContain("Opens January 1, 2027. Due March 1, 2027. Not due yet.");
      expect(html).toContain("Scheduled");
      expect(html).not.toContain("Invoiced");
    }
  });

  it("labels a future assessment invoice as not owed yet", () => {
    const detail = invoiceDetailPage(
      association,
      {
        id: "inv_2027",
        property_id: "prop_14",
        lot_number: "14",
        invoice_number: "DUES-14",
        description: "2027 annual assessment (improved lots)",
        amount_cents: 62500,
        late_fee_cents: 0,
        issued_on: "2027-01-01",
        due_on: "2027-03-01",
        status: "open",
        paid_cents: 0,
      },
      "2026-10-07",
    );
    expect(detail).toContain("2027 annual assessment");
    expect(detail).not.toContain("(improved lots)");
    expect(detail).toContain("Scheduled. Not owed until January 1, 2027.");
    expect(detail).toContain(">scheduled<");
    expect(detail).not.toContain("Remaining on this invoice");
    expect(detail).not.toContain("Past due");
    expect(detail).not.toContain("money owe");
  });
});

describe("assign flash", () => {
  it("says a future open date does not count toward the balance yet", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const token = `session-jordan`;
    sqlite
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("sess_jordan", "user_jordan", await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z");
    sqlite
      .prepare(
        `INSERT INTO assessments (
           id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at
         ) VALUES (
           'assessment_2099_improved', 'assoc_tango_mar', '2099 annual assessment (improved lots)', '',
           62500, '2099-03-01', '2099-01-01', 'improved', '2026-10-06T00:00:00Z'
         )`,
      )
      .run();
    const env = {
      DB: db,
      APP_ENV: "production",
      EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
      DOCUMENTS: {} as R2Bucket,
      RESEND_API_KEY: "",
    } as Env;
    const response = await app.request(
      "http://localhost/a/tango-mar/admin/assessments/assessment_2099_improved/assign",
      {
        method: "POST",
        headers: { Cookie: `tango_session=${token}`, Origin: "http://localhost" },
        body: new URLSearchParams({ confirm: "yes" }),
      },
      env,
    );
    expect(response.status).toBe(303);
    const flash = decodeURIComponent(response.headers.get("Set-Cookie") ?? "");
    expect(flash).toContain(
      "ok:Assigned 2099 annual assessment to 3 lots. 0 already had it. Those invoices are scheduled and do not count toward balances until 2099-01-01.",
    );
    sqlite.close();
  });
});
