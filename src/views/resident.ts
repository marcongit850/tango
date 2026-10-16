import type {
  AnnouncementRow,
  AssessmentRow,
  BalanceRow,
  ContactRow,
  DocumentRow,
  EventRow,
  FaqRow,
  InvoiceRow,
  NoticeRow,
  OwnerLotProfile,
  PaymentRow,
  MessageRow,
} from "../db";
import { groupDocuments, type CategoryGroup, type FolderGroup } from "../lib/categories";
import { assessmentDisplayName } from "../lib/dues";
import { DOCUMENT_FILE_ACCEPT, isImageContentType } from "../lib/files";
import { clip, paragraphs, esc } from "../lib/html";
import {
  BANK_TRANSFER_FEE_LABEL,
  BANK_TRANSFER_FEE_NOTE,
  BANK_TRANSFER_PROCESSING_STATUS,
  bankTransferFeeCents,
  type BankFeeConfig,
} from "../lib/bank-fee";
import { formatMoney } from "../lib/money";
import type { OwnerPayOffer, ProcessingCheckout } from "../lib/online-payments";
import type { Association } from "../types";
import { addressLine, addressLocality, confirmDeleteButton, contactPhones, dateCell, dateTimeCell, documentFileLinks, empty, invoiceLinesTable, mailingAddressHtml, moneySpan, paymentMethodLabel, propertyAddressHtml, selectField, textField, areaField } from "./bits";

function remainingCents(row: InvoiceRow): number {
  return Number(row.amount_cents) + Number(row.late_fee_cents) - Number(row.paid_cents);
}

function canPayInvoice(row: InvoiceRow): boolean {
  return row.status !== "void" && row.status !== "paid" && remainingCents(row) > 0;
}

function payControl(slug: string, pay: OwnerPayOffer | undefined, label: string): string {
  if (!pay || pay.kind === "off") return "";
  return `<a class="button" href="/a/${esc(slug)}/pay">${esc(label)}</a>`;
}

function payNote(pay: OwnerPayOffer | undefined): string {
  if (!pay || pay.kind === "off") return "";
  if (pay.kind === "demo") return `<p class="muted">Sample checkout. Nothing is charged. Nothing here is real or saved.</p>`;
  if (pay.mode === "test") return `<p class="muted">Test mode. No real charge. Owners do not see Pay now until the key is live.</p>`;
  return "";
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 180) return flat;
  return `${clip(flat, 177)}...`;
}

function eventKindLabel(kind: string): string {
  if (kind === "meeting") return "Meeting";
  if (kind === "emergency") return "Emergency";
  return "Event";
}

// Invoiced only after the open date, and only for invoices that are already live.
// invoice_count ignores future issued_on. A future opens_on stays Scheduled even
// if a live invoice was written early.
function upcomingStatusLabel(row: AssessmentRow, today: string): "Invoiced" | "Scheduled" {
  const opensOn = row.opens_on ?? "";
  const waitingToOpen = opensOn !== "" && (today === "" || opensOn > today);
  if (waitingToOpen || row.invoice_count <= 0) return "Scheduled";
  return "Invoiced";
}

export function dashboardPage(options: {
  association: Association;
  name: string;
  ledger: BalanceRow[];
  upcoming: AssessmentRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  notices: NoticeRow[];
  emergencies: AnnouncementRow[];
  news?: AnnouncementRow[];
  events?: EventRow[];
  today?: string;
  pay?: OwnerPayOffer;
  bankTransferProcessing?: boolean;
}): string {
  const { association, ledger } = options;
  const total = ledger.reduce((sum, row) => sum + row.balance_cents, 0);
  const late = ledger.reduce((sum, row) => sum + row.late_fee_cents, 0);
  const base = `/a/${esc(association.slug)}`;
  const lots = ledger
    .map((row) => {
      const status = row.delinquent
        ? `<p><span class="badge late">Past due</span></p>`
        : row.balance_cents === 0
          ? `<p><span class="badge">Paid</span></p>`
          : "";
      const house = row.house_name?.trim() ?? "";
      const locality = addressLocality(row.city ?? "", row.state ?? "", row.postal_code ?? "");
      const mailing = addressLine(row.mailing_street ?? "", row.mailing_city ?? "", row.mailing_state ?? "", row.mailing_postal_code ?? "");
      return `<div class="lot">
        <div>
          <p class="lot-name"><a href="${base}/lots/${esc(row.property_id)}">Lot ${esc(row.lot_number)}</a></p>
          ${house ? `<p>${esc(house)}</p>` : ""}
          <p class="muted">${esc(row.street_address)}</p>
          ${locality ? `<p class="muted">${esc(locality)}</p>` : ""}
          ${mailing ? `<p class="muted">Mailing address (if different): ${esc(mailing)}</p>` : ""}
          ${(row.line_items ?? []).map((item) => `<p class="muted">${esc(item.description)} ${esc(formatMoney(item.amount_cents))}</p>`).join("")}
          ${status}
        </div>
        <div class="lot-figures">
          <p class="lot-amount">${moneySpan(row.balance_cents)}</p>
          <p class="muted">Late fees ${moneySpan(row.late_fee_cents)}</p>
        </div>
      </div>`;
    })
    .join("");
  const today = options.today ?? "";
  const upcoming = options.upcoming
    .map((row) => {
      const due = dateCell(row.due_on, association.timezone);
      const opens = row.opens_on ? `Opens ${dateCell(row.opens_on, association.timezone)}. ` : "";
      const notYetDue = Boolean(today) && (row.due_on > today || Boolean(row.opens_on && row.opens_on > today));
      const when = notYetDue ? " Not due yet." : "";
      return `<li>
        <div>
          <strong>${esc(assessmentDisplayName(row.name))}</strong>
          <p class="muted">${opens}Due ${due}.${when}</p>
        </div>
        <div class="dues-amount">
          <p><span class="money">${esc(formatMoney(row.amount_cents))}</span></p>
          <p class="muted">${upcomingStatusLabel(row, today)}</p>
        </div>
      </li>`;
    })
    .join("");
  const news = (options.news ?? [])
    .slice(0, 4)
    .map((item) => {
      const kind = item.kind === "meeting" ? `<span class="muted">Meeting</span>` : "";
      return `<li>
        <a href="${base}/news/${esc(item.id)}">
          <span class="muted">${dateCell(item.published_at, association.timezone)}</span>
          <strong>${esc(item.title)}</strong>
        </a>
        ${kind}
        <p>${esc(excerpt(item.body))}</p>
      </li>`;
    })
    .join("");
  const events = (options.events ?? [])
    .slice(0, 4)
    .map((item) => {
      const place = [eventKindLabel(item.kind), item.location].filter(Boolean).join(" · ");
      return `<li>
        <a href="${base}/calendar">
          <span class="muted">${dateTimeCell(item.starts_at, association.timezone)}</span>
          <strong>${esc(item.title)}</strong>
        </a>
        ${place ? `<p class="muted">${esc(place)}</p>` : ""}
      </li>`;
    })
    .join("");
  const showPay = Boolean(options.pay && options.pay.kind !== "off");
  const payable = options.invoices.filter(canPayInvoice);
  const invoices = options.invoices
    .slice(0, 6)
    .map(
      (row) => `<tr><td><a href="${base}/invoices/${esc(row.id)}">${esc(row.invoice_number)}</a></td><td>${invoiceDescriptionCell(row)}</td><td>${dateCell(row.due_on, association.timezone)}</td><td>${moneySpan(row.amount_cents + row.late_fee_cents)}</td><td>${esc(row.status)}</td>${showPay ? `<td>${canPayInvoice(row) ? payControl(association.slug, options.pay, "Pay now") : ""}</td>` : ""}</tr>`,
    )
    .join("");
  const payments = options.payments
    .slice(0, 6)
    .map(
      (row) => `<tr><td><a href="${base}/payments/${esc(row.id)}">${dateCell(row.paid_on, association.timezone)}</a></td><td>${esc(paymentMethodLabel(row.method, Number(row.is_test) === 1))}</td><td>${esc(row.reference)}</td><td>${moneySpan(row.amount_cents)}</td></tr>`,
    )
    .join("");
  const notices = options.notices
    .slice(0, 5)
    .map(
      (row) =>
        `<li><a href="${base}/notices">${esc(row.title)}</a> <span class="muted">${dateTimeCell(row.created_at, association.timezone)}</span> <span class="muted">${esc(row.body)}</span> ${noticeFileLinks(association.slug, row)}</li>`,
    )
    .join("");
  const emergencies = options.emergencies
    .map((row) => `<article class="emergency"><h2>${esc(row.title)}</h2>${paragraphs(row.body)}</article>`)
    .join("");
  const balanceCopy = ledger.length
    ? "Balance across your properties. Charges and late fees, minus recorded payments."
    : "No lot is linked to this login yet.";

  return `<div class="dash">
    ${emergencies}
    <header class="dash-hello">
      <p class="kicker">${esc(association.name)}</p>
      <span class="rule dash-rule" aria-hidden="true"></span>
      <h1>${esc(options.name)}</h1>
      <p class="muted">${esc(association.legal_name)}</p>
    </header>
    <section class="dash-grid">
      <article class="panel dash-balance">
        <p class="kicker">Account balance</p>
        ${ledger.length ? `<p class="balance-figure">${moneySpan(total)}</p>` : ""}
        <p class="muted">${balanceCopy}</p>
        ${late > 0 ? `<p>Outstanding late fees ${moneySpan(late)}</p>` : ""}
        ${showPay && payable.length > 0 ? `<div class="pay-actions">${payNote(options.pay)}${payControl(association.slug, options.pay, "Pay now")}</div>` : ""}
      </article>
      <article class="panel">
        <h2>Lot dues</h2>
        ${lots ? `<div class="lots">${lots}</div>` : empty("No lot is linked to this login yet.")}
        <h3>Upcoming assessments</h3>
        ${upcoming ? `<ul class="dues-list">${upcoming}</ul>` : empty("No upcoming assessments.")}
      </article>
    </section>
    <section class="dash-grid">
      <article class="panel">
        <div class="panel-head"><h2>News</h2><a href="${base}/news">All news</a></div>
        ${news ? `<ul class="dash-feed">${news}</ul>` : empty("No news yet.")}
      </article>
      <article class="panel">
        <div class="panel-head"><h2>Upcoming events</h2><a href="${base}/calendar">Calendar</a></div>
        ${events ? `<ul class="dash-feed">${events}</ul>` : empty("No upcoming events.")}
      </article>
    </section>
    <section class="split">
      <article class="panel">
        <h2>Invoices</h2>
        ${invoices ? `<table><thead><tr><th>Number</th><th>Description</th><th>Due</th><th>Total</th><th>Status</th>${showPay ? "<th></th>" : ""}</tr></thead><tbody>${invoices}</tbody></table>` : empty("No invoices yet.")}
        <p><a href="${base}/invoices">Invoice history</a></p>
      </article>
      <article class="panel">
        <h2>Payments</h2>
        ${options.bankTransferProcessing ? `<p>${esc(BANK_TRANSFER_PROCESSING_STATUS)}</p>` : ""}
        ${payments ? `<table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${payments}</tbody></table>` : empty("No recorded payments yet.")}
        <p><a href="${base}/payments">Payment history</a></p>
      </article>
    </section>
    <section class="panel">
      <h2>Notices from the Board</h2>
      ${notices ? `<ul>${notices}</ul>` : empty("No notices from the Board.")}
    </section>
  </div>`;
}

export function propertyPage(options: {
  association: Association;
  lotNumber: string;
  houseName: string;
  streetAddress: string;
  city: string;
  state: string;
  postalCode: string;
  mailingStreet: string;
  mailingCity: string;
  mailingState: string;
  mailingPostalCode: string;
  contacts: { name: string; phone: string; isPrimary?: boolean }[];
}): string {
  const base = `/a/${esc(options.association.slug)}`;
  const house = options.houseName.trim();
  return `<section class="panel">
    <p><a href="${base}/dashboard">Dashboard</a></p>
    <h1>Lot ${esc(options.lotNumber)}</h1>
    ${house ? `<p><strong>${esc(house)}</strong></p>` : ""}
    ${propertyAddressHtml(options.streetAddress, options.city, options.state, options.postalCode)}
    ${mailingAddressHtml(options.mailingStreet, options.mailingCity, options.mailingState, options.mailingPostalCode)}
    <h2>Phone numbers</h2>
    ${contactPhones(options.contacts)}
    <p><a href="${base}/invoices">Invoice history</a></p>
  </section>`;
}

function lotHeading(lot: OwnerLotProfile): string {
  const house = lot.house_name.trim();
  return house ? `Lot ${lot.lot_number}, ${house}` : `Lot ${lot.lot_number}`;
}

export function profilePage(options: {
  association: Association;
  name: string;
  email: string;
  phone: string;
  lots: OwnerLotProfile[];
  devLink?: string | null;
  announcementsOn?: boolean;
  consentGranted?: boolean;
  noticesReady?: boolean;
}): string {
  const base = `/a/${esc(options.association.slug)}`;
  const dev = options.devLink
    ? `<div class="devbox"><p><strong>Local confirmation link.</strong> Outbound email is not configured, so the link is shown here instead of being sent.</p><p><a href="${esc(options.devLink)}">Open confirmation link</a></p></div>`
    : "";
  const mailing = options.lots
    .map(
      (lot) => `<section class="panel">
        <h2>Mailing address for ${esc(lotHeading(lot))}</h2>
        <p class="muted">Leave this blank if mail should go to the lot. This does not change the lot address.</p>
        <form class="fields" method="post" action="${base}/profile/lots/${esc(lot.id)}">
          ${textField("Mailing street", "mailing_street", { value: lot.mailing_street })}
          ${textField("Mailing city", "mailing_city", { value: lot.mailing_city })}
          ${textField("Mailing state", "mailing_state", { value: lot.mailing_state })}
          ${textField("Mailing ZIP", "mailing_postal_code", { value: lot.mailing_postal_code })}
          <button type="submit">Save mailing address</button>
        </form>
      </section>`,
    )
    .join("");
  const lotField =
    options.lots.length > 1
      ? selectField(
          "Lot",
          "property_id",
          options.lots.map((lot) => ({ value: lot.id, label: lotHeading(lot) })),
        )
      : options.lots.length === 1
        ? `<input type="hidden" name="property_id" value="${esc(options.lots[0].id)}"><p>Lot ${esc(options.lots[0].lot_number)}</p>`
        : "";
  const coOwner = options.lots.length
    ? `<section class="panel">
        <h2>Add another owner</h2>
        <p class="muted">The board approves this before that person can sign in. You cannot add a login yourself.</p>
        <form class="fields" method="post" action="${base}/profile/owner">
          ${textField("Name", "name", { required: true })}
          ${textField("Email", "email", { type: "email", required: true })}
          ${lotField}
          <button type="submit">Send request</button>
        </form>
      </section>`
    : "";
  const noLots = options.lots.length
    ? ""
    : `<section class="panel"><p class="muted">No lot is linked to this login.</p></section>`;
  const announcementsOn = options.announcementsOn !== false;
  const consentGranted = options.consentGranted === true;
  const noticesNote =
    options.noticesReady === false
      ? `<p class="muted">Apply the email preferences migration in D1, then these choices can be saved. The steps are in the README under Email preferences.</p>`
      : "";
  return `<section class="panel">
      <h1>My profile</h1>
      <p class="muted">Your name and phone are on your login. Your phone is listed on each lot you own.</p>
      <form class="fields" method="post" action="${base}/profile">
        ${textField("Name", "name", { value: options.name, required: true })}
        ${textField("Phone", "phone", { value: options.phone })}
        <button type="submit">Save name and phone</button>
      </form>
    </section>
    <section class="panel">
      <h2>Email preferences</h2>
      <form class="fields email-prefs" method="post" action="${base}/profile/notices">
        ${noticesNote}
        <label><input type="checkbox" name="email_announcements" value="1"${announcementsOn ? " checked" : ""}> Email me portal announcements and updates</label>
        <h2>Electronic Notice Consent</h2>
        <label><input type="checkbox" name="electronic_consent" value="1"${consentGranted ? " checked" : ""}> I consent to receiving official association notices electronically at this email address.</label>
        <button type="submit">Save email preferences</button>
      </form>
    </section>
    <section class="panel">
      <h2>Email</h2>
      <p>Current email: ${esc(options.email)}</p>
      <p class="muted">This is also your login. We send a link to the new address. The login changes after you open that link.</p>
      ${dev}
      <form class="fields" method="post" action="${base}/profile/email">
        ${textField("New email", "email", { type: "email", required: true })}
        <button type="submit">Send confirmation link</button>
      </form>
    </section>
    ${mailing}
    ${noLots}
    ${coOwner}`;
}

export function invoiceListPage(association: Association, invoices: InvoiceRow[], pay?: OwnerPayOffer): string {
  const showPay = Boolean(pay && pay.kind !== "off");
  const rows = invoices
    .map(
      (row) => `<tr>
        <td><a href="/a/${esc(association.slug)}/invoices/${esc(row.id)}">${esc(row.invoice_number)}</a></td>
        <td>Lot ${esc(row.lot_number)}</td>
        <td>${invoiceDescriptionCell(row)}</td>
        <td>${dateCell(row.issued_on, association.timezone)}</td>
        <td>${dateCell(row.due_on, association.timezone)}</td>
        <td>${moneySpan(row.amount_cents)}</td>
        <td>${moneySpan(row.late_fee_cents)}</td>
        <td>${moneySpan(Number(row.paid_cents))}</td>
        <td>${esc(row.status)}</td>
        ${showPay ? `<td>${canPayInvoice(row) ? payControl(association.slug, pay, "Pay now") : ""}</td>` : ""}
      </tr>`,
    )
    .join("");
  return `<section class="panel"><h1>Invoice history</h1>
    ${showPay ? payNote(pay) : ""}
    ${rows ? `<table><thead><tr><th>Number</th><th>Lot</th><th>Description</th><th>Issued</th><th>Due</th><th>Amount</th><th>Late fee</th><th>Paid</th><th>Status</th>${showPay ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table>` : empty("No invoices on your lots.")}
  </section>`;
}

export function invoiceDetailPage(association: Association, invoice: InvoiceRow, today = "", pay?: OwnerPayOffer): string {
  const remaining = invoice.amount_cents + invoice.late_fee_cents - Number(invoice.paid_cents);
  const scheduled = Boolean(today) && invoice.issued_on > today;
  const amount = scheduled
    ? `<span class="money">${esc(formatMoney(invoice.amount_cents))}</span>`
    : moneySpan(invoice.amount_cents);
  const timing = scheduled
    ? `<p class="muted">Scheduled. Not owed until ${dateCell(invoice.issued_on, association.timezone)}.</p>`
    : `<p>Issued ${dateCell(invoice.issued_on, association.timezone)} · Due ${dateCell(invoice.due_on, association.timezone)}</p>`;
  const remainingLine = scheduled ? "" : `<p>Remaining on this invoice ${moneySpan(remaining)}</p>`;
  return `<section class="panel">
    <h1>${esc(invoice.invoice_number)}</h1>
    <p>${esc(assessmentDisplayName(invoice.description))}</p>
    ${(invoice.lines ?? []).length > 0 ? invoiceLinesTable(invoice.lines ?? []) : `<p>Lot ${esc(invoice.lot_number)}</p>`}
    ${timing}
    <p>Amount ${amount} · Late fee ${moneySpan(invoice.late_fee_cents)} · Paid on this invoice ${moneySpan(Number(invoice.paid_cents))}</p>
    ${remainingLine}
    <p><span class="badge">${esc(scheduled ? "scheduled" : invoice.status)}</span></p>
    ${
      pay && pay.kind !== "off"
        ? scheduled || !canPayInvoice(invoice)
          ? ""
          : `<div class="pay-actions">${payNote(pay)}${payControl(association.slug, pay, "Pay now")}</div>`
        : `<p class="muted">Online payment is not available. Mail a check and the board will record it.</p>`
    }
  </section>`;
}

export function paymentListPage(
  association: Association,
  payments: PaymentRow[],
  processing: ProcessingCheckout[] = [],
): string {
  const rows = payments
    .map(
      (row) => `<tr>
        <td><a href="/a/${esc(association.slug)}/payments/${esc(row.id)}">${dateCell(row.paid_on, association.timezone)}</a></td>
        <td>Lot ${esc(row.lot_number)}</td>
        <td>${esc(paymentMethodLabel(row.method, Number(row.is_test) === 1))}</td>
        <td>${esc(row.reference)}</td>
        <td>${esc(row.invoice_number ?? "Unapplied")}</td>
        <td>${moneySpan(row.amount_cents)}</td>
        <td>${moneySpan(Number(row.fee_cents ?? 0))}</td>
      </tr>`,
    )
    .join("");
  const pending = processing
    .map(
      (row) => `<tr>
        <td>Lot ${esc(row.lotNumbers)}</td>
        <td>${moneySpan(row.amountCents)}</td>
        <td>${moneySpan(row.feeCents)}</td>
        <td>${moneySpan(row.amountCents + row.feeCents)}</td>
        <td>${esc(BANK_TRANSFER_PROCESSING_STATUS)}</td>
      </tr>`,
    )
    .join("");
  const pendingTable = pending
    ? `<h2>Bank transfers still processing</h2>
       <p>${esc(BANK_TRANSFER_PROCESSING_STATUS)}</p>
       <table><thead><tr><th>Lot</th><th>Invoices</th><th>${esc(BANK_TRANSFER_FEE_LABEL)}</th><th>Total</th><th>Status</th></tr></thead><tbody>${pending}</tbody></table>`
    : "";
  return `<section class="panel"><h1>Payment history</h1>
    ${pendingTable}
    ${rows ? `<table><thead><tr><th>Date</th><th>Lot</th><th>Method</th><th>Reference</th><th>Invoice</th><th>Amount</th><th>${esc(BANK_TRANSFER_FEE_LABEL)}</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No payments recorded for your lots.")}
  </section>`;
}

export function paymentDetailPage(association: Association, payment: PaymentRow): string {
  return `<section class="panel">
    <h1>Payment receipt</h1>
    <p>${moneySpan(payment.amount_cents)} recorded on ${dateCell(payment.paid_on, association.timezone)}</p>
    ${Number(payment.fee_cents) > 0 ? `<p>${esc(BANK_TRANSFER_FEE_LABEL)} ${moneySpan(Number(payment.fee_cents))}</p><p class="muted">The bank transfer processing fee is not applied to the invoice.</p>` : ""}
    <p>Lot ${esc(payment.lot_number)} · ${esc(paymentMethodLabel(payment.method, Number(payment.is_test) === 1))} ${esc(payment.reference)}</p>
    <p>${
      Number(payment.is_test) === 1
        ? "Test payment, not applied. This did not change the balance."
        : payment.invoice_number
          ? `Applied to ${esc(payment.invoice_number)}`
          : "Not tied to one invoice. It still reduces the lot balance."
    }</p>
    ${payment.notes ? paragraphs(payment.notes) : ""}
    <p class="muted">This is the association's record of a payment. It is not a bank receipt.</p>
  </section>`;
}

export function paySelectPage(options: {
  association: Association;
  invoices: { invoiceId: string; lotNumber: string; invoiceNumber: string; description?: string; amountCents: number }[];
  offer: OwnerPayOffer;
  message: string;
  fee?: BankFeeConfig;
}): string {
  const subtotal = options.invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const fee = options.fee ?? { enabled: false, percentBps: 0, capCents: 0 };
  const feeCents = bankTransferFeeCents(subtotal, fee) ?? 0;
  const showFee = fee.enabled && fee.percentBps > 0 && fee.capCents > 0;
  const demo = options.offer.kind === "demo";
  const action = demo ? `/a/${esc(options.association.slug)}/pay/sample` : `/a/${esc(options.association.slug)}/pay`;
  const method = demo ? "get" : "post";
  const boxes = options.invoices
    .map((invoice) => {
      const label = invoice.description?.trim() ? `${invoice.invoiceNumber}, ${invoice.description}` : invoice.invoiceNumber;
      return `<label class="pay-invoice"><input type="checkbox" name="invoice_id" value="${esc(invoice.invoiceId)}" data-cents="${invoice.amountCents}" checked><span>Lot ${esc(invoice.lotNumber)}, ${esc(label)}, ${esc(formatMoney(invoice.amountCents))}</span></label>`;
    })
    .join("");
  const feeLine = showFee
    ? `<p>Invoices <strong data-pay-subtotal>${esc(formatMoney(subtotal))}</strong></p>
       <p>${esc(BANK_TRANSFER_FEE_LABEL)} <strong data-pay-fee>${esc(formatMoney(feeCents))}</strong></p>
       <p class="muted">${esc(BANK_TRANSFER_FEE_NOTE)}</p>`
    : "";
  const form = options.invoices.length
    ? `<form class="fields" method="${method}" action="${action}" data-pay-select data-fee-enabled="${showFee ? "1" : "0"}" data-fee-bps="${fee.percentBps}" data-fee-cap-cents="${fee.capCents}">
        ${boxes}
        ${feeLine}
        <p>Total <strong data-pay-total>${esc(formatMoney(subtotal + feeCents))}</strong></p>
        <p class="muted">Uncheck an invoice to leave it for later. The amount is the total of the invoices still checked.</p>
        <button type="submit">${demo ? "Continue sample checkout" : "Pay now"}</button>
      </form>
      <script src="/pay-select.js"></script>`
    : empty("Nothing is due.");
  return `<section class="panel">
    <p class="kicker">${demo ? "Sample checkout" : "Pay now"}</p>
    <h1>Choose invoices</h1>
    ${demo ? "<p><strong>Nothing is charged. Nothing here is real or saved.</strong></p>" : ""}
    ${payNote(options.offer)}
    ${options.message ? `<p>${esc(options.message)}</p>` : ""}
    ${form}
    <p><a href="/a/${esc(options.association.slug)}/dashboard">Back to the dashboard</a></p>
  </section>`;
}

export function payStartPage(association: Association): string {
  return `<section class="panel">
    <h1>Pay an invoice</h1>
    <p>Online payment is not available. Mail a check and the board will record it.</p>
    <p><a href="/a/${esc(association.slug)}/dashboard">Back to the dashboard</a></p>
  </section>`;
}

export function sampleCheckoutPage(options: {
  association: Association;
  invoices: { invoiceId: string; lotNumber: string; invoiceNumber: string; amountCents: number }[];
  successHref: string;
  cancelHref: string;
  feeCents?: number;
}): string {
  const subtotal = options.invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const feeCents = options.feeCents ?? 0;
  const rows = options.invoices
    .map(
      (invoice) => `<tr><td>Lot ${esc(invoice.lotNumber)}</td><td>${esc(invoice.invoiceNumber)}</td><td>${moneySpan(invoice.amountCents)}</td></tr>`,
    )
    .join("");
  const feeRow = feeCents > 0
    ? `<tr><td></td><td>${esc(BANK_TRANSFER_FEE_LABEL)}</td><td>${moneySpan(feeCents)}</td></tr>`
    : "";
  const action = options.invoices.length
    ? `<p><a class="button" href="${esc(options.successHref)}">Complete sample payment</a> <a class="button secondary" href="${esc(options.cancelHref)}">Cancel</a></p>`
    : `<p><a href="/a/${esc(options.association.slug)}/dashboard">Back to the dashboard</a></p>`;
  const note = feeCents > 0 ? `<p class="muted">${esc(BANK_TRANSFER_FEE_NOTE)}</p>` : "";
  return `<section class="panel">
    <p class="kicker">Sample checkout</p>
    <h1>Sample checkout</h1>
    <p><strong>Nothing is charged. Nothing here is real or saved.</strong></p>
    <p>This is not Stripe. Bank account numbers are not collected. Credit and debit cards are not accepted.</p>
    ${rows ? `<table><thead><tr><th>Lot</th><th>Invoice</th><th>Amount</th></tr></thead><tbody>${rows}${feeRow}</tbody></table><p>Total ${moneySpan(subtotal + feeCents)}</p>${note}` : empty("Nothing is due.")}
    ${action}
  </section>`;
}

export function paySuccessPage(options: {
  association: Association;
  sample: { invoices: { lotNumber: string; invoiceNumber: string; amountCents: number }[]; appliedCents: number; feeCents: number; reference: string } | null;
  state?: "processing" | "succeeded" | "failed";
}): string {
  if (!options.sample) {
    const state = options.state ?? "processing";
    const detail = state === "succeeded"
      ? "<p>This bank transfer has been recorded. The invoice credit is the amount due. The processing fee is not applied to the invoice.</p>"
      : state === "failed"
        ? "<p>This bank transfer did not go through. Nothing was applied to the invoice.</p>"
        : `<p>${esc(BANK_TRANSFER_PROCESSING_STATUS)}</p><p>The invoice is credited after the bank transfer succeeds. It then shows in Payment history. Paying again is not required.</p>`;
    return `<section class="panel">
      <h1>Payment submitted</h1>
      ${detail}
      <p><a href="/a/${esc(options.association.slug)}/payments">Payment history</a></p>
    </section>`;
  }
  const rows = options.sample.invoices
    .map(
      (invoice) => `<tr><td>Lot ${esc(invoice.lotNumber)}</td><td>${esc(invoice.invoiceNumber)}</td><td>Online (Stripe)</td><td>${esc(options.sample?.reference ?? "")}</td><td>${moneySpan(invoice.amountCents)}</td></tr>`,
    )
    .join("");
  const feeCents = options.sample.feeCents;
  const feeLine = feeCents > 0
    ? `<p>${esc(BANK_TRANSFER_FEE_LABEL)} ${moneySpan(feeCents)}</p><p class="muted">${esc(BANK_TRANSFER_FEE_NOTE)}</p>`
    : "";
  return `<section class="panel">
    <p class="kicker">Sample payment</p>
    <h1>Sample payment applied</h1>
    <p><strong>Nothing here is real or saved.</strong></p>
    <p>The dashboard still shows the sample balance because this demo does not save payments.</p>
    ${rows ? `<table><thead><tr><th>Lot</th><th>Invoice</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>` : empty("Nothing was due.")}
    ${feeLine}
    <p>Sample payment ${moneySpan(options.sample.appliedCents)}</p>
    <p><a href="/a/${esc(options.association.slug)}/dashboard">Back to the dashboard</a></p>
  </section>`;
}

export function payCancelPage(association: Association, sample: boolean): string {
  const note = sample ? `<p><strong>Nothing here is real or saved.</strong> No sample payment was applied.</p>` : `<p>No payment was recorded.</p>`;
  return `<section class="panel">
    <h1>Payment canceled</h1>
    ${note}
    <p><a href="/a/${esc(association.slug)}/dashboard">Back to the dashboard</a></p>
  </section>`;
}

function invoiceDescriptionCell(row: InvoiceRow): string {
  const title = esc(assessmentDisplayName(row.description));
  const lines = row.lines ?? [];
  if (lines.length === 0) return title;
  const detail = lines
    .map((line) => `<span class="muted">${esc(line.description)} ${esc(formatMoney(line.amount_cents))}</span>`)
    .join("<br>");
  return `${title}<br>${detail}`;
}

function noticeFileLinks(slug: string, row: NoticeRow): string {
  if (!row.attachment_filename) return "";
  return documentFileLinks(`/a/${slug}/notices/${row.id}/file`, row.attachment_content_type);
}

function noticeHrefPath(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  const noHash = trimmed.split("#", 1)[0] ?? "";
  let path = noHash;
  if (/^https?:\/\//i.test(noHash)) {
    try {
      path = new URL(noHash).pathname;
    } catch {
      return "";
    }
  } else {
    path = noHash.split("?", 1)[0] ?? "";
  }
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path;
}

/**
 * Open stays only for an unread notice that has no text on this page and links somewhere else.
 * A read notice, a notice whose body is already shown, or a link back to this list omits it.
 */
function noticeOpenLink(slug: string, row: NoticeRow): string {
  const href = row.href.trim();
  if (!href || row.read_at) return "";
  if (row.body.trim()) return "";
  if (noticeHrefPath(href) === `/a/${slug}/notices`) return "";
  return `<p><a href="${esc(href)}">Open</a></p>`;
}

export function noticesPage(association: Association, notices: NoticeRow[]): string {
  const rows = notices
    .map(
      (row) => `<article class="card">
        <h2>${esc(row.title)}</h2>
        <p class="muted">${dateTimeCell(row.created_at, association.timezone)} · ${row.read_at ? `Opened ${dateTimeCell(row.read_at, association.timezone)}` : "Unread"}</p>
        ${row.body ? paragraphs(row.body) : ""}
        ${row.attachment_filename ? `<p>${esc(row.attachment_filename)}</p><p>${noticeFileLinks(association.slug, row)}</p>` : ""}
        ${noticeOpenLink(association.slug, row)}
        ${row.read_at ? "" : `<form method="post" action="/a/${esc(association.slug)}/notices/${esc(row.id)}/read"><button class="secondary" type="submit">Mark read</button></form>`}
      </article>`,
    )
    .join("");
  return `<section class="panel">
      <h1>Notices from the Board</h1>
      <p class="muted">These notices are one-way from the Board. You cannot reply here. To reply or start a conversation, use <a href="/a/${esc(association.slug)}/messages">Messages</a>.</p>
    </section>
    ${rows || `<section class="panel">${empty("No notices from the Board.")}</section>`}
    ${notices.some((row) => !row.read_at) ? `<form method="post" action="/a/${esc(association.slug)}/notices/read-all"><button type="submit">Mark all read</button></form>` : ""}`;
}

function documentFileRow(association: Association, row: DocumentRow): string {
  const file = row.current_version_id
    ? documentFileLinks(`/a/${association.slug}/documents/${row.id}/file`, row.content_type)
    : "No file yet";
  const version = row.version_number ? `v${row.version_number}` : "No version";
  return `<tr><td>${esc(row.title)}</td><td>${version}</td><td>${file}</td></tr>`;
}

function documentFileTable(association: Association, files: DocumentRow[]): string {
  if (!files.length) return "";
  const rows = files.map((row) => documentFileRow(association, row)).join("");
  return `<table><thead><tr><th>Title</th><th>Version</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function countLabel(count: number): string {
  if (count <= 0) return "";
  const noun = count === 1 ? "file" : "files";
  return `<span class="doc-count">${count} ${noun}</span>`;
}

function folderDetails(
  association: Association,
  options: { className: string; attr: string; name: string; count: number; files: DocumentRow[]; childrenHtml: string },
): string {
  const files = documentFileTable(association, options.files);
  const body = `${files}${options.childrenHtml}` || `<p class="muted">No documents in this folder.</p>`;
  return `<details class="${options.className}" ${options.attr}>
    <summary><span class="doc-chevron" aria-hidden="true"></span><span class="doc-folder-name">${esc(options.name)}</span>${countLabel(options.count)}</summary>
    <div class="doc-folder-body">${body}</div>
  </details>`;
}

function subfolderDetails(association: Association, node: FolderGroup<DocumentRow>): string {
  const childrenHtml = node.children.map((child) => subfolderDetails(association, child)).join("");
  return folderDetails(association, {
    className: "doc-folder doc-subfolder",
    attr: `data-path="${esc(node.path)}"`,
    name: node.name,
    count: node.count,
    files: node.files,
    childrenHtml,
  });
}

function categoryDetails(association: Association, group: CategoryGroup<DocumentRow>): string {
  const childrenHtml = group.children.map((child) => subfolderDetails(association, child)).join("");
  return folderDetails(association, {
    className: "doc-folder",
    attr: `data-category="${esc(group.id)}"`,
    name: group.label,
    count: group.count,
    files: group.files,
    childrenHtml,
  });
}

function documentFolders(association: Association, documents: readonly DocumentRow[], omitEmpty = false): string {
  const groups = groupDocuments(documents);
  const shown = omitEmpty ? groups.filter((group) => group.count > 0) : groups;
  return shown.map((group) => categoryDetails(association, group)).join("");
}

export function documentsPage(association: Association, documents: DocumentRow[]): string {
  const residents = documents.filter((row) => row.visibility === "residents");
  const boardFolders = documentFolders(
    association,
    documents.filter((row) => row.visibility === "board"),
    true,
  );
  const boardSection = boardFolders
    ? `<section class="panel">
      <h2>Board only</h2>
      <p class="muted">Private to board members.</p>
      <div class="doc-folders">${boardFolders}</div>
    </section>`
    : "";
  return `<section class="panel">
    <h1>Documents</h1>
    <p class="muted">Association documents</p>
    <div class="doc-folders">${documentFolders(association, residents)}</div>
  </section>
  ${boardSection}`;
}

export function newsPage(association: Association, items: AnnouncementRow[]): string {
  const news = items
    .map(
      (item) => `<article class="card ${item.kind === "emergency" ? "emergency" : ""}">
        <p class="muted">${esc(item.kind)}</p>
        <h2><a href="/a/${esc(association.slug)}/news/${esc(item.id)}">${esc(item.title)}</a></h2>
        <p class="muted">${dateTimeCell(item.published_at, association.timezone)}</p>
      </article>`,
    )
    .join("");
  return `<section class="panel"><h1>Neighborhood news</h1></section>
    <section class="stack">${news || empty("No announcements.")}</section>`;
}

export function newsDetailPage(association: Association, item: AnnouncementRow): string {
  return `<article class="panel ${item.kind === "emergency" ? "emergency" : ""}">
    <p class="muted">${esc(item.kind)} · ${dateTimeCell(item.published_at, association.timezone)}</p>
    <h1>${esc(item.title)}</h1>
    ${paragraphs(item.body)}
  </article>`;
}

export function calendarPage(association: Association, events: EventRow[], zoneLabel: string): string {
  const rows = events
    .map(
      (item) => `<tr><td>${dateTimeCell(item.starts_at, association.timezone)}</td><td>${esc(item.kind)}</td><td>${esc(item.title)}<div class="muted">${esc(item.description)}</div></td><td>${esc(item.location)}</td></tr>`,
    )
    .join("");
  return `<section class="panel"><h1>Calendar</h1><p class="muted">Times are shown in ${esc(zoneLabel)}.</p>
    ${rows ? `<table><thead><tr><th>When</th><th>Kind</th><th>Event</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No events yet.")}
  </section>`;
}

export function faqPage(faqs: FaqRow[]): string {
  const items = faqs
    .map(
      (faq) => `<details class="card faq">
        <summary>${esc(faq.question)}</summary>
        <div class="faq-answer">${paragraphs(faq.answer)}</div>
      </details>`,
    )
    .join("");
  return `<section class="panel"><h1>FAQ</h1></section><section class="stack">${items || empty("No questions yet.")}</section>`;
}

export function boardPage(
  association: Association,
  contacts: ContactRow[],
  options: { canEdit?: boolean; open?: boolean; error?: string; draft?: MailingDraft } = {},
): string {
  const cards = contacts
    .map(
      (contact) => `<article class="card"><h2>${esc(contact.name)}</h2><p>${esc(contact.role_title)}</p><p>${contact.email ? esc(contact.email) : ""}</p><p>${contact.phone ? esc(contact.phone) : ""}</p></article>`,
    )
    .join("");
  const edit = options.canEdit ? mailingEdit(association, options) : "";
  return `<section class="panel"><h1>Board contacts</h1><p class="muted">${esc(association.legal_name)} · ${esc(formatMailing(association))}</p>${edit}</section>
    <section class="grid">${cards || empty("No contacts published.")}</section>`;
}

type MailingDraft = {
  legal_name: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
};

function mailingEdit(
  association: Association,
  options: { open?: boolean; error?: string; draft?: MailingDraft },
): string {
  const draft = options.draft ?? {
    legal_name: association.legal_name,
    address_line1: association.address_line1,
    city: association.city,
    state: association.state,
    postal_code: association.postal_code,
  };
  return `<details class="mailing-edit"${options.open ? " open" : ""}>
    <summary class="button secondary">Edit</summary>
    <form class="fields" method="post" action="/a/${esc(association.slug)}/board">
      ${options.error ? `<p class="flash warn">${esc(options.error)}</p>` : ""}
      ${textField("Legal name", "legal_name", { value: draft.legal_name, required: true })}
      ${textField("Street address", "address_line1", { value: draft.address_line1 })}
      ${textField("City", "city", { value: draft.city })}
      ${textField("State", "state", { value: draft.state })}
      ${textField("Postal code", "postal_code", { value: draft.postal_code })}
      <button type="submit">Save mailing address</button>
    </form>
  </details>`;
}

function formatMailing(association: Association): string {
  return [association.address_line1, association.city, association.state, association.postal_code].filter(Boolean).join(", ");
}

export type SupportFormValues = {
  kind?: string;
  subject?: string;
  details?: string;
};

export function supportPage(
  association: Association,
  sender: { name: string; email: string },
  values: SupportFormValues = {},
  error = "",
): string {
  const name = sender.name.trim();
  const from = name ? `${name} (${sender.email})` : sender.email;
  const kind = values.kind ?? "";
  const option = (value: string, label: string) =>
    `<option value="${value}"${kind === value ? " selected" : ""}>${label}</option>`;
  return `<section class="panel">
      <h1>Support</h1>
      <p>Send a question, an issue, or a feature request about the portal. It includes your name, email, and role.</p>
      <p class="muted">From ${esc(from)}</p>
      ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/support" enctype="multipart/form-data">
        <label>Type<select name="kind" required>
          ${option("", "Choose one")}
          ${option("issue", "Issue")}
          ${option("question", "Question")}
          ${option("feature", "Feature request")}
        </select></label>
        ${textField("Subject", "subject", { value: values.subject ?? "", required: true })}
        ${areaField("Details", "details", values.details ?? "", true)}
        <label>Attachment, optional<input type="file" name="file" accept="${DOCUMENT_FILE_ACCEPT}"></label>
        <button type="submit">Send message</button>
      </form>
    </section>`;
}

export function messagesPage(
  association: Association,
  threads: MessageRow[],
  properties: { id: string; lot_number: string }[],
): string {
  const rows = threads
    .map((thread) => {
      const remove = confirmDeleteButton(`/a/${association.slug}/messages/${thread.thread_id}/delete`, "Delete");
      return `<tr><td><a href="/a/${esc(association.slug)}/messages/${esc(thread.thread_id)}">${esc(thread.subject)}</a></td><td>${esc(thread.from_name)}</td><td>${dateTimeCell(thread.created_at, association.timezone)}</td><td>${remove}</td></tr>`;
    })
    .join("");
  const lotOptions = properties
    .map((property) => `<option value="${esc(property.id)}">Lot ${esc(property.lot_number)}</option>`)
    .join("");
  return `<section class="split">
    <article class="panel">
      <h1>Messages</h1>
      <p class="muted">Send a private message to the Board. Messages are not visible to other residents.</p>
      ${rows ? `<table><thead><tr><th>Subject</th><th>Latest from</th><th>When</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No messages yet.")}
    </article>
    <article class="panel">
      <h2>Contact the board</h2>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/messages" enctype="multipart/form-data">
        ${properties.length ? `<label>Lot<select name="property_id"><option value="">No specific lot</option>${lotOptions}</select></label>` : ""}
        ${textField("Subject", "subject", { required: true })}
        ${areaField("Message", "body", "", true)}
        <label>Attach a file (optional)<input type="file" name="file" multiple accept="${DOCUMENT_FILE_ACCEPT}"></label>
        <button type="submit">Send</button>
      </form>
    </article>
  </section>`;
}

export function threadPage(
  association: Association,
  subject: string,
  messages: MessageRow[],
  options: {
    incoming?: boolean;
    next?: string;
    allowThreadDelete?: boolean;
    allowReply?: boolean;
    replyDelete?: "all" | "own";
    viewerUserId?: string;
    inbox?: "admin" | "resident";
  } = {},
): string {
  const threadId = messages[0]?.thread_id ?? "";
  const inbox = options.inbox ?? "resident";
  const ownCount = messages.filter((message) => message.from_user_id === options.viewerUserId).length;
  const items = messages
    .map((message) => {
      const action = replyDeleteAction(association.slug, threadId, message, inbox, options.replyDelete, options.viewerUserId, messages.length, ownCount);
      const remove = action
        ? `<div class="actions">${confirmDeleteButton(action, "Delete reply", "Delete this reply")}</div>`
        : "";
      const files = messageAttachmentHtml(association.slug, threadId, message, inbox);
      return `<article class="card"><p><strong>${esc(message.from_name)}</strong> <span class="muted">${dateTimeCell(message.created_at, association.timezone)}</span></p>${paragraphs(message.body)}${files}${remove}</article>`;
    })
    .join("");
  const intro = options.incoming
    ? `<p class="muted">Incoming from owners. Board members can read these. A homeowner or board member with edit access can delete or mark reviewed.</p>`
    : "";
  const threadDelete = options.allowThreadDelete
    ? `<div class="actions">${confirmDeleteButton(threadDeleteAction(association.slug, threadId, inbox), "Delete thread", "Delete this message thread")}</div>`
    : "";
  const next = options.next ? `<input type="hidden" name="next" value="${esc(options.next)}">` : "";
  const reply =
    options.allowReply === false
      ? ""
      : `<form class="panel fields" method="post" action="/a/${esc(association.slug)}/messages/${esc(threadId)}/reply">
      ${next}
      ${areaField("Reply", "body", "", true)}
      <button type="submit">Send reply</button>
    </form>`;
  return `<section class="panel"><h1>${esc(subject)}</h1>${intro}${threadDelete}</section>
    <section class="stack">${items}</section>
    ${reply}`;
}

function messageAttachmentHtml(
  slug: string,
  threadId: string,
  message: MessageRow,
  inbox: "admin" | "resident",
): string {
  const files = message.attachments ?? [];
  if (files.length === 0) return "";
  const stem =
    inbox === "admin"
      ? `/a/${slug}/admin/messages/${threadId}/messages/${message.id}/file`
      : `/a/${slug}/messages/${threadId}/messages/${message.id}/file`;
  return files
    .map((file) => {
      const href = `${stem}/${file.id}`;
      const links = documentFileLinks(href, isImageContentType(file.content_type) ? file.content_type : "");
      return `<p>${esc(file.filename)}</p><p>${links}</p>`;
    })
    .join("");
}

function threadDeleteAction(slug: string, threadId: string, inbox: "admin" | "resident"): string {
  return inbox === "admin" ? `/a/${slug}/admin/messages/${threadId}/delete` : `/a/${slug}/messages/${threadId}/delete`;
}

function replyDeleteAction(
  slug: string,
  threadId: string,
  message: MessageRow,
  inbox: "admin" | "resident",
  replyDelete: "all" | "own" | undefined,
  viewerUserId: string | undefined,
  threadLength: number,
  ownCount: number,
): string {
  if (!replyDelete || threadLength < 2) return "";
  if (replyDelete === "own" && (message.from_user_id !== viewerUserId || ownCount < 2)) return "";
  const stem = inbox === "admin" ? `/a/${slug}/admin/messages/${threadId}` : `/a/${slug}/messages/${threadId}`;
  return `${stem}/messages/${message.id}/delete`;
}
