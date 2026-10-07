import type { Hono } from "hono";
import {
  activeLoginEmails,
  allAnnouncements,
  assignAssessmentInvoices,
  countActiveAdmins,
  countPendingJoinRequests,
  declineJoinRequest,
  deleteAssessment,
  deleteJoinRequest,
  documentVersions,
  duesColumnsReady,
  ledgerForAssociation,
  ledgerForUser,
  listAssessments,
  listAudit,
  listContacts,
  listDocuments,
  listEvents,
  listFaqs,
  listJoinRequests,
  listLots,
  listOwners,
  listProperties,
  markThreadReviewed,
  messageWaitingOnBoard,
  notify,
  propertyInAssociation,
  refreshInvoiceStatus,
  reviewJoinRequest,
  staffUserIds,
  threadMessages,
  threadsForViewer,
  versionById,
  writeAudit,
} from "../db";
import { keepsAnAdmin } from "../lib/access";
import { changeLoginEmail } from "../lib/login-email";
import { isDocumentCategory } from "../lib/categories";
import { annualDues, defaultDuesYear, isLotType } from "../lib/dues";
import { parseOwnersCsv } from "../lib/csv";
import { formatAddress, formatDateTime, isIsoDate, todayIso, utcToDatetimeLocal, zonedLocalToUtc } from "../lib/dates";
import {
  deliverOwnerEmails,
  resendAttachment,
  loginAudienceForVisibility,
  ownerEmailFlash,
  ownerNoticeEmail,
  resendApiKey,
  sendResendEmail,
  uniqueLoginEmails,
  type LoginAudience,
  type OwnerNoticeKind,
  type ResendAttachment,
} from "../lib/email";
import { approvalSummary, approveJoinRequest, welcomeEmail } from "../lib/join-approve";
import { applyDocumentResponseHeaders, contentTypeForUpload, MAX_CSV_BYTES, MAX_DOCUMENT_BYTES, noticeFileProblem, safeFilename } from "../lib/files";
import { importOwners } from "../lib/import-owners";
import { csvText, formatDollarsPlain, formatMoney, parseMoneyToCents } from "../lib/money";
import { ensureSeedFiles } from "../lib/seed-files";
import { isCheckConstraint, isMissingColumn, isMissingTable, NotFoundError } from "../lib/errors";
import { logError, logInfo } from "../lib/log";
import type { AppBindings, Association, DocumentCategory, MembershipRole, MembershipStatus } from "../types";
import {
  adminHome,
  adminMessagesPage,
  adminThreadPage,
  auditPage,
  documentDetailPage,
  documentsAdminPage,
  importPage,
  joinRequestsPage,
  ledgerPage,
  newsAdminPage,
  ownerDetailPage,
  ownersPage,
  type NewsEdit,
} from "../views/admin";
import { render } from "../views/layout";
import { fileValue, readForm, redirectTo, requireStaff, textValue, type AppContext } from "./common";

const ROLES = new Set<MembershipRole>(["homeowner", "board"]);
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
    let pendingJoins: number | null = null;
    try {
      pendingJoins = await countPendingJoinRequests(c.env.DB, association.id);
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
    return render(c, {
      title: `Admin · ${association.name}`,
      active: "admin",
      body: adminHome({
        association,
        lots: properties.length,
        members: owners.filter((owner) => owner.status !== "inactive").length,
        delinquent: ledger.filter((row) => row.delinquent).length,
        waiting: threads.filter((thread) => messageWaitingOnBoard(thread, staff)).length,
        pendingJoins,
        audit,
      }),
    });
  });

  app.get("/a/:slug/admin/owners", async (c) => {
    const { association } = requireStaff(c);
    const delinquentOnly = c.req.query("delinquent") === "1";
    const today = todayIso(association.timezone);
    const [owners, ledger, lots] = await Promise.all([
      listOwners(c.env.DB, association.id),
      ledgerForAssociation(c.env.DB, association.id, today),
      listLots(c.env.DB, association.id),
    ]);
    const byProperty = new Map(ledger.map((row) => [row.property_id, row]));
    const decorated = owners
      .map((owner) => {
        const balance = owner.property_id ? byProperty.get(owner.property_id) : undefined;
        return { ...owner, balance_cents: balance?.balance_cents, delinquent: balance?.delinquent ?? false };
      })
      .filter((owner) => !delinquentOnly || owner.delinquent);
    return render(c, {
      title: delinquentOnly ? "Delinquent accounts" : "Owners & lots",
      active: "admin",
      body: ownersPage(association, lots, decorated, delinquentOnly),
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
    const nextAdmin = role === "board" && fields.is_admin === "1";
    const currentlyAdmin = owner.role_id === "board" && owner.is_admin === 1 && owner.status === "active";
    if (!keepsAnAdmin({ activeAdminCount: await countActiveAdmins(c.env.DB, association.id), currentlyAdmin, nextAdmin: nextAdmin && status === "active" })) {
      return redirectTo(c, ownerPath(association.slug, owner.user_id), "Keep at least one person with admin access.", "warn");
    }
    try {
      await c.env.DB
        .prepare("UPDATE memberships SET role_id = ?, status = ?, is_admin = ? WHERE association_id = ? AND user_id = ?")
        .bind(role, status, nextAdmin ? 1 : 0, association.id, owner.user_id)
        .run();
    } catch (error) {
      if (isMissingColumn(error)) {
        return redirectTo(c, ownerPath(association.slug, owner.user_id), "Apply the admin migration in D1, then try again. The steps are in the README under Admin improvements.", "warn");
      }
      throw error;
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "role_change",
      entityType: "membership",
      entityId: owner.user_id,
      detail: `${role}${nextAdmin ? " admin" : ""} / ${status}`,
    });
    return redirectTo(c, ownerPath(association.slug, owner.user_id), "Role saved.");
  });

  app.post("/a/:slug/admin/owners/:userId/email", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const owner = (await listOwners(c.env.DB, association.id)).find((row) => row.user_id === c.req.param("userId"));
    if (!owner) throw new NotFoundError();
    const back = ownerPath(association.slug, owner.user_id);
    const result = await changeLoginEmail(c.env.DB, owner.user_id, textValue(fields, "email", 200));
    if (!result.ok) {
      const message =
        result.reason === "taken"
          ? "That email is already used by another person."
          : result.reason === "missing"
            ? "That person was not found."
            : "Enter a valid email.";
      return redirectTo(c, back, message, "warn");
    }
    if (result.changed) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "email_change",
        entityType: "user",
        entityId: owner.user_id,
        detail: `${owner.email} to ${result.email}`,
      });
    }
    return redirectTo(c, back, "Login email saved.");
  });

  app.post("/a/:slug/admin/owners/:userId/profile", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const owner = (await listOwners(c.env.DB, association.id)).find((row) => row.user_id === c.req.param("userId"));
    if (!owner) throw new NotFoundError();
    const back = ownerPath(association.slug, owner.user_id);
    const name = textValue(fields, "name", 120);
    const phone = textValue(fields, "phone", 40);
    if (!name) return redirectTo(c, back, "Enter a name.", "warn");
    if (name === owner.name && phone === owner.phone) return redirectTo(c, back, "Name and phone saved.");
    const updated = await c.env.DB
      .prepare("UPDATE users SET name = ?, phone = ? WHERE id = ?")
      .bind(name, phone, owner.user_id)
      .run();
    if ((updated.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "profile_change",
      entityType: "user",
      entityId: owner.user_id,
      detail: `${owner.name} to ${name}, ${owner.phone} to ${phone}`,
    });
    return redirectTo(c, back, "Name and phone saved.");
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
    const back = ownerPath(association.slug, ownerId);
    const title = textValue(fields, "title", 200);
    const body = textValue(fields, "body", 5000);
    if (!title || !body) return redirectTo(c, back, "Add a title and a message.", "warn");
    const upload = noticeUpload(fields);
    if (upload) {
      const problem = noticeFileProblem(upload);
      if (problem) return redirectTo(c, back, problem, "warn");
    }
    const emailOwner = fields.email_owner === "1";
    const noticeId = crypto.randomUUID();
    const filename = upload ? safeFilename(upload.name) : "";
    const contentType = upload ? contentTypeForUpload(upload) : null;
    const bytes = upload ? new Uint8Array(await upload.arrayBuffer()) : null;
    const r2Key = upload && filename ? `${association.id}/notices/${noticeId}/${filename}` : "";
    if (upload && bytes && contentType && r2Key) {
      await c.env.DOCUMENTS.put(r2Key, bytes, { httpMetadata: { contentType } });
    }
    try {
      await notify(c.env.DB, {
        id: noticeId,
        associationId: association.id,
        userId: ownerId,
        kind: "account",
        title,
        body,
        href: `/a/${association.slug}/notices`,
        attachment:
          upload && bytes && contentType && r2Key
            ? { filename, contentType, r2Key, byteSize: bytes.byteLength }
            : undefined,
      });
    } catch (error) {
      if (r2Key) {
        try {
          await c.env.DOCUMENTS.delete(r2Key);
        } catch (deleteError) {
          logError("notice_r2_delete", { message: deleteError instanceof Error ? deleteError.message : "unknown" });
        }
      }
      if (isMissingColumn(error)) {
        return redirectTo(
          c,
          back,
          "Apply the notice file migration in D1, then try again. The steps are in the README under Portal notice files.",
          "warn",
        );
      }
      throw error;
    }
    const mailed = await maybeEmailOneOwner(c, {
      requested: emailOwner,
      association,
      ownerId,
      title,
      summary: body,
      saved: "Notice posted to their portal.",
      attachment: emailOwner && bytes && contentType && filename ? resendAttachment(filename, contentType, bytes) : null,
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "account_notice",
      entityType: "user",
      entityId: ownerId,
      detail: withEmailNote(filename ? `${title} (${filename})` : title, mailed.detailNote),
    });
    return redirectTo(c, back, mailed.message, mailed.tone);
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

  app.get("/a/:slug/admin/lots", (c) => {
    const { association } = requireStaff(c);
    return redirectTo(c, `/a/${association.slug}/admin/owners#lots`);
  });

  app.post("/a/:slug/admin/lots", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/admin/owners#lots`;
    const lotNumber = textValue(fields, "lot_number", 40);
    const street = textValue(fields, "street_address", 200);
    const lotType = textValue(fields, "lot_type", 20) || "improved";
    if (!lotNumber || !street || !isLotType(lotType)) return redirectTo(c, back, "Lot number, street address, and type are required.", "warn");
    const existing = await c.env.DB
      .prepare("SELECT id FROM properties WHERE association_id = ? AND lot_number = ?")
      .bind(association.id, lotNumber)
      .first();
    if (existing) return redirectTo(c, back, "That lot number already exists.", "warn");
    const id = crypto.randomUUID();
    try {
      await c.env.DB
        .prepare(
          `INSERT INTO properties (id, association_id, lot_number, street_address, city, state, postal_code, status, lot_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, association.id, lotNumber, street, association.city, association.state, association.postal_code, lotType, new Date().toISOString())
        .run();
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      await c.env.DB
        .prepare(
          `INSERT INTO properties (id, association_id, lot_number, street_address, city, state, postal_code, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .bind(id, association.id, lotNumber, street, association.city, association.state, association.postal_code, new Date().toISOString())
        .run();
      return redirectTo(c, back, `Lot ${lotNumber} added. Apply the admin migration in D1 before setting lot type.`, "warn");
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "lot_create",
      entityType: "property",
      entityId: id,
      detail: `Lot ${lotNumber} (${lotType})`,
    });
    return redirectTo(c, back, `Lot ${lotNumber} added.`);
  });

  app.post("/a/:slug/admin/lots/:propertyId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/admin/owners#lots`;
    const property = await propertyInAssociation(c.env.DB, association.id, c.req.param("propertyId"));
    if (!property) throw new NotFoundError();
    const lotNumber = textValue(fields, "lot_number", 40);
    const street = textValue(fields, "street_address", 200);
    const status = textValue(fields, "status", 20);
    const lotType = textValue(fields, "lot_type", 20);
    if (!lotNumber || !street || (status !== "active" && status !== "inactive") || !isLotType(lotType)) {
      return redirectTo(c, back, "Check the lot number, address, type, and status.", "warn");
    }
    const duplicate = await c.env.DB
      .prepare("SELECT id FROM properties WHERE association_id = ? AND lot_number = ? AND id != ?")
      .bind(association.id, lotNumber, property.id)
      .first();
    if (duplicate) return redirectTo(c, back, "That lot number already exists.", "warn");
    try {
      await c.env.DB
        .prepare("UPDATE properties SET lot_number = ?, street_address = ?, status = ?, lot_type = ? WHERE association_id = ? AND id = ?")
        .bind(lotNumber, street, status, lotType, association.id, property.id)
        .run();
    } catch (error) {
      if (!isMissingColumn(error)) throw error;
      return redirectTo(c, back, "Apply the admin migration in D1, then try again. The steps are in the README under Admin improvements.", "warn");
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "lot_update",
      entityType: "property",
      entityId: property.id,
      detail: `Lot ${lotNumber} (${lotType})`,
    });
    return redirectTo(c, back, `Lot ${lotNumber} updated.`);
  });

  app.post("/a/:slug/admin/lots/:propertyId/owner", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/admin/owners#lots`;
    const property = await propertyInAssociation(c.env.DB, association.id, c.req.param("propertyId"));
    if (!property) throw new NotFoundError();
    const ownerId = textValue(fields, "user_id", 80);
    const owner = (await listOwners(c.env.DB, association.id)).find((row) => row.user_id === ownerId);
    if (!owner) return redirectTo(c, back, "Choose a person in this association.", "warn");
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO property_owners (id, association_id, property_id, user_id, is_primary, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(property_id, user_id) DO UPDATE SET is_primary = 1`,
      )
      .bind(crypto.randomUUID(), association.id, property.id, owner.user_id, now)
      .run();
    await c.env.DB
      .prepare("UPDATE property_owners SET is_primary = 0 WHERE association_id = ? AND property_id = ? AND user_id != ?")
      .bind(association.id, property.id, owner.user_id)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "owner_assign",
      entityType: "property",
      entityId: property.id,
      detail: `${owner.name} is the primary owner of lot ${property.lot_number}.`,
    });
    return redirectTo(c, back, `${owner.name} is now the primary owner of lot ${property.lot_number}.`);
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
        `SELECT i.id, i.property_id, i.invoice_number, i.description, p.lot_number
         FROM invoices i
         JOIN properties p ON p.id = i.property_id AND p.association_id = i.association_id
         WHERE i.association_id = ? AND i.status IN ('open', 'partial')
         ORDER BY i.due_on`,
      )
      .bind(association.id)
      .all<{ id: string; property_id: string; invoice_number: string; description: string; lot_number: string }>();
    const duesReady = await duesColumnsReady(c.env.DB);
    const assessments = duesReady ? await listAssessments(c.env.DB, association.id) : [];
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
          propertyId: invoice.property_id,
          label: `Lot ${invoice.lot_number} · ${invoice.invoice_number} · ${invoice.description}`,
        })),
        assessments,
        duesReady,
        duesYear: defaultDuesYear(today),
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

  app.post("/a/:slug/admin/assessments", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/admin/ledger#dues`;
    const year = Number(textValue(fields, "year", 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return redirectTo(c, back, "Enter a year between 2000 and 2100.", "warn");
    if (!(await duesColumnsReady(c.env.DB))) {
      return redirectTo(c, back, "Apply the admin migration in D1, then try again. The steps are in the README under Admin improvements.", "warn");
    }
    const created: string[] = [];
    const existing: string[] = [];
    for (const lotType of ["improved", "unimproved"] as const) {
      const dues = annualDues(year, lotType);
      const found = await c.env.DB
        .prepare("SELECT id FROM assessments WHERE association_id = ? AND due_on = ? AND lot_type = ?")
        .bind(association.id, dues.dueOn, dues.lotType)
        .first<{ id: string }>();
      if (found) {
        existing.push(dues.name);
        continue;
      }
      const id = crypto.randomUUID();
      await c.env.DB
        .prepare(
          `INSERT INTO assessments (id, association_id, name, description, amount_cents, due_on, opens_on, lot_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, association.id, dues.name, dues.description, dues.amountCents, dues.dueOn, dues.opensOn, dues.lotType, new Date().toISOString())
        .run();
      created.push(dues.name);
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "assessment_create",
        entityType: "assessment",
        entityId: id,
        detail: dues.name,
      });
    }
    const message = [
      created.length ? `Added ${created.join(" and ")}.` : "",
      existing.length ? `Already had ${existing.join(" and ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return redirectTo(c, back, message || "Nothing to add.");
  });

  app.post("/a/:slug/admin/assessments/:assessmentId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/admin/ledger#dues`;
    const id = c.req.param("assessmentId");
    const name = textValue(fields, "name", 200);
    const amount = parseMoneyToCents(textValue(fields, "amount", 40));
    const opensOn = textValue(fields, "opens_on", 20);
    const dueOn = textValue(fields, "due_on", 20);
    const lotTypeRaw = textValue(fields, "lot_type", 20);
    const lotType = lotTypeRaw === "" ? null : lotTypeRaw;
    if (!name || amount === null || amount < 0 || !isIsoDate(dueOn) || (opensOn && !isIsoDate(opensOn)) || (lotType !== null && !isLotType(lotType))) {
      return redirectTo(c, back, "Check the name, amount, lot type, and dates.", "warn");
    }
    const result = await c.env.DB
      .prepare(
        `UPDATE assessments SET name = ?, amount_cents = ?, due_on = ?, opens_on = ?, lot_type = ?
         WHERE association_id = ? AND id = ?`,
      )
      .bind(name, amount, dueOn, opensOn || null, lotType, association.id, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "assessment_update",
      entityType: "assessment",
      entityId: id,
      detail: name,
    });
    return redirectTo(c, back, "Assessment saved. Invoices already assigned were not changed.");
  });

  app.post("/a/:slug/admin/assessments/:assessmentId/assign", async (c) => {
    const { association, user } = requireStaff(c);
    await readForm(c);
    const back = `/a/${association.slug}/admin/ledger#dues`;
    const result = await assignAssessmentInvoices(c.env.DB, {
      associationId: association.id,
      assessmentId: c.req.param("assessmentId"),
      today: todayIso(association.timezone),
    });
    if (!result) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "assessment_assign",
      entityType: "assessment",
      entityId: c.req.param("assessmentId"),
      detail: `${result.name}: ${result.created} invoices, ${result.already} already assigned.`,
    });
    return redirectTo(c, back, `Assigned ${result.name} to ${result.created} lots. ${result.already} already had it.`);
  });

  app.post("/a/:slug/admin/assessments/:assessmentId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const back = `/a/${association.slug}/admin/ledger#dues`;
    const id = c.req.param("assessmentId");
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, back, "Confirm the delete first.", "warn");
    const outcome = await deleteAssessment(c.env.DB, association.id, id);
    if (!outcome.ok) {
      const message =
        outcome.reason === "payments"
          ? "That assessment was not deleted. A payment is recorded on one of its invoices."
          : "That assessment was not deleted.";
      return redirectTo(c, back, message, "warn");
    }
    const removed =
      outcome.invoicesRemoved === 1
        ? "1 unpaid invoice was removed."
        : `${outcome.invoicesRemoved} unpaid invoices were removed.`;
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "assessment_delete",
      entityType: "assessment",
      entityId: id,
      detail: outcome.invoicesRemoved > 0 ? `${outcome.name}. ${removed}` : outcome.name,
    });
    return redirectTo(c, back, outcome.invoicesRemoved > 0 ? `Assessment deleted. ${removed}` : "Assessment deleted.");
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
    const mailed = await maybeEmailOwners(c, {
      requested: fields.email_owners === "1",
      association,
      audience: loginAudienceForVisibility(visibility),
      kind: "document",
      title,
      summary: notes,
      saved: "Document published.",
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_publish",
      entityType: "document",
      entityId: stored.documentId,
      detail: withEmailNote(title, mailed.detailNote),
    });
    return redirectTo(c, `/a/${association.slug}/admin/documents/${stored.documentId}`, mailed.message, mailed.tone);
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
    const versionLabel = `Version ${Number(max?.n ?? 0) + 1}`;
    const mailed = await maybeEmailOwners(c, {
      requested: fields.email_owners === "1",
      association,
      audience: loginAudienceForVisibility(document.visibility),
      kind: "document",
      title: document.title,
      summary: notes,
      saved: "New version is now current.",
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_publish",
      entityType: "document",
      entityId: document.id,
      detail: withEmailNote(versionLabel, mailed.detailNote),
    });
    return redirectTo(c, documentPath(association.slug, document.id), mailed.message, mailed.tone);
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
    return redirectTo(c, documentPath(association.slug, document.id), `Owners and residents now see version ${version.version_number}.`);
  });

  app.post("/a/:slug/admin/documents/:documentId/visibility", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const document = await loadDocument(c, association.id, c.req.param("documentId"));
    const visibility = textValue(fields, "visibility", 20);
    if (visibility !== "residents" && visibility !== "board") {
      return redirectTo(c, documentPath(association.slug, document.id), "Choose owners and residents, or board only.", "warn");
    }
    await c.env.DB
      .prepare("UPDATE documents SET visibility = ? WHERE association_id = ? AND id = ?")
      .bind(visibility, association.id, document.id)
      .run();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_visibility",
      entityType: "document",
      entityId: document.id,
      detail: visibility === "board" ? "Board only" : "Owners and residents",
    });
    return redirectTo(c, documentPath(association.slug, document.id), "Visibility saved.");
  });

  app.post("/a/:slug/admin/documents/:documentId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const document = await loadDocument(c, association.id, c.req.param("documentId"));
    const back = `/a/${association.slug}/admin/documents`;
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, documentPath(association.slug, document.id), "Confirm the delete first.", "warn");
    const versions = await documentVersions(c.env.DB, association.id, document.id);
    await c.env.DB
      .prepare("DELETE FROM document_versions WHERE association_id = ? AND document_id = ?")
      .bind(association.id, document.id)
      .run();
    await c.env.DB.prepare("DELETE FROM documents WHERE association_id = ? AND id = ?").bind(association.id, document.id).run();
    for (const version of versions) {
      try {
        await c.env.DOCUMENTS.delete(version.r2_key);
      } catch (error) {
        logError("document_r2_delete", { message: error instanceof Error ? error.message : "unknown" });
      }
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "document_delete",
      entityType: "document",
      entityId: document.id,
      detail: document.title,
    });
    return redirectTo(c, back, "Document deleted.");
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
    applyDocumentResponseHeaders(headers, {
      filename: version.filename,
      contentType: version.content_type,
      download: c.req.query("download") === "1",
    });
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
    const editing = newsEdit(c.req.query("edit") ?? "", c.req.query("id") ?? "", announcements, events, faqs, contacts, association.timezone);
    return render(c, {
      title: "News",
      active: "admin",
      body: newsAdminPage({ association, announcements, events, faqs, contacts, editing }),
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
    const mailed = await maybeEmailOwners(c, {
      requested: fields.email_owners === "1",
      association,
      audience: "owners",
      kind: "announcement",
      title,
      summary: body,
      itemId: id,
      saved: "Announcement posted.",
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "announcement_create",
      entityType: "announcement",
      entityId: id,
      detail: withEmailNote(title, mailed.detailNote),
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, mailed.message, mailed.tone);
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

  app.post("/a/:slug/admin/announcements/:announcementId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("announcementId");
    const parsed = readAnnouncement(fields, association.timezone);
    if (!parsed.ok) return redirectTo(c, `/a/${association.slug}/admin/news?edit=announcement&id=${id}`, parsed.message, "warn");
    const result = await c.env.DB
      .prepare(
        `UPDATE announcements SET kind = ?, title = ?, body = ?, pinned = ?, expires_at = ?
         WHERE association_id = ? AND id = ?`,
      )
      .bind(parsed.kind, parsed.title, parsed.body, parsed.pinned, parsed.expiresAt, association.id, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    const mailed = await maybeEmailOwners(c, {
      requested: fields.email_owners === "1",
      association,
      audience: "owners",
      kind: "announcement",
      title: parsed.title,
      summary: parsed.body,
      itemId: id,
      saved: "Announcement saved.",
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "announcement_update",
      entityType: "announcement",
      entityId: id,
      detail: withEmailNote(parsed.title, mailed.detailNote),
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, mailed.message, mailed.tone);
  });

  app.post("/a/:slug/admin/announcements/:announcementId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("announcementId");
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, `/a/${association.slug}/admin/news`, "Confirm the delete first.", "warn");
    const result = await c.env.DB.prepare("DELETE FROM announcements WHERE association_id = ? AND id = ?").bind(association.id, id).run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "announcement_delete",
      entityType: "announcement",
      entityId: id,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Announcement deleted.");
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
    const mailed = await maybeEmailOwners(c, {
      requested: fields.email_owners === "1",
      association,
      audience: "owners",
      kind: "event",
      title,
      summary: eventSummary(startsAt, location, description, association.timezone),
      saved: "Event added.",
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "event_create",
      entityType: "event",
      entityId: id,
      detail: withEmailNote(title, mailed.detailNote),
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, mailed.message, mailed.tone);
  });

  app.post("/a/:slug/admin/events/:eventId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("eventId");
    const parsed = readEvent(fields, association.timezone);
    if (!parsed.ok) return redirectTo(c, `/a/${association.slug}/admin/news?edit=event&id=${id}`, parsed.message, "warn");
    const result = await c.env.DB
      .prepare(
        `UPDATE events SET kind = ?, title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?
         WHERE association_id = ? AND id = ?`,
      )
      .bind(parsed.kind, parsed.title, parsed.description, parsed.location, parsed.startsAt, parsed.endsAt, association.id, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    const mailed = await maybeEmailOwners(c, {
      requested: fields.email_owners === "1",
      association,
      audience: "owners",
      kind: "event",
      title: parsed.title,
      summary: eventSummary(parsed.startsAt, parsed.location, parsed.description, association.timezone),
      saved: "Event saved.",
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "event_update",
      entityType: "event",
      entityId: id,
      detail: withEmailNote(parsed.title, mailed.detailNote),
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, mailed.message, mailed.tone);
  });

  app.post("/a/:slug/admin/events/:eventId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("eventId");
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, `/a/${association.slug}/admin/news`, "Confirm the delete first.", "warn");
    const result = await c.env.DB.prepare("DELETE FROM events WHERE association_id = ? AND id = ?").bind(association.id, id).run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "event_delete",
      entityType: "event",
      entityId: id,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Event deleted.");
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

  app.post("/a/:slug/admin/faqs/:faqId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("faqId");
    const question = textValue(fields, "question", 300);
    const answer = textValue(fields, "answer", 5000);
    if (!question || !answer) return redirectTo(c, `/a/${association.slug}/admin/news?edit=faq&id=${id}`, "Add a question and an answer.", "warn");
    const result = await c.env.DB
      .prepare("UPDATE faqs SET question = ?, answer = ? WHERE association_id = ? AND id = ?")
      .bind(question, answer, association.id, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "faq_update",
      entityType: "faq",
      entityId: id,
      detail: question,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "FAQ saved.");
  });

  app.post("/a/:slug/admin/faqs/:faqId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("faqId");
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, `/a/${association.slug}/admin/news`, "Confirm the delete first.", "warn");
    const result = await c.env.DB.prepare("DELETE FROM faqs WHERE association_id = ? AND id = ?").bind(association.id, id).run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "faq_delete",
      entityType: "faq",
      entityId: id,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "FAQ deleted.");
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

  app.post("/a/:slug/admin/contacts/:contactId", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("contactId");
    const name = textValue(fields, "name", 120);
    const roleTitle = textValue(fields, "role_title", 120);
    const email = textValue(fields, "email", 200);
    const phone = textValue(fields, "phone", 40);
    if (!name || !roleTitle) return redirectTo(c, `/a/${association.slug}/admin/news?edit=contact&id=${id}`, "Name and role are required.", "warn");
    const result = await c.env.DB
      .prepare("UPDATE board_contacts SET name = ?, role_title = ?, email = ?, phone = ? WHERE association_id = ? AND id = ?")
      .bind(name, roleTitle, email, phone, association.id, id)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "contact_update",
      entityType: "board_contact",
      entityId: id,
      detail: name,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Contact saved.");
  });

  app.post("/a/:slug/admin/contacts/:contactId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const id = c.req.param("contactId");
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, `/a/${association.slug}/admin/news`, "Confirm the delete first.", "warn");
    const result = await c.env.DB.prepare("DELETE FROM board_contacts WHERE association_id = ? AND id = ?").bind(association.id, id).run();
    if ((result.meta.changes ?? 0) === 0) throw new NotFoundError();
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "contact_delete",
      entityType: "board_contact",
      entityId: id,
    });
    return redirectTo(c, `/a/${association.slug}/admin/news`, "Contact deleted.");
  });

  app.get("/a/:slug/admin/join-requests", async (c) => {
    const { association } = requireStaff(c);
    try {
      const rows = await listJoinRequests(c.env.DB, association.id);
      return render(c, { title: "Join requests", active: "admin", body: joinRequestsPage(association, rows) });
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      return render(c, {
        title: "Join requests",
        active: "admin",
        status: 503,
        body: `<section class="panel"><h1>Join requests</h1><p>Apply the join request table in D1, then reload. The steps are in the project README under Request to join.</p></section>`,
      });
    }
  });

  app.post("/a/:slug/admin/join-requests/:requestId/approve", async (c) => {
    const { association, user } = requireStaff(c);
    await readForm(c);
    const requestId = c.req.param("requestId");
    const back = `/a/${association.slug}/admin/join-requests`;
    let result;
    try {
      result = await approveJoinRequest(c.env.DB, { associationId: association.id, requestId });
    } catch (error) {
      if (isMissingTable(error)) {
        return redirectTo(c, back, "Apply the join request table in D1, then try again. The steps are in the README under Request to join.", "warn");
      }
      if (isCheckConstraint(error)) {
        return redirectTo(
          c,
          back,
          "Apply the join request approval migration in D1, then try again. The steps are in the README under Request to join.",
          "warn",
        );
      }
      throw error;
    }
    if (!result.ok) {
      const message =
        result.reason === "invalid_email"
          ? "That request does not have a valid email, so no login was created."
          : "That request is not waiting to be approved.";
      return redirectTo(c, back, message, "warn");
    }

    const letter = welcomeEmail({ associationName: association.name, email: result.email, name: result.name });
    const apiKey = resendApiKey(c.env);
    let emailSent = false;
    if (apiKey) {
      try {
        emailSent = await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: result.email,
          subject: letter.subject,
          text: letter.text,
        });
      } catch (error) {
        logError("join_approve_email", { message: error instanceof Error ? error.message : "unknown" });
      }
    }
    const summary = approvalSummary({
      createdUser: result.createdUser,
      roleId: result.roleId,
      lot: result.lot,
      emailSent,
    });
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "join_request_approve",
      entityType: "join_request",
      entityId: requestId,
      detail: summary,
    });
    logInfo("join_request_approve", { associationId: association.id, createdUser: result.createdUser, emailSent });
    return redirectTo(c, back, summary, emailSent ? "ok" : "warn");
  });

  app.post("/a/:slug/admin/join-requests/:requestId/reviewed", async (c) => {
    const { association, user } = requireStaff(c);
    await readForm(c);
    const requestId = c.req.param("requestId");
    const updated = await reviewJoinRequest(c.env.DB, association.id, requestId);
    if (!updated) return redirectTo(c, `/a/${association.slug}/admin/join-requests`, "That request is not waiting.", "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "join_request_review",
      entityType: "join_request",
      entityId: requestId,
      detail: "Marked reviewed.",
    });
    return redirectTo(c, `/a/${association.slug}/admin/join-requests`, "Request marked reviewed.");
  });

  app.post("/a/:slug/admin/join-requests/:requestId/decline", async (c) => {
    const { association, user } = requireStaff(c);
    await readForm(c);
    const requestId = c.req.param("requestId");
    const back = `/a/${association.slug}/admin/join-requests`;
    let updated = false;
    try {
      updated = await declineJoinRequest(c.env.DB, association.id, requestId);
    } catch (error) {
      if (isCheckConstraint(error) || isMissingTable(error)) {
        return redirectTo(c, back, "Apply the admin migration in D1, then try again. The steps are in the README under Admin improvements.", "warn");
      }
      throw error;
    }
    if (!updated) return redirectTo(c, back, "That request cannot be declined. Approved requests stay approved.", "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "join_request_decline",
      entityType: "join_request",
      entityId: requestId,
      detail: "Declined. No login was created.",
    });
    return redirectTo(c, back, "Request declined. No login was created.");
  });

  app.post("/a/:slug/admin/join-requests/:requestId/delete", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const requestId = c.req.param("requestId");
    const back = `/a/${association.slug}/admin/join-requests`;
    if (textValue(fields, "confirm", 10) !== "yes") return redirectTo(c, back, "Confirm the delete first.", "warn");
    const removed = await deleteJoinRequest(c.env.DB, association.id, requestId);
    if (!removed) return redirectTo(c, back, "That request is already gone.", "warn");
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "join_request_delete",
      entityType: "join_request",
      entityId: requestId,
      detail: "Request removed. Any login already created was left in place.",
    });
    return redirectTo(c, back, "Request deleted.");
  });

  app.get("/a/:slug/admin/messages", async (c) => {
    const { association } = requireStaff(c);
    const [threads, staffIds] = await Promise.all([
      threadsForViewer(c.env.DB, association.id, "", true),
      staffUserIds(c.env.DB, association.id),
    ]);
    return render(c, { title: "Messages", active: "admin", body: adminMessagesPage(association, threads, staffIds) });
  });

  app.get("/a/:slug/admin/messages/:threadId", async (c) => {
    const { association } = requireStaff(c);
    const threadId = c.req.param("threadId");
    const [messages, staffIds] = await Promise.all([
      threadMessages(c.env.DB, association.id, threadId),
      staffUserIds(c.env.DB, association.id),
    ]);
    if (messages.length === 0) throw new NotFoundError();
    return render(c, {
      title: messages[0].subject,
      active: "admin",
      body: adminThreadPage(association, messages[0].subject, messages, staffIds),
    });
  });

  app.post("/a/:slug/admin/messages/:threadId/reviewed", async (c) => {
    const { association, user } = requireStaff(c);
    const fields = await readForm(c);
    const threadId = c.req.param("threadId");
    const listPath = `/a/${association.slug}/admin/messages`;
    const threadPath = `${listPath}/${threadId}`;
    const requested = textValue(fields, "next", 200);
    const back = requested === listPath || requested === threadPath ? requested : threadPath;
    let result: { found: boolean; changed: boolean };
    try {
      result = await markThreadReviewed(c.env.DB, association.id, threadId);
    } catch (error) {
      if (isMissingColumn(error)) {
        return redirectTo(
          c,
          back,
          "Apply the message review migration in D1, then try again. The steps are in the README under Mark a message reviewed.",
          "warn",
        );
      }
      throw error;
    }
    if (!result.found) return redirectTo(c, listPath, "That thread was not found.", "warn");
    if (result.changed) {
      await writeAudit(c.env.DB, {
        associationId: association.id,
        actorUserId: user.id,
        action: "message_review",
        entityType: "message",
        entityId: threadId,
        detail: "Marked reviewed.",
      });
    }
    return redirectTo(c, back, "Thread marked reviewed.");
  });

  app.get("/a/:slug/admin/audit", async (c) => {
    const { association } = requireStaff(c);
    const rows = await listAudit(c.env.DB, association.id);
    return render(c, { title: "Activity", active: "admin", body: auditPage(association, rows) });
  });
}

export function newsEdit(
  kind: string,
  id: string,
  announcements: Awaited<ReturnType<typeof allAnnouncements>>,
  events: Awaited<ReturnType<typeof listEvents>>,
  faqs: Awaited<ReturnType<typeof listFaqs>>,
  contacts: Awaited<ReturnType<typeof listContacts>>,
  timeZone: string,
): NewsEdit | null {
  if (!id) return null;
  if (kind === "announcement") {
    const row = announcements.find((item) => item.id === id);
    return row ? { kind: "announcement", row } : null;
  }
  if (kind === "event") {
    const row = events.find((item) => item.id === id);
    if (!row) return null;
    return {
      kind: "event",
      row,
      startsLocal: utcToDatetimeLocal(row.starts_at, timeZone),
      endsLocal: row.ends_at ? utcToDatetimeLocal(row.ends_at, timeZone) : "",
    };
  }
  if (kind === "faq") {
    const row = faqs.find((item) => item.id === id);
    return row ? { kind: "faq", row } : null;
  }
  if (kind === "contact") {
    const row = contacts.find((item) => item.id === id);
    return row ? { kind: "contact", row } : null;
  }
  return null;
}

function readAnnouncement(
  fields: Record<string, string | File>,
  timeZone: string,
):
  | { ok: true; kind: "news" | "meeting" | "emergency"; title: string; body: string; pinned: number; expiresAt: string | null }
  | { ok: false; message: string } {
  const kind = textValue(fields, "kind", 20);
  const title = textValue(fields, "title", 200);
  const body = textValue(fields, "body", 8000);
  const pinned = fields.pinned === "1" ? 1 : 0;
  const expiresOn = textValue(fields, "expires_on", 20);
  if ((kind !== "news" && kind !== "meeting" && kind !== "emergency") || !title || !body) {
    return { ok: false, message: "Add a title and body." };
  }
  let expiresAt: string | null = null;
  if (expiresOn) {
    expiresAt = zonedLocalToUtc(`${expiresOn}T23:59`, timeZone);
    if (!expiresAt) return { ok: false, message: "Expiration date is not valid." };
  }
  return { ok: true, kind, title, body, pinned, expiresAt };
}

function readEvent(
  fields: Record<string, string | File>,
  timeZone: string,
):
  | { ok: true; kind: "event" | "meeting" | "emergency"; title: string; description: string; location: string; startsAt: string; endsAt: string | null }
  | { ok: false; message: string } {
  const kind = textValue(fields, "kind", 20);
  const title = textValue(fields, "title", 200);
  const description = textValue(fields, "description", 4000);
  const location = textValue(fields, "location", 200);
  const startsAt = zonedLocalToUtc(textValue(fields, "starts_at", 40), timeZone);
  const endsRaw = textValue(fields, "ends_at", 40);
  const endsAt = endsRaw ? zonedLocalToUtc(endsRaw, timeZone) : null;
  if ((kind !== "event" && kind !== "meeting" && kind !== "emergency") || !title || !startsAt || (endsRaw && !endsAt)) {
    return { ok: false, message: "Check the event title and times." };
  }
  return { ok: true, kind, title, description, location, startsAt, endsAt };
}

function withEmailNote(detail: string, note: string): string {
  return note ? `${detail}. ${note}` : detail;
}

function eventSummary(startsAt: string, location: string, description: string, timeZone: string): string {
  return [formatDateTime(startsAt, timeZone), location, description].filter((part) => part.trim()).join(". ");
}

function noticeUpload(fields: Record<string, string | File>): File | null {
  for (const name of ["file", "attachment"]) {
    const file = fileValue(fields, name);
    if (file && file.size > 0) return file;
  }
  return null;
}

async function maybeEmailOneOwner(
  c: AppContext,
  input: {
    requested: boolean;
    association: Association;
    ownerId: string;
    title: string;
    summary: string;
    saved: string;
    attachment: ResendAttachment | null;
  },
): Promise<{ message: string; tone: "ok" | "warn"; detailNote: string }> {
  if (!input.requested) return { message: input.saved, tone: "ok", detailNote: "" };
  try {
    const row = await c.env.DB
      .prepare(
        `SELECT u.id, u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.association_id = ? AND u.id = ?`,
      )
      .bind(input.association.id, input.ownerId)
      .first<{ id: string; email: string }>();
    const recipients = uniqueLoginEmails(row ? [row] : []);
    const letter = ownerNoticeEmail({
      associationName: input.association.name,
      slug: input.association.slug,
      kind: "account",
      title: input.title,
      summary: input.summary,
      attachmentName: input.attachment?.filename,
    });
    const delivery = await deliverOwnerEmails({
      apiKey: resendApiKey(c.env),
      from: c.env.EMAIL_FROM,
      recipients,
      subject: letter.subject,
      text: letter.text,
      attachments: input.attachment ? [input.attachment] : undefined,
    });
    const flash = ownerEmailFlash({
      saved: input.saved,
      audience: "owners",
      recipients: recipients.length,
      delivery,
    });
    logInfo("owner_notice_email", {
      associationId: input.association.id,
      kind: "account",
      audience: "owners",
      recipients: recipients.length,
      sent: delivery.sent,
      failed: delivery.failed,
      skipped: delivery.skipped,
      attached: Boolean(input.attachment),
    });
    return { message: flash.message, tone: flash.tone, detailNote: flash.note };
  } catch (error) {
    logError("owner_notice_email", { message: error instanceof Error ? error.message : "unknown" });
    return { message: `${input.saved} Email was not sent.`, tone: "warn", detailNote: "Email was not sent." };
  }
}

async function maybeEmailOwners(
  c: AppContext,
  input: {
    requested: boolean;
    association: Association;
    audience: LoginAudience;
    kind: OwnerNoticeKind;
    title: string;
    summary: string;
    itemId?: string;
    saved: string;
  },
): Promise<{ message: string; tone: "ok" | "warn"; detailNote: string }> {
  if (!input.requested) return { message: input.saved, tone: "ok", detailNote: "" };
  try {
    const recipients = uniqueLoginEmails(await activeLoginEmails(c.env.DB, input.association.id, input.audience));
    const letter = ownerNoticeEmail({
      associationName: input.association.name,
      slug: input.association.slug,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      itemId: input.itemId,
    });
    const delivery = await deliverOwnerEmails({
      apiKey: resendApiKey(c.env),
      from: c.env.EMAIL_FROM,
      recipients,
      subject: letter.subject,
      text: letter.text,
    });
    const flash = ownerEmailFlash({
      saved: input.saved,
      audience: input.audience,
      recipients: recipients.length,
      delivery,
    });
    logInfo("owner_notice_email", {
      associationId: input.association.id,
      kind: input.kind,
      audience: input.audience,
      recipients: recipients.length,
      sent: delivery.sent,
      failed: delivery.failed,
      skipped: delivery.skipped,
    });
    return { message: flash.message, tone: flash.tone, detailNote: flash.note };
  } catch (error) {
    logError("owner_notice_email", { message: error instanceof Error ? error.message : "unknown" });
    return { message: `${input.saved} Email was not sent.`, tone: "warn", detailNote: "Email was not sent." };
  }
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
