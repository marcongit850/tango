import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { issueOpenAssessmentInvoices } from "../src/db";
import { runDueAssessmentInvoices } from "../src/lib/issue-assessments";
import { assessmentOpenForInvoicing } from "../src/lib/dues";

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

type InvoiceRow = {
  association_id: string;
  property_id: string;
  assessment_id: string;
  issued_on: string;
  due_on: string;
  status: string;
  amount_cents: number;
};

function openDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE associations (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      legal_name TEXT NOT NULL DEFAULT '',
      address_line1 TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      county TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE properties (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      lot_number TEXT NOT NULL,
      street_address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      lot_type TEXT NOT NULL
    );
    CREATE TABLE property_owners (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT ''
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
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      association_id TEXT NOT NULL,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO associations (
         id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone
       ) VALUES (?, ?, ?, '', '', '', '', '', '', ?)`,
    )
    .run("assoc_tango_mar", "tango-mar", "Tango Mar", "America/Chicago");
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function addLot(
  sqlite: DatabaseSync,
  row: { id: string; lotNumber: string; lotType: string; status?: string; associationId?: string; ownerId?: string },
): void {
  const associationId = row.associationId ?? "assoc_tango_mar";
  sqlite
    .prepare(
      `INSERT INTO properties (id, association_id, lot_number, street_address, status, lot_type)
       VALUES (?, ?, ?, 'Tang O Mar Drive', ?, ?)`,
    )
    .run(row.id, associationId, row.lotNumber, row.status ?? "active", row.lotType);
  if (row.ownerId) {
    sqlite
      .prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)")
      .run(row.ownerId, row.ownerId, `${row.ownerId}@example.com`);
    sqlite
      .prepare(
        `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
         VALUES (?, ?, ?, ?, 1, '2026-10-01T00:00:00Z')`,
      )
      .run(`own_${row.id}`, associationId, row.id, row.ownerId);
  }
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

function invoiceRows(sqlite: DatabaseSync): InvoiceRow[] {
  return sqlite
    .prepare(
      `SELECT association_id, property_id, assessment_id, issued_on, due_on, status, amount_cents
       FROM invoices
       ORDER BY assessment_id, property_id`,
    )
    .all() as InvoiceRow[];
}

describe("assessment open date", () => {
  it("is ready on the open date and on later dates, and not before", () => {
    expect(assessmentOpenForInvoicing("2027-01-01", "2027-01-01")).toBe(true);
    expect(assessmentOpenForInvoicing("2026-12-31", "2027-01-01")).toBe(true);
    expect(assessmentOpenForInvoicing("2027-01-02", "2027-01-01")).toBe(false);
    expect(assessmentOpenForInvoicing(null, "2027-01-01")).toBe(false);
    expect(assessmentOpenForInvoicing("2026", "2027-01-01")).toBe(false);
    expect(assessmentOpenForInvoicing("2027-01-01", "today")).toBe(false);
  });
});

describe("automatic assessment invoices", () => {
  it("creates invoices for matching lots on the open date", async () => {
    const { sqlite, db } = openDb();
    addLot(sqlite, { id: "prop_14", lotNumber: "14", lotType: "improved", ownerId: "user_sam" });
    addLot(sqlite, { id: "prop_27", lotNumber: "27", lotType: "unimproved", ownerId: "user_casey" });
    addLot(sqlite, { id: "prop_3", lotNumber: "3", lotType: "improved", status: "inactive", ownerId: "user_old" });
    addLot(sqlite, { id: "prop_other", lotNumber: "9", lotType: "improved", associationId: "assoc_other", ownerId: "user_pat" });
    addAssessment(sqlite, {
      id: "assessment_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });
    addAssessment(sqlite, {
      id: "assessment_2027_unimproved",
      name: "2027 annual assessment (unimproved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "unimproved",
      amount: 10000,
    });
    addAssessment(sqlite, {
      id: "assessment_2027_all",
      name: "2027 special assessment",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: null,
      amount: 5000,
    });
    addAssessment(sqlite, {
      id: "assessment_future",
      name: "Future assessment",
      dueOn: "2027-04-01",
      opensOn: "2027-01-02",
      lotType: "improved",
    });
    addAssessment(sqlite, {
      id: "assessment_blank",
      name: "No open date",
      dueOn: "2027-01-01",
      opensOn: null,
      lotType: "improved",
    });
    addAssessment(sqlite, {
      id: "assessment_bad_date",
      name: "Bad open date",
      dueOn: "2027-03-01",
      opensOn: "2026",
      lotType: "improved",
    });
    addAssessment(sqlite, {
      id: "assessment_other",
      name: "Other association",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
      associationId: "assoc_other",
    });

    const issued = await issueOpenAssessmentInvoices(db, { associationId: "assoc_tango_mar", today: "2027-01-01" });
    expect(issued.map((row) => row.assessmentId).sort()).toEqual([
      "assessment_2027_all",
      "assessment_2027_improved",
      "assessment_2027_unimproved",
    ]);
    expect(issued.find((row) => row.assessmentId === "assessment_2027_improved")).toMatchObject({
      created: 1,
      issuedOn: "2027-01-01",
    });

    const rows = invoiceRows(sqlite);
    expect(rows).toEqual([
      {
        association_id: "assoc_tango_mar",
        property_id: "prop_14",
        assessment_id: "assessment_2027_all",
        issued_on: "2027-01-01",
        due_on: "2027-03-01",
        status: "open",
        amount_cents: 5000,
      },
      {
        association_id: "assoc_tango_mar",
        property_id: "prop_27",
        assessment_id: "assessment_2027_all",
        issued_on: "2027-01-01",
        due_on: "2027-03-01",
        status: "open",
        amount_cents: 5000,
      },
      {
        association_id: "assoc_tango_mar",
        property_id: "prop_14",
        assessment_id: "assessment_2027_improved",
        issued_on: "2027-01-01",
        due_on: "2027-03-01",
        status: "open",
        amount_cents: 62500,
      },
      {
        association_id: "assoc_tango_mar",
        property_id: "prop_27",
        assessment_id: "assessment_2027_unimproved",
        issued_on: "2027-01-01",
        due_on: "2027-03-01",
        status: "open",
        amount_cents: 10000,
      },
    ]);
    expect(rows.some((row) => row.property_id === "prop_27" && row.assessment_id === "assessment_2027_improved")).toBe(false);
    expect(rows.some((row) => row.property_id === "prop_14" && row.assessment_id === "assessment_2027_unimproved")).toBe(false);
    expect(rows.some((row) => row.property_id === "prop_3" || row.property_id === "prop_other")).toBe(false);
    sqlite.close();
  });

  it("skips lots already invoiced and does nothing on a second run", async () => {
    const { sqlite, db } = openDb();
    addLot(sqlite, { id: "prop_14", lotNumber: "14", lotType: "improved" });
    addLot(sqlite, { id: "prop_15", lotNumber: "15", lotType: "improved" });
    addAssessment(sqlite, {
      id: "assessment_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, description,
           amount_cents, late_fee_cents, issued_on, due_on, status, created_at
         ) VALUES (
           'inv_existing', 'assoc_tango_mar', 'prop_14', 'assessment_2027_improved', 'DUES-14',
           '2027 annual assessment (improved lots)', 62500, 0, '2027-01-01', '2027-03-01', 'open', '2026-12-01T00:00:00Z'
         )`,
      )
      .run();

    const first = await issueOpenAssessmentInvoices(db, { associationId: "assoc_tango_mar", today: "2027-01-01" });
    expect(first).toEqual([
      {
        assessmentId: "assessment_2027_improved",
        name: "2027 annual assessment (improved lots)",
        created: 1,
        already: 1,
        issuedOn: "2027-01-01",
      },
    ]);
    expect(invoiceRows(sqlite).map((row) => row.property_id).sort()).toEqual(["prop_14", "prop_15"]);

    const second = await issueOpenAssessmentInvoices(db, { associationId: "assoc_tango_mar", today: "2027-01-01" });
    expect(second).toEqual([
      {
        assessmentId: "assessment_2027_improved",
        name: "2027 annual assessment (improved lots)",
        created: 0,
        already: 2,
        issuedOn: "2027-01-01",
      },
    ]);
    expect(invoiceRows(sqlite)).toHaveLength(2);
    sqlite.close();
  });

  it("does not replace a voided invoice", async () => {
    const { sqlite, db } = openDb();
    addLot(sqlite, { id: "prop_14", lotNumber: "14", lotType: "improved" });
    addAssessment(sqlite, {
      id: "assessment_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });
    sqlite
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, assessment_id, invoice_number, amount_cents, issued_on, due_on, status
         ) VALUES (
           'inv_void', 'assoc_tango_mar', 'prop_14', 'assessment_2027_improved', 'DUES-14', 62500, '2027-01-01', '2027-03-01', 'void'
         )`,
      )
      .run();

    const issued = await issueOpenAssessmentInvoices(db, { associationId: "assoc_tango_mar", today: "2027-01-01" });
    expect(issued).toEqual([
      {
        assessmentId: "assessment_2027_improved",
        name: "2027 annual assessment (improved lots)",
        created: 0,
        already: 1,
        issuedOn: "2027-01-01",
      },
    ]);
    expect(invoiceRows(sqlite)).toEqual([
      {
        association_id: "assoc_tango_mar",
        property_id: "prop_14",
        assessment_id: "assessment_2027_improved",
        issued_on: "2027-01-01",
        due_on: "2027-03-01",
        status: "void",
        amount_cents: 62500,
      },
    ]);
    sqlite.close();
  });

  it("catches up an open date that was yesterday and is still uninvoiced", async () => {
    const { sqlite, db } = openDb();
    addLot(sqlite, { id: "prop_14", lotNumber: "14", lotType: "improved" });
    addLot(sqlite, { id: "prop_27", lotNumber: "27", lotType: "unimproved" });
    addAssessment(sqlite, {
      id: "assessment_open_yesterday",
      name: "Walkway assessment",
      dueOn: "2027-03-01",
      opensOn: "2026-12-31",
      lotType: "improved",
      amount: 15000,
    });

    const issued = await issueOpenAssessmentInvoices(db, { associationId: "assoc_tango_mar", today: "2027-01-01" });
    expect(issued).toMatchObject([{ created: 1, issuedOn: "2026-12-31" }]);
    expect(invoiceRows(sqlite)).toEqual([
      {
        association_id: "assoc_tango_mar",
        property_id: "prop_14",
        assessment_id: "assessment_open_yesterday",
        issued_on: "2026-12-31",
        due_on: "2027-03-01",
        status: "open",
        amount_cents: 15000,
      },
    ]);
    sqlite.close();
  });
});

describe("daily assessment invoice job", () => {
  it("uses the association time zone and records an activity entry", async () => {
    const { sqlite, db } = openDb();
    addLot(sqlite, { id: "prop_14", lotNumber: "14", lotType: "improved" });
    addAssessment(sqlite, {
      id: "assessment_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });
    sqlite
      .prepare(
        `INSERT INTO associations (
           id, slug, name, legal_name, address_line1, city, state, postal_code, county, timezone
         ) VALUES ('assoc_west', 'west', 'West', '', '', '', '', '', '', 'America/Los_Angeles')`,
      )
      .run();
    addLot(sqlite, { id: "prop_west", lotNumber: "1", lotType: "improved", associationId: "assoc_west" });
    addAssessment(sqlite, {
      id: "assessment_west",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
      associationId: "assoc_west",
    });

    const beforeMidnight = await runDueAssessmentInvoices(db, new Date("2027-01-01T05:30:00.000Z"));
    expect(beforeMidnight).toEqual({ created: 0 });
    expect(invoiceRows(sqlite)).toEqual([]);

    const centralMorning = await runDueAssessmentInvoices(db, new Date("2027-01-01T06:15:00.000Z"));
    expect(centralMorning).toEqual({ created: 1 });
    expect(invoiceRows(sqlite).map((row) => row.property_id)).toEqual(["prop_14"]);

    const audit = sqlite
      .prepare("SELECT actor_user_id, action, entity_id, detail FROM audit_log")
      .all() as { actor_user_id: string | null; action: string; entity_id: string; detail: string }[];
    expect(audit).toEqual([
      {
        actor_user_id: null,
        action: "assessment_assign",
        entity_id: "assessment_2027_improved",
        detail: "Automatic on 2027-01-01: 2027 annual assessment (improved lots): 1 invoices, 0 already assigned.",
      },
    ]);

    const again = await runDueAssessmentInvoices(db, new Date("2027-01-01T06:15:00.000Z"));
    expect(again).toEqual({ created: 0 });
    expect(invoiceRows(sqlite)).toHaveLength(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 1 });

    const pacificEvening = await runDueAssessmentInvoices(db, new Date("2027-01-02T06:15:00.000Z"));
    expect(pacificEvening).toEqual({ created: 1 });
    expect(invoiceRows(sqlite).map((row) => row.property_id).sort()).toEqual(["prop_14", "prop_west"]);
    sqlite.close();
  });

  it("runs from the Worker scheduled handler", async () => {
    const { sqlite, db } = openDb();
    addLot(sqlite, { id: "prop_14", lotNumber: "14", lotType: "improved" });
    addAssessment(sqlite, {
      id: "assessment_2027_improved",
      name: "2027 annual assessment (improved lots)",
      dueOn: "2027-03-01",
      opensOn: "2027-01-01",
      lotType: "improved",
    });
    const env = {
      DB: db,
      APP_ENV: "production",
      EMAIL_FROM: "Tango Mar <donotreply@mytangomar.com>",
      DOCUMENTS: {} as R2Bucket,
    } as Env;
    await worker.scheduled?.(
      { scheduledTime: Date.parse("2027-01-01T06:15:00.000Z"), cron: "15 6 * * *", noRetry() {} },
      env,
    );
    expect(invoiceRows(sqlite)).toHaveLength(1);
    sqlite.close();
  });

  it("schedules the daily cron just after midnight Central", () => {
    const config = readFileSync("wrangler.jsonc", "utf8");
    expect(config).toContain('"crons": ["15 6 * * *"]');
  });
});
