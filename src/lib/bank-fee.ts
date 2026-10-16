/**
 * Bank transfer processing fee for online ACH payments.
 * Homeowners who pay online cover the fee. A mailed check stays fee-free.
 * gross = subtotal / (1 - pct/100) - subtotal, rounded up to the next cent, then capped.
 * The fee is computed here and stored beside the payment. It is not part of an invoice balance.
 */

export const DEFAULT_BANK_FEE_BPS = 80;
export const DEFAULT_BANK_FEE_CAP_CENTS = 500;
export const MAX_BANK_FEE_BPS = 1000;
export const MAX_BANK_FEE_CAP_CENTS = 2500;

export type BankFeeConfig = {
  enabled: boolean;
  /** Hundredths of a percent. 80 is 0.80%. */
  percentBps: number;
  capCents: number;
};

export const DEFAULT_BANK_FEE: BankFeeConfig = {
  enabled: true,
  percentBps: DEFAULT_BANK_FEE_BPS,
  capCents: DEFAULT_BANK_FEE_CAP_CENTS,
};

export const BANK_TRANSFER_FEE_LABEL = "Bank transfer processing fee";
export const BANK_TRANSFER_FEE_NOTE = "This fee covers bank transfer processing. To avoid it, mail a check to the association.";
export const BANK_TRANSFER_PROCESSING_STATUS = "Processing, usually 4 business days";
export const BANK_TRANSFER_PROCESSING_BLOCK =
  "A bank transfer for one of these invoices is still processing. It usually takes 4 business days.";

/** null when the saved percent or cap cannot be used. 0 when the fee is off or nothing is due. */
export function bankTransferFeeCents(subtotalCents: number, settings: BankFeeConfig): number | null {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents <= 0) return 0;
  if (!settings.enabled) return 0;
  if (!Number.isSafeInteger(settings.percentBps) || settings.percentBps < 0 || settings.percentBps >= 10000) return null;
  if (!Number.isSafeInteger(settings.capCents) || settings.capCents < 0) return null;
  if (settings.percentBps === 0 || settings.capCents === 0) return 0;
  const numerator = subtotalCents * settings.percentBps;
  if (!Number.isSafeInteger(numerator)) return null;
  const denominator = 10000 - settings.percentBps;
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  const gross = remainder === 0 ? quotient : quotient + 1;
  return Math.min(settings.capCents, gross);
}

/**
 * Cents of a Stripe refund or dispute that reverse invoice credit.
 * The bank transfer processing fee was never invoice credit, so a full refund of subtotal plus fee
 * reverses the subtotal only. Cents already reversed are not reversed again.
 * A refund at or below the subtotal is treated as invoice credit, because Stripe reports one total
 * and does not say whether those cents were the fee or the dues.
 */
export function invoiceCreditReversalCents(
  reportedCents: number,
  alreadyReversedCents: number,
  ledgerSubtotalCents: number,
): number {
  if (!Number.isSafeInteger(reportedCents) || reportedCents <= 0) return 0;
  if (!Number.isSafeInteger(ledgerSubtotalCents) || ledgerSubtotalCents <= 0) return 0;
  const already = Number.isSafeInteger(alreadyReversedCents) && alreadyReversedCents > 0 ? alreadyReversedCents : 0;
  const capped = Math.min(reportedCents, ledgerSubtotalCents);
  return Math.max(0, capped - already);
}

/** Accepts 0 through 10 with up to two decimal places. 0.8 and 0.80 are 80. */
export function parseFeePercentBps(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_BANK_FEE_BPS) return null;
  return bps;
}

export function formatFeePercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) return "0";
  const whole = Math.floor(bps / 100);
  const hundredths = bps % 100;
  if (hundredths === 0) return String(whole);
  if (hundredths % 10 === 0) return `${whole}.${hundredths / 10}`;
  return `${whole}.${String(hundredths).padStart(2, "0")}`;
}

export function formatFeeCap(cents: number): string {
  const absolute = Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
  return (absolute / 100).toFixed(2);
}
