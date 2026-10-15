import { balanceCents, isDelinquent } from "./money";

/** Improved lots use the existing lot type. Vacant lots are stored as unimproved. */
export type FeeLotType = "improved" | "unimproved";

export type FeeRates = {
  firstImprovedCents: number;
  additionalImprovedCents: number;
  vacantCents: number;
};

export type BillLineKind = "first_improved" | "additional_improved" | "vacant" | "addon";

export type BillingLot = {
  id: string;
  lotNumber: string;
  lotType: string;
  status: string;
};

export type BillingLink = {
  propertyId: string;
  userId: string;
  isPrimary: boolean;
  createdAt: string;
};

export type BillingAddon = {
  id: string;
  userId: string;
  addonTypeId: string;
  name: string;
  unitAmountCents: number;
  quantity: number;
  propertyId: string | null;
  lotNumber: string | null;
};

export type BillLine = {
  kind: BillLineKind;
  propertyId: string | null;
  nearPropertyId: string | null;
  addonTypeId: string | null;
  description: string;
  quantity: number;
  unitAmountCents: number;
  amountCents: number;
  sortOrder: number;
};

export type OwnerBill = {
  userId: string;
  lines: BillLine[];
  totalCents: number;
  anchorPropertyId: string | null;
  /** Saved choice. A vacant lot is stored but does not receive the first improved rate. */
  primaryPropertyId: string | null;
  ignoredPrimary: boolean;
  lotIds: string[];
};

export type OwnerBills = {
  bills: OwnerBill[];
  unassignedLots: BillingLot[];
};

/**
 * One period of dues for the owners in an association.
 * The invoice total is the sum of these lines. A processing fee added only when
 * someone pays online (for example a Stripe ACH fee) applies to that total, not to one line.
 */
export function buildOwnerBills(input: {
  lots: readonly BillingLot[];
  links: readonly BillingLink[];
  primaryByUser: ReadonlyMap<string, string>;
  addons: readonly BillingAddon[];
  rates: FeeRates;
}): OwnerBills {
  const active = input.lots.filter((lot) => lot.status === "active");
  const linksByLot = new Map<string, BillingLink[]>();
  for (const link of input.links) {
    const list = linksByLot.get(link.propertyId) ?? [];
    list.push(link);
    linksByLot.set(link.propertyId, list);
  }
  const linkedLotsByUser = new Map<string, Set<string>>();
  for (const link of input.links) {
    const set = linkedLotsByUser.get(link.userId) ?? new Set<string>();
    set.add(link.propertyId);
    linkedLotsByUser.set(link.userId, set);
  }

  const billedLots = new Map<string, BillingLot[]>();
  const unassignedLots: BillingLot[] = [];
  for (const lot of active) {
    const userId = billedUserId(linksByLot.get(lot.id) ?? [], input.primaryByUser);
    if (!userId) {
      unassignedLots.push(lot);
      continue;
    }
    const list = billedLots.get(userId) ?? [];
    list.push(lot);
    billedLots.set(userId, list);
  }

  const userIds = new Set<string>([...billedLots.keys(), ...input.addons.map((addon) => addon.userId)]);
  const bills: OwnerBill[] = [];
  for (const userId of userIds) {
    const lots = billedLots.get(userId) ?? [];
    const bill = billForOwner({
      userId,
      lots,
      primaryPropertyId: input.primaryByUser.get(userId) ?? null,
      addons: input.addons.filter((addon) => addon.userId === userId),
      linkedPropertyIds: linkedLotsByUser.get(userId) ?? new Set<string>(),
      rates: input.rates,
    });
    if (bill.lines.length > 0 && bill.anchorPropertyId) bills.push(bill);
  }
  bills.sort((a, b) => a.userId.localeCompare(b.userId));
  unassignedLots.sort((a, b) => compareLotNumbers(a.lotNumber, b.lotNumber));
  return { bills, unassignedLots };
}

export function compareLotNumbers(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function lotLineDescription(lotNumber: string, kind: Exclude<BillLineKind, "addon">): string {
  if (kind === "first_improved") return `Lot ${lotNumber}, first improved`;
  if (kind === "additional_improved") return `Lot ${lotNumber}, additional improved`;
  return `Lot ${lotNumber}, vacant`;
}

export function addonLineDescription(name: string, quantity: number): string {
  const label = name.trim() || "Add-on";
  if (quantity > 1) return `${label} x${quantity}`;
  return label;
}

export function feeLotType(lotType: string | null | undefined): FeeLotType {
  return lotType === "unimproved" ? "unimproved" : "improved";
}

function billedUserId(links: readonly BillingLink[], primaryByUser: ReadonlyMap<string, string>): string | null {
  if (links.length === 0) return null;
  const preferred = links.filter((link) => primaryByUser.get(link.userId) === link.propertyId);
  const pool = preferred.length > 0 ? preferred : links;
  const primaryOwners = pool.filter((link) => link.isPrimary);
  const candidates = (primaryOwners.length > 0 ? primaryOwners : pool).slice();
  candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.userId.localeCompare(b.userId));
  return candidates[0]?.userId ?? null;
}

function billForOwner(input: {
  userId: string;
  lots: readonly BillingLot[];
  primaryPropertyId: string | null;
  addons: readonly BillingAddon[];
  linkedPropertyIds: ReadonlySet<string>;
  rates: FeeRates;
}): OwnerBill {
  const improved = input.lots
    .filter((lot) => feeLotType(lot.lotType) === "improved")
    .slice()
    .sort((a, b) => compareLotNumbers(a.lotNumber, b.lotNumber) || a.id.localeCompare(b.id));
  const vacant = input.lots
    .filter((lot) => feeLotType(lot.lotType) === "unimproved")
    .slice()
    .sort((a, b) => compareLotNumbers(a.lotNumber, b.lotNumber) || a.id.localeCompare(b.id));
  const chosen = improved.find((lot) => lot.id === input.primaryPropertyId) ?? null;
  const first = chosen ?? improved[0] ?? null;
  const ignoredPrimary = Boolean(input.primaryPropertyId) && first?.id !== input.primaryPropertyId;
  const lines: BillLine[] = [];
  const pushLot = (lot: BillingLot, kind: Exclude<BillLineKind, "addon">, unit: number) => {
    lines.push({
      kind,
      propertyId: lot.id,
      nearPropertyId: null,
      addonTypeId: null,
      description: lotLineDescription(lot.lotNumber, kind),
      quantity: 1,
      unitAmountCents: unit,
      amountCents: unit,
      sortOrder: lines.length,
    });
  };
  if (first) pushLot(first, "first_improved", input.rates.firstImprovedCents);
  for (const lot of improved) {
    if (lot.id === first?.id) continue;
    pushLot(lot, "additional_improved", input.rates.additionalImprovedCents);
  }
  for (const lot of vacant) pushLot(lot, "vacant", input.rates.vacantCents);

  const billedIds = new Set(input.lots.map((lot) => lot.id));
  const anchorPropertyId = first?.id ?? vacant[0]?.id ?? null;
  const addons = input.addons.slice().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const addon of addons) {
    const quantity = addon.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) continue;
    const unit = addon.unitAmountCents;
    if (!Number.isSafeInteger(unit) || unit < 0) continue;
    const amount = unit * quantity;
    if (!Number.isSafeInteger(amount)) continue;
    const chargePropertyId = addonChargeProperty(addon.propertyId, billedIds, input.linkedPropertyIds, anchorPropertyId);
    if (!chargePropertyId) continue;
    lines.push({
      kind: "addon",
      propertyId: chargePropertyId,
      nearPropertyId: addon.propertyId,
      addonTypeId: addon.addonTypeId,
      description: addonLineDescription(addon.name, quantity),
      quantity,
      unitAmountCents: unit,
      amountCents: amount,
      sortOrder: lines.length,
    });
  }

  const anchor = anchorPropertyId ?? lines.find((line) => line.propertyId)?.propertyId ?? null;
  return {
    userId: input.userId,
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    anchorPropertyId: anchor,
    primaryPropertyId: input.primaryPropertyId,
    ignoredPrimary,
    lotIds: input.lots.map((lot) => lot.id),
  };
}

function addonChargeProperty(
  nearPropertyId: string | null,
  billedIds: ReadonlySet<string>,
  linkedPropertyIds: ReadonlySet<string>,
  anchorPropertyId: string | null,
): string | null {
  if (nearPropertyId && (billedIds.has(nearPropertyId) || linkedPropertyIds.has(nearPropertyId))) return nearPropertyId;
  return anchorPropertyId;
}

export type BalanceLineInput = {
  id: string;
  invoiceId: string;
  propertyId: string | null;
  anchorPropertyId: string;
  description: string;
  amountCents: number;
  sortOrder: number;
  lateFeeCents: number;
  dueOn: string;
  issuedOn: string;
  status: string;
};

export type BalanceCarry<T extends BalanceNumbers> = T & {
  line_items?: { description: string; amount_cents: number }[];
};

type BalanceNumbers = {
  property_id: string;
  charges_cents: number;
  late_fee_cents: number;
  payment_cents: number;
  past_due: number;
  balance_cents: number;
  delinquent: boolean;
};

/** Adds itemized dues onto lot balances. Payments fill lines in sort order. Any remainder sits on the anchor lot. */
export function adjustBalancesForLines<T extends BalanceNumbers>(
  rows: readonly T[],
  lines: readonly BalanceLineInput[],
  paidByInvoice: ReadonlyMap<string, number>,
  futurePaidByProperty: ReadonlyMap<string, number>,
  today: string,
): BalanceCarry<T>[] {
  const next = new Map<string, BalanceCarry<T>>(rows.map((row) => [row.property_id, { ...row }]));
  const grouped = new Map<string, BalanceLineInput[]>();
  for (const line of lines) {
    const list = grouped.get(line.invoiceId) ?? [];
    list.push(line);
    grouped.set(line.invoiceId, list);
  }
  for (const [invoiceId, invoiceLines] of grouped) {
    const ordered = invoiceLines.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    const anchorId = ordered[0]?.anchorPropertyId ?? "";
    const paid = paidByInvoice.get(invoiceId) ?? 0;
    const { byLineId, remainderCents } = allocateLinePayments(ordered, paid);
    const lateFee = ordered[0]?.lateFeeCents ?? 0;
    const anchor = anchorId ? next.get(anchorId) : undefined;
    if (anchor && lateFee > 0) {
      anchor.charges_cents += lateFee;
      anchor.late_fee_cents += lateFee;
    }
    if (anchor && remainderCents > 0) anchor.payment_cents += remainderCents;
    for (const line of ordered) {
      const propertyId = line.propertyId || anchorId;
      const row = propertyId ? next.get(propertyId) : undefined;
      if (!row) continue;
      row.charges_cents += line.amountCents;
      row.payment_cents += byLineId.get(line.id) ?? 0;
      const items = row.line_items ?? [];
      items.push({ description: line.description, amount_cents: line.amountCents });
      row.line_items = items;
      const unpaid = line.amountCents - (byLineId.get(line.id) ?? 0);
      if (
        unpaid > 0 &&
        (line.status === "open" || line.status === "partial") &&
        line.dueOn < today &&
        line.issuedOn <= today
      ) {
        row.past_due = 1;
      }
    }
  }
  for (const [propertyId, paid] of futurePaidByProperty) {
    const row = next.get(propertyId);
    if (row && paid > 0) row.payment_cents += paid;
  }
  return [...next.values()].map((row) => {
    const balance = balanceCents(row.charges_cents, row.payment_cents);
    const pastDue = Number(row.past_due) === 1;
    return {
      ...row,
      past_due: pastDue ? 1 : 0,
      balance_cents: balance,
      delinquent: isDelinquent(balance, pastDue),
    };
  });
}

export function allocateLinePayments(
  lines: readonly { id: string; amountCents: number; sortOrder: number }[],
  paidCents: number,
): { byLineId: Map<string, number>; remainderCents: number } {
  const ordered = lines.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  let left = Math.max(0, paidCents);
  const byLineId = new Map<string, number>();
  for (const line of ordered) {
    const take = Math.min(left, Math.max(0, line.amountCents));
    byLineId.set(line.id, take);
    left -= take;
  }
  return { byLineId, remainderCents: left };
}
