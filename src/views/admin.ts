import { DOCUMENT_CATEGORIES } from "../lib/categories";
import { zonedIsoDate } from "../lib/dates";
import { lotTypeLabel } from "../lib/dues";
import { esc } from "../lib/html";
import type { Association, DocumentCategory } from "../types";
import type {
  AnnouncementRow,
  AssessmentAdminRow,
  AuditRow,
  BalanceRow,
  ContactRow,
  DocumentRow,
  EventRow,
  FaqRow,
  JoinRequestRow,
  LotRow,
  MessageRow,
  OwnerListRow,
  PropertyRow,
  VersionRow,
} from "../db";
import type { CsvIssue } from "../lib/csv";
import type { ImportResult } from "../lib/import-owners";
import {
  areaField,
  categoryCell,
  dateCell,
  dateTimeCell,
  documentFileLinks,
  empty,
  moneySpan,
  roleLabel,
  selectField,
  textField,
  visibilityLabel,
} from "./bits";
import { threadPage } from "./resident";

function adminNav(slug: string, current: string): string {
  const links = [
    ["overview", "Overview"],
    ["owners", "Owners & lots"],
    ["import", "CSV import"],
    ["ledger", "Ledger"],
    ["documents", "Documents"],
    ["news", "News"],
    ["messages", "Messages"],
    ["joins", "Join requests"],
    ["audit", "Activity"],
  ];
  return `<p class="actions">${links
    .map(([id, label]) => {
      const href =
        id === "overview"
          ? `/a/${esc(slug)}/admin`
          : id === "joins"
            ? `/a/${esc(slug)}/admin/join-requests`
            : id === "messages"
              ? `/a/${esc(slug)}/admin/messages`
              : `/a/${esc(slug)}/admin/${id}`;
      return `<a class="button ${id === current ? "" : "secondary"}" href="${href}">${label}</a>`;
    })
    .join(" ")}</p>`;
}

export function adminHome(options: {
  association: Association;
  lots: number;
  members: number;
  delinquent: number;
  waiting: number;
  pendingJoins: number | null;
  audit: AuditRow[];
}): string {
  const base = `/a/${esc(options.association.slug)}/admin`;
  const joins =
    options.pendingJoins === null
      ? ""
      : statCard(options.pendingJoins, "Join requests waiting", `${base}/join-requests`);
  return `${adminNav(options.association.slug, "overview")}
    <section class="panel">
      <h1>Board admin</h1>
      <p class="muted">Only board admins can open these tools.</p>
    </section>
    <section class="grid">
      ${statCard(options.lots, "Lots", `${base}/owners#lots`)}
      ${statCard(options.members, "Active logins", `${base}/owners#logins`)}
      ${statCard(options.delinquent, "Delinquent lots", `${base}/owners?delinquent=1#logins`)}
      ${statCard(options.waiting, "Messages waiting on the board", `${base}/messages`)}
      ${joins}
    </section>
    <section class="panel">
      <h2>Roles</h2>
      <p>Homeowners see their lots. Board members can be given Admin access, which opens these tools. Keep at least one admin.</p>
      <p><a href="${base}/export.csv">Export ledger for the accountant</a></p>
    </section>
    <section class="panel"><h2>Recent activity</h2>${auditTable(options.association, options.audit.slice(0, 8))}</section>`;
}

function statCard(count: number, label: string, href: string): string {
  return `<a class="card" href="${href}"><h2>${count}</h2><p>${esc(label)}</p></a>`;
}

export function ownersPage(
  association: Association,
  lots: LotRow[],
  owners: (OwnerListRow & { balance_cents?: number; delinquent?: boolean })[],
  delinquentOnly: boolean,
): string {
  const rows = owners
    .map(
      (owner) => `<tr>
        <td><a href="/a/${esc(association.slug)}/admin/owners/${esc(owner.user_id)}">${esc(owner.name)}</a><div class="muted">${esc(owner.email)}</div></td>
        <td>${esc(roleLabel(owner.role_id, owner.is_admin === 1))}</td>
        <td>${esc(owner.status)}</td>
        <td>${owner.lot_number ? `Lot ${esc(owner.lot_number)}` : "None"}</td>
        <td>${owner.balance_cents === undefined ? "" : moneySpan(owner.balance_cents)}</td>
        <td>${owner.delinquent ? `<span class="badge late">Past due</span>` : ""}</td>
      </tr>`,
    )
    .join("");
  const ownerChoices = owners.map((owner) => ({ value: owner.user_id, label: `${owner.name} (${owner.email})` }));
  const lotRows = lots
    .map((lot) => {
      const edit = `/a/${esc(association.slug)}/admin/lots/${esc(lot.id)}`;
      return `<tr>
        <td>Lot ${esc(lot.lot_number)}</td>
        <td>${esc(lot.street_address)}</td>
        <td>${esc(lotTypeLabel(lot.lot_type))}</td>
        <td>${lot.owner_name ? esc(lot.owner_name) : "No owner"}</td>
        <td>${lot.owner_email ? esc(lot.owner_email) : ""}</td>
        <td>${esc(lot.status)}</td>
        <td>
          <details>
            <summary>Edit</summary>
            <form class="fields" method="post" action="${edit}">
              ${textField("Lot number", "lot_number", { value: lot.lot_number, required: true })}
              ${textField("Street", "street_address", { value: lot.street_address, required: true })}
              ${selectField("Type", "lot_type", [
                { value: "improved", label: "Improved" },
                { value: "unimproved", label: "Unimproved" },
              ], lot.lot_type)}
              ${selectField("Status", "status", [
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ], lot.status)}
              <button class="secondary" type="submit">Save lot</button>
            </form>
            <form class="fields" method="post" action="${edit}/owner">
              ${selectField("Primary owner", "user_id", [{ value: "", label: "Choose a person" }, ...ownerChoices])}
              <button class="secondary" type="submit">Assign owner</button>
            </form>
          </details>
        </td>
      </tr>`;
    })
    .join("");
  return `${adminNav(association.slug, "owners")}
    <section class="panel" id="lots">
      <h1>Owners & lots</h1>
      <p class="muted">Each lot shows its primary owner. CSV import is still the bulk way to add a roster. Set improved or unimproved here before assigning annual dues.</p>
      ${lotRows ? `<table><thead><tr><th>Lot</th><th>Address</th><th>Type</th><th>Primary owner</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>${lotRows}</tbody></table>` : empty("No lots yet.")}
      <h2>Add a lot</h2>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/lots">
        ${textField("Lot number", "lot_number", { required: true })}
        ${textField("Street address", "street_address", { required: true })}
        ${selectField("Type", "lot_type", [
          { value: "improved", label: "Improved" },
          { value: "unimproved", label: "Unimproved" },
        ], "improved")}
        <button type="submit">Add lot</button>
      </form>
    </section>
    <section class="panel" id="logins">
      <h2>${delinquentOnly ? "Delinquent accounts" : "Users"}</h2>
      <p class="filters">
        <a ${delinquentOnly ? "" : `class="active"`} href="/a/${esc(association.slug)}/admin/owners#logins">Everyone</a>
        <a ${delinquentOnly ? `class="active"` : ""} href="/a/${esc(association.slug)}/admin/owners?delinquent=1#logins">Past due only</a>
      </p>
      ${rows ? `<table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Lot</th><th>Balance</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No matching accounts.")}
    </section>`;
}

export function ownerDetailPage(options: {
  association: Association;
  owner: OwnerListRow;
  balance: number | null;
  lots: PropertyRow[];
  properties: PropertyRow[];
}): string {
  const { association, owner } = options;
  const base = `/a/${association.slug}/admin/owners/${owner.user_id}`;
  const lotChoices = options.properties
    .map((property) => ({ value: property.id, label: `Lot ${property.lot_number}, ${property.street_address}` }));
  return `${adminNav(association.slug, "owners")}
    <section class="panel">
      <h1>${esc(owner.name)}</h1>
      <p>${esc(owner.email)}${owner.phone ? ` · ${esc(owner.phone)}` : ""}</p>
      <p>${esc(roleLabel(owner.role_id, owner.is_admin === 1))} · ${esc(owner.status)}</p>
      <p>Primary lot balance ${options.balance === null ? "" : moneySpan(options.balance)}</p>
      <h2>Name and phone</h2>
      <p class="muted">Name is required. Phone is optional and shows on this page for the board.</p>
      <form class="fields" method="post" action="${esc(base)}/profile">
        ${textField("Name", "name", { value: owner.name, required: true })}
        ${textField("Phone", "phone", { value: owner.phone })}
        <button type="submit">Save name and phone</button>
      </form>
      <h2>Login email</h2>
      <p class="muted">This is the address they use to sign in. Saving it keeps the same person and the lots already linked to them.</p>
      <form class="fields" method="post" action="${esc(base)}/email">
        ${textField("Email", "email", { type: "email", value: owner.email, required: true })}
        <button type="submit">Save email</button>
      </form>
    </section>
    <section class="split">
      <article class="panel">
        <h2>Role</h2>
        <form class="fields" method="post" action="${esc(base)}/role">
          ${selectField("Role", "role_id", [
            { value: "homeowner", label: "Homeowner" },
            { value: "board", label: "Board member" },
          ], owner.role_id === "board" ? "board" : "homeowner")}
          <label><input type="checkbox" name="is_admin" value="1" ${owner.role_id === "board" && owner.is_admin === 1 ? "checked" : ""}> Admin access</label>
          <p class="muted">Admin access applies only to a board member. Keep at least one active admin.</p>
          ${selectField("Status", "status", [
            { value: "active", label: "Active" },
            { value: "invited", label: "Invited" },
            { value: "inactive", label: "Inactive" },
          ], owner.status)}
          <button type="submit">Save role</button>
        </form>
      </article>
      <article class="panel">
        <h2>Link a lot</h2>
        <form class="fields" method="post" action="${esc(base)}/lot">
          ${selectField("Lot", "property_id", lotChoices)}
          <button type="submit">Make primary lot</button>
        </form>
      </article>
    </section>
    <section class="split">
      <article class="panel">
        <h2>Portal notice</h2>
        <form class="fields" method="post" action="${esc(base)}/notice" enctype="multipart/form-data">
          ${textField("Title", "title", { required: true })}
          ${areaField("Message", "body", "", true)}
          <label>File (optional)<input type="file" name="file" accept=".pdf,.txt,.jpg,.jpeg,.png,.webp,.doc,.docx,application/pdf,text/plain,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>
          <p class="muted">PDF, text, image, or Word. 8 MB or smaller. The owner can view or download it on their notices.</p>
          ${emailOwnersField("Email owner", "email_owner")}
          <p class="muted">Sends one email to this owner with a link to the notice. A file on the form is attached to that email.</p>
          <button type="submit">Post to their notices</button>
        </form>
      </article>
      <article class="panel">
        <h2>Balance reminder</h2>
        <p class="muted">Sends one email to this owner when Resend is configured, and always leaves a portal notice. This is not a neighborhood blast.</p>
        <form method="post" action="${esc(base)}/remind"><button type="submit">Send reminder</button></form>
      </article>
    </section>`;
}

export function importPage(association: Association, result?: { importResult: ImportResult; parseErrors: CsvIssue[] }): string {
  const issues = [
    ...(result?.parseErrors ?? []),
    ...(result?.importResult.errors ?? []),
  ];
  const summary = result
    ? `<div class="flash">Created ${result.importResult.createdUsers}, updated ${result.importResult.updatedUsers}, opening invoices ${result.importResult.invoices}, opening credits ${result.importResult.credits}.</div>`
    : "";
  const issueList = issues.map((issue) => `<li>Line ${issue.line}: ${esc(issue.message)}</li>`).join("");
  return `${adminNav(association.slug, "import")}
    <section class="panel">
      <h1>Import owners from CSV</h1>
      <p>Save the Excel roster as CSV UTF-8. Required columns: <code>email</code>, <code>name</code>, <code>lot_number</code>, <code>street_address</code>. Optional: <code>role</code> (homeowner or board; an older sheet may still say officer, which becomes board with admin), <code>admin</code> (yes or no), <code>starting_balance</code> (dollars owed; negative is a credit), <code>balance_as_of</code> (YYYY-MM-DD), <code>phone</code>, <code>city</code>, <code>state</code>, <code>postal_code</code>.</p>
      <p>A positive starting balance creates one opening invoice per lot. Importing again does not add a second opening balance. Sample file: <code>samples/tango-mar-owners.csv</code>.</p>
      ${summary}
      ${issueList ? `<ul>${issueList}</ul>` : ""}
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/import" enctype="multipart/form-data">
        <label>CSV file<input type="file" name="csv" accept=".csv,text/csv" required></label>
        <button type="submit">Import</button>
      </form>
    </section>`;
}

export function ledgerPage(options: {
  association: Association;
  ledger: BalanceRow[];
  ownersByProperty: Map<string, string>;
  properties: PropertyRow[];
  invoices: { id: string; label: string }[];
  assessments: AssessmentAdminRow[];
  duesReady: boolean;
  duesYear: number;
}): string {
  const rows = options.ledger
    .map(
      (row) => `<tr>
        <td>Lot ${esc(row.lot_number)}</td>
        <td>${esc(options.ownersByProperty.get(row.property_id) ?? "")}</td>
        <td>${moneySpan(row.charges_cents - row.late_fee_cents)}</td>
        <td>${moneySpan(row.late_fee_cents)}</td>
        <td>${moneySpan(row.payment_cents)}</td>
        <td>${moneySpan(row.balance_cents)}</td>
        <td>${row.delinquent ? `<span class="badge late">Past due</span>` : ""}</td>
      </tr>`,
    )
    .join("");
  const propertyOptions = options.properties.map((property) => ({
    value: property.id,
    label: `Lot ${property.lot_number}`,
  }));
  return `${adminNav(options.association.slug, "ledger")}
    <section class="panel">
      <h1>Assessments and balances</h1>
      <p><a href="/a/${esc(options.association.slug)}/admin/export.csv">Download CSV for the accountant</a></p>
      ${rows ? `<table><thead><tr><th>Lot</th><th>Primary owner</th><th>Charges</th><th>Late fees</th><th>Payments</th><th>Balance</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No lots.")}
    </section>
    ${duesSection(options)}
    <section class="split">
      <article class="panel">
        <h2>Record an invoice</h2>
        <form class="fields" method="post" action="/a/${esc(options.association.slug)}/admin/invoices">
          ${selectField("Lot", "property_id", propertyOptions)}
          ${textField("Description", "description", { required: true })}
          ${textField("Amount", "amount", { required: true, type: "text" })}
          ${textField("Late fee", "late_fee", { value: "0" })}
          ${textField("Issued", "issued_on", { type: "date", required: true })}
          ${textField("Due", "due_on", { type: "date", required: true })}
          <button type="submit">Save invoice</button>
        </form>
      </article>
      <article class="panel">
        <h2>Record a payment</h2>
        <form class="fields" method="post" action="/a/${esc(options.association.slug)}/admin/payments">
          ${selectField("Lot", "property_id", propertyOptions)}
          ${selectField("Invoice", "invoice_id", [{ value: "", label: "Not tied to one invoice" }, ...options.invoices.map((invoice) => ({ value: invoice.id, label: invoice.label }))])}
          ${textField("Amount", "amount", { required: true })}
          ${selectField("Method", "method", [
            { value: "check", label: "Check" },
            { value: "cash", label: "Cash" },
            { value: "ach_recorded", label: "ACH (recorded)" },
            { value: "other", label: "Other" },
          ])}
          ${textField("Reference", "reference")}
          ${textField("Paid on", "paid_on", { type: "date", required: true })}
          ${areaField("Notes", "notes")}
          <button type="submit">Save payment</button>
        </form>
      </article>
    </section>`;
}

export function documentsAdminPage(association: Association, documents: DocumentRow[]): string {
  const rows = documents
    .map(
      (doc) => `<tr>
        <td>${categoryCell(doc.category)}</td>
        <td><a href="/a/${esc(association.slug)}/admin/documents/${esc(doc.id)}">${esc(doc.title)}</a></td>
        <td>${esc(visibilityLabel(doc.visibility))}</td>
        <td>${doc.version_number ? `v${doc.version_number}` : "None"}</td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "documents")}
    <section class="split">
      <article class="panel">
        <h1>Documents</h1>
        <p class="muted">Residents see the version marked current. Choose board-only for budgets and other financial reports.</p>
        ${rows ? `<table><thead><tr><th>Category</th><th>Title</th><th>Visibility</th><th>Current</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No documents yet.")}
      </article>
      <article class="panel">
        <h2>Publish a file</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents" enctype="multipart/form-data">
          ${textField("Title", "title", { required: true })}
          ${selectField("Category", "category", DOCUMENT_CATEGORIES.map((item) => ({ value: item.id, label: item.label })))}
          ${selectField("Who can see it", "visibility", [
            { value: "residents", label: "Owners and residents" },
            { value: "board", label: "Board only" },
          ])}
          ${areaField("Notes", "notes")}
          <label>File<input type="file" name="file" required></label>
          ${emailOwnersField()}
          <button type="submit">Publish</button>
        </form>
      </article>
    </section>`;
}

export function documentDetailPage(
  association: Association,
  document: { id: string; title: string; category: DocumentCategory; visibility: string; current_version_id: string | null },
  versions: VersionRow[],
): string {
  const rows = versions
    .map(
      (version) => `<tr>
        <td>v${version.version_number}${version.id === document.current_version_id ? " · current" : ""}</td>
        <td>${esc(version.filename)}</td>
        <td>${esc(version.notes)}</td>
        <td>${dateTimeCell(version.created_at, association.timezone)}</td>
        <td>${documentFileLinks(`/a/${association.slug}/admin/documents/${document.id}/versions/${version.id}/file`, version.content_type)}</td>
        <td>${version.id === document.current_version_id ? "" : `<form method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/current"><input type="hidden" name="version_id" value="${esc(version.id)}"><button class="secondary" type="submit">Make current</button></form>`}</td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "documents")}
    <section class="panel">
      <h1>${esc(document.title)}</h1>
      <p>${categoryCell(document.category)} · ${esc(visibilityLabel(document.visibility))}</p>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/visibility">
        ${selectField("Who can see it", "visibility", [
          { value: "residents", label: "Owners and residents" },
          { value: "board", label: "Board only" },
        ], document.visibility)}
        <button class="secondary" type="submit">Save visibility</button>
      </form>
      <p class="muted">Saving visibility does not upload a new file.</p>
      ${rows ? `<table><thead><tr><th>Version</th><th>File</th><th>Notes</th><th>Uploaded</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    </section>
    <section class="panel">
      <h2>Upload a new version</h2>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/versions" enctype="multipart/form-data">
        ${areaField("Notes", "notes")}
        <label>File<input type="file" name="file" required></label>
        ${emailOwnersField()}
        <button type="submit">Upload and make current</button>
      </form>
    </section>
    <section class="panel">
      <h2>Delete document</h2>
      <p class="muted">This removes the document, every version, and the stored files.</p>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/delete">
        <label><input type="checkbox" name="confirm" value="yes" required> Delete this document and its files</label>
        <button class="secondary" type="submit">Delete document</button>
      </form>
    </section>`;
}

export type NewsEdit =
  | { kind: "announcement"; row: AnnouncementRow }
  | { kind: "event"; row: EventRow; startsLocal: string; endsLocal: string }
  | { kind: "faq"; row: FaqRow }
  | { kind: "contact"; row: ContactRow };

export function newsAdminPage(options: {
  association: Association;
  announcements: AnnouncementRow[];
  events: EventRow[];
  faqs: FaqRow[];
  contacts: ContactRow[];
  editing?: NewsEdit | null;
}): string {
  const { association } = options;
  const base = `/a/${esc(association.slug)}/admin`;
  const editing = options.editing ?? null;
  const editingId = editing ? ("row" in editing ? editing.row.id : "") : "";
  const announcements = options.announcements
    .map((item) => {
      const hidden = item.expires_at && item.expires_at <= new Date().toISOString();
      return `<tr>
        <td>${esc(item.kind)}${hidden ? ` <span class="badge">Hidden</span>` : ""}${editingId === item.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${esc(item.title)}</td>
        <td>${dateCell(item.published_at, association.timezone)}</td>
        <td>${newsItemActions(association.slug, "announcements", item.id, `${base}/announcements/${esc(item.id)}/hide`)}</td>
      </tr>`;
    })
    .join("");
  const events = options.events
    .map(
      (event) => `<tr>
        <td>${esc(event.kind)}${editingId === event.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${esc(event.title)}</td>
        <td>${dateTimeCell(event.starts_at, association.timezone)}</td>
        <td>${newsItemActions(association.slug, "events", event.id)}</td>
      </tr>`,
    )
    .join("");
  const faqs = options.faqs
    .map(
      (faq) => `<tr>
        <td>${esc(faq.question)}${editingId === faq.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${newsItemActions(association.slug, "faqs", faq.id)}</td>
      </tr>`,
    )
    .join("");
  const contacts = options.contacts
    .map(
      (contact) => `<tr>
        <td>${esc(contact.name)}${editingId === contact.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${esc(contact.role_title)}</td>
        <td>${newsItemActions(association.slug, "contacts", contact.id)}</td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "news")}
    ${editing ? `<section class="panel" id="edit">${newsEditForm(association, editing)}</section>` : ""}
    <section class="panel">
      <h1>News, calendar, FAQ, Board Contact</h1>
      <h2>Announcements</h2>
      ${
        announcements
          ? `<table><thead><tr><th>Kind</th><th>Title</th><th>Published</th><th></th></tr></thead><tbody>${announcements}</tbody></table>`
          : empty("No announcements.")
      }
      <h2>Events</h2>
      ${
        events
          ? `<table><thead><tr><th>Kind</th><th>Title</th><th>Starts</th><th></th></tr></thead><tbody>${events}</tbody></table>`
          : empty("No events.")
      }
      <h2>FAQs</h2>
      ${faqs ? `<table><thead><tr><th>Question</th><th></th></tr></thead><tbody>${faqs}</tbody></table>` : empty("No FAQs.")}
      <h2>Board Contact</h2>
      ${
        contacts
          ? `<table><thead><tr><th>Name</th><th>Role</th><th></th></tr></thead><tbody>${contacts}</tbody></table>`
          : empty("No contacts.")
      }
    </section>
    <section class="grid">
      <article class="panel"><h2>Add announcement</h2>${announcementForm(base, association, null)}</article>
      <article class="panel"><h2>Add event</h2>${eventForm(base, null)}</article>
      <article class="panel"><h2>Add FAQ</h2>${faqForm(base, null)}</article>
      <article class="panel"><h2>Add Board Contact</h2>${contactForm(base, null)}</article>
    </section>`;
}

function newsEditForm(association: Association, editing: NewsEdit): string {
  const base = `/a/${esc(association.slug)}/admin`;
  const cancel = `<p><a href="${base}/news">Cancel</a></p>`;
  if (editing.kind === "announcement") {
    return `<h1>Edit announcement</h1><p class="muted">Change this announcement, then save.</p>${announcementForm(base, association, editing.row)}${cancel}`;
  }
  if (editing.kind === "event") {
    return `<h1>Edit event</h1><p class="muted">Change this event, then save.</p>${eventForm(base, editing)}${cancel}`;
  }
  if (editing.kind === "faq") {
    return `<h1>Edit FAQ</h1><p class="muted">Change this question, then save.</p>${faqForm(base, editing.row)}${cancel}`;
  }
  return `<h1>Edit board contact</h1><p class="muted">Change this contact, then save.</p>${contactForm(base, editing.row)}${cancel}`;
}

function announcementForm(base: string, association: Association, row: AnnouncementRow | null): string {
  return `<form class="fields" method="post" action="${base}/announcements${row ? `/${esc(row.id)}` : ""}">
      ${selectField("Kind", "kind", [
        { value: "news", label: "News" },
        { value: "meeting", label: "Meeting notice" },
        { value: "emergency", label: "Emergency" },
      ], row?.kind ?? "news")}
      ${textField("Title", "title", { value: row?.title ?? "", required: true })}
      ${areaField("Description", "body", row?.body ?? "", true)}
      <label><input type="checkbox" name="pinned" value="1" ${row?.pinned ? "checked" : ""}> Pin</label>
      ${textField("Expires", "expires_on", { type: "date", value: row?.expires_at ? zonedIsoDate(new Date(row.expires_at), association.timezone) : "" })}
      ${emailOwnersField()}
      <button type="submit">${row ? "Save announcement" : "Post"}</button>
    </form>`;
}

function eventForm(base: string, editing: Extract<NewsEdit, { kind: "event" }> | null): string {
  const row = editing?.row;
  return `<form class="fields" method="post" action="${base}/events${row ? `/${esc(row.id)}` : ""}">
      ${selectField("Kind", "kind", [
        { value: "event", label: "Event" },
        { value: "meeting", label: "Meeting" },
        { value: "emergency", label: "Emergency" },
      ], row?.kind ?? "event")}
      ${textField("Title", "title", { value: row?.title ?? "", required: true })}
      ${areaField("Description", "description", row?.description ?? "")}
      ${textField("Location", "location", { value: row?.location ?? "" })}
      ${textField("Starts", "starts_at", { type: "datetime-local", value: editing?.startsLocal ?? "", required: true })}
      ${textField("Ends", "ends_at", { type: "datetime-local", value: editing?.endsLocal ?? "" })}
      ${emailOwnersField()}
      <button type="submit">${row ? "Save event" : "Add event"}</button>
    </form>`;
}

function faqForm(base: string, row: FaqRow | null): string {
  return `<form class="fields" method="post" action="${base}/faqs${row ? `/${esc(row.id)}` : ""}">
      ${textField("Question", "question", { value: row?.question ?? "", required: true })}
      ${areaField("Answer", "answer", row?.answer ?? "", true)}
      <button type="submit">${row ? "Save FAQ" : "Add FAQ"}</button>
    </form>`;
}

function contactForm(base: string, row: ContactRow | null): string {
  return `<form class="fields" method="post" action="${base}/contacts${row ? `/${esc(row.id)}` : ""}">
      ${textField("Name", "name", { value: row?.name ?? "", required: true })}
      ${textField("Role", "role_title", { value: row?.role_title ?? "", required: true })}
      ${textField("Email", "email", { type: "email", value: row?.email ?? "" })}
      ${textField("Phone", "phone", { value: row?.phone ?? "" })}
      <button type="submit">${row ? "Save contact" : "Add Board Contact"}</button>
    </form>`;
}

export function joinRequestsPage(association: Association, rows: JoinRequestRow[]): string {
  const body = rows
    .map((row) => {
      return `<tr>
        <td>${dateTimeCell(row.created_at, association.timezone)}</td>
        <td>${esc(row.name)}<div class="muted">${esc(row.email)}</div></td>
        <td>${esc(row.address)}</td>
        <td>${esc(row.note)}</td>
        <td>${esc(joinStatusLabel(row.status))}</td>
        <td>${joinRequestActions(association.slug, row)}</td>
      </tr>`;
    })
    .join("");
  return `${adminNav(association.slug, "joins")}
    <section class="panel">
      <h1>Join requests</h1>
      <p class="muted">Approve creates a login and sends a welcome email. Decline does not. Delete removes the request. A lot links only if the address matches one empty lot.</p>
      ${body ? `<table><thead><tr><th>Received</th><th>Person</th><th>Address or lot</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table>` : empty("No join requests yet.")}
    </section>`;
}

function joinRequestActions(slug: string, row: JoinRequestRow): string {
  const base = `/a/${esc(slug)}/admin/join-requests/${esc(row.id)}`;
  const approve =
    row.status === "pending" || row.status === "reviewed" || row.status === "declined"
      ? `<form method="post" action="${base}/approve"><button type="submit">Approve</button></form>`
      : "";
  const decline =
    row.status === "pending" || row.status === "reviewed"
      ? `<form method="post" action="${base}/decline"><button class="secondary" type="submit">Decline</button></form>`
      : "";
  const review =
    row.status === "pending"
      ? `<form method="post" action="${base}/reviewed"><button class="secondary" type="submit">Mark reviewed</button></form>`
      : "";
  const remove = `<form method="post" action="${base}/delete" onsubmit="return confirm('Delete this join request? This cannot be undone.')"><input type="hidden" name="confirm" value="yes"><button class="secondary" type="submit">Delete</button></form>`;
  return `<div class="actions join-actions">${approve}${decline}${review}${remove}</div>`;
}

function joinStatusLabel(status: string): string {
  if (status === "pending") return "Pending";
  if (status === "reviewed") return "Reviewed";
  if (status === "approved") return "Approved";
  if (status === "declined") return "Declined";
  return status;
}

export function auditPage(association: Association, rows: AuditRow[]): string {
  return `${adminNav(association.slug, "audit")}<section class="panel"><h1>Activity</h1>${auditTable(association, rows)}</section>`;
}

export function adminMessagesPage(association: Association, threads: MessageRow[]): string {
  const rows = threads
    .map(
      (thread) => `<tr>
        <td><a href="/a/${esc(association.slug)}/admin/messages/${esc(thread.thread_id)}">${esc(thread.subject)}</a></td>
        <td>${esc(thread.from_name)}</td>
        <td>${thread.lot_number ? `Lot ${esc(thread.lot_number)}` : ""}</td>
        <td>${dateTimeCell(thread.created_at, association.timezone)}</td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "messages")}
    <section class="panel">
      <h1>Messages</h1>
      <p class="muted">Incoming from owners. These notes are private to the board. Other owners cannot read them.</p>
      ${rows ? `<table><thead><tr><th>Subject</th><th>Latest from</th><th>Lot</th><th>When</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No incoming messages.")}
    </section>`;
}

export function adminThreadPage(association: Association, subject: string, messages: MessageRow[]): string {
  const threadId = messages[0]?.thread_id ?? "";
  return `${adminNav(association.slug, "messages")}${threadPage(association, subject, messages, {
    incoming: true,
    next: `/a/${association.slug}/admin/messages/${threadId}`,
  })}`;
}

function duesSection(options: {
  association: Association;
  assessments: AssessmentAdminRow[];
  duesReady: boolean;
  duesYear: number;
}): string {
  const base = `/a/${esc(options.association.slug)}/admin`;
  if (!options.duesReady) {
    return `<section class="panel" id="dues"><h2>Annual dues</h2><p>Apply the admin migration in D1, then reload. The steps are in the README under Admin improvements.</p></section>`;
  }
  const rows = options.assessments
    .map((row) => {
      const edit = `${base}/assessments/${esc(row.id)}`;
      const remove =
        row.invoice_count === 0
          ? `<form method="post" action="${edit}/delete"><label><input type="checkbox" name="confirm" value="yes" required> Confirm</label><button class="secondary" type="submit">Delete</button></form>`
          : "";
      return `<tr>
        <td>${esc(row.name)}</td>
        <td>${esc(lotTypeLabel(row.lot_type))}</td>
        <td>${row.opens_on ? dateCell(row.opens_on, options.association.timezone) : ""}</td>
        <td>${dateCell(row.due_on, options.association.timezone)}</td>
        <td>${moneySpan(row.amount_cents)}</td>
        <td>${row.invoice_count}</td>
        <td>
          <form method="post" action="${edit}/assign"><button type="submit">Assign to matching lots</button></form>
          <details>
            <summary>Edit</summary>
            <form class="fields" method="post" action="${edit}">
              ${textField("Name", "name", { value: row.name, required: true })}
              ${selectField("Lot type", "lot_type", [
                { value: "improved", label: "Improved" },
                { value: "unimproved", label: "Unimproved" },
                { value: "", label: "All lots" },
              ], row.lot_type ?? "")}
              ${textField("Amount", "amount", { value: (row.amount_cents / 100).toFixed(2), required: true })}
              ${textField("Opens", "opens_on", { type: "date", value: row.opens_on ?? "" })}
              ${textField("Due", "due_on", { type: "date", value: row.due_on, required: true })}
              <button class="secondary" type="submit">Save assessment</button>
            </form>
            ${remove}
          </details>
        </td>
      </tr>`;
    })
    .join("");
  return `<section class="panel" id="dues">
    <h2>Annual dues</h2>
    <p class="muted">The schedule opens January 1 and is due March 1. Improved lots are $625. Unimproved lots are $100. Assigning writes one invoice on each active lot of that type that does not already have this assessment, so Upcoming assessments can show it on those owners' dashboards. Changing the amount later does not rewrite invoices already assigned.</p>
    ${rows ? `<table><thead><tr><th>Assessment</th><th>Lots</th><th>Opens</th><th>Due</th><th>Amount</th><th>Invoices</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No assessments yet.")}
    <h3>Add a year</h3>
    <form class="fields" method="post" action="${base}/assessments">
      ${textField("Year", "year", { value: String(options.duesYear), required: true })}
      <button type="submit">Add improved and unimproved dues</button>
    </form>
  </section>`;
}

function emailOwnersField(label = "Email owners", name = "email_owners"): string {
  return `<label><input type="checkbox" name="${name}" value="1"> ${label}</label>`;
}

function newsItemActions(
  slug: string,
  resource: "announcements" | "events" | "faqs" | "contacts",
  id: string,
  hideAction = "",
): string {
  const editKind = resource === "announcements" ? "announcement" : resource === "events" ? "event" : resource === "faqs" ? "faq" : "contact";
  const noun = editKind === "announcement" ? "announcement" : editKind === "event" ? "event" : editKind === "faq" ? "FAQ" : "contact";
  const base = `/a/${esc(slug)}/admin`;
  const hide = hideAction ? `<form method="post" action="${hideAction}"><button class="secondary" type="submit">Hide</button></form>` : "";
  return `<div class="actions">
    <a class="button secondary" href="${base}/news?edit=${editKind}&amp;id=${esc(id)}#edit">Edit</a>
    ${hide}
    <form method="post" action="${base}/${resource}/${esc(id)}/delete" onsubmit="return confirm('Delete this ${noun}? This cannot be undone.')">
      <input type="hidden" name="confirm" value="yes">
      <button class="secondary" type="submit">Delete</button>
    </form>
  </div>`;
}

function auditTable(association: Association, rows: AuditRow[]): string {
  if (rows.length === 0) return empty("No activity yet.");
  const body = rows
    .map(
      (row) => `<tr>
        <td>${dateTimeCell(row.created_at, association.timezone)}</td>
        <td>${esc(row.actor_name || row.actor_email || "System")}</td>
        <td>${esc(row.action)}</td>
        <td>${esc(row.entity_type)}</td>
        <td>${esc(row.detail)}</td>
      </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead><tbody>${body}</tbody></table>`;
}
