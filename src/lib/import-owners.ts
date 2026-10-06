import type { Association, User } from "../types";
import { keepsAnAdmin } from "./access";
import type { OwnerCsvRow } from "./csv";
import { countActiveAdmins, writeAudit } from "../db";

const OPENING_DESCRIPTION = "Opening balance (CSV import)";

class LastAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastAdminError";
  }
}

export type ImportResult = {
  createdUsers: number;
  updatedUsers: number;
  invoices: number;
  credits: number;
  errors: { line: number; message: string }[];
};

export async function importOwners(
  db: D1Database,
  association: Association,
  actor: User,
  rows: OwnerCsvRow[],
): Promise<ImportResult> {
  const result: ImportResult = { createdUsers: 0, updatedUsers: 0, invoices: 0, credits: 0, errors: [] };
  const now = new Date().toISOString();

  for (const row of rows) {
    try {
      const outcome = await importRow(db, association, row, now);
      if (outcome.createdUser) result.createdUsers += 1;
      else result.updatedUsers += 1;
      if (outcome.invoice) result.invoices += 1;
      if (outcome.credit) result.credits += 1;
    } catch (error) {
      if (error instanceof LastAdminError) {
        result.errors.push({ line: row.line, message: error.message });
        continue;
      }
      console.error(
        JSON.stringify({
          level: "error",
          event: "csv_row_failed",
          line: row.line,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      result.errors.push({ line: row.line, message: "Could not import this row." });
    }
  }

  await writeAudit(db, {
    associationId: association.id,
    actorUserId: actor.id,
    action: "csv_import",
    entityType: "membership",
    entityId: association.id,
    detail: JSON.stringify({
      rows: rows.length,
      createdUsers: result.createdUsers,
      updatedUsers: result.updatedUsers,
      invoices: result.invoices,
      credits: result.credits,
      errors: result.errors.length,
    }),
  });

  return result;
}

async function importRow(
  db: D1Database,
  association: Association,
  row: OwnerCsvRow,
  now: string,
): Promise<{ createdUser: boolean; invoice: boolean; credit: boolean }> {
  const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(row.email).first<{ id: string }>();
  const user = await db
    .prepare(
      `INSERT INTO users (id, email, name, phone, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE users.phone END
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), row.email, row.name, row.phone, now)
    .first<{ id: string }>();
  if (!user) throw new Error("User upsert did not return an id.");

  const existingMembership = await db
    .prepare("SELECT role_id, is_admin, status FROM memberships WHERE association_id = ? AND user_id = ?")
    .bind(association.id, user.id)
    .first<{ role_id: string; is_admin: number; status: string }>();
  const isAdmin =
    row.role === "board" ? (row.isAdmin === null ? (Number(existingMembership?.is_admin) === 1 ? 1 : 0) : row.isAdmin ? 1 : 0) : 0;
  const currentlyAdmin =
    !!existingMembership &&
    (existingMembership.role_id === "board" || existingMembership.role_id === "officer") &&
    (existingMembership.role_id === "officer" || Number(existingMembership.is_admin) === 1) &&
    existingMembership.status === "active";
  const activeAdmins = await countActiveAdmins(db, association.id);
  if (!keepsAnAdmin({ activeAdminCount: activeAdmins, currentlyAdmin, nextAdmin: row.role === "board" && isAdmin === 1 })) {
    throw new LastAdminError("Keep at least one person with admin access.");
  }

  await db
    .prepare(
      `INSERT INTO memberships (id, association_id, user_id, role_id, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(association_id, user_id) DO UPDATE SET role_id = excluded.role_id, is_admin = excluded.is_admin, status = 'active'`,
    )
    .bind(crypto.randomUUID(), association.id, user.id, row.role, isAdmin, now)
    .run();

  const property = await db
    .prepare(
      `INSERT INTO properties (
         id, association_id, lot_number, street_address, city, state, postal_code, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON CONFLICT(association_id, lot_number) DO UPDATE SET
         street_address = excluded.street_address,
         city = excluded.city,
         state = excluded.state,
         postal_code = excluded.postal_code,
         status = 'active'
       RETURNING id`,
    )
    .bind(
      crypto.randomUUID(),
      association.id,
      row.lotNumber,
      row.streetAddress,
      row.city,
      row.state,
      row.postalCode,
      now,
    )
    .first<{ id: string }>();
  if (!property) throw new Error("Property upsert did not return an id.");

  await db
    .prepare(
      `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(property_id, user_id) DO UPDATE SET is_primary = 1`,
    )
    .bind(crypto.randomUUID(), association.id, property.id, user.id, now)
    .run();
  await db
    .prepare(
      `UPDATE property_owners SET is_primary = 0
       WHERE association_id = ? AND property_id = ? AND user_id != ?`,
    )
    .bind(association.id, property.id, user.id)
    .run();

  let invoice = false;
  let credit = false;
  if (row.startingBalanceCents > 0) {
    const existingInvoice = await db
      .prepare(
        `SELECT id FROM invoices
         WHERE association_id = ? AND property_id = ? AND description = ? AND status != 'void'`,
      )
      .bind(association.id, property.id, OPENING_DESCRIPTION)
      .first<{ id: string }>();
    if (!existingInvoice) {
      const invoiceNumber = `OPEN-${row.lotNumber}`.slice(0, 40);
      await db
        .prepare(
          `INSERT INTO invoices (
             id, association_id, property_id, invoice_number, description, amount_cents, late_fee_cents,
             issued_on, due_on, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'open', ?)`,
        )
        .bind(
          crypto.randomUUID(),
          association.id,
          property.id,
          invoiceNumber,
          OPENING_DESCRIPTION,
          row.startingBalanceCents,
          row.balanceAsOf,
          row.balanceAsOf,
          now,
        )
        .run();
      invoice = true;
    }
  } else if (row.startingBalanceCents < 0) {
    const reference = `OPENCREDIT-${row.lotNumber}`.slice(0, 80);
    const existingCredit = await db
      .prepare("SELECT id FROM payments WHERE association_id = ? AND property_id = ? AND reference = ?")
      .bind(association.id, property.id, reference)
      .first<{ id: string }>();
    if (!existingCredit) {
      await db
        .prepare(
          `INSERT INTO payments (
             id, association_id, property_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
           ) VALUES (?, ?, ?, ?, 'other', ?, ?, 'Opening credit (CSV import)', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          association.id,
          property.id,
          Math.abs(row.startingBalanceCents),
          reference,
          row.balanceAsOf,
          null,
          now,
        )
        .run();
      credit = true;
    }
  }

  return { createdUser: !existing, invoice, credit };
}
