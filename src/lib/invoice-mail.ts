import type { Association } from "../types";
import { invoiceBankFeeLine, type BankFeeConfig } from "./bank-fee";
import { formatAddress } from "./dates";
import { invoiceOwnerEmail } from "./email";
import { tableExists } from "./fee-schedule-store";
import { canonicalPortalUrl } from "./hosts";
import { bankFeeConfig, onlinePaymentsOn } from "./online-payments";

export const INVOICE_MAIL_MIGRATION_MESSAGE =
  "Apply migrations/0027_invoice_mail.sql in D1, then reload, before mailed check details can be saved.";

export const DEMO_INVOICE_BOARD_NOTE =
  "Thank you for keeping our neighborhood beautiful. Dues are unchanged for 2027.";

export type InvoiceMailSettings = {
  ready: boolean;
  payableTo: string;
  boardNote: string;
};

export type InvoiceMailSave = { ok: true } | { ok: false; message: string };

const EMPTY_MAIL: InvoiceMailSettings = { ready: false, payableTo: "", boardNote: "" };

export async function invoiceMailSettings(db: D1Database, associationId: string): Promise<InvoiceMailSettings> {
  if (!(await tableExists(db, "invoice_mail_settings"))) return EMPTY_MAIL;
  // mailing_address stays in the table and is not read. Checks use the association address.
  const row = await db
    .prepare("SELECT payable_to, board_note FROM invoice_mail_settings WHERE association_id = ?")
    .bind(associationId)
    .first<{ payable_to: string; board_note: string }>();
  if (!row) return { ready: true, payableTo: "", boardNote: "" };
  return {
    ready: true,
    payableTo: row.payable_to ?? "",
    boardNote: row.board_note ?? "",
  };
}

export async function saveInvoiceMailSettings(
  db: D1Database,
  associationId: string,
  input: { payableTo: string; boardNote: string },
): Promise<InvoiceMailSave> {
  if (!(await tableExists(db, "invoice_mail_settings"))) return { ok: false, message: INVOICE_MAIL_MIGRATION_MESSAGE };
  const payableTo = input.payableTo.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  if (payableTo.length > 120) return { ok: false, message: "Checks payable to must be 120 characters or less." };
  const boardNote = input.boardNote.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  if (boardNote.length > 300) return { ok: false, message: "Note from the board must be 300 characters or less." };
  // mailing_address is not written, so a value already stored on the row is left as it is.
  await db
    .prepare(
      `INSERT INTO invoice_mail_settings (association_id, payable_to, board_note)
       VALUES (?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET
         payable_to = excluded.payable_to,
         board_note = excluded.board_note`,
    )
    .bind(associationId, payableTo, boardNote)
    .run();
  return { ok: true };
}

type CheckAddressSource = {
  name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
};

/** Same lines the public Estoppel page shows. A street of TBD is kept as written. */
export function associationCheckMailLines(association: CheckAddressSource): string[] {
  if (!association.address_line1.trim()) return [];
  return [association.name.trim(), "Attn: Board of Directors", formatAddress(association)];
}

/** Check box lines. Always the association address. Hidden only when the street is blank. */
export function mailLinesForEmail(association: CheckAddressSource): string[] {
  return associationCheckMailLines(association);
}

/** Read-only line in Payment settings. The lines are the same ones the email shows, joined with commas. */
export function checksMailedToLine(association: CheckAddressSource): string {
  const lines = associationCheckMailLines(association);
  if (lines.length === 0) return "No address yet. Add it on the Board page.";
  return `Checks are mailed to: ${lines.join(", ")}`;
}

/** Sample letter for the Payment settings preview. Uses this HOA's saved check details and payment switch. */
export async function previewInvoiceEmail(db: D1Database, association: Association): Promise<{ html: string }> {
  const [mail, payOnline, fee] = await Promise.all([
    invoiceMailSettings(db, association.id),
    onlinePaymentsOn(db, association.id),
    bankFeeConfig(db, association.id),
  ]);
  const letter = invoiceOwnerEmail({
    associationName: association.name,
    invoiceNumber: "2027-ANNUAL-014",
    description: "2027 Annual Assessment",
    lotNumber: "12",
    amountDueCents: 62500,
    lateFeeCents: 0,
    dueOn: "2027-01-31",
    timeZone: association.timezone,
    payUrl: canonicalPortalUrl(association, "/invoices/sample"),
    payOnline,
    feeLine: payOnline ? invoiceBankFeeLine(fee) : "",
    payableTo: mail.payableTo,
    mailLines: mailLinesForEmail(association),
    boardNote: mail.ready ? mail.boardNote : "",
  });
  return { html: letter.html };
}

export function feeLineForEmail(payOnline: boolean, fee: BankFeeConfig): string {
  return payOnline ? invoiceBankFeeLine(fee) : "";
}
