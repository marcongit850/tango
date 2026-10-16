import { describe, expect, it } from "vitest";
import {
  bankTransferFeeCents,
  formatFeeCap,
  formatFeePercent,
  invoiceCreditReversalCents,
  parseFeePercentBps,
} from "../src/lib/bank-fee";

const standard = { enabled: true, percentBps: 80, capCents: 500 };

describe("bank transfer processing fee", () => {
  it("caps $625 at $5.00 and charges $0.81 on $100", () => {
    expect(bankTransferFeeCents(62_500, standard)).toBe(500);
    expect(bankTransferFeeCents(10_000, standard)).toBe(81);
  });

  it("rounds a tiny amount up to the next cent and leaves an exact gross-up alone", () => {
    expect(bankTransferFeeCents(1, standard)).toBe(1);
    expect(bankTransferFeeCents(124, standard)).toBe(1);
    expect(bankTransferFeeCents(40_050, standard)).toBe(323);
  });

  it("charges nothing when the fee is off, the percent is 0, or the cap is 0", () => {
    expect(bankTransferFeeCents(10_000, { ...standard, enabled: false })).toBe(0);
    expect(bankTransferFeeCents(10_000, { ...standard, percentBps: 0 })).toBe(0);
    expect(bankTransferFeeCents(10_000, { ...standard, capCents: 0 })).toBe(0);
    expect(bankTransferFeeCents(0, standard)).toBe(0);
  });

  it("refuses a percent or cap that cannot be used", () => {
    expect(bankTransferFeeCents(10_000, { ...standard, percentBps: 10000 })).toBeNull();
    expect(bankTransferFeeCents(10_000, { ...standard, percentBps: -1 })).toBeNull();
    expect(bankTransferFeeCents(10_000, { ...standard, capCents: -1 })).toBeNull();
    expect(parseFeePercentBps("0.8")).toBe(80);
    expect(parseFeePercentBps("0.80")).toBe(80);
    expect(parseFeePercentBps("10")).toBe(1000);
    expect(parseFeePercentBps("10.01")).toBeNull();
    expect(formatFeePercent(80)).toBe("0.8");
    expect(formatFeeCap(500)).toBe("5.00");
  });

  it("reverses invoice credit only up to the subtotal", () => {
    expect(invoiceCreditReversalCents(40_373, 0, 40_050)).toBe(40_050);
    expect(invoiceCreditReversalCents(10_000, 0, 40_050)).toBe(10_000);
    expect(invoiceCreditReversalCents(40_373, 40_050, 40_050)).toBe(0);
  });
});
