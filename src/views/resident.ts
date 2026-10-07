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
  PaymentRow,
  MessageRow,
} from "../db";
import { paragraphs, esc } from "../lib/html";
import type { Association } from "../types";
import { categoryCell, dateCell, dateTimeCell, documentFileLinks, empty, methodLabel, moneySpan, textField, areaField } from "./bits";

export function dashboardPage(options: {
  association: Association;
  name: string;
  ledger: BalanceRow[];
  upcoming: AssessmentRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  notices: NoticeRow[];
  emergencies: AnnouncementRow[];
}): string {
  const { association, ledger } = options;
  const total = ledger.reduce((sum, row) => sum + row.balance_cents, 0);
  const late = ledger.reduce((sum, row) => sum + row.late_fee_cents, 0);
  const lots = ledger
    .map(
      (row) => `<article class="card">
        <h3>Lot ${esc(row.lot_number)}</h3>
        <p class="muted">${esc(row.street_address)}</p>
        <p class="figure">${moneySpan(row.balance_cents)}</p>
        <p class="muted">Late fees ${moneySpan(row.late_fee_cents)}</p>
        ${row.delinquent ? `<p><span class="badge late">Past due</span></p>` : ""}
      </article>`,
    )
    .join("");
  const upcoming = options.upcoming
    .map(
      (row) => `<tr><td>${esc(row.name)}</td><td>${row.opens_on ? dateCell(row.opens_on, association.timezone) : ""}</td><td>${dateCell(row.due_on, association.timezone)}</td><td>${moneySpan(row.amount_cents)}</td><td>${row.invoice_count > 0 ? "Invoiced" : "Scheduled"}</td></tr>`,
    )
    .join("");
  const invoices = options.invoices
    .slice(0, 6)
    .map(
      (row) => `<tr><td><a href="/a/${esc(association.slug)}/invoices/${esc(row.id)}">${esc(row.invoice_number)}</a></td><td>${esc(row.description)}</td><td>${dateCell(row.due_on, association.timezone)}</td><td>${moneySpan(row.amount_cents + row.late_fee_cents)}</td><td>${esc(row.status)}</td></tr>`,
    )
    .join("");
  const payments = options.payments
    .slice(0, 6)
    .map(
      (row) => `<tr><td><a href="/a/${esc(association.slug)}/payments/${esc(row.id)}">${dateCell(row.paid_on, association.timezone)}</a></td><td>${esc(methodLabel(row.method))}</td><td>${esc(row.reference)}</td><td>${moneySpan(row.amount_cents)}</td></tr>`,
    )
    .join("");
  const notices = options.notices
    .slice(0, 5)
    .map((row) => `<li><a href="/a/${esc(association.slug)}/notices">${esc(row.title)}</a> <span class="muted">${esc(row.body)}</span></li>`)
    .join("");
  const emergencies = options.emergencies
    .map((row) => `<article class="emergency"><h2>${esc(row.title)}</h2>${paragraphs(row.body)}</article>`)
    .join("");

  return `${emergencies}
    <section class="panel">
      <p class="muted">${esc(association.name)} · ${esc(options.name)}</p>
      <h1>Your account</h1>
      <p class="figure">${ledger.length ? moneySpan(total) : ""}</p>
      <p class="muted">${ledger.length ? "Balance across your lots. Charges and late fees, minus recorded payments." : "No lot is linked to this login yet."}</p>
      ${late > 0 ? `<p>Outstanding late fees ${moneySpan(late)}</p>` : ""}
    </section>
    ${lots ? `<section class="grid">${lots}</section>` : ""}
    <section class="panel">
      <h2>Upcoming assessments</h2>
      ${upcoming ? `<table><thead><tr><th>Assessment</th><th>Opens</th><th>Due</th><th>Amount</th><th></th></tr></thead><tbody>${upcoming}</tbody></table>` : empty("No upcoming assessments.")}
    </section>
    <section class="split">
      <article class="panel">
        <h2>Invoices</h2>
        ${invoices ? `<table><thead><tr><th>Number</th><th>Description</th><th>Due</th><th>Total</th><th>Status</th></tr></thead><tbody>${invoices}</tbody></table>` : empty("No invoices yet.")}
        <p><a href="/a/${esc(association.slug)}/invoices">Invoice history</a></p>
      </article>
      <article class="panel">
        <h2>Payments</h2>
        ${payments ? `<table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead><tbody>${payments}</tbody></table>` : empty("No recorded payments yet.")}
        <p><a href="/a/${esc(association.slug)}/payments">Payment history</a></p>
      </article>
    </section>
    <section class="panel">
      <h2>Personal notices</h2>
      ${notices ? `<ul>${notices}</ul>` : empty("No account messages.")}
    </section>`;
}

export function invoiceListPage(association: Association, invoices: InvoiceRow[]): string {
  const rows = invoices
    .map(
      (row) => `<tr>
        <td><a href="/a/${esc(association.slug)}/invoices/${esc(row.id)}">${esc(row.invoice_number)}</a></td>
        <td>Lot ${esc(row.lot_number)}</td>
        <td>${esc(row.description)}</td>
        <td>${dateCell(row.issued_on, association.timezone)}</td>
        <td>${dateCell(row.due_on, association.timezone)}</td>
        <td>${moneySpan(row.amount_cents)}</td>
        <td>${moneySpan(row.late_fee_cents)}</td>
        <td>${moneySpan(Number(row.paid_cents))}</td>
        <td>${esc(row.status)}</td>
      </tr>`,
    )
    .join("");
  return `<section class="panel"><h1>Invoice history</h1>
    ${rows ? `<table><thead><tr><th>Number</th><th>Lot</th><th>Description</th><th>Issued</th><th>Due</th><th>Amount</th><th>Late fee</th><th>Paid</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No invoices on your lots.")}
  </section>`;
}

export function invoiceDetailPage(association: Association, invoice: InvoiceRow): string {
  const remaining = invoice.amount_cents + invoice.late_fee_cents - Number(invoice.paid_cents);
  return `<section class="panel">
    <h1>${esc(invoice.invoice_number)}</h1>
    <p>${esc(invoice.description)}</p>
    <p>Lot ${esc(invoice.lot_number)}</p>
    <p>Issued ${dateCell(invoice.issued_on, association.timezone)} · Due ${dateCell(invoice.due_on, association.timezone)}</p>
    <p>Amount ${moneySpan(invoice.amount_cents)} · Late fee ${moneySpan(invoice.late_fee_cents)} · Paid on this invoice ${moneySpan(Number(invoice.paid_cents))}</p>
    <p>Remaining on this invoice ${moneySpan(remaining)}</p>
    <p><span class="badge">${esc(invoice.status)}</span></p>
    <p class="muted">Online payment is not available. Mail a check and the board will record it.</p>
  </section>`;
}

export function paymentListPage(association: Association, payments: PaymentRow[]): string {
  const rows = payments
    .map(
      (row) => `<tr>
        <td><a href="/a/${esc(association.slug)}/payments/${esc(row.id)}">${dateCell(row.paid_on, association.timezone)}</a></td>
        <td>Lot ${esc(row.lot_number)}</td>
        <td>${esc(methodLabel(row.method))}</td>
        <td>${esc(row.reference)}</td>
        <td>${esc(row.invoice_number ?? "Unapplied")}</td>
        <td>${moneySpan(row.amount_cents)}</td>
      </tr>`,
    )
    .join("");
  return `<section class="panel"><h1>Payment history</h1>
    ${rows ? `<table><thead><tr><th>Date</th><th>Lot</th><th>Method</th><th>Reference</th><th>Invoice</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No payments recorded for your lots.")}
  </section>`;
}

export function paymentDetailPage(association: Association, payment: PaymentRow): string {
  return `<section class="panel">
    <h1>Payment receipt</h1>
    <p>${moneySpan(payment.amount_cents)} recorded on ${dateCell(payment.paid_on, association.timezone)}</p>
    <p>Lot ${esc(payment.lot_number)} · ${esc(methodLabel(payment.method))} ${esc(payment.reference)}</p>
    <p>${payment.invoice_number ? `Applied to ${esc(payment.invoice_number)}` : "Not tied to one invoice. It still reduces the lot balance."}</p>
    ${payment.notes ? paragraphs(payment.notes) : ""}
    <p class="muted">This is the association's record of a payment. It is not a bank receipt.</p>
  </section>`;
}

export function noticesPage(association: Association, notices: NoticeRow[]): string {
  const rows = notices
    .map(
      (row) => `<article class="card">
        <h2>${esc(row.title)}</h2>
        <p class="muted">${dateTimeCell(row.created_at, association.timezone)} · ${row.read_at ? "Read" : "Unread"}</p>
        ${row.body ? paragraphs(row.body) : ""}
        ${row.href ? `<p><a href="${esc(row.href)}">Open</a></p>` : ""}
        ${row.read_at ? "" : `<form method="post" action="/a/${esc(association.slug)}/notices/${esc(row.id)}/read"><button class="secondary" type="submit">Mark read</button></form>`}
      </article>`,
    )
    .join("");
  return `<section class="panel"><h1>Notices</h1></section>
    ${rows || `<section class="panel">${empty("No notices.")}</section>`}
    ${notices.some((row) => !row.read_at) ? `<form method="post" action="/a/${esc(association.slug)}/notices/read-all"><button type="submit">Mark all read</button></form>` : ""}`;
}

export function documentsPage(association: Association, documents: DocumentRow[]): string {
  const rows = documents
    .map((row) => {
      const file = row.current_version_id
        ? documentFileLinks(`/a/${association.slug}/documents/${row.id}/file`, row.content_type)
        : "No file yet";
      return `<tr><td>${categoryCell(row.category)}</td><td>${esc(row.title)}</td><td>${row.version_number ? `v${row.version_number}` : "—"}</td><td>${esc(row.filename ?? "")}</td><td>${file}</td></tr>`;
    })
    .join("");
  return `<section class="panel">
    <h1>Documents</h1>
    <p class="muted">Association documents</p>
    ${rows ? `<table><thead><tr><th>Category</th><th>Title</th><th>Version</th><th>File</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No documents published yet.")}
  </section>`;
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

export function boardPage(association: Association, contacts: ContactRow[]): string {
  const cards = contacts
    .map(
      (contact) => `<article class="card"><h2>${esc(contact.name)}</h2><p>${esc(contact.role_title)}</p><p>${contact.email ? esc(contact.email) : ""}</p><p>${contact.phone ? esc(contact.phone) : ""}</p></article>`,
    )
    .join("");
  return `<section class="panel"><h1>Board contacts</h1><p class="muted">${esc(association.legal_name)} · ${esc(formatMailing(association))}</p></section>
    <section class="grid">${cards || empty("No contacts published.")}</section>`;
}

function formatMailing(association: Association): string {
  return [association.address_line1, association.city, association.state, association.postal_code].filter(Boolean).join(", ");
}

export function supportPage(
  association: Association,
  sender: { name: string; email: string },
  message = "",
  error = "",
): string {
  const name = sender.name.trim();
  const from = name ? `${name} (${sender.email})` : sender.email;
  return `<section class="panel">
      <h1>Support</h1>
      <p>Send a message about the portal. It includes your name and the email on your account.</p>
      <p class="muted">From ${esc(from)}</p>
      ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
      <form class="fields" method="post" action="/a/${esc(association.slug)}/support">
        ${areaField("Message", "body", message, true)}
        <button type="submit">Send message</button>
      </form>
    </section>`;
}

export function messagesPage(
  association: Association,
  threads: MessageRow[],
  properties: { id: string; lot_number: string }[],
  adminInboxHref = "",
): string {
  const rows = threads
    .map(
      (thread) => `<tr><td><a href="/a/${esc(association.slug)}/messages/${esc(thread.thread_id)}">${esc(thread.subject)}</a></td><td>${esc(thread.from_name)}</td><td>${dateTimeCell(thread.created_at, association.timezone)}</td></tr>`,
    )
    .join("");
  const lotOptions = properties
    .map((property) => `<option value="${esc(property.id)}">Lot ${esc(property.lot_number)}</option>`)
    .join("");
  return `<section class="split">
    <article class="panel">
      <h1>Messages</h1>
      <p class="muted">Private notes to the board. Other residents cannot read them.</p>
      ${adminInboxHref ? `<p class="muted">Incoming from owners is listed under <a href="${esc(adminInboxHref)}">Admin, Messages</a>.</p>` : ""}
      ${rows ? `<table><thead><tr><th>Subject</th><th>Latest from</th><th>When</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No messages yet.")}
    </article>
    <article class="panel">
      <h2>Contact the board</h2>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/messages">
        ${properties.length ? `<label>Lot<select name="property_id"><option value="">No specific lot</option>${lotOptions}</select></label>` : ""}
        ${textField("Subject", "subject", { required: true })}
        ${areaField("Message", "body", "", true)}
        <button type="submit">Send</button>
      </form>
    </article>
  </section>`;
}

export function threadPage(
  association: Association,
  subject: string,
  messages: MessageRow[],
  options: { incoming?: boolean; next?: string } = {},
): string {
  const threadId = messages[0]?.thread_id ?? "";
  const items = messages
    .map(
      (message) => `<article class="card"><p><strong>${esc(message.from_name)}</strong> <span class="muted">${dateTimeCell(message.created_at, association.timezone)}</span></p>${paragraphs(message.body)}</article>`,
    )
    .join("");
  const intro = options.incoming
    ? `<p class="muted">Incoming from owners. Only people with admin access can read the board side of this thread.</p>`
    : "";
  const next = options.next ? `<input type="hidden" name="next" value="${esc(options.next)}">` : "";
  return `<section class="panel"><h1>${esc(subject)}</h1>${intro}</section>
    <section class="stack">${items}</section>
    <form class="panel fields" method="post" action="/a/${esc(association.slug)}/messages/${esc(threadId)}/reply">
      ${next}
      ${areaField("Reply", "body", "", true)}
      <button type="submit">Send reply</button>
    </form>`;
}
