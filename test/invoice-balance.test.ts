import { describe, expect, it } from "vitest";
import type { InvoiceRow } from "../src/db";
import type { Association } from "../src/types";
import { dashboardPage, invoiceDetailPage, invoiceListPage } from "../src/views/resident";

const association: Association = {
  id: "assoc_seaside",
  slug: "seaside",
  name: "Seaside",
  legal_name: "Seaside Owners Association",
  address_line1: "1 Beach Road",
  city: "Seaside",
  state: "FL",
  postal_code: "32459",
  county: "Walton County",
  timezone: "America/Chicago",
};

function invoice(overrides: Partial<InvoiceRow> & Pick<InvoiceRow, "id" | "invoice_number" | "status" | "amount_cents" | "paid_cents">): InvoiceRow {
  return {
    property_id: "prop_1",
    lot_number: "12",
    description: "Annual assessment",
    late_fee_cents: 0,
    issued_on: "2026-01-01",
    due_on: "2026-03-01",
    ...overrides,
  };
}

const partial = invoice({
  id: "invoice_demo_riley",
  invoice_number: "2026-12-ANNUAL",
  status: "partial",
  amount_cents: 90000,
  paid_cents: 60000,
});

const paid = invoice({
  id: "invoice_paid",
  invoice_number: "2025-12-ANNUAL",
  status: "paid",
  amount_cents: 90000,
  paid_cents: 90000,
});

const openWithFee = invoice({
  id: "invoice_open",
  invoice_number: "2026-06-SPECIAL",
  status: "open",
  amount_cents: 20000,
  late_fee_cents: 1500,
  paid_cents: 0,
});

function rowHtml(html: string, invoiceNumber: string): string {
  const marker = `>${invoiceNumber}</a>`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const tr = html.lastIndexOf("<tr>", start);
  const end = html.indexOf("</tr>", start);
  return html.slice(tr, end + 5);
}

describe("owner invoice balance", () => {
  it("shows the remaining balance after Total on the dashboard", () => {
    const html = dashboardPage({
      association,
      name: "Riley",
      ledger: [],
      upcoming: [],
      invoices: [partial, paid, openWithFee],
      payments: [],
      notices: [],
      emergencies: [],
      today: "2026-10-16",
      pay: { kind: "demo" },
    });
    const card = html.slice(html.indexOf("<h2>Invoices</h2>"), html.indexOf("Invoice history"));
    expect(card).toContain("<th>Number</th><th>Description</th><th>Due</th><th>Total</th><th>Balance</th><th>Status</th><th></th>");
    expect(card.indexOf("<th>Total</th>")).toBeLessThan(card.indexOf("<th>Balance</th>"));
    expect(card.indexOf("<th>Balance</th>")).toBeLessThan(card.indexOf("<th>Status</th>"));

    const partialRow = rowHtml(card, "2026-12-ANNUAL");
    expect(partialRow).toContain('<td><span class="money">$900.00</span></td><td><span class="money owe">$300.00</span></td><td>partial</td>');
    expect(partialRow).not.toContain('class="money owe">$900.00');
    expect(partialRow).toContain(">Pay now</a>");

    const paidRow = rowHtml(card, "2025-12-ANNUAL");
    expect(paidRow).toContain('<td><span class="money">$900.00</span></td><td><span class="money settled">$0.00</span></td><td>paid</td>');
    expect(paidRow).not.toContain("Pay now");
    expect(paidRow).not.toContain("money owe");

    const openRow = rowHtml(card, "2026-06-SPECIAL");
    expect(openRow).toContain('<td><span class="money">$215.00</span></td><td><span class="money owe">$215.00</span></td><td>open</td>');
  });

  it("adds Balance after Paid on invoice history and keeps component amounts plain", () => {
    const html = invoiceListPage(association, [partial, paid], { kind: "stripe", mode: "live" });
    expect(html).toContain("<th>Amount</th><th>Late fee</th><th>Paid</th><th>Balance</th><th>Status</th>");
    const partialRow = rowHtml(html, "2026-12-ANNUAL").replace(/\s+/g, " ");
    expect(partialRow).toContain('<td><span class="money">$900.00</span></td>');
    expect(partialRow).toContain('<td><span class="money">$0.00</span></td> <td><span class="money">$600.00</span></td> <td><span class="money owe">$300.00</span></td> <td>partial</td>');
    expect(partialRow).not.toContain("money owe\">$900.00");
    expect(partialRow).not.toContain("money owe\">$600.00");
    expect(rowHtml(html, "2025-12-ANNUAL")).toContain('<span class="money settled">$0.00</span>');
  });

  it("shows Balance on the invoice detail page and leaves the amount plain", () => {
    const detail = invoiceDetailPage(
      association,
      {
        ...partial,
        lines: [
          {
            id: "line_1",
            invoice_id: partial.id,
            property_id: partial.property_id,
            description: "Annual dues",
            quantity: 1,
            unit_amount_cents: 90000,
            amount_cents: 90000,
            sort_order: 0,
          },
        ],
      },
      "2026-10-16",
      { kind: "demo" },
    );
    expect(detail).toContain('<td>Total</td><td><span class="money">$900.00</span></td>');
    expect(detail).toContain('Amount <span class="money">$900.00</span>');
    expect(detail).toContain('Paid on this invoice <span class="money">$600.00</span>');
    expect(detail).toContain('Balance <span class="money owe">$300.00</span>');
    expect(detail).not.toContain("Remaining on this invoice");
    expect(detail).not.toContain('class="money owe">$900.00');
    expect(detail).not.toContain('class="money owe">$600.00');
    expect(detail).toContain(">Pay now</a>");

    const settled = invoiceDetailPage(association, paid, "2026-10-16");
    expect(settled).toContain('Balance <span class="money settled">$0.00</span>');
    expect(settled).not.toContain("money owe");
    expect(settled).not.toContain("Pay now");
  });

  it("leaves a future invoice without a balance or a red amount", () => {
    const detail = invoiceDetailPage(
      association,
      invoice({
        id: "inv_future",
        invoice_number: "2027-12-ANNUAL",
        status: "open",
        amount_cents: 90000,
        paid_cents: 0,
        issued_on: "2027-01-01",
      }),
      "2026-10-16",
    );
    expect(detail).toContain("Scheduled. Not owed until January 1, 2027.");
    expect(detail).toContain('<span class="money">$900.00</span>');
    expect(detail).not.toContain("Balance");
    expect(detail).not.toContain("money owe");
  });
});
