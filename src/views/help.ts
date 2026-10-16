import { esc } from "../lib/html";

export const PROCESSING_FEE_TOPIC = "Processing fee";
export const PROCESSING_TOPIC = "Processing";
export const ELECTRONIC_NOTICE_TOPIC = "Electronic Notice Consent";
export const STRIPE_KEY_TOPIC = "Stripe secret key";
export const WEBHOOK_TOPIC = "Webhook";
export const ROLE_TOPIC = "Role";
export const BOARD_ONLY_TOPIC = "Board only";
export const CLEAR_STUCK_TOPIC = "Clear stuck transfer";
export const INVOICE_EMAIL_TOPIC = "Invoice emails";
export const LATE_FEE_TOPIC = "Late fees";
export const RESEND_INVOICE_TOPIC = "Email this invoice";
export const MAILED_CHECKS_TOPIC = "Mailed checks";

export const PROCESSING_HELP =
  "Bank transfers usually take about 4 business days to clear. Your balance will update automatically once your payment goes through. You don't need to do anything.";

export const ELECTRONIC_NOTICE_HELP =
  "Checking this box lets the association send official notices to this email address instead of by mail. You can uncheck it at any time, and changing your email address will ask you to agree again.";

export const STRIPE_KEY_HELP =
  "Paste your association's Stripe secret key here so owners can pay online. Start with the test key, run one test payment and refund, then switch to the live key. Your key is stored encrypted and kept separate from every other association.";

export const WEBHOOK_HELP =
  "This tells the portal when a bank payment clears, fails, or is refunded. Copy the address shown into your Stripe webhook settings and paste Stripe's signing secret here.";

/** Users tab. Edit access is what can change records and what receives staff notices. */
export const ROLE_HELP =
  "Owners see their own account, invoices, and documents. Board members also see board-only documents. Anyone with edit access, including admins, can edit owners, lots, invoices, and settings and gets staff notices.";

export const BOARD_ONLY_HELP = "Only board members and admins can see these files. Owners never see this section.";

export const CLEAR_STUCK_HELP =
  "Use this only if a bank payment has shown Processing for more than 14 days with no update from Stripe. It removes the hold so the owner can pay again. It does not mark anything paid.";

export const INVOICE_EMAIL_HELP =
  "When this is on, each owner is emailed their invoice on the date it is scheduled to go out, with a link to view and pay. Invoices are emailed once.";

export const LATE_FEE_HELP =
  "Late fees are added once to each invoice still unpaid after the number of days you choose. Florida law limits a late fee to $25 or 5% of the late installment, whichever is greater, and your governing documents must allow it.";

export const RESEND_INVOICE_HELP =
  "Sends this invoice to the owners of this lot, with a link to view and pay. You can send it again once a minute.";

export const MAILED_CHECKS_HELP =
  "These lines appear on invoice emails so an owner can mail a check. Leave the mailing address blank to use the association address. The note is optional and stays off the email when it is blank. Checks payable to uses the association name when you leave it blank.";

/** One help control. className is an extra class on the wrapper, such as help-desktop or help-mobile. */
export function helpTip(topic: string, text: string, className = ""): string {
  const id = `help-${crypto.randomUUID()}`;
  const label = `Help: ${topic}`;
  const extra = className ? ` ${esc(className)}` : "";
  return `<span class="help${extra}"><button type="button" class="help-btn" aria-label="${esc(label)}" aria-expanded="false" aria-controls="${esc(id)}"><span class="help-mark" aria-hidden="true">?</span></button><span id="${esc(id)}" class="help-pop" role="dialog" aria-modal="false" aria-label="${esc(label)}" tabindex="-1" hidden>${esc(text)}</span></span>`;
}
