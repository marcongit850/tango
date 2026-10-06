import { DOCUMENT_CATEGORIES } from "../lib/categories";
import { esc } from "../lib/html";
import type { Association, DocumentCategory } from "../types";
import type {
  AnnouncementRow,
  AuditRow,
  BalanceRow,
  ContactRow,
  DocumentRow,
  EventRow,
  FaqRow,
  JoinRequestRow,
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
  empty,
  moneySpan,
  roleLabel,
  selectField,
  textField,
} from "./bits";

function adminNav(slug: string, current: string): string {
  const links = [
    ["overview", "Overview"],
    ["owners", "Owners"],
    ["lots", "Lots"],
    ["import", "CSV import"],
    ["ledger", "Ledger"],
    ["documents", "Documents"],
    ["news", "News"],
    ["joins", "Join requests"],
    ["audit", "Audit"],
  ];
  return `<p class="actions">${links
    .map(([id, label]) => {
      const href = id === "overview" ? `/a/${esc(slug)}/admin` : id === "joins" ? `/a/${esc(slug)}/admin/join-requests` : `/a/${esc(slug)}/admin/${id}`;
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
  const joins =
    options.pendingJoins === null
      ? ""
      : `<article class="card"><h2>${options.pendingJoins}</h2><p><a href="/a/${esc(options.association.slug)}/admin/join-requests">Join requests waiting</a></p></article>`;
  return `${adminNav(options.association.slug, "overview")}
    <section class="panel">
      <h1>Board admin</h1>
      <p class="muted">${esc(options.association.legal_name)}. Tools on this page stay inside ${esc(options.association.name)}.</p>
    </section>
    <section class="grid">
      <article class="card"><h2>${options.lots}</h2><p>Lots</p></article>
      <article class="card"><h2>${options.members}</h2><p>Active logins</p></article>
      <article class="card"><h2>${options.delinquent}</h2><p>Delinquent lots</p></article>
      <article class="card"><h2>${options.waiting}</h2><p>Messages waiting on the board</p></article>
      ${joins}
    </section>
    <section class="panel">
      <h2>Roles</h2>
      <p>Homeowner sees only their lots. Board member and officer/manager share these admin tools. Public is the logged-out visitor and is not assigned on a roster.</p>
      <p><a href="/a/${esc(options.association.slug)}/admin/export.csv">Export ledger for the accountant</a></p>
    </section>
    <section class="panel"><h2>Recent activity</h2>${auditTable(options.association, options.audit.slice(0, 8))}</section>`;
}

export function ownersPage(
  association: Association,
  owners: (OwnerListRow & { balance_cents?: number; delinquent?: boolean })[],
  delinquentOnly: boolean,
): string {
  const rows = owners
    .map(
      (owner) => `<tr>
        <td><a href="/a/${esc(association.slug)}/admin/owners/${esc(owner.user_id)}">${esc(owner.name)}</a><div class="muted">${esc(owner.email)}</div></td>
        <td>${esc(roleLabel(owner.role_id))}</td>
        <td>${esc(owner.status)}</td>
        <td>${owner.lot_number ? `Lot ${esc(owner.lot_number)}` : "—"}</td>
        <td>${owner.balance_cents === undefined ? "—" : moneySpan(owner.balance_cents)}</td>
        <td>${owner.delinquent ? `<span class="badge late">Past due</span>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "owners")}
    <section class="panel">
      <h1>${delinquentOnly ? "Delinquent accounts" : "Homeowner accounts"}</h1>
      <p class="actions">
        <a class="button ${delinquentOnly ? "secondary" : ""}" href="/a/${esc(association.slug)}/admin/owners">All owners</a>
        <a class="button ${delinquentOnly ? "" : "secondary"}" href="/a/${esc(association.slug)}/admin/owners?delinquent=1">Delinquent</a>
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
    .map((property) => ({ value: property.id, label: `Lot ${property.lot_number} — ${property.street_address}` }));
  return `${adminNav(association.slug, "owners")}
    <section class="panel">
      <h1>${esc(owner.name)}</h1>
      <p>${esc(owner.email)}${owner.phone ? ` · ${esc(owner.phone)}` : ""}</p>
      <p>${esc(roleLabel(owner.role_id))} · ${esc(owner.status)}</p>
      <p>Primary lot balance ${options.balance === null ? "—" : moneySpan(options.balance)}</p>
    </section>
    <section class="split">
      <article class="panel">
        <h2>Role</h2>
        <form class="fields" method="post" action="${esc(base)}/role">
          ${selectField("Role", "role_id", [
            { value: "homeowner", label: "Homeowner" },
            { value: "board", label: "Board member" },
            { value: "officer", label: "Officer / manager" },
          ], owner.role_id)}
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
        <form class="fields" method="post" action="${esc(base)}/notice">
          ${textField("Title", "title", { required: true })}
          ${areaField("Message", "body", "", true)}
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

export function lotsPage(association: Association, properties: PropertyRow[]): string {
  const rows = properties
    .map(
      (property) => `<tr>
        <td>Lot ${esc(property.lot_number)}</td>
        <td>${esc(property.street_address)}</td>
        <td>${esc(property.city)} ${esc(property.state)} ${esc(property.postal_code)}</td>
        <td>${esc(property.status)}</td>
        <td>
          <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/lots/${esc(property.id)}">
            ${textField("Street", "street_address", { value: property.street_address, required: true })}
            ${selectField("Status", "status", [
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ], property.status)}
            <button class="secondary" type="submit">Update</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "lots")}
    <section class="split">
      <article class="panel">
        <h1>Lots</h1>
        ${rows ? `<table><thead><tr><th>Lot</th><th>Address</th><th>Place</th><th>Status</th><th>Edit</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No lots yet.")}
      </article>
      <article class="panel">
        <h2>Add a lot</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/lots">
          ${textField("Lot number", "lot_number", { required: true })}
          ${textField("Street address", "street_address", { required: true })}
          <button type="submit">Add lot</button>
        </form>
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
      <p>Save the Excel roster as CSV UTF-8. Required columns: <code>email</code>, <code>name</code>, <code>lot_number</code>, <code>street_address</code>. Optional: <code>role</code> (homeowner, board, officer), <code>starting_balance</code> (dollars owed; negative is a credit), <code>balance_as_of</code> (YYYY-MM-DD), <code>phone</code>, <code>city</code>, <code>state</code>, <code>postal_code</code>.</p>
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
        <td>${esc(doc.visibility)}</td>
        <td>${doc.version_number ? `v${doc.version_number}` : "—"}</td>
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
            { value: "residents", label: "Residents" },
            { value: "board", label: "Board only" },
          ])}
          ${areaField("Notes", "notes")}
          <label>File<input type="file" name="file" required></label>
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
        <td><a href="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/versions/${esc(version.id)}/file">Download</a></td>
        <td>${version.id === document.current_version_id ? "" : `<form method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/current"><input type="hidden" name="version_id" value="${esc(version.id)}"><button class="secondary" type="submit">Make current</button></form>`}</td>
      </tr>`,
    )
    .join("");
  return `${adminNav(association.slug, "documents")}
    <section class="panel">
      <h1>${esc(document.title)}</h1>
      <p>${categoryCell(document.category)} · ${esc(document.visibility)}</p>
      ${rows ? `<table><thead><tr><th>Version</th><th>File</th><th>Notes</th><th>Uploaded</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    </section>
    <section class="panel">
      <h2>Upload a new version</h2>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/versions" enctype="multipart/form-data">
        ${areaField("Notes", "notes")}
        <label>File<input type="file" name="file" required></label>
        <button type="submit">Upload and make current</button>
      </form>
    </section>`;
}

export function newsAdminPage(options: {
  association: Association;
  announcements: AnnouncementRow[];
  events: EventRow[];
  faqs: FaqRow[];
  contacts: ContactRow[];
}): string {
  const { association } = options;
  const events = options.events
    .map((event) => `<li>${esc(event.kind)} · ${esc(event.title)} · ${dateTimeCell(event.starts_at, association.timezone)}</li>`)
    .join("");
  const faqs = options.faqs.map((faq) => `<li>${esc(faq.question)}</li>`).join("");
  const contacts = options.contacts.map((contact) => `<li>${esc(contact.name)} · ${esc(contact.role_title)}</li>`).join("");
  const announcements = options.announcements
    .map(
      (item) => `<li>${esc(item.kind)} · ${esc(item.title)} · ${dateCell(item.published_at, association.timezone)}
        ${item.expires_at && item.expires_at <= new Date().toISOString() ? "(expired)" : ""}
        <form method="post" action="/a/${esc(association.slug)}/admin/announcements/${esc(item.id)}/hide"><button class="linkish" type="submit">Hide</button></form>
      </li>`,
    )
    .join("");
  return `${adminNav(association.slug, "news")}
    <section class="panel"><h1>News, calendar, FAQ, contacts</h1>
      <h2>Announcements</h2><ul>${announcements || "<li>No announcements.</li>"}</ul>
      <h2>Events</h2><ul>${events || "<li>No events.</li>"}</ul>
      <h2>FAQs</h2><ul>${faqs || "<li>No FAQs.</li>"}</ul>
      <h2>Contacts</h2><ul>${contacts || "<li>No contacts.</li>"}</ul>
    </section>
    <section class="grid">
      <article class="panel">
        <h2>Announcement</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/announcements">
          ${selectField("Kind", "kind", [
            { value: "news", label: "News" },
            { value: "meeting", label: "Meeting notice" },
            { value: "emergency", label: "Emergency" },
          ])}
          ${textField("Title", "title", { required: true })}
          ${areaField("Body", "body", "", true)}
          <label><input type="checkbox" name="pinned" value="1"> Pin</label>
          ${textField("Expires", "expires_on", { type: "date" })}
          <button type="submit">Post</button>
        </form>
      </article>
      <article class="panel">
        <h2>Calendar event</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/events">
          ${selectField("Kind", "kind", [
            { value: "event", label: "Event" },
            { value: "meeting", label: "Meeting" },
            { value: "emergency", label: "Emergency" },
          ])}
          ${textField("Title", "title", { required: true })}
          ${areaField("Description", "description")}
          ${textField("Location", "location")}
          ${textField("Starts", "starts_at", { type: "datetime-local", required: true })}
          ${textField("Ends", "ends_at", { type: "datetime-local" })}
          <button type="submit">Add event</button>
        </form>
      </article>
      <article class="panel">
        <h2>FAQ</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/faqs">
          ${textField("Question", "question", { required: true })}
          ${areaField("Answer", "answer", "", true)}
          <button type="submit">Add FAQ</button>
        </form>
      </article>
      <article class="panel">
        <h2>Board contact</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/contacts">
          ${textField("Name", "name", { required: true })}
          ${textField("Role", "role_title", { required: true })}
          ${textField("Email", "email", { type: "email" })}
          ${textField("Phone", "phone")}
          <button type="submit">Add contact</button>
        </form>
      </article>
    </section>`;
}

export function joinRequestsPage(association: Association, rows: JoinRequestRow[]): string {
  const body = rows
    .map((row) => {
      const review =
        row.status === "pending"
          ? `<form method="post" action="/a/${esc(association.slug)}/admin/join-requests/${esc(row.id)}/reviewed"><button class="secondary" type="submit">Mark reviewed</button></form>`
          : "";
      return `<tr>
        <td>${dateTimeCell(row.created_at, association.timezone)}</td>
        <td>${esc(row.name)}<div class="muted">${esc(row.email)}</div></td>
        <td>${esc(row.address)}</td>
        <td>${esc(row.note)}</td>
        <td>${esc(joinStatusLabel(row.status))}</td>
        <td>${review}</td>
      </tr>`;
    })
    .join("");
  return `${adminNav(association.slug, "joins")}
    <section class="panel">
      <h1>Join requests</h1>
      <p class="muted">People who asked to join from the public home page. Marking a request reviewed does not create a login. Add them from CSV import or the owner tools when they should have access.</p>
      ${body ? `<table><thead><tr><th>Received</th><th>Person</th><th>Address or lot</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table>` : empty("No join requests yet.")}
    </section>`;
}

function joinStatusLabel(status: string): string {
  if (status === "pending") return "Pending";
  if (status === "reviewed") return "Reviewed";
  return status;
}

export function auditPage(association: Association, rows: AuditRow[]): string {
  return `${adminNav(association.slug, "audit")}<section class="panel"><h1>Audit log</h1>${auditTable(association, rows)}</section>`;
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
