import { isIsoDate } from "./dates";

export type LotType = "improved" | "unimproved";

export const IMPROVED_DUES_CENTS = 62500;
export const UNIMPROVED_DUES_CENTS = 10000;

export type AnnualDues = {
  name: string;
  description: string;
  amountCents: number;
  opensOn: string;
  dueOn: string;
  lotType: LotType;
};

export function isLotType(value: string): value is LotType {
  return value === "improved" || value === "unimproved";
}

export function lotTypeLabel(lotType: string | null | undefined): string {
  if (lotType === "unimproved") return "Unimproved";
  if (lotType === "improved") return "Improved";
  return "All lots";
}

export type AnnualDuesOptions = {
  amountCents: number;
  opensOn: string;
  dueOn: string;
};

export function annualDues(year: number, lotType: LotType, options?: AnnualDuesOptions): AnnualDues {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("Year must be between 2000 and 2100.");
  }
  const amountCents = options?.amountCents ?? (lotType === "improved" ? IMPROVED_DUES_CENTS : UNIMPROVED_DUES_CENTS);
  const label = lotType === "improved" ? "improved" : "unimproved";
  const opensOn = options?.opensOn ?? `${year}-01-01`;
  const dueOn = options?.dueOn ?? `${year}-03-01`;
  const standardDates = opensOn === `${year}-01-01` && dueOn === `${year}-03-01`;
  return {
    name: `${year} annual assessment (${label} lots)`,
    description: standardDates
      ? `HOA dues for ${label} lots. Open January 1 and due March 1.`
      : `HOA dues for ${label} lots.`,
    amountCents,
    opensOn,
    dueOn,
    lotType,
  };
}

export type DuesAmountRow = {
  name: string;
  amount_cents: number;
  due_on: string;
  lot_type: string | null;
};

/** Amounts for the Add a year form. Each lot type uses its newest annual row, or 625 / 100 when none exist. */
export function latestDuesAmounts(rows: readonly DuesAmountRow[]): { improvedCents: number; unimprovedCents: number } {
  return {
    improvedCents: latestLotAmount(rows, "improved"),
    unimprovedCents: latestLotAmount(rows, "unimproved"),
  };
}

function assessmentYear(name: string, dueOn: string): number | null {
  const named = /^(\d{4})\b/.exec(name.trim());
  const source = named ?? /^(\d{4})-/.exec(dueOn);
  if (!source) return null;
  const year = Number(source[1]);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return year;
}

function latestLotAmount(rows: readonly DuesAmountRow[], lotType: LotType): number {
  const fallback = lotType === "improved" ? IMPROVED_DUES_CENTS : UNIMPROVED_DUES_CENTS;
  const ranked = rows.flatMap((row) => {
    if (row.lot_type !== lotType) return [];
    const year = assessmentYear(row.name, row.due_on);
    if (year === null) return [];
    return [
      {
        year,
        dueOn: row.due_on,
        annual: row.name.trim() === `${year} annual assessment (${lotType} lots)`,
        cents: row.amount_cents,
      },
    ];
  });
  const annual = ranked.filter((row) => row.annual);
  const pool = annual.length > 0 ? annual : ranked;
  let best: (typeof pool)[number] | null = null;
  for (const candidate of pool) {
    if (!best || candidate.year > best.year || (candidate.year === best.year && candidate.dueOn > best.dueOn)) {
      best = candidate;
    }
  }
  return best ? best.cents : fallback;
}

/** In March or later, the next open January 1 is next year. Earlier, it is this year. */
export function defaultDuesYear(today: string): number {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return new Date().getFullYear();
  return month >= 3 ? year + 1 : year;
}

export type AssignableLot = {
  id: string;
  lotNumber: string;
  status: string;
  lotType: LotType;
};

/** True when the open date is today or earlier, so matching lots should have invoices. */
export function assessmentOpenForInvoicing(opensOn: string | null | undefined, today: string): boolean {
  if (!opensOn || !isIsoDate(opensOn) || !isIsoDate(today)) return false;
  return opensOn <= today;
}

export function lotsToInvoice(
  lots: readonly AssignableLot[],
  assessmentLotType: LotType | null,
  alreadyInvoiced: ReadonlySet<string>,
): { create: AssignableLot[]; already: number } {
  const eligible = lots.filter((lot) => {
    if (lot.status !== "active") return false;
    if (assessmentLotType && lot.lotType !== assessmentLotType) return false;
    return true;
  });
  const create = eligible.filter((lot) => !alreadyInvoiced.has(lot.id));
  return { create, already: eligible.length - create.length };
}
