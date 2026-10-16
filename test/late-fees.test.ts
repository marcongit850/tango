import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  applyAutomaticLateFeesForAssociation,
  describeLateFeeSettings,
  floridaLateFeeCapCents,
  isPastLateFeeWait,
  lateFeeCents,
  lateFeeThresholdDate,
  runAutomaticLateFees,
  validateLateFeeSettings,
} from "../src/lib/late-fees";
import { addIsoDays } from "../src/lib/dates";
import { sha256Hex } from "../src/lib/tokens";
import { LATE_FEE_HELP } from "../src/views/help";

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
];

const TANGO = "assoc_tango_mar";
const ZONE = "America/Chicago";

function openPortal(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(file, "utf8"));
  return { sqlite, db: new SqliteD1(sqlite) as unknown as D1Database };
}

function portalEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_ENV: "production",
    EMAIL_FROM: "Tang-O-Mar <donotreply@mytangomar.com>",
    DOCUMENTS: {} as R2Bucket,
  } as Env;
}

function at(day: string): Date {
  return new Date(`${day}T18:00:00.000Z`);
}

async function signIn(sqlite: DatabaseSync, userId: string): Promise<string> {
  const token = `session-${userId}`;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(`sess_${userId}_${crypto.randomUUID()}`, userId, await sha256Hex(token), "2099-01-01T00:00:00.000Z", "2026-10-16T00:00:00.000Z");
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
    body: new URLSearchParams(fields),
  });
}

function flash(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/tango_flash=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function feeRow(sqlite: DatabaseSync, id: string): { late_fee_cents: number; late_fee_applied_at: string | null; late_fee_waived_at: string | null; status: string } {
  return sqlite
    .prepare("SELECT late_fee_cents, late_fee_applied_at, late_fee_waived_at, status FROM invoices WHERE id = ?")
    .get(id) as { late_fee_cents: number; late_fee_applied_at: string | null; late_fee_waived_at: string | null; status: string };
}

function insertInvoice(
  sqlite: DatabaseSync,
  row: { id: string; amount: number; issued: string; due: string; late?: number; status?: string; propertyId?: string },
): void {
  sqlite
    .prepare(
      `INSERT INTO invoices (
         id, association_id, property_id, invoice_number, description, amount_cents, late_fee_cents,
         issued_on, due_on, status, created_at
       ) VALUES (?, ?, ?, ?, 'Dues', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      row.id,
      TANGO,
      row.propertyId ?? "prop_27",
      row.id,
      row.amount,
      row.late ?? 0,
      row.issued,
      row.due,
      row.status ?? "open",
    );
}

function saveSettings(
  sqlite: DatabaseSync,
  settings: { type?: "flat" | "percent"; flat?: number; percent?: number; days?: number; from?: "issued_on" | "due_on"; enabled?: number },
): void {
  sqlite.prepare("DELETE FROM late_fee_settings WHERE association_id = ?").run(TANGO);
  sqlite
    .prepare(
      `INSERT INTO late_fee_settings (
         association_id, enabled, fee_type, flat_cents, percent_bps, days_to_wait, count_from, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-16T00:00:00.000Z')`,
    )
    .run(
      TANGO,
      settings.enabled ?? 1,
      settings.type ?? "flat",
      settings.flat ?? 2500,
      settings.percent ?? 0,
      settings.days ?? 10,
      settings.from ?? "due_on",
    );
}

function auditCount(sqlite: DatabaseSync, action: string, entityId: string): number {
  return Number(
    (sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE association_id = ? AND action = ? AND entity_id = ?").get(TANGO, action, entityId) as { n: number }).n,
  );
}

describe("late fee rules", () => {
  it("counts the wait from the invoice date or the due date", () => {
    expect(addIsoDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(lateFeeThresholdDate("2026-01-01", 10)).toBe("2026-01-11");
    expect(lateFeeThresholdDate("2026-01-15", 10)).toBe("2026-01-25");
    expect(isPastLateFeeWait("2026-01-10", "2026-01-01", 10)).toBe(false);
    expect(isPastLateFeeWait("2026-01-11", "2026-01-01", 10)).toBe(true);
    expect(isPastLateFeeWait("2026-01-24", "2026-01-15", 10)).toBe(false);
    expect(isPastLateFeeWait("2026-01-25", "2026-01-15", 10)).toBe(true);
  });

  it("uses a flat amount or a percent of the unpaid balance and clamps to the Florida cap", () => {
    expect(floridaLateFeeCapCents(10_000)).toBe(2500);
    expect(floridaLateFeeCapCents(200_000)).toBe(10_000);
    expect(lateFeeCents({ feeType: "flat", flatCents: 4000, percentBps: 0, unpaidCents: 10_000, invoiceAmountCents: 10_000 })).toBe(2500);
    expect(lateFeeCents({ feeType: "flat", flatCents: 1000, percentBps: 0, unpaidCents: 100_000, invoiceAmountCents: 100_000 })).toBe(1000);
    expect(lateFeeCents({ feeType: "flat", flatCents: 8000, percentBps: 0, unpaidCents: 200_000, invoiceAmountCents: 200_000 })).toBe(8000);
    expect(lateFeeCents({ feeType: "percent", flatCents: 0, percentBps: 1000, unpaidCents: 40_000, invoiceAmountCents: 100_000 })).toBe(4000);
    expect(lateFeeCents({ feeType: "percent", flatCents: 0, percentBps: 1000, unpaidCents: 200_000, invoiceAmountCents: 200_000 })).toBe(10_000);
    expect(lateFeeCents({ feeType: "percent", flatCents: 0, percentBps: 500, unpaidCents: 100_010, invoiceAmountCents: 100_010 })).toBe(5000);
  });

  it("rejects settings outside the allowed ranges", () => {
    expect(validateLateFeeSettings({ enabled: true, feeType: "flat", flatAmount: "25.00", percent: "0", days: "15", countFrom: "due_on" }).ok).toBe(true);
    const cases: { input: Parameters<typeof validateLateFeeSettings>[0]; message: string }[] = [
      { input: { enabled: true, feeType: "weekly", flatAmount: "25", percent: "0", days: "15", countFrom: "due_on" }, message: "Choose a flat dollar amount or a percent of the unpaid balance." },
      { input: { enabled: true, feeType: "flat", flatAmount: "25", percent: "0", days: "15", countFrom: "mailed" }, message: "Choose Invoice date or Due date." },
      { input: { enabled: true, feeType: "flat", flatAmount: "25", percent: "0", days: "0", countFrom: "due_on" }, message: "Days to wait must be a whole number from 1 to 365." },
      { input: { enabled: true, feeType: "flat", flatAmount: "25", percent: "0", days: "366", countFrom: "due_on" }, message: "Days to wait must be a whole number from 1 to 365." },
      { input: { enabled: true, feeType: "flat", flatAmount: "25", percent: "0", days: "10.5", countFrom: "due_on" }, message: "Days to wait must be a whole number from 1 to 365." },
      { input: { enabled: true, feeType: "flat", flatAmount: "-1", percent: "0", days: "15", countFrom: "due_on" }, message: "Enter a flat amount from 0.00 to 100000.00." },
      { input: { enabled: true, feeType: "percent", flatAmount: "0", percent: "101", days: "15", countFrom: "due_on" }, message: "Enter a percent from 0 to 100, such as 5." },
      { input: { enabled: true, feeType: "flat", flatAmount: "0", percent: "5", days: "15", countFrom: "due_on" }, message: "Enter a flat amount greater than 0.00 to turn late fees on." },
      { input: { enabled: true, feeType: "percent", flatAmount: "0", percent: "0", days: "15", countFrom: "issued_on" }, message: "Enter a percent greater than 0 to turn late fees on." },
    ];
    for (const item of cases) {
      const result = validateLateFeeSettings(item.input);
      expect(result.ok, item.message).toBe(false);
      if (!result.ok) expect(result.message).toBe(item.message);
    }
  });
});

describe("automatic late fees", () => {
  it("leaves real associations off and enables only the demo sample", () => {
    const { sqlite } = openPortal();
    try {
      expect(sqlite.prepare("SELECT association_id FROM late_fee_settings WHERE association_id = ?").get(TANGO)).toBeUndefined();
      expect(
        sqlite.prepare("SELECT enabled, fee_type, flat_cents, percent_bps, days_to_wait, count_from FROM late_fee_settings WHERE association_id = ?").get("assoc_seaside_demo"),
      ).toEqual({ enabled: 1, fee_type: "flat", flat_cents: 2500, percent_bps: 500, days_to_wait: 15, count_from: "due_on" });
      expect(sqlite.prepare("SELECT late_fee_cents, late_fee_applied_at FROM invoices WHERE id = 'invoice_demo_alex'").get()).toEqual({
        late_fee_cents: 2500,
        late_fee_applied_at: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("adds the fee from the invoice date or the due date, and not before the wait ends", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_basis", amount: 100_000, issued: "2026-01-01", due: "2026-01-15" });
      saveSettings(sqlite, { from: "issued_on", days: 10, flat: 2500 });
      expect((await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-10"))).applied).toBe(0);
      expect(feeRow(sqlite, "inv_basis").late_fee_cents).toBe(0);
      expect((await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-11"))).applied).toBe(1);
      expect(feeRow(sqlite, "inv_basis").late_fee_cents).toBe(2500);

      sqlite.prepare("UPDATE invoices SET late_fee_cents = 0, late_fee_applied_at = NULL, status = 'open' WHERE id = 'inv_basis'").run();
      saveSettings(sqlite, { from: "due_on", days: 10, flat: 2500 });
      expect((await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-11"))).applied).toBe(0);
      expect((await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-24"))).applied).toBe(0);
      expect((await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-25"))).applied).toBe(1);
      expect(feeRow(sqlite, "inv_basis").late_fee_cents).toBe(2500);
      expect(feeRow(sqlite, "inv_basis").late_fee_applied_at).toBeTruthy();
    } finally {
      sqlite.close();
    }
  });

  it("charges a flat amount or a percent of the unpaid balance and clamps both to the Florida cap", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_flat_cap", amount: 10_000, issued: "2026-01-01", due: "2026-01-01" });
      insertInvoice(sqlite, { id: "inv_flat_under", amount: 100_000, issued: "2026-01-01", due: "2026-01-01" });
      saveSettings(sqlite, { type: "flat", flat: 4000, days: 1, from: "due_on" });
      await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-02"));
      expect(feeRow(sqlite, "inv_flat_cap").late_fee_cents).toBe(2500);
      expect(feeRow(sqlite, "inv_flat_under").late_fee_cents).toBe(4000);
      expect(auditCount(sqlite, "late_fee_applied", "inv_flat_cap")).toBe(1);
      const capped = sqlite.prepare("SELECT detail FROM audit_log WHERE entity_id = 'inv_flat_cap' AND action = 'late_fee_applied'").get() as { detail: string };
      expect(capped.detail).toContain("from $0.00 to $25.00");
      expect(capped.detail).toContain("Florida limit");

      sqlite.prepare("UPDATE invoices SET late_fee_cents = 0, late_fee_applied_at = NULL WHERE id IN ('inv_flat_cap', 'inv_flat_under')").run();
      sqlite
        .prepare(
          `INSERT INTO payments (
             id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, created_at, is_test
           ) VALUES ('pay_part', ?, 'prop_27', 'inv_flat_under', 60000, 'check', '1', '2026-01-02', '', '2026-01-02T00:00:00.000Z', 0)`,
        )
        .run(TANGO);
      saveSettings(sqlite, { type: "percent", percent: 1000, flat: 0, days: 1, from: "due_on" });
      await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-01-02"));
      expect(feeRow(sqlite, "inv_flat_under").late_fee_cents).toBe(4000);
      expect(feeRow(sqlite, "inv_flat_cap").late_fee_cents).toBe(1000);
    } finally {
      sqlite.close();
    }
  });

  it("does not add the fee twice", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_once", amount: 50_000, issued: "2026-01-01", due: "2026-01-01" });
      saveSettings(sqlite, { flat: 2500, days: 1, from: "due_on" });
      const first = await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-02-01"));
      const second = await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-03-01"));
      expect(first.applied).toBe(1);
      expect(second.applied).toBe(0);
      expect(feeRow(sqlite, "inv_once").late_fee_cents).toBe(2500);
      expect(auditCount(sqlite, "late_fee_applied", "inv_once")).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("skips an invoice covered by a processing or open bank transfer", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_processing", amount: 40_000, issued: "2026-01-01", due: "2026-01-01" });
      insertInvoice(sqlite, { id: "inv_open", amount: 40_000, issued: "2026-01-01", due: "2026-01-01" });
      insertInvoice(sqlite, { id: "inv_expired", amount: 40_000, issued: "2026-01-01", due: "2026-01-01" });
      insertInvoice(sqlite, { id: "inv_paid_online", amount: 40_000, issued: "2026-01-01", due: "2026-01-01" });
      const allocation = (id: string) => JSON.stringify([{ invoiceId: id, propertyId: "prop_27", lotNumber: "27", amountCents: 40_000 }]);
      const insertIntent = (id: string, invoiceId: string, status: string, expires: string) => {
        sqlite
          .prepare(
            `INSERT INTO checkout_intents (
               id, association_id, user_id, amount_cents, allocation_json, lot_numbers, stripe_session_id, expires_at, created_at, status
             ) VALUES (?, ?, 'user_casey', 40000, ?, '27', '', ?, '2026-01-02T00:00:00.000Z', ?)`,
          )
          .run(id, TANGO, allocation(invoiceId), expires, status);
      };
      insertIntent("intent_processing", "inv_processing", "processing", "2020-01-01T00:00:00.000Z");
      insertIntent("intent_open", "inv_open", "open", "2099-01-01T00:00:00.000Z");
      insertIntent("intent_expired", "inv_expired", "open", "2020-01-01T00:00:00.000Z");
      insertIntent("intent_done", "inv_paid_online", "succeeded", "2099-01-01T00:00:00.000Z");
      saveSettings(sqlite, { flat: 2500, days: 1, from: "due_on" });
      await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-02-01"));
      expect(feeRow(sqlite, "inv_processing").late_fee_cents).toBe(0);
      expect(feeRow(sqlite, "inv_open").late_fee_cents).toBe(0);
      expect(feeRow(sqlite, "inv_expired").late_fee_cents).toBe(2500);
      expect(feeRow(sqlite, "inv_paid_online").late_fee_cents).toBe(2500);
    } finally {
      sqlite.close();
    }
  });

  it("does not replace a manual late fee", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_manual", amount: 80_000, issued: "2026-01-01", due: "2026-01-01", late: 1500 });
      saveSettings(sqlite, { flat: 2500, days: 1, from: "due_on" });
      const result = await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-06-01"));
      expect(result.applied).toBeGreaterThan(0);
      expect(feeRow(sqlite, "inv_manual")).toMatchObject({ late_fee_cents: 1500, late_fee_applied_at: null });
      expect(feeRow(sqlite, "invoice_casey_open").late_fee_cents).toBe(2500);
      expect(feeRow(sqlite, "invoice_casey_2026").late_fee_cents).toBe(2500);
      expect(auditCount(sqlite, "late_fee_applied", "inv_manual")).toBe(0);
      expect(auditCount(sqlite, "late_fee_applied", "invoice_casey_open")).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("does not treat a test payment as paid and does treat a reversed payment as unpaid", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_test_pay", amount: 20_000, issued: "2026-01-01", due: "2026-01-01" });
      insertInvoice(sqlite, { id: "inv_reversed", amount: 20_000, issued: "2026-01-01", due: "2026-01-01" });
      sqlite
        .prepare(
          `INSERT INTO payments (
             id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, created_at, is_test
           ) VALUES ('pay_test_only', ?, 'prop_27', 'inv_test_pay', 20000, 'stripe', 'py_test', '2026-01-02', '', '2026-01-02T00:00:00.000Z', 1)`,
        )
        .run(TANGO);
      sqlite
        .prepare(
          `INSERT INTO payments (
             id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, created_at, is_test
           ) VALUES ('pay_real', ?, 'prop_27', 'inv_reversed', 20000, 'check', '9', '2026-01-02', '', '2026-01-02T00:00:00.000Z', 0)`,
        )
        .run(TANGO);
      saveSettings(sqlite, { flat: 2500, days: 1, from: "due_on" });
      await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-02-01"));
      expect(feeRow(sqlite, "inv_test_pay").late_fee_cents).toBe(2500);
      expect(feeRow(sqlite, "inv_reversed").late_fee_cents).toBe(0);

      sqlite
        .prepare(
          `INSERT INTO payment_reversals (
             id, association_id, payment_id, property_id, invoice_id, amount_cents, kind, status,
             stripe_payment_id, stripe_object_id, event_id, created_at
           ) VALUES ('rev_real', ?, 'pay_real', 'prop_27', 'inv_reversed', 20000, 'refund', 'refunded', 'py_real', 're_real', 'evt_real', '2026-02-02T00:00:00.000Z')`,
        )
        .run(TANGO);
      expect((await applyAutomaticLateFeesForAssociation(db, { id: TANGO, timezone: ZONE }, at("2026-02-03"))).applied).toBe(1);
      expect(feeRow(sqlite, "inv_reversed").late_fee_cents).toBe(2500);
    } finally {
      sqlite.close();
    }
  });

  it("does not change the demo ledger when the daily job runs", async () => {
    const { sqlite, db } = openPortal();
    try {
      insertInvoice(sqlite, { id: "inv_live", amount: 30_000, issued: "2026-01-01", due: "2026-01-01", propertyId: "prop_14" });
      saveSettings(sqlite, { flat: 2500, days: 1, from: "due_on" });
      const before = sqlite.prepare("SELECT late_fee_cents FROM invoices WHERE id = 'invoice_demo_riley'").get() as { late_fee_cents: number };
      const result = await runAutomaticLateFees(db, at("2026-10-16"));
      expect(result.applied).toBe(2);
      expect(feeRow(sqlite, "inv_live").late_fee_cents).toBe(2500);
      expect(feeRow(sqlite, "invoice_casey_2026").late_fee_cents).toBe(2500);
      expect(sqlite.prepare("SELECT late_fee_cents FROM invoices WHERE id = 'invoice_demo_riley'").get()).toEqual(before);
      expect(sqlite.prepare("SELECT late_fee_cents FROM invoices WHERE id = 'invoice_demo_alex'").get()).toEqual({ late_fee_cents: 2500 });
    } finally {
      sqlite.close();
    }
  });
});

describe("late fee settings and waive", () => {
  it("saves settings for an editor, records old and new values, and refuses everyone else", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    try {
      sqlite
        .prepare("INSERT INTO users (id, email, name, phone, created_at) VALUES ('user_board_view', 'board.view@example.com', 'Board View', '', '2026-10-16T00:00:00.000Z')")
        .run();
      sqlite
        .prepare(
          "INSERT INTO memberships (id, association_id, user_id, role_id, status, is_admin, created_at) VALUES ('mem_board_view', ?, 'user_board_view', 'board', 'active', 0, '2026-10-16T00:00:00.000Z')",
        )
        .run(TANGO);
      const jordan = await signIn(sqlite, "user_jordan");
      const sam = await signIn(sqlite, "user_sam");
      const board = await signIn(sqlite, "user_board_view");
      const page = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(LATE_FEE_HELP);
      expect(html).toContain('id="late-fees"');
      expect(html).toContain("Turn on automatic late fees");
      expect(html).toContain("Flat dollar amount");
      expect(html).toContain("Percent of the unpaid balance");
      expect(html).toContain("Invoice date");
      expect(html).toContain("Due date");
      expect(html).not.toContain("\u2014");
      expect(html).not.toContain("\u2013");

      for (const token of [sam, board]) {
        const deniedGet = await app.request("http://localhost/a/tango-mar/admin/payment-settings", { headers: { Cookie: `tango_session=${token}` } }, env);
        expect(deniedGet.status).toBe(403);
        const deniedPost = await app.request(
          formRequest("/a/tango-mar/admin/payment-settings/late-fees", token, {
            late_fee_enabled: "yes",
            fee_type: "flat",
            flat_amount: "25.00",
            percent: "0",
            days: "15",
            count_from: "due_on",
          }),
          {},
          env,
        );
        expect(deniedPost.status).toBe(403);
      }

      const invalid = await app.request(
        formRequest("/a/tango-mar/admin/payment-settings/late-fees", jordan, {
          late_fee_enabled: "yes",
          fee_type: "flat",
          flat_amount: "25.00",
          percent: "0",
          days: "0",
          count_from: "due_on",
        }),
        {},
        env,
      );
      expect(invalid.status).toBe(303);
      expect(flash(invalid)).toContain("Days to wait must be a whole number from 1 to 365.");
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM late_fee_settings WHERE association_id = ?").get(TANGO)).toEqual({ n: 0 });

      const fields = {
        late_fee_enabled: "yes",
        fee_type: "flat",
        flat_amount: "40.00",
        percent: "5",
        days: "15",
        count_from: "issued_on",
      };
      const saved = await app.request(formRequest("/a/tango-mar/admin/payment-settings/late-fees", jordan, fields), {}, env);
      expect(saved.status).toBe(303);
      expect(flash(saved)).toContain("Late fees saved.");
      const again = await app.request(formRequest("/a/tango-mar/admin/payment-settings/late-fees", jordan, fields), {}, env);
      expect(again.status).toBe(303);
      const audits = sqlite
        .prepare("SELECT action, detail, actor_user_id FROM audit_log WHERE association_id = ? AND action = 'late_fee_settings'")
        .all(TANGO) as { action: string; detail: string; actor_user_id: string }[];
      expect(audits).toHaveLength(1);
      expect(audits[0].actor_user_id).toBe("user_jordan");
      expect(audits[0].detail).toContain(`from ${describeLateFeeSettings({ enabled: false, feeType: "flat", flatCents: 0, percentBps: 0, daysToWait: 15, countFrom: "due_on" })}`);
      expect(audits[0].detail).toContain(`to ${describeLateFeeSettings({ enabled: true, feeType: "flat", flatCents: 4000, percentBps: 500, daysToWait: 15, countFrom: "issued_on" })}`);
      expect(audits[0].detail).not.toContain("\u2014");
      expect(audits[0].detail).not.toContain("\u2013");
    } finally {
      sqlite.close();
    }
  });

  it("lets an editor waive a late fee and keeps the job from adding it again", async () => {
    const { sqlite, db } = openPortal();
    const app = createApp();
    const env = portalEnv(db);
    try {
      insertInvoice(sqlite, { id: "inv_waive", amount: 90_000, issued: "2026-01-01", due: "2026-01-15", propertyId: "prop_14" });
      saveSettings(sqlite, { flat: 2500, days: 1, from: "due_on" });
      await runAutomaticLateFees(db, at("2026-02-01"));
      expect(feeRow(sqlite, "inv_waive").late_fee_cents).toBe(2500);

      const sam = await signIn(sqlite, "user_sam");
      const jordan = await signIn(sqlite, "user_jordan");
      const owner = await app.request("http://localhost/a/tango-mar/invoices/inv_waive", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(owner.status).toBe(200);
      const ownerHtml = await owner.text();
      expect(ownerHtml).toContain('<p>Late fee <span class="money">$25.00</span></p>');
      expect(ownerHtml).not.toContain("\u2014");
      expect(ownerHtml).not.toContain("\u2013");

      const admin = await app.request("http://localhost/a/tango-mar/admin/invoices/inv_waive", { headers: { Cookie: `tango_session=${jordan}` } }, env);
      expect(admin.status).toBe(200);
      expect(await admin.text()).toContain("Waive late fee");

      const ownerWaive = await app.request(formRequest("/a/tango-mar/admin/invoices/inv_waive/waive-late-fee", sam, {}), {}, env);
      expect(ownerWaive.status).toBe(403);
      expect(feeRow(sqlite, "inv_waive").late_fee_cents).toBe(2500);

      const waived = await app.request(formRequest("/a/tango-mar/admin/invoices/inv_waive/waive-late-fee", jordan, {}), {}, env);
      expect(waived.status).toBe(303);
      expect(flash(waived)).toContain("waived");
      const after = feeRow(sqlite, "inv_waive");
      expect(after.late_fee_cents).toBe(0);
      expect(after.late_fee_waived_at).toBeTruthy();
      const waiver = sqlite.prepare("SELECT actor_user_id, detail, created_at FROM audit_log WHERE action = 'late_fee_waived' AND entity_id = 'inv_waive'").get() as {
        actor_user_id: string;
        detail: string;
        created_at: string;
      };
      expect(waiver.actor_user_id).toBe("user_jordan");
      expect(waiver.detail).toContain("waived by Jordan Lee");
      expect(waiver.detail).toContain("from $25.00 to $0.00");
      expect(waiver.created_at).toBeTruthy();

      sqlite.prepare("UPDATE invoices SET late_fee_applied_at = NULL WHERE id = 'inv_waive'").run();
      const again = await runAutomaticLateFees(db, at("2026-06-01"));
      expect(again.applied).toBe(1);
      expect(feeRow(sqlite, "inv_waive").late_fee_cents).toBe(0);
      expect(feeRow(sqlite, "invoice_casey_2026").late_fee_cents).toBe(2500);

      const cleared = await app.request("http://localhost/a/tango-mar/invoices/inv_waive", { headers: { Cookie: `tango_session=${sam}` } }, env);
      expect(await cleared.text()).not.toContain("<p>Late fee");
    } finally {
      sqlite.close();
    }
  });
});
