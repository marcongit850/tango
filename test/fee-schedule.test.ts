import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { assignAssessmentInvoices, ledgerForUser } from "../src/db";
import { todayIso } from "../src/lib/dates";
import {
  allocateLinePayments,
  buildOwnerBills,
  type BillingAddon,
  type BillingLink,
  type BillingLot,
  type FeeRates,
} from "../src/lib/fee-schedule";
import { sha256Hex } from "../src/lib/tokens";

const RATES: FeeRates = {
  firstImprovedCents: 62500,
  additionalImprovedCents: 31500,
  vacantCents: 22000,
};

function lot(id: string, lotNumber: string, lotType: "improved" | "unimproved", status = "active"): BillingLot {
  return { id, lotNumber, lotType, status };
}

function link(propertyId: string, userId = "user_pat"): BillingLink {
  return { propertyId, userId, isPrimary: true, createdAt: "2026-01-01T00:00:00Z" };
}

function beachBox(quantity = 1, propertyId: string | null = "prop_12"): BillingAddon {
  return {
    id: "addon_row",
    userId: "user_pat",
    addonTypeId: "addon_tango_beach_box",
    name: "Beach box",
    unitAmountCents: 15000,
    quantity,
    propertyId,
    lotNumber: propertyId === "prop_12" ? "12" : null,
  };
}

function patLots(): BillingLot[] {
  return [lot("prop_43", "43", "improved"), lot("prop_44", "44", "improved"), lot("prop_12", "12", "unimproved")];
}

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
    "migrations/0018_fee_schedule.sql",
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
    EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>",
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

function insertPat(sqlite: DatabaseSync): void {
  sqlite
    .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("user_pat", "pat.owner@example.com", "Pat Owner", "850-555-0199", "2026-10-01T15:00:00Z");
  sqlite
    .prepare(
      "INSERT INTO memberships (id, association_id, user_id, role_id, status, created_at) VALUES (?, 'assoc_tango_mar', ?, 'homeowner', 'active', ?)",
    )
    .run("mem_pat", "user_pat", "2026-10-01T15:00:00Z");
  const insertLot = sqlite.prepare(
    `INSERT INTO properties (
       id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type, created_at
     ) VALUES (?, 'assoc_tango_mar', ?, ?, 'Miramar Beach', 'FL', '32550', 'active', ?, '2026-10-01T15:00:00Z')`,
  );
  insertLot.run("prop_43", "43", "Lot 43, Tang O Mar Drive", "improved");
  insertLot.run("prop_44", "44", "Lot 44, Tang O Mar Drive", "improved");
  insertLot.run("prop_12", "12", "Lot 12, Tang O Mar Drive", "unimproved");
  const insertOwner = sqlite.prepare(
    `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
     VALUES (?, 'assoc_tango_mar', ?, 'user_pat', 1, '2026-10-01T15:00:00Z')`,
  );
  insertOwner.run("own_pat_43", "prop_43");
  insertOwner.run("own_pat_44", "prop_44");
  insertOwner.run("own_pat_12", "prop_12");
  sqlite
    .prepare(
      `INSERT INTO owner_addons (id, association_id, user_id, addon_type_id, property_id, quantity, created_at)
       VALUES ('ownaddon_pat_box', 'assoc_tango_mar', 'user_pat', 'addon_tango_beach_box', 'prop_12', 1, '2026-10-15T00:00:00Z')`,
    )
    .run();
}

describe("fee schedule math", () => {
  it("bills 2 improved lots, 1 vacant lot, and 1 beach box at $1,310", () => {
    const { bills } = buildOwnerBills({
      lots: patLots(),
      links: [link("prop_43"), link("prop_44"), link("prop_12")],
      primaryByUser: new Map(),
      addons: [beachBox()],
      rates: RATES,
    });
    expect(bills).toHaveLength(1);
    const bill = bills[0];
    expect(bill?.totalCents).toBe(131000);
    expect(bill?.anchorPropertyId).toBe("prop_43");
    expect(bill?.ignoredPrimary).toBe(false);
    expect(bill?.lines.map((line) => [line.description, line.amountCents, line.kind])).toEqual([
      ["Lot 43, first improved", 62500, "first_improved"],
      ["Lot 44, additional improved", 31500, "additional_improved"],
      ["Lot 12, vacant", 22000, "vacant"],
      ["Beach box", 15000, "addon"],
    ]);
    expect(62500 + 31500 + 22000 + 15000).toBe(131000);
  });

  it("keeps a vacant lot off the first improved rate, including when it is marked primary", () => {
    const vacantFirst = buildOwnerBills({
      lots: [lot("prop_1", "1", "unimproved"), lot("prop_10", "10", "improved")],
      links: [link("prop_1"), link("prop_10")],
      primaryByUser: new Map(),
      addons: [],
      rates: RATES,
    });
    expect(vacantFirst.bills[0]?.lines.map((line) => [line.description, line.amountCents])).toEqual([
      ["Lot 10, first improved", 62500],
      ["Lot 1, vacant", 22000],
    ]);

    const ignored = buildOwnerBills({
      lots: patLots(),
      links: [link("prop_43"), link("prop_44"), link("prop_12")],
      primaryByUser: new Map([["user_pat", "prop_12"]]),
      addons: [],
      rates: RATES,
    });
    expect(ignored.bills[0]?.ignoredPrimary).toBe(true);
    expect(ignored.bills[0]?.lines[0]).toMatchObject({ description: "Lot 43, first improved", amountCents: 62500 });
  });

  it("uses the saved improved lot as the first lot", () => {
    const { bills } = buildOwnerBills({
      lots: patLots(),
      links: [link("prop_43"), link("prop_44"), link("prop_12")],
      primaryByUser: new Map([["user_pat", "prop_44"]]),
      addons: [beachBox(2)],
      rates: RATES,
    });
    expect(bills[0]?.lines.map((line) => [line.description, line.amountCents])).toEqual([
      ["Lot 44, first improved", 62500],
      ["Lot 43, additional improved", 31500],
      ["Lot 12, vacant", 22000],
      ["Beach box x2", 30000],
    ]);
    expect(bills[0]?.totalCents).toBe(146000);
  });

  it("applies a payment to lines in order and leaves the rest of the invoice open", () => {
    const lines = [
      { id: "a", amountCents: 62500, sortOrder: 0 },
      { id: "b", amountCents: 31500, sortOrder: 1 },
      { id: "c", amountCents: 22000, sortOrder: 2 },
      { id: "d", amountCents: 15000, sortOrder: 3 },
    ];
    const paid = allocateLinePayments(lines, 62500);
    expect(paid.byLineId.get("a")).toBe(62500);
    expect(paid.byLineId.get("b")).toBe(0);
    expect(paid.remainderCents).toBe(0);
    const full = allocateLinePayments(lines, 131000);
    expect([...full.byLineId.values()]).toEqual([62500, 31500, 22000, 15000]);
    expect(full.remainderCents).toBe(0);
  });
});

describe("fee schedule invoices", () => {
  it("previews, assigns one itemized owner invoice, and leaves older invoices alone", async () => {
    const { sqlite, db } = openPortal();
    insertPat(sqlite);
    const beforeHistory = sqlite.prepare("SELECT amount_cents, status FROM invoices WHERE id = 'invoice_sam_2026'").get() as {
      amount_cents: number;
      status: string;
    };
    const app = createApp();
    const env = portalEnv(db);
    const admin = await signIn(sqlite, "user_jordan");
    const headers = { Cookie: `tango_session=${admin}`, Origin: "http://localhost" };
    const today = todayIso("America/Chicago");

    const ledger = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    expect(ledger.status).toBe(200);
    const preview = await ledger.text();
    expect(preview).toContain("Fee schedule");
    expect(preview).toContain('name="first_improved_amount" type="text" value="625.00" required');
    expect(preview).toContain('name="additional_improved_amount" type="text" value="315.00" required');
    expect(preview).toContain('name="vacant_amount" type="text" value="220.00" required');
    expect(preview).toContain("Beach box");
    expect(preview).toContain("$150.00");
    const patPreview = preview.slice(preview.indexOf("/admin/owners/user_pat"));
    expect(patPreview).toContain("Lot 43, first improved");
    expect(patPreview).toContain("Lot 44, additional improved");
    expect(patPreview).toContain("Lot 12, vacant");
    expect(patPreview).toContain("Beach box");
    expect(patPreview).toContain("$1,310.00");
    expect(preview).toContain("Add dues for this schedule");
    expect(preview).not.toContain("Tango Mar");
    mkdirSync("/tmp/hoa-fee-preview", { recursive: true });
    writeFileSync("/tmp/hoa-fee-preview/admin-ledger.html", preview);

    const created = await app.request(
      "http://localhost/a/tango-mar/admin/assessments",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          year: "2026",
          schedule: "annual",
          opens_on: "2026-01-01",
          due_on: "2026-03-01",
        }),
      },
      env,
    );
    expect(created.status).toBe(303);
    expect(decodeURIComponent(created.headers.get("Set-Cookie") ?? "")).toContain("ok:Added 2026 annual assessment.");
    const assessment = sqlite
      .prepare(
        `SELECT id, billing_mode, amount_cents, lot_type FROM assessments
         WHERE billing_mode = 'schedule' AND due_on = '2026-03-01'`,
      )
      .get() as { id: string; billing_mode: string; amount_cents: number; lot_type: string | null };
    expect(assessment.billing_mode).toBe("schedule");
    expect(assessment.lot_type).toBeNull();
    expect(assessment.amount_cents).toBe(62500);

    const assigned = await app.request(
      `http://localhost/a/tango-mar/admin/assessments/${assessment.id}/assign`,
      { method: "POST", headers, body: new URLSearchParams({ confirm: "yes" }) },
      env,
    );
    expect(assigned.status).toBe(303);
    expect(decodeURIComponent(assigned.headers.get("Set-Cookie") ?? "")).toContain(
      "Assigned 2026 annual assessment to 4 owners. 0 already had it.",
    );
    const again = await assignAssessmentInvoices(db, {
      associationId: "assoc_tango_mar",
      assessmentId: assessment.id,
      today,
    });
    expect(again).toMatchObject({ created: 0, already: 4, audience: "owners" });

    const invoice = sqlite
      .prepare(
        `SELECT id, property_id, billed_user_id, amount_cents, description
         FROM invoices WHERE assessment_id = ? AND billed_user_id = 'user_pat'`,
      )
      .get(assessment.id) as {
      id: string;
      property_id: string;
      billed_user_id: string;
      amount_cents: number;
      description: string;
    };
    expect(invoice.property_id).toBe("prop_43");
    expect(invoice.amount_cents).toBe(131000);
    const lines = sqlite
      .prepare(
        `SELECT kind, description, amount_cents FROM invoice_lines
         WHERE invoice_id = ? ORDER BY sort_order`,
      )
      .all(invoice.id) as { kind: string; description: string; amount_cents: number }[];
    expect(lines).toEqual([
      { kind: "first_improved", description: "Lot 43, first improved", amount_cents: 62500 },
      { kind: "additional_improved", description: "Lot 44, additional improved", amount_cents: 31500 },
      { kind: "vacant", description: "Lot 12, vacant", amount_cents: 22000 },
      { kind: "addon", description: "Beach box", amount_cents: 15000 },
    ]);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = ?", assessment.id)).toBe(4);
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = 'invoice_sam_2026'")).toBe(0);
    expect(sqlite.prepare("SELECT amount_cents, status FROM invoices WHERE id = 'invoice_sam_2026'").get()).toEqual(beforeHistory);

    const owner = await signIn(sqlite, "user_pat");
    const ownerHeaders = { Cookie: `tango_session=${owner}` };
    const detail = await app.request(`http://localhost/a/tango-mar/invoices/${invoice.id}`, { headers: ownerHeaders }, env);
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Lot 43, first improved");
    expect(detailHtml).toContain("Lot 44, additional improved");
    expect(detailHtml).toContain("Lot 12, vacant");
    expect(detailHtml).toContain("Beach box");
    expect(detailHtml).toContain("$625.00");
    expect(detailHtml).toContain("$315.00");
    expect(detailHtml).toContain("$220.00");
    expect(detailHtml).toContain("$150.00");
    expect(detailHtml).toContain("$1,310.00");
    expect(detailHtml).not.toContain("Tango Mar");
    writeFileSync("/tmp/hoa-fee-preview/owner-invoice.html", detailHtml);

    const home = await app.request("http://localhost/a/tango-mar/dashboard", { headers: ownerHeaders }, env);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Lot 43, first improved");
    expect(homeHtml).toContain("Beach box");
    expect(homeHtml).toContain("$1,310.00");

    const adminInvoice = await app.request(
      `http://localhost/a/tango-mar/admin/invoices/${invoice.id}`,
      { headers },
      env,
    );
    expect(adminInvoice.status).toBe(200);
    const adminInvoiceHtml = await adminInvoice.text();
    expect(adminInvoiceHtml).toContain("Lot 44, additional improved");
    expect(adminInvoiceHtml).toContain("The amount is the total of the lines.");
    writeFileSync("/tmp/hoa-fee-preview/admin-invoice.html", adminInvoiceHtml);

    const paid = await app.request(
      "http://localhost/a/tango-mar/admin/payments",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          property_id: "prop_43",
          invoice_id: invoice.id,
          amount: "625.00",
          method: "check",
          reference: "1001",
          paid_on: "2026-10-15",
          notes: "First improved lot",
        }),
      },
      env,
    );
    expect(paid.status).toBe(303);
    const balances = await ledgerForUser(db, "assoc_tango_mar", "user_pat", today);
    const byLot = new Map(balances.map((row) => [row.lot_number, row.balance_cents]));
    expect(byLot.get("43")).toBe(0);
    expect(byLot.get("44")).toBe(31500);
    expect(byLot.get("12")).toBe(37000);
    expect((byLot.get("43") ?? 0) + (byLot.get("44") ?? 0) + (byLot.get("12") ?? 0)).toBe(68500);
    const status = sqlite.prepare("SELECT status FROM invoices WHERE id = ?").get(invoice.id) as { status: string };
    expect(status.status).toBe("partial");

    const reminded = await app.request(
      "http://localhost/a/tango-mar/admin/owners/user_pat/remind",
      { method: "POST", headers, body: new URLSearchParams() },
      env,
    );
    expect(reminded.status).toBe(303);
    const notice = sqlite.prepare("SELECT body FROM notifications WHERE user_id = 'user_pat' ORDER BY created_at DESC").get() as {
      body: string;
    };
    expect(notice.body).toContain("Lot 43, first improved: $625.00");
    expect(notice.body).toContain("Lot 44, additional improved: $315.00");
    expect(notice.body).toContain("Lot 12, vacant: $220.00");
    expect(notice.body).toContain("Beach box: $150.00");

    const savedRates = await app.request(
      "http://localhost/a/tango-mar/admin/fee-schedule",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({
          first_improved_amount: "700.00",
          additional_improved_amount: "400.00",
          vacant_amount: "250.00",
        }),
      },
      env,
    );
    expect(decodeURIComponent(savedRates.headers.get("Set-Cookie") ?? "")).toContain(
      "Fee schedule saved. Invoices already assigned were not changed.",
    );
    const still = sqlite.prepare("SELECT amount_cents FROM invoices WHERE id = ?").get(invoice.id) as { amount_cents: number };
    expect(still.amount_cents).toBe(131000);
    expect(
      sqlite.prepare("SELECT description FROM invoice_lines WHERE invoice_id = ? AND kind = 'first_improved'").get(invoice.id),
    ).toEqual({ description: "Lot 43, first improved" });

    const primary = await app.request(
      "http://localhost/a/tango-mar/admin/fee-schedule/primary",
      {
        method: "POST",
        headers,
        body: new URLSearchParams({ user_id: "user_pat", property_id: "prop_44" }),
      },
      env,
    );
    expect(decodeURIComponent(primary.headers.get("Set-Cookie") ?? "")).toContain("First improved lot saved for lot 44.");
    const afterPrimary = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    const nextPreview = await afterPrimary.text();
    const patNext = nextPreview.slice(nextPreview.indexOf("/admin/owners/user_pat"));
    expect(patNext.indexOf("Lot 44, first improved")).toBeLessThan(patNext.indexOf("Lot 43, additional improved"));
    expect(
      sqlite.prepare("SELECT description FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order LIMIT 1").get(invoice.id),
    ).toEqual({ description: "Lot 43, first improved" });

    sqlite.prepare("UPDATE fee_addon_types SET active = 0 WHERE id = 'addon_tango_beach_box'").run();
    const inactivePreview = await app.request("http://localhost/a/tango-mar/admin/ledger", { headers }, env);
    const inactiveHtml = await inactivePreview.text();
    const patInactive = inactiveHtml.slice(inactiveHtml.indexOf("/admin/owners/user_pat"), inactiveHtml.indexOf("</table>", inactiveHtml.indexOf("/admin/owners/user_pat")));
    expect(patInactive).not.toContain("Beach box");
    expect(patInactive).toContain("$1,350.00");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ? AND kind = 'addon'").get(invoice.id)).toEqual({
      n: 1,
    });

    sqlite
      .prepare(
        `INSERT INTO assessments (
           id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, billing_mode, created_at
         ) VALUES (
           'assessment_flat_improved', 'assoc_tango_mar', 'Flat improved dues', '', 10000, '2098-03-01', '2098-01-01', 'improved', 'flat', '2026-10-15T00:00:00Z'
         )`,
      )
      .run();
    const flat = await assignAssessmentInvoices(db, {
      associationId: "assoc_tango_mar",
      assessmentId: "assessment_flat_improved",
      today,
    });
    expect(flat).toMatchObject({ created: 5, audience: "lots" });
    expect(count(sqlite, "SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE assessment_id = 'assessment_flat_improved')")).toBe(0);
    expect(
      count(sqlite, "SELECT COUNT(*) AS n FROM invoices WHERE assessment_id = 'assessment_flat_improved' AND property_id = 'prop_12'"),
    ).toBe(0);

    sqlite.close();
  });
});
