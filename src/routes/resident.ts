import type { Hono } from "hono";
import { canViewPropertyFinancials, isAdmin, isBoardMember } from "../lib/access";
import { timeZoneLabel, todayIso } from "../lib/dates";
import { resendApiKey, sendResendEmail, SUPPORT_INBOX, supportEmailText } from "../lib/email";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import { logError, logInfo } from "../lib/log";
import { ensureSeedFiles } from "../lib/seed-files";
import { applyDocumentResponseHeaders } from "../lib/files";
import {
  invoiceById,
  invoicesForUser,
  ledgerForUser,
  listContacts,
  listDocuments,
  listEvents,
  listFaqs,
  noticeFileForUser,
  notificationsForUser,
  ownerIdsForProperty,
  paymentById,
  paymentsForUser,
  propertyInAssociation,
  staffUserIds,
  threadMessages,
  threadsForViewer,
  upcomingAssessments,
  versionById,
  visibleAnnouncements,
  writeAudit,
  notify,
} from "../db";
import type { AppBindings, Association, Membership } from "../types";
import { render } from "../views/layout";
import {
  boardPage,
  calendarPage,
  dashboardPage,
  documentsPage,
  faqPage,
  invoiceDetailPage,
  invoiceListPage,
  messagesPage,
  newsDetailPage,
  newsPage,
  noticesPage,
  paymentDetailPage,
  paymentListPage,
  supportPage,
  threadPage,
} from "../views/resident";
import { readForm, redirectTo, requireMember, textValue, type AppContext } from "./common";

export function registerResidentRoutes(app: Hono<AppBindings>): void {
  app.get("/a/:slug/dashboard", async (c) => {
    const { association, user } = requireMember(c);
    const today = todayIso(association.timezone);
    const now = new Date().toISOString();
    const [ledger, upcoming, invoices, payments, notices, emergencies] = await Promise.all([
      ledgerForUser(c.env.DB, association.id, user.id, today),
      upcomingAssessments(c.env.DB, association.id, user.id, today),
      invoicesForUser(c.env.DB, association.id, user.id),
      paymentsForUser(c.env.DB, association.id, user.id),
      notificationsForUser(c.env.DB, association.id, user.id),
      visibleAnnouncements(c.env.DB, association.id, now, "emergency"),
    ]);
    return render(c, {
      title: `Dashboard · ${association.name}`,
      active: "dashboard",
      body: dashboardPage({ association, name: user.name || user.email, ledger, upcoming, invoices, payments, notices, emergencies }),
    });
  });

  app.get("/a/:slug/invoices", async (c) => {
    const { association, user } = requireMember(c);
    const invoices = await invoicesForUser(c.env.DB, association.id, user.id);
    return render(c, { title: "Invoices", active: "dashboard", body: invoiceListPage(association, invoices) });
  });

  app.get("/a/:slug/invoices/:invoiceId", async (c) => {
    const { association } = requireMember(c);
    const invoice = await invoiceById(c.env.DB, association.id, c.req.param("invoiceId"));
    if (!invoice) throw new NotFoundError();
    await assertPropertyAccess(c, association.id, invoice.property_id);
    return render(c, { title: invoice.invoice_number, active: "dashboard", body: invoiceDetailPage(association, invoice) });
  });

  app.get("/a/:slug/payments", async (c) => {
    const { association, user } = requireMember(c);
    const payments = await paymentsForUser(c.env.DB, association.id, user.id);
    return render(c, { title: "Payments", active: "dashboard", body: paymentListPage(association, payments) });
  });

  app.get("/a/:slug/payments/:paymentId", async (c) => {
    const { association } = requireMember(c);
    const payment = await paymentById(c.env.DB, association.id, c.req.param("paymentId"));
    if (!payment) throw new NotFoundError();
    await assertPropertyAccess(c, association.id, payment.property_id);
    return render(c, { title: "Receipt", active: "dashboard", body: paymentDetailPage(association, payment) });
  });

  app.get("/a/:slug/notices", async (c) => {
    const { association, user } = requireMember(c);
    const notices = await notificationsForUser(c.env.DB, association.id, user.id);
    return render(c, { title: "Notices", active: "notices", body: noticesPage(association, notices) });
  });

  app.post("/a/:slug/notices/read-all", async (c) => {
    const { association, user } = requireMember(c);
    await readForm(c);
    await c.env.DB
      .prepare("UPDATE notifications SET read_at = ? WHERE association_id = ? AND user_id = ? AND read_at IS NULL")
      .bind(new Date().toISOString(), association.id, user.id)
      .run();
    return redirectTo(c, `/a/${association.slug}/notices`, "Notices marked read.");
  });

  app.get("/a/:slug/notices/:noticeId/file", async (c) => {
    const { association, user } = requireMember(c);
    const file = await noticeFileForUser(c.env.DB, association.id, user.id, c.req.param("noticeId"));
    if (!file) throw new NotFoundError();
    const object = await c.env.DOCUMENTS.get(file.r2_key);
    if (!object) throw new NotFoundError();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    applyDocumentResponseHeaders(headers, {
      filename: file.filename,
      contentType: file.content_type,
      download: c.req.query("download") === "1",
    });
    return new Response(object.body, { headers });
  });

  app.post("/a/:slug/notices/:noticeId/read", async (c) => {
    const { association, user } = requireMember(c);
    await readForm(c);
    await c.env.DB
      .prepare("UPDATE notifications SET read_at = ? WHERE association_id = ? AND user_id = ? AND id = ?")
      .bind(new Date().toISOString(), association.id, user.id, c.req.param("noticeId"))
      .run();
    return redirectTo(c, `/a/${association.slug}/notices`);
  });

  app.get("/a/:slug/documents", async (c) => {
    const { association, membership } = requireMember(c);
    await ensureSeedFiles(c.env.DOCUMENTS, c.env.DB);
    const documents = await listDocuments(c.env.DB, association.id, isBoardMember(membership));
    return render(c, { title: "Documents", active: "documents", body: documentsPage(association, documents) });
  });

  app.get("/a/:slug/documents/:documentId/file", async (c) => {
    const { association, membership } = requireMember(c);
    return streamCurrent(c, association, membership, c.req.param("documentId"));
  });

  app.get("/a/:slug/news", async (c) => {
    const { association } = requireMember(c);
    const items = await visibleAnnouncements(c.env.DB, association.id, new Date().toISOString());
    return render(c, { title: "News", active: "news", body: newsPage(association, items) });
  });

  app.get("/a/:slug/news/:announcementId", async (c) => {
    const { association } = requireMember(c);
    const items = await visibleAnnouncements(c.env.DB, association.id, new Date().toISOString());
    const item = items.find((entry) => entry.id === c.req.param("announcementId"));
    if (!item) throw new NotFoundError();
    return render(c, { title: item.title, active: "news", body: newsDetailPage(association, item) });
  });

  app.get("/a/:slug/calendar", async (c) => {
    const { association } = requireMember(c);
    const events = await listEvents(c.env.DB, association.id);
    return render(c, {
      title: "Calendar",
      active: "calendar",
      body: calendarPage(association, events, timeZoneLabel(association.timezone)),
    });
  });

  app.get("/a/:slug/faq", async (c) => {
    const { association } = requireMember(c);
    const faqs = await listFaqs(c.env.DB, association.id);
    return render(c, { title: "FAQ", active: "faq", body: faqPage(faqs) });
  });

  app.get("/a/:slug/board", async (c) => {
    const { association } = requireMember(c);
    const contacts = await listContacts(c.env.DB, association.id);
    return render(c, { title: "Board", active: "board", body: boardPage(association, contacts) });
  });

  app.get("/a/:slug/support", async (c) => {
    const { association, user } = requireMember(c);
    return render(c, {
      title: "Support",
      active: "support",
      body: supportPage(association, user),
    });
  });

  app.post("/a/:slug/support", async (c) => {
    const { association, user } = requireMember(c);
    const fields = await readForm(c);
    const message = textValue(fields, "body", 5000);
    if (!message) {
      return render(c, {
        title: "Support",
        active: "support",
        status: 400,
        body: supportPage(association, user, "", "Write a message before sending."),
      });
    }
    const name = user.name.replace(/[\r\n]+/g, " ").trim();
    const email = user.email.replace(/[\r\n]+/g, "").trim();
    const apiKey = resendApiKey(c.env);
    let sent = false;
    if (apiKey) {
      try {
        sent = await sendResendEmail({
          apiKey,
          from: c.env.EMAIL_FROM,
          to: SUPPORT_INBOX,
          replyTo: email,
          subject: `Support message from ${name || email}`.slice(0, 200),
          text: supportEmailText({ name, email, message }),
        });
      } catch (error) {
        logError("support_email", { message: error instanceof Error ? error.message : "unknown" });
      }
    } else {
      logError("support_email", { message: "email not configured" });
    }
    if (!sent) {
      return render(c, {
        title: "Support",
        active: "support",
        status: 503,
        body: supportPage(association, user, message, "Your message could not be sent. Please try again later."),
      });
    }
    logInfo("support_email", { associationId: association.id, userId: user.id });
    return redirectTo(c, `/a/${association.slug}/support`, "Your message was sent.");
  });

  app.get("/a/:slug/messages", async (c) => {
    const { association, user, membership } = requireMember(c);
    const [threads, properties] = await Promise.all([
      threadsForViewer(c.env.DB, association.id, user.id, false),
      ownedProperties(c, association.id, user.id),
    ]);
    return render(c, {
      title: "Messages",
      active: "messages",
      body: messagesPage(
        association,
        threads,
        properties.map((property) => ({ id: property.id, lot_number: property.lot_number })),
        isAdmin(membership) ? `/a/${association.slug}/admin/messages` : "",
      ),
    });
  });

  app.post("/a/:slug/messages", async (c) => {
    const { association, user, membership } = requireMember(c);
    const fields = await readForm(c);
    const subject = textValue(fields, "subject", 200);
    const body = textValue(fields, "body", 5000);
    const propertyId = textValue(fields, "property_id", 80);
    if (!subject || !body) return redirectTo(c, `/a/${association.slug}/messages`, "Add a subject and a message.", "warn");
    if (propertyId) {
      const property = await propertyInAssociation(c.env.DB, association.id, propertyId);
      if (!property) throw new NotFoundError();
      if (!isAdmin(membership)) await assertPropertyAccess(c, association.id, propertyId);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, id, user.id, propertyId || null, subject, body, now)
      .run();
    const staff = await staffUserIds(c.env.DB, association.id);
    for (const staffId of staff) {
      if (staffId === user.id) continue;
      await notify(c.env.DB, {
        associationId: association.id,
        userId: staffId,
        kind: "message",
        title: `New message from ${user.name || user.email}`,
        body: subject,
        href: `/a/${association.slug}/admin/messages/${id}`,
      });
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "message_create",
      entityType: "message",
      entityId: id,
    });
    return redirectTo(c, `/a/${association.slug}/messages/${id}`, "Message sent to the board.");
  });

  app.get("/a/:slug/messages/:threadId", async (c) => {
    const { association } = requireMember(c);
    const messages = await loadThread(c, association.id, c.req.param("threadId"));
    return render(c, { title: messages[0].subject, active: "messages", body: threadPage(association, messages[0].subject, messages) });
  });

  app.post("/a/:slug/messages/:threadId/reply", async (c) => {
    const { association, user, membership } = requireMember(c);
    const fields = await readForm(c);
    const body = textValue(fields, "body", 5000);
    const threadId = c.req.param("threadId");
    const messages = await loadThread(c, association.id, threadId);
    if (!body) return redirectTo(c, `/a/${association.slug}/messages/${threadId}`, "Write a reply before sending.", "warn");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await c.env.DB
      .prepare(
        `INSERT INTO messages (id, association_id, thread_id, parent_id, from_user_id, property_id, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, association.id, threadId, messages.at(-1)?.id ?? threadId, user.id, messages[0].property_id, messages[0].subject, body, now)
      .run();
    const recipients = new Set<string>();
    const next = textValue(fields, "next", 200);
    if (isAdmin(membership)) {
      for (const message of messages) recipients.add(message.from_user_id);
    } else {
      for (const staffId of await staffUserIds(c.env.DB, association.id)) recipients.add(staffId);
    }
    recipients.delete(user.id);
    for (const recipient of recipients) {
      await notify(c.env.DB, {
        associationId: association.id,
        userId: recipient,
        kind: "message",
        title: `Reply from ${user.name || user.email}`,
        body: messages[0].subject,
        href: isAdmin(membership) ? `/a/${association.slug}/messages/${threadId}` : `/a/${association.slug}/admin/messages/${threadId}`,
      });
    }
    await writeAudit(c.env.DB, {
      associationId: association.id,
      actorUserId: user.id,
      action: "message_reply",
      entityType: "message",
      entityId: id,
    });
    const back = next.startsWith(`/a/${association.slug}/admin/messages/`) ? next : `/a/${association.slug}/messages/${threadId}`;
    return redirectTo(c, back, "Reply sent.");
  });
}

async function assertPropertyAccess(c: AppContext, associationId: string, propertyId: string): Promise<void> {
  const { user, membership } = requireMember(c);
  const property = await propertyInAssociation(c.env.DB, associationId, propertyId);
  if (!property) throw new NotFoundError();
  const owners = await ownerIdsForProperty(c.env.DB, associationId, propertyId);
  if (!canViewPropertyFinancials(membership, user.id, owners)) throw new ForbiddenError();
}

async function ownedProperties(c: AppContext, associationId: string, userId: string) {
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.id, p.lot_number, p.street_address, p.city, p.state, p.postal_code, p.status
       FROM properties p
       JOIN property_owners po ON po.property_id = p.id AND po.association_id = p.association_id
       WHERE p.association_id = ? AND po.user_id = ?
       ORDER BY p.lot_number`,
    )
    .bind(associationId, userId)
    .all<{ id: string; lot_number: string; street_address: string; city: string; state: string; postal_code: string; status: string }>();
  return results;
}

async function loadThread(c: AppContext, associationId: string, threadId: string) {
  const { user, membership } = requireMember(c);
  const messages = await threadMessages(c.env.DB, associationId, threadId);
  if (messages.length === 0) throw new NotFoundError();
  if (!isAdmin(membership) && !messages.some((message) => message.from_user_id === user.id)) {
    throw new ForbiddenError();
  }
  return messages;
}

async function streamCurrent(c: AppContext, association: Association, membership: Membership, documentId: string): Promise<Response> {
  const document = await c.env.DB
    .prepare("SELECT id, visibility, current_version_id FROM documents WHERE association_id = ? AND id = ?")
    .bind(association.id, documentId)
    .first<{ id: string; visibility: "residents" | "board"; current_version_id: string | null }>();
  if (!document?.current_version_id) throw new NotFoundError();
  if (document.visibility === "board" && !isBoardMember(membership)) throw new ForbiddenError();
  const version = await versionById(c.env.DB, association.id, document.current_version_id);
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
}
