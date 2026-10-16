import type { Association } from "../types";
import { invoiceBankFeeLine, type BankFeeConfig } from "./bank-fee";
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
  mailingAddress: string;
  boardNote: string;
};

export type InvoiceMailSave = { ok: true } | { ok: false; message: string };

const EMPTY_MAIL: InvoiceMailSettings = { ready: false, payableTo: "", mailingAddress: "", boardNote: "" };

export function mailAddressLines(value: string): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean);
}

export async function invoiceMailSettings(db: D1Database, associationId: string): Promise<InvoiceMailSettings> {
  if (!(await tableExists(db, "invoice_mail_settings"))) return EMPTY_MAIL;
  const row = await db
    .prepare("SELECT payable_to, mailing_address, board_note FROM invoice_mail_settings WHERE association_id = ?")
    .bind(associationId)
    .first<{ payable_to: string; mailing_address: string; board_note: string }>();
  if (!row) return { ready: true, payableTo: "", mailingAddress: "", boardNote: "" };
  return {
    ready: true,
    payableTo: row.payable_to ?? "",
    mailingAddress: row.mailing_address ?? "",
    boardNote: row.board_note ?? "",
  };
}

export async function saveInvoiceMailSettings(
  db: D1Database,
  associationId: string,
  input: { payableTo: string; mailingAddress: string; boardNote: string },
): Promise<InvoiceMailSave> {
  if (!(await tableExists(db, "invoice_mail_settings"))) return { ok: false, message: INVOICE_MAIL_MIGRATION_MESSAGE };
  const payableTo = input.payableTo.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  if (payableTo.length > 120) return { ok: false, message: "Checks payable to must be 120 characters or less." };
  const lines = mailAddressLines(input.mailingAddress);
  if (lines.length > 5) return { ok: false, message: "Mailing address can be at most 5 lines." };
  if (lines.some((line) => line.length > 80)) return { ok: false, message: "Each mailing address line must be 80 characters or less." };
  const boardNote = input.boardNote.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  if (boardNote.length > 300) return { ok: false, message: "Note from the board must be 300 characters or less." };
  await db
    .prepare(
      `INSERT INTO invoice_mail_settings (association_id, payable_to, mailing_address, board_note)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(association_id) DO UPDATE SET
         payable_to = excluded.payable_to,
         mailing_address = excluded.mailing_address,
         board_note = excluded.board_note`,
    )
    .bind(associationId, payableTo, lines.join("\n"), boardNote)
    .run();
  return { ok: true };
}

export function mailLinesForEmail(settings: InvoiceMailSettings): string[] {
  if (!settings.ready) return [];
  return mailAddressLines(settings.mailingAddress).slice(0, 5);
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
    mailLines: mailLinesForEmail(mail),
    boardNote: mail.ready ? mail.boardNote : "",
  });
  return { html: letter.html };
}

export function feeLineForEmail(payOnline: boolean, fee: BankFeeConfig): string {
  return payOnline ? invoiceBankFeeLine(fee) : "";
}
