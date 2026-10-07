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
import { groupDocuments, type CategoryGroup, type FolderGroup } from "../lib/categories";
import { clip, paragraphs, esc } from "../lib/html";
import { formatMoney } from "../lib/money";
import type { Association } from "../types";
import { confirmDeleteButton, dateCell, dateTimeCell, documentFileLinks, empty, methodLabel, moneySpan, textField, areaField } from "./bits";

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
      return `<div class="lot">
        <div>
          <p class="lot-name">Lot ${esc(row.lot_number)}</p>
          <p class="muted">${esc(row.street_address)}</p>
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
          <strong>${esc(row.name)}</strong>
          <p class="muted">${opens}Due ${due}.${when}</p>
        </div>
        <div class="dues-amount">
          <p><span class="money">${esc(formatMoney(row.amount_cents))}</span></p>
          <p class="muted">${row.invoice_count > 0 ? "Invoiced" : "Scheduled"}</p>
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
  const invoices = options.invoices
    .slice(0, 6)
    .map(
      (row) => `<tr><td><a href="${base}/invoices/${esc(row.id)}">${esc(row.invoice_number)}</a></td><td>${esc(row.description)}</td><td>${dateCell(row.due_on, association.timezone)}</td><td>${moneySpan(row.amount_cents + row.late_fee_cents)}</td><td>${esc(row.status)}</td></tr>`,
    )
    .join("");
  const payments = options.payments
    .slice(0, 6)
    .map(
      (row) => `<tr><td><a href="${base}/payments/${esc(row.id)}">${dateCell(row.paid_on, association.timezone)}</a></td><td>${esc(methodLabel(row.method))}</td><td>${esc(row.reference)}</td><td>${moneySpan(row.amount_cents)}</td></tr>`,
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
        ${invoices ? `<table><thead><tr><th>Number</th><th>Description</th><th>Due</th><th>Total</th><th>Status</th></tr></thead><tbody>${invoices}</tbody></table>` : empty("No invoices yet.")}
        <p><a href="${base}/invoices">Invoice history</a></p>
      </article>
      <article class="panel">
        <h2>Payments</h2>
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

export function invoiceDetailPage(association: Association, invoice: InvoiceRow, today = ""): string {
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
    <p>${esc(invoice.description)}</p>
    <p>Lot ${esc(invoice.lot_number)}</p>
    ${timing}
    <p>Amount ${amount} · Late fee ${moneySpan(invoice.late_fee_cents)} · Paid on this invoice ${moneySpan(Number(invoice.paid_cents))}</p>
    ${remainingLine}
    <p><span class="badge">${esc(scheduled ? "scheduled" : invoice.status)}</span></p>
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

export function documentsPage(association: Association, documents: DocumentRow[]): string {
  const folders = groupDocuments(documents).map((group) => categoryDetails(association, group)).join("");
  return `<section class="panel">
    <h1>Documents</h1>
    <p class="muted">Association documents</p>
    <div class="doc-folders">${folders}</div>
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
      return `<article class="card"><p><strong>${esc(message.from_name)}</strong> <span class="muted">${dateTimeCell(message.created_at, association.timezone)}</span></p>${paragraphs(message.body)}${remove}</article>`;
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
