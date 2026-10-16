import { invoiceNetPaidSql, listAssociations, paymentReversalsReady, paymentTestReady, refreshInvoiceStatus, writeAudit } from "../db";
import { addIsoDays, isIsoDate, todayIso } from "./dates";
import { isDemoAssociationId } from "./demo";
import { tableExists } from "./fee-schedule-store";
import { logError, logInfo } from "./log";
import { formatMoney, parseMoneyToCents } from "./money";

/** F.S. 720.3085(3): the greater of $25 or 5% of the late installment. */
export const FLORIDA_LATE_FEE_FLAT_CAP_CENTS = 2500;
export const FLORIDA_LATE_FEE_PERCENT_BPS = 500;
export const MAX_LATE_FEE_FLAT_CENTS = 10_000_000;
export const MAX_LATE_FEE_PERCENT_BPS = 10_000;

export type LateFeeType = "flat" | "percent";
export type LateFeeCountFrom = "issued_on" | "due_on";

export type LateFeeSettings = {
  enabled: boolean;
  feeType: LateFeeType;
  flatCents: number;
  percentBps: number;
  daysToWait: number;
  countFrom: LateFeeCountFrom;
};

export const DEFAULT_LATE_FEE_SETTINGS: LateFeeSettings = {
  enabled: false,
  feeType: "flat",
  flatCents: 0,
  percentBps: 0,
  daysToWait: 15,
  countFrom: "due_on",
};

export type LateFeeSettingsView = LateFeeSettings & { ready: boolean };

const MIGRATION_MESSAGE = "Apply migrations/0023_late_fees.sql in D1, then try again. Until then, late fees stay a manual amount on each invoice.";

/**
 * First calendar day a late fee may be added.
 * Ten days from a due date of 2026-01-15 is 2026-01-25. The fee is not added on 2026-01-24.
 */
export function lateFeeThresholdDate(basis: string, days: number): string | null {
  if (!isIsoDate(basis) || !Number.isInteger(days) || days < 1 || days > 365) return null;
  return addIsoDays(basis, days);
}

/** True once the wait has elapsed. `today` is the association's calendar date. */
export function isPastLateFeeWait(today: string, basis: string, days: number): boolean {
  const threshold = lateFeeThresholdDate(basis, days);
  if (!threshold || !isIsoDate(today)) return false;
  return today >= threshold;
}

/** Greater of $25 or 5% of the invoice amount, in cents. 5% is rounded down so the fee cannot go over. */
export function floridaLateFeeCapCents(invoiceAmountCents: number): number {
  const amount = Math.max(0, Math.floor(invoiceAmountCents));
  const percent = Math.floor((amount * FLORIDA_LATE_FEE_PERCENT_BPS) / 10_000);
  return Math.max(FLORIDA_LATE_FEE_FLAT_CAP_CENTS, percent);
}

/**
 * Fee for one invoice. Flat uses the configured dollars. Percent uses the unpaid balance.
 * The result is clamped to the Florida cap for that invoice amount.
 */
export function lateFeeCents(input: {
  feeType: LateFeeType;
  flatCents: number;
  percentBps: number;
  unpaidCents: number;
  invoiceAmountCents: number;
}): number {
  const raw = input.feeType === "flat"
    ? Math.round(input.flatCents)
    : Math.round((Math.max(0, input.unpaidCents) * input.percentBps) / 10_000);
  if (!Number.isSafeInteger(raw) || raw <= 0) return 0;
  return Math.min(raw, floridaLateFeeCapCents(input.invoiceAmountCents));
}

export function parseLateFeePercentBps(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_LATE_FEE_PERCENT_BPS) return null;
  return bps;
}

export function formatLateFeePercent(bps: number): string {
  const hundredths = bps / 100;
  if (Number.isInteger(hundredths)) return String(hundredths);
  return hundredths.toFixed(2).replace(/0$/, "");
}

export function describeLateFeeSettings(settings: LateFeeSettings): string {
  const state = settings.enabled ? "on" : "off";
  const type = settings.feeType === "percent" ? "percent of the unpaid balance" : "flat dollar amount";
  const from = settings.countFrom === "issued_on" ? "Invoice date" : "Due date";
  return `${state}, ${type}, flat ${formatMoney(settings.flatCents)}, ${formatLateFeePercent(settings.percentBps)}%, ${settings.daysToWait} days from ${from}`;
}

export function validateLateFeeSettings(input: {
  enabled: boolean;
  feeType: string;
  flatAmount: string;
  percent: string;
  days: string;
  countFrom: string;
}): { ok: true; settings: LateFeeSettings } | { ok: false; message: string } {
  if (input.feeType !== "flat" && input.feeType !== "percent") {
    return { ok: false, message: "Choose a flat dollar amount or a percent of the unpaid balance." };
  }
  if (input.countFrom !== "issued_on" && input.countFrom !== "due_on") {
    return { ok: false, message: "Choose Invoice date or Due date." };
  }
  const daysText = input.days.trim();
  if (!/^\d+$/.test(daysText)) return { ok: false, message: "Days to wait must be a whole number from 1 to 365." };
  const days = Number(daysText);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { ok: false, message: "Days to wait must be a whole number from 1 to 365." };
  }
  const flatText = input.flatAmount.trim();
  const flatCents = flatText ? parseMoneyToCents(flatText) : 0;
  if (flatCents === null || flatCents < 0 || flatCents > MAX_LATE_FEE_FLAT_CENTS) {
    return { ok: false, message: "Enter a flat amount from 0.00 to 100000.00." };
  }
  const percentText = input.percent.trim();
  const percentBps = percentText ? parseLateFeePercentBps(percentText) : 0;
  if (percentBps === null) return { ok: false, message: "Enter a percent from 0 to 100, such as 5." };
  if (input.enabled && input.feeType === "flat" && flatCents <= 0) {
    return { ok: false, message: "Enter a flat amount greater than 0.00 to turn late fees on." };
  }
  if (input.enabled && input.feeType === "percent" && percentBps <= 0) {
    return { ok: false, message: "Enter a percent greater than 0 to turn late fees on." };
  }
  return {
    ok: true,
    settings: {
      enabled: input.enabled,
      feeType: input.feeType,
      flatCents,
      percentBps,
      daysToWait: days,
      countFrom: input.countFrom,
    },
  };
}

export async function lateFeesReady(db: D1Database): Promise<boolean> {
  return (await tableExists(db, "late_fee_settings")) && (await hasColumn(db, "invoices", "late_fee_applied_at")) && (await hasColumn(db, "invoices", "late_fee_waived_at"));
}

export async function lateFeeSettingsView(db: D1Database, associationId: string): Promise<LateFeeSettingsView> {
  if (!(await lateFeesReady(db))) return { ...DEFAULT_LATE_FEE_SETTINGS, ready: false };
  const row = await readSettings(db, associationId);
  return { ...(row ?? DEFAULT_LATE_FEE_SETTINGS), ready: true };
}

export async function saveLateFeeSettings(
  db: D1Database,
  associationId: string,
  userId: string,
  input: {
    enabled: boolean;
    feeType: string;
    flatAmount: string;
    percent: string;
    days: string;
    countFrom: string;
  },
): Promise<
  | { ok: true; changed: boolean; previous: LateFeeSettings; next: LateFeeSettings }
  | { ok: false; message: string }
> {
  if (!(await lateFeesReady(db))) return { ok: false, message: MIGRATION_MESSAGE };
  const parsed = validateLateFeeSettings(input);
  if (!parsed.ok) return parsed;
  const previous = (await readSettings(db, associationId)) ?? DEFAULT_LATE_FEE_SETTINGS;
  const next = parsed.settings;
  if (sameSettings(previous, next)) return { ok: true, changed: false, previous, next };
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO late_fee_settings (
         association_id, enabled, fee_type, flat_cents, percent_bps, days_to_wait, count_from, updated_at, updated_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET
         enabled = excluded.enabled,
         fee_type = excluded.fee_type,
         flat_cents = excluded.flat_cents,
         percent_bps = excluded.percent_bps,
         days_to_wait = excluded.days_to_wait,
         count_from = excluded.count_from,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    )
    .bind(
      associationId,
      next.enabled ? 1 : 0,
      next.feeType,
      next.flatCents,
      next.percentBps,
      next.daysToWait,
      next.countFrom,
      now,
      userId,
    )
    .run();
  return { ok: true, changed: true, previous, next };
}

export async function lateFeeWaiverState(
  db: D1Database,
  associationId: string,
  invoiceId: string,
): Promise<{ ready: boolean; waived: boolean }> {
  if (!(await hasColumn(db, "invoices", "late_fee_waived_at"))) return { ready: false, waived: false };
  const row = await db
    .prepare("SELECT late_fee_waived_at FROM invoices WHERE association_id = ? AND id = ?")
    .bind(associationId, invoiceId)
    .first<{ late_fee_waived_at: string | null }>();
  return { ready: true, waived: Boolean(row?.late_fee_waived_at) };
}

export async function waiveLateFee(
  db: D1Database,
  associationId: string,
  invoiceId: string,
  userId: string,
): Promise<
  | { ok: true; invoiceNumber: string; lotNumber: string; previousCents: number }
  | { ok: false; message: string }
> {
  if (!(await lateFeesReady(db))) return { ok: false, message: MIGRATION_MESSAGE };
  const invoice = await db
    .prepare(
      `SELECT i.invoice_number, i.late_fee_cents, p.lot_number
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       WHERE i.association_id = ? AND i.id = ?`,
    )
    .bind(associationId, invoiceId)
    .first<{ invoice_number: string; late_fee_cents: number; lot_number: string }>();
  if (!invoice) return { ok: false, message: "That invoice was not found." };
  const previous = Number(invoice.late_fee_cents);
  if (previous <= 0) return { ok: false, message: "This invoice has no late fee to waive." };
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE invoices
       SET late_fee_cents = 0, late_fee_waived_at = ?, late_fee_waived_by_user_id = ?
       WHERE association_id = ? AND id = ? AND late_fee_cents > 0`,
    )
    .bind(now, userId, associationId, invoiceId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return { ok: false, message: "This invoice has no late fee to waive." };
  await refreshInvoiceStatus(db, associationId, invoiceId);
  return { ok: true, invoiceNumber: invoice.invoice_number, lotNumber: invoice.lot_number, previousCents: previous };
}

/** Daily job. Skips the demo association so the sample ledger does not change. */
export async function runAutomaticLateFees(db: D1Database, now: Date): Promise<{ applied: number }> {
  if (!(await lateFeesReady(db))) {
    logInfo("late_fees", { skipped: "migration" });
    return { applied: 0 };
  }
  const associations = await listAssociations(db);
  let applied = 0;
  const failures: string[] = [];
  for (const association of associations) {
    if (isDemoAssociationId(association.id)) continue;
    try {
      const result = await applyAutomaticLateFeesForAssociation(db, association, now);
      applied += result.applied;
      if (result.applied > 0) {
        logInfo("late_fees", { associationId: association.id, applied: result.applied });
      }
    } catch (error) {
      failures.push(association.id);
      logError("late_fees", {
        associationId: association.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  if (failures.length > 0) throw new Error(`Late fees failed for ${failures.join(", ")}.`);
  return { applied };
}

export async function applyAutomaticLateFeesForAssociation(
  db: D1Database,
  association: { id: string; timezone: string },
  now: Date,
): Promise<{ applied: number }> {
  if (!(await lateFeesReady(db))) return { applied: 0 };
  const settings = await readSettings(db, association.id);
  if (!settings?.enabled) return { applied: 0 };
  const today = todayIso(association.timezone, now);
  const reversals = await paymentReversalsReady(db);
  const excludeTest = await paymentTestReady(db);
  const paidSql = invoiceNetPaidSql(reversals, excludeTest);
  const { results } = await db
    .prepare(
      `SELECT i.id, i.invoice_number, p.lot_number, i.amount_cents, i.late_fee_cents, i.issued_on, i.due_on,
              ${paidSql} AS paid_cents
       FROM invoices i
       JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
       WHERE i.association_id = ?
         AND i.status != 'void'
         AND i.issued_on <= ?
         AND i.late_fee_cents = 0
         AND i.late_fee_applied_at IS NULL
         AND i.late_fee_waived_at IS NULL`,
    )
    .bind(association.id, today)
    .all<{
      id: string;
      invoice_number: string;
      lot_number: string;
      amount_cents: number;
      late_fee_cents: number;
      issued_on: string;
      due_on: string;
      paid_cents: number;
    }>();
  const blocked = await checkoutBlockedInvoiceIds(db, association.id, now.toISOString());
  let applied = 0;
  for (const invoice of results) {
    if (blocked.has(invoice.id)) continue;
    const amount = Number(invoice.amount_cents);
    const already = Number(invoice.late_fee_cents);
    const paid = Number(invoice.paid_cents);
    const unpaid = amount + already - paid;
    if (unpaid <= 0) continue;
    const basis = settings.countFrom === "issued_on" ? invoice.issued_on : invoice.due_on;
    if (!isPastLateFeeWait(today, basis, settings.daysToWait)) continue;
    const fee = lateFeeCents({
      feeType: settings.feeType,
      flatCents: settings.flatCents,
      percentBps: settings.percentBps,
      unpaidCents: unpaid,
      invoiceAmountCents: amount,
    });
    if (fee <= 0) continue;
    const appliedAt = now.toISOString();
    const result = await db
      .prepare(
        `UPDATE invoices
         SET late_fee_cents = ?, late_fee_applied_at = ?
         WHERE association_id = ? AND id = ?
           AND late_fee_cents = 0
           AND late_fee_applied_at IS NULL
           AND late_fee_waived_at IS NULL
           AND status != 'void'`,
      )
      .bind(fee, appliedAt, association.id, invoice.id)
      .run();
    if ((result.meta.changes ?? 0) !== 1) continue;
    const from = settings.countFrom === "issued_on" ? "Invoice date" : "Due date";
    const raw = settings.feeType === "flat"
      ? settings.flatCents
      : Math.round((unpaid * settings.percentBps) / 10_000);
    const clamped = raw > fee ? ` Reduced to the Florida limit of ${formatMoney(fee)}.` : "";
    await writeAudit(db, {
      associationId: association.id,
      actorUserId: null,
      action: "late_fee_applied",
      entityType: "invoice",
      entityId: invoice.id,
      detail: `Automatic late fee on ${invoice.invoice_number} for lot ${invoice.lot_number} changed from ${formatMoney(0)} to ${formatMoney(fee)}. ${settings.daysToWait} days from ${from} ${basis}.${clamped}`,
    });
    await refreshInvoiceStatus(db, association.id, invoice.id);
    applied += 1;
  }
  return { applied };
}

async function readSettings(db: D1Database, associationId: string): Promise<LateFeeSettings | null> {
  const row = await db
    .prepare(
      `SELECT enabled, fee_type, flat_cents, percent_bps, days_to_wait, count_from
       FROM late_fee_settings WHERE association_id = ?`,
    )
    .bind(associationId)
    .first<{
      enabled: number;
      fee_type: string;
      flat_cents: number;
      percent_bps: number;
      days_to_wait: number;
      count_from: string;
    }>();
  if (!row) return null;
  if (row.fee_type !== "flat" && row.fee_type !== "percent") return null;
  if (row.count_from !== "issued_on" && row.count_from !== "due_on") return null;
  return {
    enabled: Number(row.enabled) === 1,
    feeType: row.fee_type,
    flatCents: Number(row.flat_cents),
    percentBps: Number(row.percent_bps),
    daysToWait: Number(row.days_to_wait),
    countFrom: row.count_from,
  };
}

function sameSettings(left: LateFeeSettings, right: LateFeeSettings): boolean {
  return left.enabled === right.enabled
    && left.feeType === right.feeType
    && left.flatCents === right.flatCents
    && left.percentBps === right.percentBps
    && left.daysToWait === right.daysToWait
    && left.countFrom === right.countFrom;
}

async function checkoutBlockedInvoiceIds(db: D1Database, associationId: string, nowIso: string): Promise<Set<string>> {
  if (!(await tableExists(db, "checkout_intents"))) return new Set();
  const statusReady = await hasColumn(db, "checkout_intents", "status");
  const sql = statusReady
    ? `SELECT allocation_json FROM checkout_intents
       WHERE association_id = ?
         AND (status = 'processing' OR (status = 'open' AND expires_at > ?))`
    : `SELECT allocation_json FROM checkout_intents
       WHERE association_id = ? AND expires_at > ?`;
  const { results } = await db.prepare(sql).bind(associationId, nowIso).all<{ allocation_json: string }>();
  const ids = new Set<string>();
  for (const row of results) {
    for (const id of invoiceIdsFromAllocation(row.allocation_json)) ids.add(id);
  }
  return ids;
}

function invoiceIdsFromAllocation(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { invoiceId?: unknown }).invoiceId;
      if (typeof id === "string" && id) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) return false;
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.some((row) => row.name === column);
}
