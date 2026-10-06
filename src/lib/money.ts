export function parseMoneyToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith("-");
  const cleaned = trimmed.replace(/[$,()\s]/g, "").replace(/^-/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, fraction = ""] = cleaned.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

export function formatDollarsPlain(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}${dollars}.${String(remainder).padStart(2, "0")}`;
}

export function balanceCents(chargesCents: number, paymentCents: number): number {
  return chargesCents - paymentCents;
}

export function isDelinquent(balance: number, pastDue: boolean): boolean {
  return balance > 0 && pastDue;
}

export function invoiceStatus(
  amountCents: number,
  lateFeeCents: number,
  paidCents: number,
): "open" | "partial" | "paid" {
  const due = amountCents + lateFeeCents;
  if (paidCents <= 0) return "open";
  if (paidCents >= due) return "paid";
  return "partial";
}

export function csvText(value: string): string {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
