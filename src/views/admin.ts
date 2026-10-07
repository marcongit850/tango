import { DOCUMENT_CATEGORIES } from "../lib/categories";
import { DOCUMENT_FILE_ACCEPT } from "../lib/files";
import { zonedIsoDate } from "../lib/dates";
import { lotTypeLabel } from "../lib/dues";
import { MASTER_ADMIN_DELETE_MESSAGE, MASTER_ADMIN_EDIT_MESSAGE } from "../lib/access";
import { esc, paragraphs } from "../lib/html";
import { formatMoney } from "../lib/money";
import type { Association, DocumentCategory } from "../types";
import { messageWaitingOnBoard, type MessageRow } from "../db";
import type {
  AnnouncementRow,
  AssessmentAdminRow,
  AuditRow,
  BalanceRow,
  ContactRow,
  DocumentRow,
  EventRow,
  FaqRow,
  InvoicePaymentRow,
  InvoiceRow,
  JoinRequestRow,
  LotRow,
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
  addressLine,
  addressLines,
  mailingAddressHtml,
  propertyAddressHtml,
  confirmDeleteButton,
  contactPhones,
  documentFileLinks,
  empty,
  methodLabel,
  moneySpan,
  roleLabel,
  selectField,
  textField,
  visibilityLabel,
} from "./bits";
import { threadPage } from "./resident";

function adminNav(slug: string, current: string, canEdit = true): string {
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
    .join(" ")}</p>${canEdit ? "" : `<p class="muted">View only. Edit access is required to create, edit, or delete.</p>`}`;
}

function moneyLink(href: string, cents: number): string {
  return `<a class="money-link" href="${esc(href)}">${moneySpan(cents)}</a>`;
}

function lotBalanceCell(slug: string, lot: { id: string; balance_cents?: number }): string {
  if (lot.balance_cents === undefined) return "";
  return moneyLink(`/a/${slug}/admin/ledger/${lot.id}`, lot.balance_cents);
}

function accountAccessLabel(owner: OwnerListRow): string {
  if (owner.is_master === 1) return "Master admin";
  if (owner.is_admin === 1) return "Edit access";
  return "No edit access";
}

function lastLoginLabel(value: string | null | undefined, timeZone: string): string {
  if (!value) return "Has not signed in";
  return dateTimeCell(value, timeZone);
}

function notePreview(notes: string): string {
  const flat = notes.replace(/\s+/g, " ").trim();
  if (flat.length <= 80) return flat;
  return `${flat.slice(0, 77)}...`;
}

type LotFormValues = {
  lot_number?: string;
  street_address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  lot_type?: string;
  status?: string;
  house_name?: string;
  mailing_street?: string;
  mailing_city?: string;
  mailing_state?: string;
  mailing_postal_code?: string;
  admin_notes?: string;
};

function lotDetailFields(values: LotFormValues, mode: "add" | "edit"): string {
  const status =
    mode === "edit"
      ? selectField(
          "Status",
          "status",
          [
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
          ],
          values.status ?? "active",
        )
      : "";
  return `${textField("Lot number", "lot_number", { value: values.lot_number ?? "", required: true })}
    ${textField("House name", "house_name", { value: values.house_name ?? "" })}
    ${textField(mode === "add" ? "Street address" : "Street", "street_address", { value: values.street_address ?? "", required: true })}
    ${textField("City", "city", { value: values.city ?? "" })}
    ${textField("State", "state", { value: values.state ?? "" })}
    ${textField("ZIP", "postal_code", { value: values.postal_code ?? "" })}
    <p>Mailing address (if different)</p>
    ${textField("Mailing street", "mailing_street", { value: values.mailing_street ?? "" })}
    ${textField("Mailing city", "mailing_city", { value: values.mailing_city ?? "" })}
    ${textField("Mailing state", "mailing_state", { value: values.mailing_state ?? "" })}
    ${textField("Mailing postal code", "mailing_postal_code", { value: values.mailing_postal_code ?? "" })}
    <p class="muted">Leave mailing blank when it matches the property address.</p>
    ${areaField("Admin notes", "admin_notes", values.admin_notes ?? "")}
    <p class="muted">Admin notes are visible only on admin pages. Owners do not see them.</p>
    ${selectField(
      "Type",
      "lot_type",
      [
        { value: "improved", label: "Improved" },
        { value: "unimproved", label: "Unimproved" },
      ],
      values.lot_type ?? "improved",
    )}
    ${status}`;
}

function dollarsInput(cents: number): string {
  return (Number(cents) / 100).toFixed(2);
}

export function adminHome(options: {
  association: Association;
  lots: number;
  members: number;
  delinquent: number;
  waiting: number;
  pendingJoins: number | null;
  outstandingCents: number;
  admins: { user_id: string; name: string; email: string; is_master?: number }[];
  audit: AuditRow[];
  canEdit?: boolean;
}): string {
  const canEdit = options.canEdit !== false;
  const base = `/a/${esc(options.association.slug)}/admin`;
  const joins =
    options.pendingJoins === null
      ? ""
      : statCard(options.pendingJoins, "Join requests waiting", `${base}/join-requests`);
  return `${adminNav(options.association.slug, "overview", canEdit)}
    <section class="panel">
      <h1>Board admin</h1>
      <p class="muted">Board members can view these tools. Edit access can be given to a homeowner or a board member, and it is required to change them.</p>
    </section>
    <section class="grid">
      ${statCard(formatMoney(options.outstandingCents), "Total Outstanding", `${base}/ledger`)}
      ${statCard(options.lots, "Lots", `${base}/owners#lots`)}
      ${statCard(options.members, "Active logins", `${base}/owners#logins`)}
      ${statCard(options.delinquent, "Delinquent lots", `${base}/owners?delinquent=1#lots`)}
      ${statCard(options.waiting, "Messages waiting on the board", `${base}/messages`)}
      ${joins}
    </section>
    <section class="panel">
      <h2>Access</h2>
      ${accessExplainer()}
      <details>
        <summary>Current admins</summary>
        ${currentAdminList(options.association.slug, options.admins)}
      </details>
    </section>
    <section class="panel"><h2>Recent activity</h2>${auditTable(options.association, options.audit.slice(0, 8))}</section>`;
}

const ACCESS_EXPLAINER =
  "Board members can view these tools. Edit access can be given to a homeowner or a board member. It is required to create, edit, or delete. A homeowner without edit access only sees their own lots. Keep at least one person with edit access.";

function accessExplainer(): string {
  // WebKit triple-click walks past a paragraph into later elements until it finds a line break.
  // The hidden break stops that selection inside this explainer, before Current admins.
  return `<div class="access-explainer"><p>${ACCESS_EXPLAINER}</p><div class="access-selection-barrier" aria-hidden="true"><br></div></div>`;
}

function currentAdminList(slug: string, admins: { user_id: string; name: string; email: string; is_master?: number }[]): string {
  const items = admins
    .map((admin) => {
      const name = admin.name.trim();
      const email = admin.email.trim();
      const label = name || email;
      if (!label) return "";
      const emailLine = name && email ? `<span class="muted">${esc(email)}</span>` : "";
      const master = admin.is_master === 1 ? `<span class="muted">Master admin</span>` : "";
      return `<li><a href="/a/${esc(slug)}/admin/owners/${esc(admin.user_id)}">${esc(label)}</a>${emailLine}${master}</li>`;
    })
    .filter(Boolean)
    .join("");
  return items ? `<div class="access-admin-list"><ul>${items}</ul></div>` : empty("No current admins.");
}

function lotOwnerEditor(
  slug: string,
  propertyId: string,
  owners: LotOwnerControl[],
  returnTo: "owners" | "ledger",
): string {
  const base = `/a/${esc(slug)}/admin/lots/${esc(propertyId)}`;
  const items = owners
    .map((owner) => {
      const primary = owner.isPrimary ? ` <span class="badge">Primary</span>` : "";
      const makePrimary = owner.isPrimary
        ? ""
        : `<form method="post" action="${base}/owner">
            <input type="hidden" name="user_id" value="${esc(owner.userId)}">
            <input type="hidden" name="return_to" value="${esc(returnTo)}">
            <button class="secondary" type="submit">Make primary</button>
          </form>`;
      return `<li>${esc(owner.name)}, ${esc(owner.email)}${primary}
        ${makePrimary}
        <form method="post" action="${base}/owners/${esc(owner.userId)}/remove">
          <input type="hidden" name="return_to" value="${esc(returnTo)}">
          <button class="secondary" type="submit">Remove from lot</button>
        </form>
      </li>`;
    })
    .join("");
  const list = items ? `<ul>${items}</ul>` : `<p class="muted">No owner is linked to this lot.</p>`;
  return `<p><strong>Owners</strong></p>
    ${list}
    <p><strong>Add owner to this lot</strong></p>
    <form class="fields" method="post" action="${base}/owners">
      <input type="hidden" name="return_to" value="${esc(returnTo)}">
      ${textField("Name", "name")}
      ${textField("Email", "email", { type: "email", required: true })}
      ${textField("Phone", "phone")}
      <button class="secondary" type="submit">Add owner</button>
    </form>`;
}

function statCard(value: number | string, label: string, href: string): string {
  const figure = typeof value === "number" ? String(value) : esc(value);
  return `<a class="card" href="${href}"><h2>${figure}</h2><p>${esc(label)}</p></a>`;
}

export type LotOwnerControl = {
  userId: string;
  name: string;
  email: string;
  isPrimary: boolean;
};

export function ownersPage(
  association: Association,
  lots: (LotRow & { balance_cents?: number; delinquent?: boolean })[],
  owners: OwnerListRow[],
  delinquentOnly: boolean,
  canEdit = true,
  ownersByLot: ReadonlyMap<string, LotOwnerControl[]> = new Map(),
): string {
  const shownLots = delinquentOnly ? lots.filter((lot) => lot.delinquent) : lots;
  const loginRows = owners
    .map(
      (owner) => `<tr>
        <td><a href="/a/${esc(association.slug)}/admin/owners/${esc(owner.user_id)}">${esc(owner.name)}</a></td>
        <td>${esc(owner.email)}</td>
        <td>${esc(accountAccessLabel(owner))}</td>
        <td>${lastLoginLabel(owner.last_login_at, association.timezone)}</td>
      </tr>`,
    )
    .join("");
  const ownerChoices = owners.map((owner) => ({ value: owner.user_id, label: `${owner.name} (${owner.email})` }));
  const lotRows = shownLots
    .map((lot) => {
      const edit = `/a/${esc(association.slug)}/admin/lots/${esc(lot.id)}`;
      const mailing = addressLine(lot.mailing_street, lot.mailing_city, lot.mailing_state, lot.mailing_postal_code);
      const phone = !lot.owner_user_id ? "" : lot.owner_phone?.trim() || "No phone on file";
      const editCell = canEdit
        ? `<td>
          <details>
            <summary>Edit</summary>
            <form class="fields" method="post" action="${edit}">
              ${lotDetailFields(lot, "edit")}
              <button class="secondary" type="submit">Save lot</button>
            </form>
            <form class="fields" method="post" action="${edit}/owner">
              ${selectField("Primary owner", "user_id", [{ value: "", label: "Choose a person" }, ...ownerChoices])}
              <button class="secondary" type="submit">Assign owner</button>
            </form>
            ${lotOwnerEditor(association.slug, lot.id, ownersByLot.get(lot.id) ?? [], "owners")}
          </details>
        </td>`
        : "";
      return `<tr>
        <td><a href="/a/${esc(association.slug)}/admin/ledger/${esc(lot.id)}">Lot ${esc(lot.lot_number)}</a>${lot.delinquent ? ` <span class="badge late">Past due</span>` : ""}</td>
        <td>${esc(lot.house_name)}</td>
        <td>${addressLines(lot.street_address, lot.city, lot.state, lot.postal_code)}</td>
        <td>${esc(mailing)}</td>
        <td>${esc(lotTypeLabel(lot.lot_type))}</td>
        <td>${lot.owner_name ? esc(lot.owner_name) : "No owner"}</td>
        <td>${lot.owner_email ? esc(lot.owner_email) : ""}</td>
        <td>${esc(phone)}</td>
        <td>${lotBalanceCell(association.slug, lot)}</td>
        <td>${esc(lot.status)}</td>
        <td>${esc(notePreview(lot.admin_notes))}</td>
        ${editCell}
      </tr>`;
    })
    .join("");
  const addLot = canEdit
    ? `<h2>Add a lot</h2>
      <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/lots">
        ${lotDetailFields({}, "add")}
        <button type="submit">Add lot</button>
      </form>`
    : "";
  const lotTable = lotRows
    ? `<table><thead><tr><th>Lot</th><th>House name</th><th>Address</th><th>Mailing</th><th>Type</th><th>Primary owner</th><th>Email</th><th>Phone</th><th>Balance</th><th>Status</th><th>Admin notes</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>${lotRows}</tbody></table>`
    : empty(delinquentOnly ? "No past due lots." : "No lots yet.");
  return `${adminNav(association.slug, "owners", canEdit)}
    <section class="panel" id="lots">
      <h1>Owners & lots</h1>
      <p class="muted">This is the property roster. Each lot shows its house name, property address, mailing address, primary owner, phone, and balance. Open a lot for every linked phone number. Open Edit on a lot to add another owner. That person can sign in with a magic link at their own email. Admin notes stay on this page and are not shown to owners. CSV import is still the bulk way to add a roster. Set improved or unimproved here before assigning annual dues.</p>
      <p class="filters">
        <a ${delinquentOnly ? "" : `class="active"`} href="/a/${esc(association.slug)}/admin/owners#lots">All lots</a>
        <a ${delinquentOnly ? `class="active"` : ""} href="/a/${esc(association.slug)}/admin/owners?delinquent=1#lots">Past due only</a>
      </p>
      ${lotTable}
      ${addLot}
    </section>
    <section class="panel" id="logins">
      <h2>Users</h2>
      <p class="muted">Sign-in accounts only. Email, admin access, and last login. Lot details stay in Owners and lots above.</p>
      ${loginRows ? `<table><thead><tr><th>Person</th><th>Email</th><th>Access</th><th>Last login</th></tr></thead><tbody>${loginRows}</tbody></table>` : empty("No sign-in accounts.")}
    </section>`;
}

function editAccessField(owner: OwnerListRow): string {
  if (owner.is_master === 1) {
    return `<input type="hidden" name="is_admin" value="1">
          <label><input type="checkbox" value="1" checked disabled> Edit access</label>
          <p class="muted">${esc(MASTER_ADMIN_EDIT_MESSAGE)}</p>`;
  }
  return `<label><input type="checkbox" name="is_admin" value="1" ${owner.is_admin === 1 ? "checked" : ""}> Edit access</label>
          <p class="muted">Edit access can be given to a homeowner or a board member. It lets them create, edit, and delete. A board member without it can still view these pages. A homeowner without it only sees their own lots. Keep at least one person with edit access.</p>`;
}

export function ownerDetailPage(options: {
  association: Association;
  owner: OwnerListRow;
  balance: number | null;
  balanceHref?: string;
  lots: PropertyRow[];
  properties: PropertyRow[];
  canEdit?: boolean;
}): string {
  const { association, owner } = options;
  const canEdit = options.canEdit !== false;
  const base = `/a/${association.slug}/admin/owners/${owner.user_id}`;
  const lotChoices = options.properties
    .map((property) => ({ value: property.id, label: `Lot ${property.lot_number}, ${property.street_address}` }));
  const writes = canEdit
    ? `<h2>Name and phone</h2>
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
          ${editAccessField(owner)}
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
          <label>File (optional)<input type="file" name="file" accept="${DOCUMENT_FILE_ACCEPT}"></label>
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
    </section>
    <section class="panel" id="delete">
      <h2>Delete person</h2>
      ${
        owner.is_master === 1
          ? `<p class="muted">${esc(MASTER_ADMIN_DELETE_MESSAGE)}</p>`
          : `<p class="muted">This removes the login, sessions, and membership. Messages they sent are removed. Lots and their invoices stay. Keep at least one person with edit access.</p>
      ${confirmDeleteButton(`${base}/delete`, "Delete person", "Delete this person")}`
      }
    </section>`
    : "";
  return `${adminNav(association.slug, "owners", canEdit)}
    <section class="panel">
      <h1>${esc(owner.name)}</h1>
      <p>${esc(owner.email)}${owner.phone ? ` · ${esc(owner.phone)}` : ""}</p>
      <p>${esc(roleLabel(owner.role_id, owner.is_admin === 1))} · ${esc(owner.status)}${owner.is_master === 1 ? " · Master admin" : ""}</p>
      <p>Primary lot balance ${options.balance === null ? "" : options.balanceHref ? moneyLink(options.balanceHref, options.balance) : moneySpan(options.balance)}</p>
      ${writes || "</section>"}`;
}

export function importPage(
  association: Association,
  result?: { importResult: ImportResult; parseErrors: CsvIssue[] },
  canEdit = true,
): string {
  const issues = [
    ...(result?.parseErrors ?? []),
    ...(result?.importResult.errors ?? []),
  ];
  const summary = result
    ? `<div class="flash">Created ${result.importResult.createdUsers}, updated ${result.importResult.updatedUsers}, opening invoices ${result.importResult.invoices}, opening credits ${result.importResult.credits}.</div>`
    : "";
  const issueList = issues.map((issue) => `<li>Line ${issue.line}: ${esc(issue.message)}</li>`).join("");
  const upload = canEdit
    ? `<form class="fields" method="post" action="/a/${esc(association.slug)}/admin/import" enctype="multipart/form-data">
        <label>CSV file<input type="file" name="csv" accept=".csv,text/csv" required></label>
        <button type="submit">Import</button>
      </form>`
    : "";
  return `${adminNav(association.slug, "import", canEdit)}
    <section class="panel">
      <h1>Import owners from CSV</h1>
      <p>Upload a CSV (UTF-8). Required: <code>email</code>, <code>name</code>, <code>lot_number</code>, <code>street_address</code>. Optional: <code>role</code>, <code>admin</code>, <code>starting_balance</code>, <code>balance_as_of</code>, <code>phone</code>, <code>city</code>, <code>state</code>, <code>postal_code</code>, <code>zip</code>, <code>house_name</code>, <code>mailing_street</code>, <code>mailing_city</code>, <code>mailing_state</code>, <code>mailing_postal_code</code>, <code>owner2_name</code>, <code>owner2_email</code>, <code>owner2_phone</code>.</p>
      <p><code>owner2_email</code> adds a second person on that lot. They are not the primary owner. Blank owner2 cells are skipped. A row for a lot that already has a primary owner links that person as another owner and does not replace the primary.</p>
      <p><code>city</code>, <code>state</code>, and <code>postal_code</code> (or <code>zip</code>) are the physical address of the house. A blank city, state, ZIP, house name, or mailing cell keeps the value already stored. Phone is stored on the person and shown when you open the lot. Admin notes are not part of this import.</p>
      <p>A positive starting balance adds one opening invoice per lot (re-import will not double it).</p>
      <p>The admin column is edit access for a homeowner or a board member. Leave it blank to keep an existing flag. A new person with a blank admin cell does not get edit access.</p>
      <p><a href="/a/${esc(association.slug)}/admin/import/template.csv">Download template</a></p>
      ${summary}
      ${issueList ? `<ul>${issueList}</ul>` : ""}
      ${upload}
    </section>`;
}

const PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "ach_recorded", label: "ACH (recorded)" },
  { value: "other", label: "Other" },
];

export function paymentInvoiceVisible(selectedLotId: string, propertyId: string): boolean {
  return propertyId === selectedLotId;
}

export function ledgerPage(options: {
  association: Association;
  ledger: BalanceRow[];
  ownersByProperty: Map<string, string>;
  properties: PropertyRow[];
  invoices: { id: string; label: string; propertyId: string }[];
  assessments: AssessmentAdminRow[];
  duesReady: boolean;
  duesYear: number;
  canEdit?: boolean;
}): string {
  const canEdit = options.canEdit !== false;
  const rows = options.ledger
    .map((row) => {
      const href = `/a/${options.association.slug}/admin/ledger/${row.property_id}`;
      return `<tr>
        <td><a href="${esc(href)}">Lot ${esc(row.lot_number)}</a></td>
        <td>${esc(options.ownersByProperty.get(row.property_id) ?? "")}</td>
        <td>${moneyLink(href, row.charges_cents - row.late_fee_cents)}</td>
        <td>${moneyLink(href, row.late_fee_cents)}</td>
        <td>${moneyLink(href, row.payment_cents)}</td>
        <td>${moneyLink(href, row.balance_cents)}</td>
        <td>${row.delinquent ? `<span class="badge late">Past due</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  const propertyOptions = options.properties.map((property) => ({
    value: property.id,
    label: `Lot ${property.lot_number}`,
  }));
  const selectedLot = propertyOptions[0]?.value ?? "";
  const record = canEdit
    ? `<section class="split">
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
        <form class="fields" method="post" action="/a/${esc(options.association.slug)}/admin/payments" data-payment-form>
          ${selectField("Lot", "property_id", propertyOptions, selectedLot)}
          ${selectField("Invoice", "invoice_id", [
            { value: "", label: "Not tied to one invoice" },
            ...options.invoices.map((invoice) => ({
              value: invoice.id,
              label: invoice.label,
              propertyId: invoice.propertyId,
              hidden: !paymentInvoiceVisible(selectedLot, invoice.propertyId),
            })),
          ])}
          ${textField("Amount", "amount", { required: true })}
          ${selectField("Method", "method", PAYMENT_METHODS)}
          ${textField("Reference", "reference")}
          ${textField("Paid on", "paid_on", { type: "date", required: true })}
          ${areaField("Notes", "notes")}
          <button type="submit">Save payment</button>
        </form>
        <script src="/ledger-payment.js"></script>
      </article>
    </section>`
    : "";
  return `${adminNav(options.association.slug, "ledger", canEdit)}
    <section class="panel">
      <h1>Assessments and balances</h1>
      <p class="muted">Click a dollar amount to open that lot's invoices. From there you can edit an invoice or delete it. Delete stays blocked when a payment is recorded on that invoice. Delete the payment on the invoice page first.</p>
      <p><a href="/a/${esc(options.association.slug)}/admin/export.csv">Download ledger (CSV)</a></p>
      ${rows ? `<table><thead><tr><th>Lot</th><th>Primary owner</th><th>Charges</th><th>Late fees</th><th>Payments</th><th>Balance</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No lots.")}
    </section>
    ${duesSection(options, canEdit)}
    ${record}`;
}

export function ledgerLotPage(options: {
  association: Association;
  propertyId: string;
  lotNumber: string;
  streetAddress: string;
  city?: string;
  state?: string;
  postalCode?: string;
  houseName?: string;
  mailingStreet?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingPostalCode?: string;
  adminNotes?: string;
  lotType?: string;
  status?: string;
  contacts?: { name: string; phone: string; isPrimary?: boolean }[];
  lotOwners?: LotOwnerControl[];
  ownerName: string;
  balance: BalanceRow | null;
  invoices: InvoiceRow[];
  paymentCount: number;
  canEdit?: boolean;
  today?: string;
}): string {
  const canEdit = options.canEdit !== false;
  const base = `/a/${esc(options.association.slug)}/admin`;
  const today = options.today ?? "";
  const scheduledInvoice = (invoice: InvoiceRow) =>
    Boolean(today) && invoice.status !== "void" && invoice.issued_on > today;
  const rows = options.invoices
    .map((invoice) => {
      const href = `${base}/invoices/${invoice.id}`;
      const status = scheduledInvoice(invoice) ? "scheduled" : invoice.status;
      return `<tr>
        <td><a href="${esc(href)}">${esc(invoice.invoice_number)}</a></td>
        <td>${esc(invoice.description)}</td>
        <td>${dateCell(invoice.due_on, options.association.timezone)}</td>
        <td>${moneyLink(href, Number(invoice.amount_cents))}</td>
        <td>${moneyLink(href, Number(invoice.late_fee_cents))}</td>
        <td>${moneyLink(href, Number(invoice.paid_cents))}</td>
        <td><span class="badge">${esc(status)}</span></td>
      </tr>`;
    })
    .join("");
  const houseName = options.houseName?.trim() ?? "";
  const notes = options.adminNotes ?? "";
  const phones = contactPhones(options.contacts ?? (options.ownerName ? [{ name: options.ownerName, phone: "", isPrimary: true }] : []));
  const ownerEditor = canEdit ? lotOwnerEditor(options.association.slug, options.propertyId, options.lotOwners ?? [], "ledger") : "";
  const profileForm = canEdit
    ? `<form class="fields" method="post" action="/a/${esc(options.association.slug)}/admin/lots/${esc(options.propertyId)}">
        <input type="hidden" name="return_to" value="ledger">
        ${lotDetailFields(
          {
            lot_number: options.lotNumber,
            street_address: options.streetAddress,
            city: options.city ?? "",
            state: options.state ?? "",
            postal_code: options.postalCode ?? "",
            house_name: houseName,
            mailing_street: options.mailingStreet ?? "",
            mailing_city: options.mailingCity ?? "",
            mailing_state: options.mailingState ?? "",
            mailing_postal_code: options.mailingPostalCode ?? "",
            admin_notes: notes,
            lot_type: options.lotType ?? "improved",
            status: options.status ?? "active",
          },
          "edit",
        )}
        <button type="submit">Save lot</button>
      </form>`
    : `<h2>Admin notes</h2>
       <p class="muted">Only admins can see this. Owners do not see it on their pages.</p>
       ${notes ? paragraphs(notes) : `<p class="muted">No admin notes.</p>`}`;
  const balance = options.balance
    ? `<p>Balance ${moneySpan(options.balance.balance_cents)}${options.balance.delinquent ? ` <span class="badge late">Past due</span>` : ""}</p>`
    : "";
  const scheduledNote = options.invoices.some(scheduledInvoice)
    ? `<p class="muted">An invoice dated after today is scheduled. It is not included in the balance until that date.</p>`
    : "";
  const blocked = options.invoices.length > 0 || options.paymentCount > 0;
  const remove = !canEdit
    ? ""
    : blocked
      ? `<p>This lot still has invoices or payments. Clear those before deleting the lot.</p>`
      : confirmDeleteButton(
          `/a/${options.association.slug}/admin/ledger/${options.propertyId}/delete`,
          "Delete lot",
          "Delete this lot",
        );
  const deleteSection = canEdit
    ? `<section class="panel" id="delete">
      <h2>Delete lot</h2>
      <p class="muted">This removes the lot and its owner links. Invoices and payments have to be cleared first.</p>
      ${remove}
    </section>`
    : "";
  return `${adminNav(options.association.slug, "ledger", canEdit)}
    <section class="panel">
      <p><a href="${base}/ledger">Assessments and balances</a></p>
      <h1>Lot ${esc(options.lotNumber)}</h1>
      ${houseName ? `<p><strong>${esc(houseName)}</strong></p>` : ""}
      ${propertyAddressHtml(options.streetAddress, options.city ?? "", options.state ?? "", options.postalCode ?? "")}
      ${mailingAddressHtml(options.mailingStreet ?? "", options.mailingCity ?? "", options.mailingState ?? "", options.mailingPostalCode ?? "")}
      <h2>Phone numbers</h2>
      ${phones}
      ${ownerEditor}
      ${profileForm}
      ${balance}
      ${scheduledNote}
      <p class="muted">Click an amount to edit or delete that invoice. Delete stays blocked when a payment is recorded on that invoice. Delete the payment on the invoice page first.</p>
      ${
        rows
          ? `<table><thead><tr><th>Invoice</th><th>Description</th><th>Due</th><th>Amount</th><th>Late fee</th><th>Paid</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
          : empty("No invoices on this lot.")
      }
    </section>
    ${deleteSection}`;
}

export function invoiceAdminPage(options: {
  association: Association;
  invoice: InvoiceRow;
  payments: InvoicePaymentRow[];
  canEdit?: boolean;
}): string {
  const { association, invoice } = options;
  const canEdit = options.canEdit !== false;
  const base = `/a/${esc(association.slug)}/admin`;
  const paid = Number(invoice.paid_cents);
  const remaining = Number(invoice.amount_cents) + Number(invoice.late_fee_cents) - paid;
  const paymentRows = options.payments
    .map((payment) => {
      const actions = canEdit
        ? `<div class="actions"><a href="#edit-payment-${esc(payment.id)}">Edit</a>${confirmDeleteButton(`/a/${association.slug}/admin/invoices/${invoice.id}/payments/${payment.id}/delete`, "Delete payment", "Delete this payment")}</div>`
        : "";
      return `<tr>
        <td>${dateCell(payment.paid_on, association.timezone)}</td>
        <td>${esc(methodLabel(payment.method))}</td>
        <td>${esc(payment.reference)}</td>
        <td>${moneySpan(Number(payment.amount_cents))}</td>
        <td>${esc(payment.notes)}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");
  const paymentForms = canEdit
    ? options.payments.map((payment) => paymentEditForm(association.slug, invoice.id, payment, association.timezone)).join("")
    : "";
  const remove =
    options.payments.length > 0
      ? `<p class="muted">A payment is recorded on this invoice, so delete stays blocked. Delete that payment above first if it was recorded by mistake. You can still change the amount, dates, description, and status.</p>`
      : `<p class="muted">This removes the invoice from the lot.</p>
         ${confirmDeleteButton(`/a/${association.slug}/admin/invoices/${invoice.id}/delete`, "Delete invoice", "Delete this invoice")}`;
  const editForm = canEdit
    ? `<h2>Edit invoice</h2>
      <form class="fields" method="post" action="${base}/invoices/${esc(invoice.id)}">
        ${textField("Description", "description", { value: invoice.description, required: true })}
        ${textField("Amount", "amount", { value: dollarsInput(invoice.amount_cents), required: true })}
        ${textField("Late fee", "late_fee", { value: dollarsInput(invoice.late_fee_cents) })}
        ${textField("Issued", "issued_on", { type: "date", value: invoice.issued_on, required: true })}
        ${textField("Due", "due_on", { type: "date", value: invoice.due_on, required: true })}
        ${selectField("Status", "status", [
          { value: "open", label: "Open" },
          { value: "partial", label: "Partial" },
          { value: "paid", label: "Paid" },
          { value: "void", label: "Void" },
        ], invoice.status)}
        <p class="muted">Open, partial, and paid follow payments on this invoice when you save. Void leaves the invoice off the balance. A recorded payment stays on the lot.</p>
        <button type="submit">Save invoice</button>
      </form>`
    : "";
  const deleteSection = canEdit
    ? `<section class="panel">
      <h2>Delete invoice</h2>
      ${remove}
    </section>`
    : "";
  return `${adminNav(association.slug, "ledger", canEdit)}
    <section class="panel">
      <p><a href="${base}/ledger/${esc(invoice.property_id)}">Lot ${esc(invoice.lot_number)}</a></p>
      <h1>${esc(invoice.invoice_number)}</h1>
      <p><span class="badge">${esc(invoice.status)}</span></p>
      <p>Amount ${moneySpan(Number(invoice.amount_cents))} · Late fee ${moneySpan(Number(invoice.late_fee_cents))} · Paid ${moneySpan(paid)} · Remaining ${moneySpan(remaining)}</p>
      ${editForm}
    </section>
    <section class="panel">
      <h2>Payments on this invoice</h2>
      ${canEdit && options.payments.length > 0 ? `<p class="muted">Edit a payment to correct the amount, date, method, reference, or notes.</p>` : ""}
      ${
        paymentRows
          ? `<table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Amount</th><th>Notes</th><th></th></tr></thead><tbody>${paymentRows}</tbody></table>${paymentForms}`
          : empty("No payment is recorded on this invoice.")
      }
    </section>
    ${deleteSection}`;
}

function paymentEditForm(slug: string, invoiceId: string, payment: InvoicePaymentRow, timeZone: string): string {
  const action = `/a/${esc(slug)}/admin/invoices/${esc(invoiceId)}/payments/${esc(payment.id)}`;
  return `<form class="fields" id="edit-payment-${esc(payment.id)}" method="post" action="${action}">
    <h3>Edit payment from ${dateCell(payment.paid_on, timeZone)}</h3>
    ${textField("Amount", "amount", { value: dollarsInput(payment.amount_cents), required: true })}
    ${selectField("Method", "method", PAYMENT_METHODS, payment.method)}
    ${textField("Reference", "reference", { value: payment.reference })}
    ${textField("Paid on", "paid_on", { type: "date", value: payment.paid_on, required: true })}
    ${areaField("Notes", "notes", payment.notes)}
    <button type="submit">Save payment</button>
  </form>`;
}

function folderField(folder = "", documentDate = ""): string {
  return `${textField("Date", "document_date", { type: "date", value: documentDate })}
    ${textField("Year or subfolder", "folder", { value: folder })}
    <p class="muted">Optional. Leave blank to put the file directly in the category. On Meeting Minutes, Budgets, and Insurance, a date files the document in that year. A slash adds a folder inside that year, such as 2024/January.</p>`;
}

export function documentsAdminPage(association: Association, documents: DocumentRow[], canEdit = true): string {
  const rows = documents
    .map(
      (doc) => `<tr>
        <td>${categoryCell(doc.category)}</td>
        <td>${doc.document_date ? dateCell(doc.document_date, association.timezone) : ""}</td>
        <td>${esc(doc.folder ?? "")}</td>
        <td><a href="/a/${esc(association.slug)}/admin/documents/${esc(doc.id)}">${esc(doc.title)}</a></td>
        <td>${esc(visibilityLabel(doc.visibility))}</td>
        <td>${doc.version_number ? `v${doc.version_number}` : "None"}</td>
      </tr>`,
    )
    .join("");
  const publish = canEdit
    ? `<article class="panel">
        <h2>Publish a file</h2>
        <form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents" enctype="multipart/form-data">
          ${textField("Title", "title", { required: true })}
          ${selectField("Category", "category", DOCUMENT_CATEGORIES.map((item) => ({ value: item.id, label: item.label })))}
          ${folderField()}
          ${selectField("Who can see it", "visibility", [
            { value: "residents", label: "Owners and residents" },
            { value: "board", label: "Board only" },
          ])}
          ${areaField("Notes", "notes")}
          <label>File<input type="file" name="file" required></label>
          ${emailOwnersField()}
          <button type="submit">Publish</button>
        </form>
      </article>`
    : "";
  return `${adminNav(association.slug, "documents", canEdit)}
    <section class="split">
      <article class="panel">
        <h1>Documents</h1>
        <p class="muted">Residents see the version marked current. Choose board-only for budgets and other financial reports. A date on Meeting Minutes, Budgets, or Insurance files that document in the year's folder. Leave the year or subfolder blank to keep a file in the category.</p>
        ${rows ? `<table><thead><tr><th>Category</th><th>Date</th><th>Subfolder</th><th>Title</th><th>Visibility</th><th>Current</th></tr></thead><tbody>${rows}</tbody></table>` : empty("No documents yet.")}
      </article>
      ${publish}
    </section>`;
}

export function documentDetailPage(
  association: Association,
  document: {
    id: string;
    title: string;
    category: DocumentCategory;
    visibility: string;
    current_version_id: string | null;
    folder?: string | null;
    document_date?: string | null;
  },
  versions: VersionRow[],
  canEdit = true,
): string {
  const rows = versions
    .map(
      (version) => `<tr>
        <td>v${version.version_number}${version.id === document.current_version_id ? " · current" : ""}</td>
        <td>${esc(version.filename)}</td>
        <td>${esc(version.notes)}</td>
        <td>${dateTimeCell(version.created_at, association.timezone)}</td>
        <td>${documentFileLinks(`/a/${association.slug}/admin/documents/${document.id}/versions/${version.id}/file`, version.content_type)}</td>
        <td>${!canEdit || version.id === document.current_version_id ? "" : `<form method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/current"><input type="hidden" name="version_id" value="${esc(version.id)}"><button class="secondary" type="submit">Make current</button></form>`}</td>
      </tr>`,
    )
    .join("");
  const visibility = canEdit
    ? `<form class="fields" method="post" action="/a/${esc(association.slug)}/admin/documents/${esc(document.id)}/visibility">
        ${selectField("Category", "category", DOCUMENT_CATEGORIES.map((item) => ({ value: item.id, label: item.label })), document.category)}
        ${folderField(document.folder ?? "", document.document_date ?? "")}
        ${selectField("Who can see it", "visibility", [
          { value: "residents", label: "Owners and residents" },
          { value: "board", label: "Board only" },
        ], document.visibility)}
        <button class="secondary" type="submit">Save</button>
      </form>
      <p class="muted">Saving does not upload a new file.</p>`
    : "";
  const upload = canEdit
    ? `<section class="panel">
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
    </section>`
    : "";
  return `${adminNav(association.slug, "documents", canEdit)}
    <section class="panel">
      <h1>${esc(document.title)}</h1>
      <p>${categoryCell(document.category)}${document.document_date ? ` · ${dateCell(document.document_date, association.timezone)}` : ""}${document.folder?.trim() ? ` · ${esc(document.folder.trim())}` : ""} · ${esc(visibilityLabel(document.visibility))}</p>
      ${visibility}
      ${rows ? `<table><thead><tr><th>Version</th><th>File</th><th>Notes</th><th>Uploaded</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    </section>
    ${upload}`;
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
  canEdit?: boolean;
}): string {
  const { association } = options;
  const canEdit = options.canEdit !== false;
  const base = `/a/${esc(association.slug)}/admin`;
  const editing = canEdit ? options.editing ?? null : null;
  const editingId = editing ? ("row" in editing ? editing.row.id : "") : "";
  const announcements = options.announcements
    .map((item) => {
      const hidden = item.expires_at && item.expires_at <= new Date().toISOString();
      return `<tr>
        <td>${esc(item.kind)}${hidden ? ` <span class="badge">Hidden</span>` : ""}${editingId === item.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${esc(item.title)}</td>
        <td>${dateCell(item.published_at, association.timezone)}</td>
        <td>${newsItemActions(association.slug, "announcements", item.id, canEdit ? `${base}/announcements/${esc(item.id)}/hide` : "", canEdit)}</td>
      </tr>`;
    })
    .join("");
  const events = options.events
    .map(
      (event) => `<tr>
        <td>${esc(event.kind)}${editingId === event.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${esc(event.title)}</td>
        <td>${dateTimeCell(event.starts_at, association.timezone)}</td>
        <td>${newsItemActions(association.slug, "events", event.id, "", canEdit)}</td>
      </tr>`,
    )
    .join("");
  const faqs = options.faqs
    .map(
      (faq) => `<tr>
        <td>${esc(faq.question)}${editingId === faq.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${newsItemActions(association.slug, "faqs", faq.id, "", canEdit)}</td>
      </tr>`,
    )
    .join("");
  const contacts = options.contacts
    .map(
      (contact) => `<tr>
        <td>${esc(contact.name)}${editingId === contact.id ? ` <span class="badge">Editing</span>` : ""}</td>
        <td>${esc(contact.role_title)}</td>
        <td>${newsItemActions(association.slug, "contacts", contact.id, "", canEdit)}</td>
      </tr>`,
    )
    .join("");
  const addForms = canEdit
    ? `<section class="grid">
      <article class="panel"><h2>Add announcement</h2>${announcementForm(base, association, null)}</article>
      <article class="panel"><h2>Add event</h2>${eventForm(base, null)}</article>
      <article class="panel"><h2>Add FAQ</h2>${faqForm(base, null)}</article>
      <article class="panel"><h2>Add Board Contact</h2>${contactForm(base, null)}</article>
    </section>`
    : "";
  return `${adminNav(association.slug, "news", canEdit)}
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
    ${addForms}`;
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

export function joinRequestsPage(association: Association, rows: JoinRequestRow[], canEdit = true): string {
  const body = rows
    .map((row) => {
      return `<tr>
        <td>${dateTimeCell(row.created_at, association.timezone)}</td>
        <td>${esc(row.name)}<div class="muted">${esc(row.email)}</div></td>
        <td>${esc(row.address)}</td>
        <td>${esc(row.note)}</td>
        <td>${esc(joinStatusLabel(row.status))}</td>
        <td>${canEdit ? joinRequestActions(association.slug, row) : ""}</td>
      </tr>`;
    })
    .join("");
  return `${adminNav(association.slug, "joins", canEdit)}
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

export function auditPage(association: Association, rows: AuditRow[], canEdit = true): string {
  return `${adminNav(association.slug, "audit", canEdit)}<section class="panel"><h1>Activity</h1>${auditTable(association, rows)}</section>`;
}

export function adminMessagesPage(
  association: Association,
  threads: MessageRow[],
  staffIds: readonly string[],
  canEdit = true,
): string {
  const staff = new Set(staffIds);
  const listPath = `/a/${association.slug}/admin/messages`;
  const rows = threads
    .map((thread) => {
      const remove = canEdit ? confirmDeleteButton(`${listPath}/${thread.thread_id}/delete`, "Delete") : "";
      return `<tr>
        <td><a href="${esc(listPath)}/${esc(thread.thread_id)}">${esc(thread.subject)}</a></td>
        <td>${esc(thread.from_name)}</td>
        <td>${thread.lot_number ? `Lot ${esc(thread.lot_number)}` : ""}</td>
        <td>${dateTimeCell(thread.created_at, association.timezone)}</td>
        <td>${canEdit ? messageReviewCell(association.slug, thread, staff, listPath) : thread.reviewed_at ? "Reviewed" : ""}</td>
        <td>${remove}</td>
      </tr>`;
    })
    .join("");
  return `${adminNav(association.slug, "messages", canEdit)}
    <section class="panel">
      <h1>Messages</h1>
      <p class="muted">Incoming from owners. These notes are private to the board. Other owners cannot read them. Mark reviewed clears a thread from Messages waiting on the board without sending a reply.</p>
      ${rows ? `<table><thead><tr><th>Subject</th><th>Latest from</th><th>Lot</th><th>When</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>` : empty("No incoming messages.")}
    </section>`;
}

export function adminThreadPage(
  association: Association,
  subject: string,
  messages: MessageRow[],
  staffIds: readonly string[],
  canEdit = true,
): string {
  const threadId = messages[0]?.thread_id ?? "";
  const latest = messages.at(-1);
  const threadPath = `/a/${association.slug}/admin/messages/${threadId}`;
  const review = canEdit && latest ? messageReviewNote(association.slug, latest, new Set(staffIds), threadPath) : "";
  return `${adminNav(association.slug, "messages", canEdit)}${review}${threadPage(association, subject, messages, {
    incoming: true,
    next: threadPath,
    allowThreadDelete: canEdit,
    allowReply: canEdit,
    replyDelete: canEdit ? "all" : undefined,
    inbox: "admin",
  })}`;
}

function messageReviewCell(slug: string, thread: MessageRow, staff: ReadonlySet<string>, next: string): string {
  if (messageWaitingOnBoard(thread, staff)) return messageReviewForm(slug, thread.thread_id, next);
  if (thread.reviewed_at) return "Reviewed";
  return "";
}

function messageReviewNote(slug: string, latest: MessageRow, staff: ReadonlySet<string>, next: string): string {
  if (messageWaitingOnBoard(latest, staff)) {
    return `<section class="panel">${messageReviewForm(slug, latest.thread_id, next)}<p class="muted">This clears the thread from Messages waiting on the board. It does not send a reply. A new message from the owner puts it back.</p></section>`;
  }
  if (latest.reviewed_at) {
    return `<section class="panel"><p class="muted">Reviewed. A new message from the owner puts this thread back on the waiting list.</p></section>`;
  }
  return "";
}

function messageReviewForm(slug: string, threadId: string, next: string): string {
  return `<form method="post" action="/a/${esc(slug)}/admin/messages/${esc(threadId)}/reviewed"><input type="hidden" name="next" value="${esc(next)}"><button class="secondary" type="submit">Mark reviewed</button></form>`;
}

function duesSection(options: {
  association: Association;
  assessments: AssessmentAdminRow[];
  duesReady: boolean;
  duesYear: number;
}, canEdit = true): string {
  const base = `/a/${esc(options.association.slug)}/admin`;
  if (!options.duesReady) {
    return `<section class="panel" id="dues"><h2>Annual dues</h2><p>Apply the admin migration in D1, then reload. The steps are in the README under Admin improvements.</p></section>`;
  }
  const rows = options.assessments
    .map((row) => {
      const edit = `${base}/assessments/${esc(row.id)}`;
      const confirm = row.invoice_count === 0 ? "Confirm" : "Delete this assessment and its unpaid invoices";
      const actions = canEdit
        ? `<td>
          <form method="post" action="${edit}/assign"><label><input type="checkbox" name="confirm" value="yes" required> Assign this assessment to matching lots</label><button class="secondary" type="submit">Assign to matching lots</button></form>
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
            <form method="post" action="${edit}/delete"><label><input type="checkbox" name="confirm" value="yes" required> ${confirm}</label><button class="secondary" type="submit">Delete</button></form>
          </details>
        </td>`
        : "";
      return `<tr>
        <td>${esc(row.name)}</td>
        <td>${esc(lotTypeLabel(row.lot_type))}</td>
        <td>${row.opens_on ? dateCell(row.opens_on, options.association.timezone) : ""}</td>
        <td>${dateCell(row.due_on, options.association.timezone)}</td>
        <td>${moneySpan(row.amount_cents)}</td>
        <td>${row.invoice_count}</td>
        ${actions}
      </tr>`;
    })
    .join("");
  return `<section class="panel" id="dues">
    <h2>Annual dues</h2>
    <p class="muted">Set the open date, due date, and amounts for improved and unimproved lots. Add a year creates both: improved lots at $625 and unimproved lots at $100, open January 1 and due March 1.</p>
    <ul class="muted dues-help">
      <li>On the open date, each active lot of that type that does not already have this assessment gets an invoice. If a day is missed, the next run catches up. The invoice date stays the open date.</li>
      <li>Leave the open date blank if you want to invoice only by hand. Use Assign to matching lots to create those invoices early.</li>
      <li>Until the open date, the amount stays off the owner balance, so a future year does not look due today. Upcoming stays Scheduled until that open date. On and after the open date, once invoices are live, Upcoming shows Invoiced.</li>
      <li>Changing the amount later does not rewrite invoices already assigned. A voided invoice stays void.</li>
      <li>Under Assessments and balances, click a dollar amount to change one invoice. Delete removes the assessment and its unpaid invoices. Delete is blocked when a payment is recorded on one of those invoices.</li>
    </ul>
    ${rows ? `<table><thead><tr><th>Assessment</th><th>Lots</th><th>Opens</th><th>Due</th><th>Amount</th><th>Invoices</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>${rows}</tbody></table>` : empty("No assessments yet.")}
    ${canEdit ? `<h3>Add a year</h3>
    <form class="fields" method="post" action="${base}/assessments">
      ${textField("Year", "year", { value: String(options.duesYear), required: true })}
      <button type="submit">Add improved and unimproved dues</button>
    </form>` : ""}
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
  canEdit = true,
): string {
  if (!canEdit) return "";
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
