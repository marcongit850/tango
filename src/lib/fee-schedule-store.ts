import {
  buildOwnerBills,
  feeLotType,
  type BillingAddon,
  type BillingLink,
  type BillingLot,
  type FeeRates,
} from "./fee-schedule";

export type FeeAddonTypeRow = {
  id: string;
  name: string;
  amountCents: number;
  active: boolean;
};

export type FeeAttachmentRow = {
  id: string;
  userId: string;
  ownerName: string;
  name: string;
  quantity: number;
  propertyId: string | null;
  lotNumber: string | null;
};

export type FeeScheduleView = {
  ready: boolean;
  rates: FeeRates | null;
  addonTypes: FeeAddonTypeRow[];
  owners: { id: string; name: string }[];
  lots: { id: string; lotNumber: string; lotType: FeeLotKind }[];
  attachments: FeeAttachmentRow[];
  preview: {
    userId: string;
    name: string;
    primaryPropertyId: string | null;
    ignoredPrimary: boolean;
    lots: { id: string; lotNumber: string; lotType: FeeLotKind }[];
    lines: { description: string; amountCents: number }[];
    totalCents: number;
  }[];
  unassigned: { lotNumber: string; lotType: FeeLotKind }[];
};

type FeeLotKind = "improved" | "unimproved";

const EMPTY_VIEW: FeeScheduleView = {
  ready: false,
  rates: null,
  addonTypes: [],
  owners: [],
  lots: [],
  attachments: [],
  preview: [],
  unassigned: [],
};

export async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row?.name === name;
}

export async function invoiceLinesReady(db: D1Database): Promise<boolean> {
  return tableExists(db, "invoice_lines");
}

export async function feeBillingReady(db: D1Database): Promise<boolean> {
  if (!(await tableExists(db, "fee_schedules"))) return false;
  const columns = await db.prepare("PRAGMA table_info(assessments)").all<{ name: string }>();
  return columns.results.some((column) => column.name === "billing_mode");
}

export async function getFeeRates(db: D1Database, associationId: string): Promise<FeeRates | null> {
  if (!(await tableExists(db, "fee_schedules"))) return null;
  const row = await db
    .prepare(
      `SELECT first_improved_cents, additional_improved_cents, vacant_cents
       FROM fee_schedules WHERE association_id = ?`,
    )
    .bind(associationId)
    .first<{ first_improved_cents: number; additional_improved_cents: number; vacant_cents: number }>();
  if (!row) return null;
  return {
    firstImprovedCents: Number(row.first_improved_cents),
    additionalImprovedCents: Number(row.additional_improved_cents),
    vacantCents: Number(row.vacant_cents),
  };
}

export async function saveFeeRates(
  db: D1Database,
  associationId: string,
  rates: FeeRates,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fee_schedules (
         association_id, first_improved_cents, additional_improved_cents, vacant_cents, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET
         first_improved_cents = excluded.first_improved_cents,
         additional_improved_cents = excluded.additional_improved_cents,
         vacant_cents = excluded.vacant_cents,
         updated_at = excluded.updated_at`,
    )
    .bind(associationId, rates.firstImprovedCents, rates.additionalImprovedCents, rates.vacantCents, now)
    .run();
}

export async function insertAddonType(
  db: D1Database,
  input: { id: string; associationId: string; name: string; amountCents: number; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fee_addon_types (id, association_id, name, amount_cents, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .bind(input.id, input.associationId, input.name, input.amountCents, input.now)
    .run();
}

export async function updateAddonType(
  db: D1Database,
  input: { associationId: string; id: string; name: string; amountCents: number; active: boolean },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE fee_addon_types
       SET name = ?, amount_cents = ?, active = ?
       WHERE association_id = ? AND id = ?`,
    )
    .bind(input.name, input.amountCents, input.active ? 1 : 0, input.associationId, input.id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function insertOwnerAddon(
  db: D1Database,
  input: {
    id: string;
    associationId: string;
    userId: string;
    addonTypeId: string;
    propertyId: string | null;
    quantity: number;
    now: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO owner_addons (
         id, association_id, user_id, addon_type_id, property_id, quantity, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.id, input.associationId, input.userId, input.addonTypeId, input.propertyId, input.quantity, input.now)
    .run();
}

export async function deleteOwnerAddon(db: D1Database, associationId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM owner_addons WHERE association_id = ? AND id = ?")
    .bind(associationId, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function setOwnerPrimaryLot(
  db: D1Database,
  input: { associationId: string; userId: string; propertyId: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO owner_primary_lots (association_id, user_id, property_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(association_id, user_id) DO UPDATE SET
         property_id = excluded.property_id,
         updated_at = excluded.updated_at`,
    )
    .bind(input.associationId, input.userId, input.propertyId, input.now)
    .run();
}

export async function clearOwnerPrimaryLot(db: D1Database, associationId: string, userId: string): Promise<void> {
  await db.prepare("DELETE FROM owner_primary_lots WHERE association_id = ? AND user_id = ?").bind(associationId, userId).run();
}

export async function userLinkedToLot(
  db: D1Database,
  associationId: string,
  userId: string,
  propertyId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM property_owners
       WHERE association_id = ? AND user_id = ? AND property_id = ?`,
    )
    .bind(associationId, userId, propertyId)
    .first<{ found: number }>();
  return Boolean(row);
}

export async function addonTypeInAssociation(
  db: D1Database,
  associationId: string,
  addonTypeId: string,
): Promise<{ id: string; active: number } | null> {
  return db
    .prepare("SELECT id, active FROM fee_addon_types WHERE association_id = ? AND id = ?")
    .bind(associationId, addonTypeId)
    .first<{ id: string; active: number }>();
}

export type BillingInputs = {
  rates: FeeRates;
  lots: BillingLot[];
  links: BillingLink[];
  primaryByUser: Map<string, string>;
  addons: BillingAddon[];
};

export async function loadBillingInputs(db: D1Database, associationId: string): Promise<BillingInputs | null> {
  if (!(await feeBillingReady(db))) return null;
  const rates = await getFeeRates(db, associationId);
  if (!rates) return null;
  const [lots, links, primaries, addons] = await Promise.all([
    listBillingLots(db, associationId),
    listBillingLinks(db, associationId),
    listPrimaryLots(db, associationId),
    listBillingAddons(db, associationId),
  ]);
  return { rates, lots, links, primaryByUser: primaries, addons };
}

export async function loadFeeScheduleView(db: D1Database, associationId: string): Promise<FeeScheduleView> {
  if (!(await feeBillingReady(db))) return EMPTY_VIEW;
  const [rates, addonTypes, owners, lots, links, primaries, attachments, billingAddons] = await Promise.all([
    getFeeRates(db, associationId),
    listAddonTypes(db, associationId),
    listBillingOwners(db, associationId),
    listBillingLots(db, associationId),
    listBillingLinks(db, associationId),
    listPrimaryLots(db, associationId),
    listAttachmentRows(db, associationId),
    listBillingAddons(db, associationId),
  ]);
  const names = new Map(owners.map((owner) => [owner.id, owner.name]));
  const built = rates ? buildOwnerBills({ lots, links, primaryByUser: primaries, addons: billingAddons, rates }) : null;
  const preview = (built?.bills ?? []).map((bill) => ({
    userId: bill.userId,
    name: names.get(bill.userId) ?? "Owner",
    primaryPropertyId: bill.primaryPropertyId,
    ignoredPrimary: bill.ignoredPrimary,
    lots: lots
      .filter((lot) => bill.lotIds.includes(lot.id))
      .map((lot) => ({ id: lot.id, lotNumber: lot.lotNumber, lotType: feeLotType(lot.lotType) })),
    lines: bill.lines.map((line) => ({ description: line.description, amountCents: line.amountCents })),
    totalCents: bill.totalCents,
  }));
  preview.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  const unassigned = (built?.unassignedLots ?? []).map((lot) => ({
    lotNumber: lot.lotNumber,
    lotType: feeLotType(lot.lotType),
  }));
  return {
    ready: true,
    rates,
    addonTypes,
    owners,
    lots: lots.map((lot) => ({ id: lot.id, lotNumber: lot.lotNumber, lotType: feeLotType(lot.lotType) })),
    attachments,
    preview,
    unassigned,
  };
}

export type InvoiceLineRecord = {
  id: string;
  invoice_id: string;
  property_id: string | null;
  near_property_id: string | null;
  kind: string;
  description: string;
  quantity: number;
  unit_amount_cents: number;
  amount_cents: number;
  sort_order: number;
};

export async function listInvoiceLines(
  db: D1Database,
  associationId: string,
  invoiceIds: readonly string[],
): Promise<InvoiceLineRecord[]> {
  if (invoiceIds.length === 0 || !(await invoiceLinesReady(db))) return [];
  const rows: InvoiceLineRecord[] = [];
  for (let index = 0; index < invoiceIds.length; index += 80) {
    const chunk = invoiceIds.slice(index, index + 80);
    const marks = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT id, invoice_id, property_id, near_property_id, kind, description, quantity,
                unit_amount_cents, amount_cents, sort_order
         FROM invoice_lines
         WHERE association_id = ? AND invoice_id IN (${marks})
         ORDER BY sort_order, id`,
      )
      .bind(associationId, ...chunk)
      .all<InvoiceLineRecord>();
    rows.push(...results);
  }
  return rows;
}

export async function sumInvoiceLineCents(db: D1Database, associationId: string, invoiceId: string): Promise<number | null> {
  if (!(await invoiceLinesReady(db))) return null;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
       FROM invoice_lines WHERE association_id = ? AND invoice_id = ?`,
    )
    .bind(associationId, invoiceId)
    .first<{ n: number; total: number }>();
  if (!row || Number(row.n) === 0) return null;
  return Number(row.total);
}

export async function deleteInvoiceLines(db: D1Database, associationId: string, invoiceId: string): Promise<void> {
  if (!(await invoiceLinesReady(db))) return;
  await db.prepare("DELETE FROM invoice_lines WHERE association_id = ? AND invoice_id = ?").bind(associationId, invoiceId).run();
}

export async function deleteFeeRowsForUser(
  db: D1Database,
  associationId: string,
  userId: string,
  shared: boolean,
): Promise<void> {
  if (await tableExists(db, "owner_addons")) {
    if (shared) {
      await db.prepare("DELETE FROM owner_addons WHERE association_id = ? AND user_id = ?").bind(associationId, userId).run();
    } else {
      await db.prepare("DELETE FROM owner_addons WHERE user_id = ?").bind(userId).run();
    }
  }
  if (await tableExists(db, "owner_primary_lots")) {
    if (shared) {
      await db
        .prepare("DELETE FROM owner_primary_lots WHERE association_id = ? AND user_id = ?")
        .bind(associationId, userId)
        .run();
    } else {
      await db.prepare("DELETE FROM owner_primary_lots WHERE user_id = ?").bind(userId).run();
    }
  }
  if (!shared && (await columnExists(db, "invoices", "billed_user_id"))) {
    await db.prepare("UPDATE invoices SET billed_user_id = NULL WHERE billed_user_id = ?").bind(userId).run();
  }
}

export async function propertyFeeBlockCount(db: D1Database, associationId: string, propertyId: string): Promise<number> {
  if (!(await invoiceLinesReady(db))) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM invoice_lines
       WHERE association_id = ? AND property_id = ?`,
    )
    .bind(associationId, propertyId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function clearPropertyFeeLinks(db: D1Database, associationId: string, propertyId: string): Promise<void> {
  const statements = [];
  if (await tableExists(db, "owner_primary_lots")) {
    statements.push(
      db.prepare("DELETE FROM owner_primary_lots WHERE association_id = ? AND property_id = ?").bind(associationId, propertyId),
    );
  }
  if (await tableExists(db, "owner_addons")) {
    statements.push(
      db
        .prepare("UPDATE owner_addons SET property_id = NULL WHERE association_id = ? AND property_id = ?")
        .bind(associationId, propertyId),
    );
  }
  if (await invoiceLinesReady(db)) {
    statements.push(
      db
        .prepare("UPDATE invoice_lines SET near_property_id = NULL WHERE association_id = ? AND near_property_id = ?")
        .bind(associationId, propertyId),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

async function columnExists(db: D1Database, table: string, column: string): Promise<boolean> {
  const columns = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return columns.results.some((row) => row.name === column);
}

async function listAddonTypes(db: D1Database, associationId: string): Promise<FeeAddonTypeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, amount_cents, active
       FROM fee_addon_types WHERE association_id = ?
       ORDER BY active DESC, name`,
    )
    .bind(associationId)
    .all<{ id: string; name: string; amount_cents: number; active: number }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    amountCents: Number(row.amount_cents),
    active: Number(row.active) === 1,
  }));
}

async function listBillingOwners(db: D1Database, associationId: string): Promise<{ id: string; name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.name
       FROM users u
       JOIN property_owners po ON po.user_id = u.id AND po.association_id = ?
       ORDER BY u.name, u.id`,
    )
    .bind(associationId)
    .all<{ id: string; name: string }>();
  return results;
}

async function listBillingLots(db: D1Database, associationId: string): Promise<BillingLot[]> {
  const { results } = await db
    .prepare(
      `SELECT id, lot_number, status, COALESCE(lot_type, 'improved') AS lot_type
       FROM properties WHERE association_id = ?`,
    )
    .bind(associationId)
    .all<{ id: string; lot_number: string; status: string; lot_type: string }>();
  return results.map((row) => ({
    id: row.id,
    lotNumber: row.lot_number,
    status: row.status,
    lotType: row.lot_type,
  }));
}

async function listBillingLinks(db: D1Database, associationId: string): Promise<BillingLink[]> {
  const { results } = await db
    .prepare(
      `SELECT property_id, user_id, is_primary, created_at
       FROM property_owners WHERE association_id = ?`,
    )
    .bind(associationId)
    .all<{ property_id: string; user_id: string; is_primary: number; created_at: string }>();
  return results.map((row) => ({
    propertyId: row.property_id,
    userId: row.user_id,
    isPrimary: Number(row.is_primary) === 1,
    createdAt: row.created_at ?? "",
  }));
}

async function listPrimaryLots(db: D1Database, associationId: string): Promise<Map<string, string>> {
  if (!(await tableExists(db, "owner_primary_lots"))) return new Map();
  const { results } = await db
    .prepare("SELECT user_id, property_id FROM owner_primary_lots WHERE association_id = ?")
    .bind(associationId)
    .all<{ user_id: string; property_id: string }>();
  return new Map(results.map((row) => [row.user_id, row.property_id]));
}

async function listBillingAddons(db: D1Database, associationId: string): Promise<BillingAddon[]> {
  if (!(await tableExists(db, "owner_addons"))) return [];
  const { results } = await db
    .prepare(
      `SELECT a.id, a.user_id, a.addon_type_id, t.name, t.amount_cents, a.quantity, a.property_id, p.lot_number
       FROM owner_addons a
       JOIN fee_addon_types t ON t.id = a.addon_type_id AND t.association_id = a.association_id
       LEFT JOIN properties p ON p.id = a.property_id AND p.association_id = a.association_id
       WHERE a.association_id = ? AND t.active = 1`,
    )
    .bind(associationId)
    .all<{
      id: string;
      user_id: string;
      addon_type_id: string;
      name: string;
      amount_cents: number;
      quantity: number;
      property_id: string | null;
      lot_number: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    addonTypeId: row.addon_type_id,
    name: row.name,
    unitAmountCents: Number(row.amount_cents),
    quantity: Number(row.quantity),
    propertyId: row.property_id,
    lotNumber: row.lot_number,
  }));
}

async function listAttachmentRows(db: D1Database, associationId: string): Promise<FeeAttachmentRow[]> {
  if (!(await tableExists(db, "owner_addons"))) return [];
  const { results } = await db
    .prepare(
      `SELECT a.id, a.user_id, u.name AS owner_name, t.name, a.quantity, a.property_id, p.lot_number
       FROM owner_addons a
       JOIN fee_addon_types t ON t.id = a.addon_type_id AND t.association_id = a.association_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN properties p ON p.id = a.property_id AND p.association_id = a.association_id
       WHERE a.association_id = ?
       ORDER BY u.name, t.name, a.id`,
    )
    .bind(associationId)
    .all<{
      id: string;
      user_id: string;
      owner_name: string;
      name: string;
      quantity: number;
      property_id: string | null;
      lot_number: string | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    ownerName: row.owner_name,
    name: row.name,
    quantity: Number(row.quantity),
    propertyId: row.property_id,
    lotNumber: row.lot_number,
  }));
}
