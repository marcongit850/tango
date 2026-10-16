import { esc } from "../lib/html";

export const PROCESSING_FEE_TOPIC = "Processing fee";
export const PROCESSING_TOPIC = "Processing";
export const ELECTRONIC_NOTICE_TOPIC = "Electronic Notice Consent";
export const STRIPE_KEY_TOPIC = "Stripe secret key";
export const WEBHOOK_TOPIC = "Webhook";
export const ROLE_TOPIC = "Role";
export const BOARD_ONLY_TOPIC = "Board only";
export const CLEAR_STUCK_TOPIC = "Clear stuck transfer";

export const PROCESSING_HELP =
  "Bank transfers usually take about 4 business days to clear. Your balance will update automatically once your payment goes through. You don't need to do anything.";

export const ELECTRONIC_NOTICE_HELP =
  "Checking this box lets the association send official notices to this email address instead of by mail. You can uncheck it at any time, and changing your email address will ask you to agree again.";

export const STRIPE_KEY_HELP =
  "Paste your association's Stripe secret key here so owners can pay online. Start with the test key, run one test payment and refund, then switch to the live key. Your key is stored encrypted and kept separate from every other association.";

export const WEBHOOK_HELP =
  "This tells the portal when a bank payment clears, fails, or is refunded. Copy the address shown into your Stripe webhook settings and paste Stripe's signing secret here.";

/**
 * Approved users-tab copy. Kept as written. It does not fully match the code:
 * Board-only documents are visible to board members and to anyone with edit access (canViewAdmin).
 * Staff notices go to people with edit access (notifyStaff / listStaffContacts), not to every board member.
 * Edit access, not the Admin label, is what can change owners, lots, invoices, and settings.
 * A board member with edit access is still labeled Board member and can edit. Admin is a homeowner with edit access.
 */
export const ROLE_HELP =
  "Owners see their own account, invoices, and documents. Board members also see board-only documents and notices. Admins can edit owners, lots, invoices, and settings.";

export const BOARD_ONLY_HELP = "Only board members and admins can see these files. Owners never see this section.";

export const CLEAR_STUCK_HELP =
  "Use this only if a bank payment has shown Processing for more than 14 days with no update from Stripe. It removes the hold so the owner can pay again. It does not mark anything paid.";

/** One help control. className is an extra class on the wrapper, such as help-desktop or help-mobile. */
export function helpTip(topic: string, text: string, className = ""): string {
  const id = `help-${crypto.randomUUID()}`;
  const label = `Help: ${topic}`;
  const extra = className ? ` ${esc(className)}` : "";
  return `<span class="help${extra}"><button type="button" class="help-btn" aria-label="${esc(label)}" aria-expanded="false" aria-controls="${esc(id)}"><span class="help-mark" aria-hidden="true">?</span></button><span id="${esc(id)}" class="help-pop" role="dialog" aria-modal="false" aria-label="${esc(label)}" tabindex="-1" hidden>${esc(text)}</span></span>`;
}
