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

export const DUES_SCHEDULES = ["annual", "semiannual", "quarterly", "monthly"] as const;

export type DuesSchedule = (typeof DUES_SCHEDULES)[number];

export const DUES_SCHEDULE_OPTIONS: { value: DuesSchedule; label: string }[] = [
  { value: "annual", label: "Annual" },
  { value: "semiannual", label: "Semi-annual" },
  { value: "quarterly", label: "Quarterly" },
  { value: "monthly", label: "Monthly" },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const SCHEDULE_STEPS: Record<DuesSchedule, { count: number; months: number }> = {
  annual: { count: 1, months: 0 },
  semiannual: { count: 2, months: 6 },
  quarterly: { count: 4, months: 3 },
  monthly: { count: 12, months: 1 },
};

export function isDuesSchedule(value: string): value is DuesSchedule {
  return (DUES_SCHEDULES as readonly string[]).includes(value);
}

export function duesAmountFieldLabel(kind: "improved" | "unimproved", schedule: DuesSchedule): string {
  const lot = kind === "improved" ? "Improved" : "Unimproved";
  const period: Record<DuesSchedule, string> = {
    annual: "per year",
    semiannual: "per half year",
    quarterly: "per quarter",
    monthly: "per month",
  };
  return `${lot} lot amount ${period[schedule]}`;
}

/** Steps a calendar date by whole months and clamps the day (Jan 31 plus 1 month is Feb 28 or 29). */
export function addCalendarMonths(iso: string, months: number): string {
  if (!isIsoDate(iso) || !Number.isInteger(months)) throw new Error("Date is not valid.");
  const year = Number(iso.slice(0, 4));
  const monthIndex = Number(iso.slice(5, 7)) - 1;
  const day = Number(iso.slice(8, 10));
  const shifted = monthIndex + months;
  const nextYear = year + Math.floor(shifted / 12);
  const nextMonthIndex = ((shifted % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonthIndex + 1, 0)).getUTCDate();
  const clamped = Math.min(day, lastDay);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${nextYear}-${pad(nextMonthIndex + 1)}-${pad(clamped)}`;
}

export function duesScheduleFromName(name: string, year: number): DuesSchedule | null {
  const title = name.trim();
  if (
    title === `${year} annual assessment` ||
    title === `${year} annual assessment (improved lots)` ||
    title === `${year} annual assessment (unimproved lots)`
  ) {
    return "annual";
  }
  if (title === `${year} dues, Q1` || title === `${year} dues, Q2` || title === `${year} dues, Q3` || title === `${year} dues, Q4`) {
    return "quarterly";
  }
  if (title === `${year} dues, 1st half` || title === `${year} dues, 2nd half`) return "semiannual";
  if (MONTH_NAMES.some((month) => title === `${year} dues, ${month}`)) return "monthly";
  return null;
}

function installmentTitle(year: number, schedule: DuesSchedule, index: number, opensOn: string): string {
  if (schedule === "annual") return `${year} annual assessment`;
  if (schedule === "quarterly") return `${year} dues, Q${index + 1}`;
  if (schedule === "semiannual") return `${year} dues, ${index === 0 ? "1st half" : "2nd half"}`;
  const month = Number(opensOn.slice(5, 7));
  return `${year} dues, ${MONTH_NAMES[month - 1] ?? ""}`;
}

export function duesInstallments(input: {
  year: number;
  schedule: DuesSchedule;
  opensOn: string;
  dueOn: string;
}): { name: string; opensOn: string; dueOn: string }[] {
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) {
    throw new Error("Year must be between 2000 and 2100.");
  }
  if (!isIsoDate(input.opensOn) || !isIsoDate(input.dueOn)) throw new Error("Check the open date and due date.");
  const step = SCHEDULE_STEPS[input.schedule];
  const rows: { name: string; opensOn: string; dueOn: string }[] = [];
  for (let index = 0; index < step.count; index += 1) {
    const months = index * step.months;
    const opensOn = addCalendarMonths(input.opensOn, months);
    const dueOn = addCalendarMonths(input.dueOn, months);
    rows.push({ name: installmentTitle(input.year, input.schedule, index, opensOn), opensOn, dueOn });
  }
  return rows;
}

function duesDescription(lotType: LotType, schedule: DuesSchedule, year: number, opensOn: string, dueOn: string): string {
  const label = lotType === "improved" ? "improved" : "unimproved";
  if (schedule === "annual" && opensOn === `${year}-01-01` && dueOn === `${year}-03-01`) {
    return `HOA dues for ${label} lots. Open January 1 and due March 1.`;
  }
  return `HOA dues for ${label} lots.`;
}

/** Owner and admin lists show the year. Lot type stays on the Annual dues setup rows. */
export function assessmentDisplayName(name: string): string {
  return name.replace(/ \((?:improved|unimproved) lots\)$/, "");
}

export type AnnualDuesOptions = {
  amountCents: number;
  opensOn: string;
  dueOn: string;
};

export function scheduledDues(input: {
  year: number;
  lotType: LotType;
  schedule: DuesSchedule;
  amountCents: number;
  opensOn: string;
  dueOn: string;
}): AnnualDues[] {
  return duesInstallments(input).map((row) => ({
    name: row.name,
    description: duesDescription(input.lotType, input.schedule, input.year, row.opensOn, row.dueOn),
    amountCents: input.amountCents,
    opensOn: row.opensOn,
    dueOn: row.dueOn,
    lotType: input.lotType,
  }));
}

export function annualDues(year: number, lotType: LotType, options?: AnnualDuesOptions): AnnualDues {
  const row = scheduledDues({
    year,
    lotType,
    schedule: "annual",
    amountCents: options?.amountCents ?? (lotType === "improved" ? IMPROVED_DUES_CENTS : UNIMPROVED_DUES_CENTS),
    opensOn: options?.opensOn ?? `${year}-01-01`,
    dueOn: options?.dueOn ?? `${year}-03-01`,
  })[0];
  if (!row) throw new Error("Year must be between 2000 and 2100.");
  return row;
}

export type DuesAmountRow = {
  name: string;
  amount_cents: number;
  due_on: string;
  lot_type: string | null;
};

/** Schedule and amounts for Add a year. Each lot type uses its newest dues row, or 625 / 100 when none exist. */
export function latestDuesPrefill(rows: readonly DuesAmountRow[]): {
  schedule: DuesSchedule;
  improvedCents: number;
  unimprovedCents: number;
} {
  return {
    schedule: latestDuesSchedule(rows),
    improvedCents: latestLotAmount(rows, "improved"),
    unimprovedCents: latestLotAmount(rows, "unimproved"),
  };
}

export function latestDuesAmounts(rows: readonly DuesAmountRow[]): { improvedCents: number; unimprovedCents: number } {
  const prefill = latestDuesPrefill(rows);
  return { improvedCents: prefill.improvedCents, unimprovedCents: prefill.unimprovedCents };
}

function latestDuesSchedule(rows: readonly DuesAmountRow[]): DuesSchedule {
  let best: { year: number; dueOn: string; schedule: DuesSchedule } | null = null;
  for (const row of rows) {
    const year = assessmentYear(row.name, row.due_on);
    if (year === null) continue;
    const schedule = duesScheduleFromName(row.name, year);
    if (!schedule) continue;
    if (!best || year > best.year || (year === best.year && row.due_on > best.dueOn)) {
      best = { year, dueOn: row.due_on, schedule };
    }
  }
  return best?.schedule ?? "annual";
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
    const title = row.name.trim();
    return [
      {
        year,
        dueOn: row.due_on,
        dues: duesScheduleFromName(title, year) !== null,
        cents: row.amount_cents,
      },
    ];
  });
  const dues = ranked.filter((row) => row.dues);
  const pool = dues.length > 0 ? dues : ranked;
  let best: (typeof pool)[number] | null = null;
  for (const candidate of pool) {
    if (!best || candidate.year > best.year || (candidate.year === best.year && candidate.dueOn > best.dueOn)) {
      best = candidate;
    }
  }
  return best ? best.cents : fallback;
}

function lotTypeRank(lotType: string | null | undefined): number {
  if (lotType === "improved") return 0;
  if (lotType === "unimproved") return 1;
  return 2;
}

/** Newest year first, then installments in due-date order, then lot type. */
export function compareDuesRows(
  a: { name: string; due_on: string; lot_type: string | null },
  b: { name: string; due_on: string; lot_type: string | null },
): number {
  const yearA = assessmentYear(a.name, a.due_on) ?? 0;
  const yearB = assessmentYear(b.name, b.due_on) ?? 0;
  if (yearA !== yearB) return yearB - yearA;
  if (a.due_on !== b.due_on) return a.due_on < b.due_on ? -1 : 1;
  return lotTypeRank(a.lot_type) - lotTypeRank(b.lot_type);
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
