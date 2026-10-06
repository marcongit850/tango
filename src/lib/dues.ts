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

export function annualDues(year: number, lotType: LotType): AnnualDues {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error("Year must be between 2000 and 2100.");
  }
  const amountCents = lotType === "improved" ? IMPROVED_DUES_CENTS : UNIMPROVED_DUES_CENTS;
  const label = lotType === "improved" ? "improved" : "unimproved";
  return {
    name: `${year} annual assessment (${label} lots)`,
    description: `HOA dues for ${label} lots. Open January 1 and due March 1.`,
    amountCents,
    opensOn: `${year}-01-01`,
    dueOn: `${year}-03-01`,
    lotType,
  };
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
