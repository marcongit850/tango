import type { Hono } from "hono";
import {
  allAnnouncements,
  countActiveOfficers,
  documentVersions,
  ledgerForAssociation,
  ledgerForUser,
  listAudit,
  listContacts,
  listDocuments,
  listEvents,
  listFaqs,
  listOwners,
  listProperties,
  notify,
  propertyInAssociation,
  refreshInvoiceStatus,
  staffUserIds,
  threadsForViewer,
  versionById,
  writeAudit,
} from "../db";
import { isDocumentCategory } from "../lib/categories";
import { parseOwnersCsv } from "../lib/csv";
import { formatAddress, isIsoDate, todayIso, zonedLocalToUtc } from "../lib/dates";
import { resendApiKey, sendResendEmail } from "../lib/email";
import { attachmentDisposition, contentTypeForUpload, MAX_CSV_BYTES, MAX_DOCUMENT_BYTES, safeFilename } from "../lib/files";
import { importOwners } from "../lib/import-owners";
import { csvText, formatDollarsPlain, formatMoney, parseMoneyToCents } from "../lib/money";
import { ensureSeedFiles } from "../lib/seed-files";
import { NotFoundError } from "../lib/errors";
import type { AppBindings, DocumentCategory, MembershipRole, MembershipStatus } from "../types";
import {
  adminHome,
  auditPage,
  documentDetailPage,
  documentsAdminPage,
  importPage,
  ledgerPage,
  lotsPage,
  newsAdminPage,
  ownerDetailPage,
  ownersPage,
} from "../views/admin";
import { render } from "../views/layout";
import { fileValue, readForm, redirectTo, requireStaff, textValue, type AppContext } from "./common";

const ROLES = new Set<MembershipRole>(["homeowner", "board", "officer"]);
const STATUSES = new Set<MembershipStatus>(["invited", "active", "inactive"]);
const METHODS = new Set(["check", "cash", "ach_recorded", "other"]);

export function registerAdminRoutes(app: Hono<AppBindings>): void {
  app.get("/a/:slug/admin", async (c) => {
    const { association } = requireStaff(c);
    const today = todayIso(association.timezone);
    const [properties, owners, ledger, threads, staffIds, audit] = await Promise.all([
      listProperties(c.env.DB, association.id),
      listOwners(c.env.DB, association.id),
      ledgerForAssociation(c.env.DB, association.id, today),
      threadsForViewer(c.env.DB, association.id, "", true),
      staffUserIds(c.env.DB, association.id),
      listAudit(c.env.DB, association.id),
    ]);
    const staff = new Set(staffIds);
    return render(c, {
      title: `Admin · ${association.name}`,
      active: "admin",
      body: adminHome({
        association,
        lots: properties.length,
        members: owners.filter((owner) => owner.status !== "inactive").length,
        delinquent: ledger.filter((row) => row.delinquent).length,
        waiting: threads.filter((thread) => !staff.has(thread.from_user_id)).length,
        audit,
      }),
    });
  });

  app.get("/a/:slug/admin/owners", async (c) => {
    const { association } = requireStaff(c);
    const delinquentOnly = c.req.query("delinquent") === "1";
    const today = todayIso(association.timezone);
    const [owners, ledger] = await Promise.all([
      listOwners(c.env.DB, association.id),
      ledgerForAssociation(c.env.DB, association.id, today),
    ]);
    const byProperty = new Map(ledger.map((row) => [row.property_id, row]));
    const decorated = owners
      .map((owner) => {
        const balance = owner.property_id ? byProperty.get(owner.property_id) : undefined;
        return { ...owner, balance_cents: balance?.balance_cents, delinquent: balance?.delinquent ?? false };
      })
      .filter((owner) => !delinquentOnly || owner.delinquent);
    return render(c, {
      title: delinquentOnly ? "Delinquent accounts" : "Owners",
      active: "admin",
      body: ownersPage(association, decorated, delinquentOnly),
    });
  });

  app.get("/a/:slug/admin/owners/:userId", async (c) => {
    const { association } = requireStaff(c);
    const owner = (await listOwners(c.env.DB, association.id)).find((row) => row.user_id === c.req.param("userId"));
    if (!owner) throw new NotFoundError();
    const today = todayIso(association.timezone);
    const [ledger, properties] = await Promise.all([
      ledgerForUser(c.env.DB, association.id, owner.user_id, today),
      listProperties(c.env.DB, association.id),
    ]);
    const primary = owner.property_id ? ledger.find((row) => row.property_id === owner.property_id) : undefined;
    return render(c, {
      title: owner.name,
      active: "admin",
      body: ownerDetailPage({
        association,
        owner,
        balance: primary ? primary.balance_cents : ledger.reduce((sum, row) => sum + row.balance_cents, 0),
        lots: [],
        properties,
      }),
    });
  });

  app.post("/a/:slug/admin/owners/:userId/role", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const role = textValue(fields, "role_id", 20);
    const status = textValue(fields, "status", 20);
    const owner = (await listOwners(c.env.DB, association.id)).find((row) => row.user_id === c.req.param("userId"));
    if (!owner) throw new NotFoundError();
    if (!ROLES.has(role as MembershipRole) || !STATUSES.has(status as MembershipStatus)) {
      return redirectTo(c, ownerPath(association.slug, owner.user_id), "Choose a valid role and status.", "warn");
    }
    const removingLastOfficer =
      user.id === owner.user_id &&
      owner.role_id === "officer" &&
      owner.status === "active" &&
      (role !== "officer" || status !== "active") &&
      (await countActiveOfficers(c.env.DB, association.id)) <= 1;
    if (removingLastOfficer) {
      return redirectTo(c, ownerPath(association.slug, owner.user_id), "Keep at least one active officer.", "warn");
    }
    await c.env.DB
      .prepare("UPDATE memberships SET role_id = ?, status = ? WHERE association_id = ? AND user_id = ?")
      .bind(role, status, association.id, owner.user_id)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "role_change",
      entityType: "membership",
      entityId: owner.user_id,
      detail: `${role} / ${status}`,
    });
    return redirectTo(c, ownerPath(association.slug, owner.user_id), "Role saved.");
  });

  app.post("/a/:slug/admin/owners/:userId/lot", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const ownerId = c.req.param("userId");
    const property = await propertyInAssociation(c.env.DB, association.id, textValue(fields, "property_id", 80));
    if (!property) return redirectTo(c, ownerPath(association.slug, ownerId), "Choose a lot in this association.", "warn");
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(property_id, user_id) DO UPDATE SET is_primary = 1`,
      )
      .bind(crypto.randomUUID(), association.id, property.id, ownerId, now)
      .run();
    await c.env.DB
      .prepare("UPDATE property_owners SET is_primary = 0 WHERE association_id = ? AND property_id = ? AND user_id != ?")
      .bind(association.id, property.id, ownerId)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "owner_assign",
      entityType: "property",
      entityId: property.id,
      detail: `Primary owner set for lot ${property.lot_number}.`,
    });
    return redirectTo(c, ownerPath(association.slug, ownerId), `Lot ${property.lot_number} is now the primary lot.`);
  });

  app.post("/a/:slug/admin/owners/:userId/notice", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const ownerId = c.req.param("userId");
    const title = textValue(fields, "title", 200);
    const body = textValue(fields, "body", 5000);
    if (!title || !body) return redirectTo(c, ownerPath(association.slug, ownerId), "Add a title and a message.", "warn");
    await notify(c.env.DB, { associationId: association.id, userId: ownerId, kind: "account", title, body, href: `/a/${association.slug}/notices` });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "account_notice",
      entityType: "user",
      entityId: ownerId,
      detail: title,
    });
    return redirectTo(c, ownerPath(association.slug, ownerId), "Notice posted to their portal.");
  });

  app.post("/a/:slug/admin/owners/:userId/remind", async (c) => {
    const { association, user } = requireStaff(c);
    await readForm(c);
    const owner = (await listOwners(c.env.DB, association.id)).find((row) => row.user_id === c.req.param("userId"));
    if (!owner) throw new NotFoundError();
    const ledger = await ledgerForUser(c.env.DB, association.id, owner.user_id, todayIso(association.timezone));
    const total = ledger.reduce((sum, row) => sum + row.balance_cents, 0);
    const lines = ledger.map((row) => `Lot ${row.lot_number}: ${formatMoney(row.balance_cents)}`);
    const body = [
      `${association.name} is writing about the balance on your lots.`,
      ...lines,
      `Total: ${formatMoney(total)}.`,
      `Mail checks to ${formatAddress(association)}.`,
      "This portal does not take card or ACH payments.",
      "This note is not legal advice.",
    ].join("\n");
    await notify(c.env.DB, {
      associationId: association.id,
      userId: owner.user_id,
      kind: "account",
      title: "Balance reminder",
      body,
      href: `/a/${association.slug}/invoices`,
    });
    const apiKey = resendApiKey(c.env);
    const sent = apiKey
      ? await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: owner.email,
          subject: `${association.name} balance reminder`,
          text: body,
        })
      : false;
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "invoice_reminder",
      entityType: "user",
      entityId: owner.user_id,
      detail: sent ? "Emailed and posted in the portal." : "Posted in the portal. Email was not sent.",
    });
    const message = sent
      ? "Reminder emailed and saved in their notices."
      : "Reminder saved in their notices. Email was not sent.";
    return redirectTo(c, ownerPath(association.slug, owner.user_id), message, sent ? "ok" : "warn");
  });

  app.get("/a/:slug/admin/lots", async (c) => {
    const { association } = requireStaff(c);
    const properties = await listProperties(c.env.DB, association.id);
    return render(c, { title: "Lots", active: "admin", body: lotsPage(association, properties) });
  });

  app.post("/a/:slug/admin/lots", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const lotNumber = textValue(fields, "lot_number", 40);
    const street = textValue(fields, "street_address", 200);
    if (!lotNumber || !street) return redirectTo(c, `/a/${association.slug}/admin/lots`, "Lot number and street address are required.", "warn");
    const existing = await c.env.DB
      .prepare("SELECT id FROM properties WHERE association_id = ? AND lot_number = ?")
      .bind(association.id, lotNumber)
      .first();
    if (existing) return redirectTo(c, `/a/${association.slug}/admin/lots`, "That lot number already exists.", "warn");
    const id = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO properties (id, association_id, lot_number, street_address, city, state, postal_code, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .bind(id, association.id, lotNumber, street, association.city, association.state, association.postal_code, new Date().toISOString())
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "lot_create",
      entityType: "property",
      entityId: id,
      detail: `Lot ${lotNumber}`,
    });
    return redirectTo(c, `/a/${association.slug}/admin/lots`, `Lot ${lotNumber} added.`);
  });

  app.post("/a/:slug/admin/lots/:propertyId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const property = await propertyInAssociation(c.env.DB, association.id, c.req.param("propertyId"));
    if (!property) throw new NotFoundError();
    const street = textValue(fields, "street_address", 200);
    const status = textValue(fields, "status", 20);
    if (!street || (status !== "active" && status !== "inactive")) {
      return redirectTo(c, `/a/${association.slug}/admin/lots`, "Check the address and status.", "warn");
    }
    await c.env.DB
      .prepare("UPDATE properties SET street_address = ?, status = ? WHERE association_id = ? AND id = ?")
      .bind(street, status, association.id, property.id)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "lot_update",
      entityType: "property",
      entityId: property.id,
      detail: `Lot ${property.lot_number}`,
    });
    return redirectTo(c, `/a/${association.slug}/admin/lots`, `Lot ${property.lot_number} updated.`);
  });

  app.get("/a/:slug/admin/import", async (c) => {
    const { association } = requireStaff(c);
    return render(c, { title: "CSV import", active: "admin", body: importPage(association) });
  });

  app.post("/a/:slug/admin/import", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const file = fileValue(fields, "csv");
    if (!file || file.size === 0) return redirectTo(c, `/a/${association.slug}/admin/import`, "Choose a CSV file.", "warn");
    if (file.size > MAX_CSV_BYTES) return redirectTo(c, `/a/${association.slug}/admin/import`, "CSV files must be 1 MB or smaller.", "warn");
    const parsed = parseOwnersCsv(await file.text(), {
      city: association.city,
      state: association.state,
      postalCode: association.postal_code,
      today: todayIso(association.timezone),
    });
    const importResult = parsed.rows.length
      ? await importOwners(c.env.DB, association, user, parsed.rows)
      : { createdUsers: 0, updatedUsers: 0, invoices: 0, credits: 0, errors: [] };
    return render(c, {
      title: "CSV import",
      active: "admin",
      body: importPage(association, { importResult, parseErrors: parsed.errors }),
    });
  });

  app.get("/a/:slug/admin/ledger", async (c) => {
    const { association } = requireStaff(c);
    const today = todayIso(association.timezone);
    const [ledger, owners, properties] = await Promise.all([
      ledgerForAssociation(c.env.DB, association.id, today),
      listOwners(c.env.DB, association.id),
      listProperties(c.env.DB, association.id),
    ]);
    const ownersByProperty = new Map<string, string>();
    for (const owner of owners) {
      if (owner.property_id) ownersByProperty.set(owner.property_id, owner.name);
    }
    const { results: invoices } = await c.env.DB
      .prepare(
        `SELECT i.id, i.invoice_number, i.description, p.lot_number
         FROM invoices i
         JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
         WHERE i.association_id = ? AND i.status IN ('open', 'partial')
         ORDER BY i.due_on`,
      )
      .bind(association.id)
      .all<{ id: string; invoice_number: string; description: string; lot_number: string }>();
    return render(c, {
      title: "Ledger",
      active: "admin",
      body: ledgerPage({
        association,
        ledger,
        ownersByProperty,
        properties,
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          label: `Lot ${invoice.lot_number} · ${invoice.invoice_number} · ${invoice.description}`,
        })),
      }),
    });
  });

  app.post("/a/:slug/admin/invoices", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const property = await propertyInAssociation(c.env.DB, association.id, textValue(fields, "property_id", 80));
    const description = textValue(fields, "description", 200);
    const amount = parseMoneyToCents(textValue(fields, "amount", 40));
    const lateFee = parseMoneyToCents(textValue(fields, "late_fee", 40) || "0");
    const issuedOn = textValue(fields, "issued_on", 20);
    const dueOn = textValue(fields, "due_on", 20);
    if (!property || !description || amount === null || amount < 0 || lateFee === null || lateFee < 0 || !isIsoDate(issuedOn) || !isIsoDate(dueOn)) {
      return redirectTo(c, `/a/${association.slug}/admin/ledger`, "Check the lot, amounts, and dates.", "warn");
    }
    const id = crypto.randomUUID();
    const invoiceNumber = `INV-${property.lot_number}-${id.slice(0, 8)}`.slice(0, 40);
    await c.env.DB
      .prepare(
        `INSERT INTO invoices (
           id, association_id, property_id, invoice_number, description, amount_cents, late_fee_cents,
           issued_on, due_on, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(id, association.id, property.id, invoiceNumber, description, amount, lateFee, issuedOn, dueOn, new Date().toISOString())
      .run();
    await refreshInvoiceStatus(c.env.DB, association.id, id);
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "invoice_create",
      entityType: "invoice",
      entityId: id,
      detail: `${invoiceNumber} for lot ${property.lot_number}`,
    });
    return redirectTo(c, `/a/${association.slug}/admin/ledger`, `Invoice ${invoiceNumber} recorded.`);
  });

  app.post("/a/:slug/admin/payments", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const property = await propertyInAssociation(c.env.DB, association.id, textValue(fields, "property_id", 80));
    const amount = parseMoneyToCents(textValue(fields, "amount", 40));
    const method = textValue(fields, "method", 20);
    const reference = textValue(fields, "reference", 80);
    const paidOn = textValue(fields, "paid_on", 20);
    const notes = textValue(fields, "notes", 1000);
    const invoiceId = textValue(fields, "invoice_id", 80);
    if (!property || amount === null || amount <= 0 || !METHODS.has(method) || !isIsoDate(paidOn)) {
      return redirectTo(c, `/a/${association.slug}/admin/ledger`, "Check the lot, amount, method, and date.", "warn");
    }
    if (invoiceId) {
      const invoice = await c.env.DB
        .prepare("SELECT id FROM invoices WHERE association_id = ? AND property_id = ? AND id = ?")
        .bind(association.id, property.id, invoiceId)
        .first();
      if (!invoice) return redirectTo(c, `/a/${association.slug}/admin/ledger`, "That invoice is not on this lot.", "warn");
    }
    const id = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO payments (
           id, association_id, property_id, invoice_id, amount_cents, method, reference, paid_on, notes, recorded_by_user_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, property.id, invoiceId || null, amount, method, reference, paidOn, notes, user.id, new Date().toISOString())
      .run();
    if (invoiceId) await refreshInvoiceStatus(c.env.DB, association.id, invoiceId);
    const { results: owners } = await c.env.DB
      .prepare("SELECT user_id FROM property_owners WHERE association_id = ? AND property_id = ?")
      .bind(association.id, property.id)
      .all<{ user_id: string }>();
    for (const owner of owners) {
      await notify(c.env.DB, {
        associationId: association.id,
        userId: owner.user_id,
        kind: "account",
        title: "Payment recorded",
        body: `${formatMoney(amount)} recorded for lot ${property.lot_number}.`,
        href: `/a/${association.slug}/payments/${id}`,
      });
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "payment_record",
      entityType: "payment",
      entityId: id,
      detail: `Lot ${property.lot_number}`,
    });
    return redirectTo(c, `/a/${association.slug}/admin/ledger`, "Payment recorded.");
  });

  app.get("/a/:slug/admin/export.csv", async (c) => {
    const { association } = requireStaff(c);
    const today = todayIso(association.timezone);
    const [ledger, owners] = await Promise.all([
      ledgerForAssociation(c.env.DB, association.id, today),
      listOwners(c.env.DB, association.id),
    ]);
    const ownerByProperty = new Map<string, { name: string; email: string }>();
    for (const owner of owners) {
      if (owner.property_id) ownerByProperty.set(owner.property_id, { name: owner.name, email: owner.email });
    }
    const lines = [
      ["lot_number", "street_address", "owner_name", "owner_email", "charges", "late_fees", "payments", "balance", "delinquent"].join(","),
    ];
    for (const row of ledger) {
      const owner = ownerByProperty.get(row.property_id);
      lines.push(
        [
          csvText(row.lot_number),
          csvText(row.street_address),
          csvText(owner?.name ?? ""),
          csvText(owner?.email ?? ""),
          formatDollarsPlain(row.charges_cents - row.late_fee_cents),
          formatDollarsPlain(row.late_fee_cents),
          formatDollarsPlain(row.payment_cents),
          formatDollarsPlain(row.balance_cents),
          row.delinquent ? "yes" : "no",
        ].join(","),
      );
    }
    return new Response(`${lines.join("\n")}\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${association.slug}-ledger.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  });

  app.get("/a/:slug/admin/documents", async (c) => {
    const { association } = requireStaff(c);
    await ensureSeedFiles(c.env.DOCUMENTS, c.env.DB);
    const documents = await listDocuments(c.env.DB, association.id, true);
    return render(c, { title: "Documents", active: "admin", body: documentsAdminPage(association, documents) });
  });

  app.post("/a/:slug/admin/documents", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const title = textValue(fields, "title", 200);
    const category = textValue(fields, "category", 40);
    const visibility = textValue(fields, "visibility", 20);
    const notes = textValue(fields, "notes", 1000);
    const file = fileValue(fields, "file");
    if (!title || !isDocumentCategory(category) || (visibility !== "residents" && visibility !== "board") || !file) {
      return redirectTo(c, `/a/${association.slug}/admin/documents`, "Title, category, visibility, and a file are required.", "warn");
    }
    const stored = await storeVersion(c, { associationId: association.id, documentId: crypto.randomUUID(), versionNumber: 1, file, notes, userId: user.id, title, category, visibility, create: true });
    if (stored.error) return redirectTo(c, `/a/${association.slug}/admin/documents`, stored.error, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_publish",
      entityType: "document",
      entityId: stored.documentId,
      detail: title,
    });
    return redirectTo(c, `/a/${association.slug}/admin/documents/${stored.documentId}`, "Document published.");
  });

  app.get("/a/:slug/admin/documents/:documentId", async (c) => {
    const { association } = requireStaff(c);
    await ensureSeedFiles(c.env.DOCUMENTS, c.env.DB);
    const document = await loadDocument(c, association.id, c.req.param("documentId"));
    const versions = await documentVersions(c.env.DB, association.id, document.id);
    return render(c, { title: document.title, active: "admin", body: documentDetailPage(association, document, versions) });
  });

  app.post("/a/:slug/admin/documents/:documentId/versions", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const document = await loadDocument(c, association.id, c.req.param("documentId"));
    const file = fileValue(fields, "file");
    const notes = textValue(fields, "notes", 1000);
    if (!file) return redirectTo(c, documentPath(association.slug, document.id), "Choose a file.", "warn");
    const max = await c.env.DB
      .prepare("SELECT COALESCE(MAX(version_number), 0) AS n FROM document_versions WHERE association_id = ? AND document_id = ?")
      .bind(association.id, document.id)
      .first<{ n: number }>();
    const stored = await storeVersion(c, {
      associationId: association.id,
      documentId: document.id,
      versionNumber: Number(max?.n ?? 0) + 1,
      file,
      notes,
      userId: user.id,
      title: document.title,
      category: document.category,
      visibility: document.visibility,
      create: false,
    });
    if (stored.error) return redirectTo(c, documentPath(association.slug, document.id), stored.error, "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_publish",
      entityType: "document",
      entityId: document.id,
      detail: `Version ${Number(max?.n ?? 0) + 1}`,
    });
    return redirectTo(c, documentPath(association.slug, document.id), "New version is now current.");
  });

  app.post("/a/:slug/admin/documents/:documentId/current", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const document = await loadDocument(c, association.id, c.req.param("documentId"));
    const version = await versionById(c.env.DB, association.id, textValue(fields, "version_id", 80));
    if (!version || version.document_id !== document.id) throw new NotFoundError();
    await c.env.DB
      .prepare("UPDATE documents SET current_version_id = ? WHERE association_id = ? AND id = ?")
      .bind(version.id, association.id, document.id)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_current",
      entityType: "document",
      entityId: document.id,
      detail: `Current version set to v${version.version_number}.`,
    });
    return redirectTo(c, documentPath(association.slug, document.id), `Residents now see version ${version.version_number}.`);
  });

  app.get("/a/:slug/admin/documents/:documentId/versions/:versionId/file", async (c) => {
    const { association } = requireStaff(c);
    const document = await loadDocument(c, association.id, c.req.param("documentId"));
    const version = await versionById(c.env.DB, association.id, c.req.param("versionId"));
    if (!version || version.document_id !== document.id) throw new NotFoundError();
    await ensureSeedFiles(c.env.DOCUMENTS, c.env.DB);
    const object = await c.env.DOCUMENTS.get(version.r2_key);
    if (!object) throw new NotFoundError();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", version.content_type);
    headers.set("Content-Disposition", attachmentDisposition(version.filename));
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  });

  app.get("/a/:slug/admin/news", async (c) => {
    const { association } = requireStaff(c);
    const [announcements, events, faqs, contacts] = await Promise.all([
      allAnnouncements(c.env.DB, association.id),
      listEvents(c.env.DB, association.id),
      listFaqs(c.env.DB, association.id),
      listContacts(c.env.DB, association.id),
    ]);
    return render(c, {
      title: "News",
      active: "admin",
      body: newsAdminPage({ association, announcements, events, faqs, contacts }),
    });
  });

  app.post("/a/:slug/admin/announcements", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const kind = textValue(fields, "kind", 20);
    const title = textValue(fields, "title", 200);
    const body = textValue(fields, "body", 8000);
    const pinned = fields.pinned === "1" ? 1 : 0;
    const expiresOn = textValue(fields, "expires_on", 20);
    if ((kind !== "news" && kind !== "meeting" && kind !== "emergency") || !title || !body) {
      return redirectTo(c, `/a/${association.slug}/admin/news`, "Add a title and body.", "warn");
    }
    let expiresAt: string | null = null;
    if (expiresOn) {
      expiresAt = zonedLocalToUtc(`${expiresOn}T23:59`, association.timezone);
      if (!expiresAt) return redirectTo(c, `/a/${association.slug}/admin/news`, "Expiration date is not valid.", "warn");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO announcements (id, association_id, kind, title, body, pinned, published_at, expires_at, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, kind, title, body, pinned, now, expiresAt, user.id, now)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "announcement_create",
      entityType: "announcement",
      entityId: id,
      detail: title,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Announcement posted.");
  });

  app.post("/a/:slug/admin/announcements/:announcementId/hide", async (c) => {
    const { association, user } = requireStaff(c);
    await readForm(c);
    const id = c.req.param("announcementId");
    const now = new Date().toISOString();
    const result = await c.env.DB
      .prepare("UPDATE announcements SET expires_at = ? WHERE association_id = ? AND id = ?")
      .bind(now, association.id, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "announcement_hide",
      entityType: "announcement",
      entityId: id,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Announcement hidden.");
  });

  app.post("/a/:slug/admin/events", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const kind = textValue(fields, "kind", 20);
    const title = textValue(fields, "title", 200);
    const description = textValue(fields, "description", 4000);
    const location = textValue(fields, "location", 200);
    const startsAt = zonedLocalToUtc(textValue(fields, "starts_at", 40), association.timezone);
    const endsRaw = textValue(fields, "ends_at", 40);
    const endsAt = endsRaw ? zonedLocalToUtc(endsRaw, association.timezone) : null;
    if ((kind !== "event" && kind !== "meeting" && kind !== "emergency") || !title || !startsAt || (endsRaw && !endsAt)) {
      return redirectTo(c, `/a/${association.slug}/admin/news`, "Check the event title and times.", "warn");
    }
    const id = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO events (id, association_id, title, description, location, starts_at, ends_at, kind, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, title, description, location, startsAt, endsAt, kind, user.id, new Date().toISOString())
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "event_create",
      entityType: "event",
      entityId: id,
      detail: title,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Event added.");
  });

  app.post("/a/:slug/admin/faqs", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const question = textValue(fields, "question", 300);
    const answer = textValue(fields, "answer", 5000);
    if (!question || !answer) return redirectTo(c, `/a/${association.slug}/admin/news`, "Add a question and an answer.", "warn");
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM faqs WHERE association_id = ?").bind(association.id).first<{ n: number }>();
    const id = crypto.randomUUID();
    await c.env.DB
      .prepare("INSERT INTO faqs (id, association_id, question, answer, sort_order) VALUES (?, ?, ?, ?, ?)")
      .bind(id, association.id, question, answer, Number(count?.n ?? 0) + 1)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "faq_create",
      entityType: "faq",
      entityId: id,
      detail: question,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "FAQ added.");
  });

  app.post("/a/:slug/admin/contacts", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const name = textValue(fields, "name", 120);
    const roleTitle = textValue(fields, "role_title", 120);
    const email = textValue(fields, "email", 200);
    const phone = textValue(fields, "phone", 40);
    if (!name || !roleTitle) return redirectTo(c, `/a/${association.slug}/admin/news`, "Name and role are required.", "warn");
    const count = await c.env.DB
      .prepare("SELECT COUNT(*) AS n FROM board_contacts WHERE association_id = ?")
      .bind(association.id)
      .first<{ n: number }>();
    const id = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO board_contacts (id, association_id, name, role_title, email, phone, sort_order, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(id, association.id, name, roleTitle, email, phone, Number(count?.n ?? 0) + 1)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "contact_create",
      entityType: "board_contact",
      entityId: id,
      detail: name,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Contact added.");
  });

  app.get("/a/:slug/admin/audit", async (c) => {
    const { association } = requireStaff(c);
    const rows = await listAudit(c.env.DB, association.id);
    return render(c, { title: "Audit log", active: "admin", body: auditPage(association, rows) });
  });
}

function ownerPath(slug: string, userId: string): string {
  return `/a/${slug}/admin/owners/${userId}`;
}

function documentPath(slug: string, documentId: string): string {
  return `/a/${slug}/admin/documents/${documentId}`;
}

async function loadDocument(c: AppContext, associationId: string, documentId: string) {
  const document = await c.env.DB
    .prepare("SELECT id, title, category, visibility, current_version_id FROM documents WHERE association_id = ? AND id = ?")
    .bind(associationId, documentId)
    .first<{ id: string; title: string; category: DocumentCategory; visibility: "residents" | "board"; current_version_id: string | null }>();
  if (!document) throw new NotFoundError();
  return document;
}

async function storeVersion(
  c: AppContext,
  input: {
    associationId: string;
    documentId: string;
    versionNumber: number;
    file: File;
    notes: string;
    userId: string;
    title: string;
    category: DocumentCategory;
    visibility: "residents" | "board";
    create: boolean;
  },
): Promise<{ documentId: string; error?: string }> {
  const contentType = contentTypeForUpload(input.file);
  if (!contentType) return { documentId: input.documentId, error: "Upload a PDF, text file, image, or Word document." };
  if (input.file.size > MAX_DOCUMENT_BYTES) return { documentId: input.documentId, error: "Files must be 8 MB or smaller." };
  const versionId = crypto.randomUUID();
  const key = `${input.associationId}/${input.documentId}/v${input.versionNumber}-${safeFilename(input.file.name)}`;
  await c.env.DOCUMENTS.put(key, await input.file.arrayBuffer(), { httpMetadata: { contentType } });
  const now = new Date().toISOString();
  if (input.create) {
    await c.env.DB
      .prepare(
        `INSERT INTO documents (id, association_id, category, title, visibility, current_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.documentId, input.associationId, input.category, input.title, input.visibility, versionId, now)
      .run();
  }
  await c.env.DB
    .prepare(
      `INSERT INTO document_versions (
         id, association_id, document_id, version_number, r2_key, filename, content_type, byte_size, notes, uploaded_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      versionId,
      input.associationId,
      input.documentId,
      input.versionNumber,
      key,
      safeFilename(input.file.name),
      contentType,
      input.file.size,
      input.notes,
      input.userId,
      now,
    )
    .run();
  if (!input.create) {
    await c.env.DB
      .prepare("UPDATE documents SET current_version_id = ? WHERE association_id = ? AND id = ?")
      .bind(versionId, input.associationId, input.documentId)
      .run();
  }
  return { documentId: input.documentId };
}
